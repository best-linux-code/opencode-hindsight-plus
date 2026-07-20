/**
 * Hook implementations for the Hindsight OpenCode plugin.
 *
 * Aligned with Claude Code hindsight-memory:
 *   - experimental.chat.system.transform → per-user-turn auto-recall
 *   - event (session.idle) → auto-retain after the assistant finishes
 *   - event (session.deleted) + dispose → force-retain pending turns (SessionEnd)
 *   - experimental.session.compacting → retain + inject for compaction
 */

import type { HindsightClient } from "@vectorize-io/hindsight-client";
import type { HindsightConfig } from "./config.js";
import { Logger } from "./logger.js";
import {
  formatMemories,
  formatCurrentTime,
  composeRecallQuery,
  truncateRecallQuery,
  prepareRetentionTranscript,
  sliceLastTurnsByUserBoundary,
  injectHindsightMemories,
  buildMessageContent,
  buildRetainTemplateVars,
  resolveRetainTags,
  resolveRetainMetadata,
  type Message,
  type ToolPartLike,
} from "./content.js";
import { ensureBankMission } from "./bank.js";

export interface TurnRecallCache {
  userTurnCount: number;
  context: string | null;
}

export interface PluginState {
  turnCount: number;
  missionsSet: Set<string>;
  turnRecall: Map<string, TurnRecallCache>;
  lastRetainedTurn: Map<string, number>;
  /** Sessions observed this process — used by dispose force-retain. */
  activeSessions: Set<string>;
}

interface EventInput {
  event: {
    type: string;
    properties: Record<string, unknown>;
  };
}

interface CompactingInput {
  sessionID: string;
}

interface CompactingOutput {
  context: string[];
  prompt?: string;
}

interface SystemTransformInput {
  sessionID?: string;
  model: unknown;
}

interface SystemTransformOutput {
  system: string[];
}

type SessionPart = {
  type: string;
  text?: string;
  tool?: string;
  synthetic?: boolean;
  state?: ToolPartLike["state"];
  [key: string]: unknown;
};

interface MessagesTransformOutput {
  messages: Array<{
    info: { role: string; sessionID?: string; id?: string };
    parts: SessionPart[];
  }>;
}

type OpencodeClient = {
  session: {
    messages: (params: { path: { id: string } }) => Promise<{
      data?: Array<{
        info: { role: string };
        parts: SessionPart[];
      }>;
      error?: unknown;
      request?: unknown;
      response?: unknown;
    }>;
  };
};

export interface HindsightHooks {
  event: (input: EventInput) => Promise<void>;
  dispose: () => Promise<void>;
  "experimental.session.compacting": (
    input: CompactingInput,
    output: CompactingOutput
  ) => Promise<void>;
  "experimental.chat.system.transform": (
    input: SystemTransformInput,
    output: SystemTransformOutput
  ) => Promise<void>;
  "experimental.chat.messages.transform": (
    input: Record<string, never>,
    output: MessagesTransformOutput
  ) => Promise<void>;
}

function countUserTurns(messages: readonly Message[]): number {
  return messages.filter((m) => m.role === "user").length;
}

function lastUserMessage(messages: readonly Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i];
  }
  return undefined;
}

function applyContextToSystem(output: SystemTransformOutput, context: string): void {
  output.system[0] = injectHindsightMemories(output.system[0] ?? "", context);
}

function isHindsightMemoryPart(part: SessionPart): boolean {
  return (
    part.type === "text" &&
    typeof part.text === "string" &&
    part.text.includes("<hindsight_memories>")
  );
}

function applyContextToLatestUserMessage(
  output: MessagesTransformOutput,
  context: string
): boolean {
  for (let i = output.messages.length - 1; i >= 0; i--) {
    const msg = output.messages[i];
    if (msg.info.role !== "user") continue;
    msg.parts = msg.parts.filter((p) => !isHindsightMemoryPart(p));
    msg.parts.push({
      type: "text",
      text: context,
      synthetic: true,
    });
    return true;
  }
  return false;
}

function sessionIdFromMessages(output: MessagesTransformOutput): string | undefined {
  for (let i = output.messages.length - 1; i >= 0; i--) {
    const id = output.messages[i]?.info?.sessionID;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/**
 * Text content from transform parts for recall query composition.
 * Skips prior hindsight injects. Prefer non-synthetic text (Claude: user prompt only).
 */
function textFromParts(
  parts: readonly SessionPart[],
  includeSynthetic: boolean
): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type !== "text" || typeof part.text !== "string" || !part.text) continue;
    if (isHindsightMemoryPart(part)) continue;
    if (!includeSynthetic && part.synthetic) continue;
    chunks.push(part.text);
  }
  return chunks.join("\n").trim();
}

/**
 * Convert OpenCode transform messages → text-only Message[] for recall.
 * Claude Code uses hook `prompt` (+ optional transcript); we use the transform
 * payload already in hand so we never re-fetch the full session for recall.
 */
function messagesFromTransformOutput(output: MessagesTransformOutput): Message[] {
  const messages: Message[] = [];
  for (const msg of output.messages) {
    const role = msg.info.role;
    if (role !== "user" && role !== "assistant") continue;
    const content =
      role === "user"
        ? textFromParts(msg.parts, false) || textFromParts(msg.parts, true)
        : textFromParts(msg.parts, true);
    if (content) messages.push({ role, content });
  }
  return messages;
}

function capMapSize<K, V>(map: Map<K, V>, max: number): void {
  if (map.size <= max) return;
  const first = map.keys().next().value;
  if (first !== undefined) map.delete(first);
}

function extractSessionIdFromDeleted(properties: Record<string, unknown>): string | undefined {
  if (typeof properties.sessionID === "string") return properties.sessionID;
  const info = properties.info;
  if (info && typeof info === "object" && info !== null) {
    const id = (info as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

export function createHooks(
  hindsightClient: HindsightClient,
  bankId: string,
  config: HindsightConfig,
  state: PluginState,
  opencodeClient: OpencodeClient,
  logger: Logger = new Logger({ silent: true })
): HindsightHooks {
  interface RecallOutcome {
    context: string | null;
    ok: boolean;
  }

  function trackSession(sessionId: string): void {
    state.activeSessions.add(sessionId);
    if (state.activeSessions.size > 1000) {
      const first = state.activeSessions.values().next().value;
      if (first) state.activeSessions.delete(first);
    }
  }

  async function recallForContext(query: string): Promise<RecallOutcome> {
    try {
      const response = await hindsightClient.recall(bankId, query, {
        budget: config.recallBudget as "low" | "mid" | "high",
        maxTokens: config.recallMaxTokens,
        types: config.recallTypes,
        tags: config.recallTags.length ? config.recallTags : undefined,
        tagsMatch: config.recallTags.length ? config.recallTagsMatch : undefined,
      });

      const results = response.results || [];
      if (!results.length) return { context: null, ok: true };

      const formatted = formatMemories(results);
      const context =
        `<hindsight_memories>\n` +
        `${config.recallPromptPreamble}\n` +
        `Current time: ${formatCurrentTime()} UTC\n\n` +
        `${formatted}\n` +
        `</hindsight_memories>`;
      return { context, ok: true };
    } catch (e) {
      logger.error("Recall failed", e);
      return { context: null, ok: false };
    }
  }

  /**
   * @param includeToolCalls - retain path may include tools; recall path stays text-only
   *   so tool dumps do not dilute the recall query.
   */
  async function getSessionMessages(
    sessionId: string,
    includeToolCalls: boolean
  ): Promise<Message[]> {
    try {
      logger.debug(`getSessionMessages: fetching messages for session ${sessionId}`);
      const response = await opencodeClient.session.messages({
        path: { id: sessionId },
      });
      if (response.error) {
        logger.warn("getSessionMessages: OpenCode returned an error", {
          error: JSON.stringify(response.error)?.substring(0, 500),
        });
      }
      const rawMessages = response.data || [];
      const messages: Message[] = [];
      for (const msg of rawMessages) {
        const role = msg.info.role;
        if (role !== "user" && role !== "assistant") continue;
        const content = buildMessageContent(msg.parts, includeToolCalls);
        if (content.trim()) {
          messages.push({ role, content });
        }
      }
      logger.debug(`getSessionMessages: raw=${rawMessages.length}, parsed=${messages.length}`);
      return messages;
    } catch (e) {
      logger.error("Failed to get session messages", e);
      return [];
    }
  }

  async function retainSession(sessionId: string, messages: Message[]): Promise<void> {
    const retainFullWindow = config.retainMode === "full-session";
    let targetMessages: Message[];
    let documentId: string;

    if (retainFullWindow) {
      targetMessages = messages;
      documentId = sessionId;
    } else {
      const windowTurns = config.retainEveryNTurns + config.retainOverlapTurns;
      targetMessages = sliceLastTurnsByUserBoundary(messages, windowTurns);
      documentId = `${sessionId}-${Date.now()}`;
    }

    const { transcript, messageCount } = prepareRetentionTranscript(targetMessages, true);
    if (!transcript) return;

    const vars = buildRetainTemplateVars({ sessionId, bankId });
    const tags = resolveRetainTags(config.retainTags, vars);
    const metadata = resolveRetainMetadata(config.retainMetadata, vars, messageCount);

    await ensureBankMission(hindsightClient, bankId, config, state.missionsSet, logger);
    await hindsightClient.retain(bankId, transcript, {
      documentId,
      context: config.retainContext,
      tags,
      metadata,
      async: true,
    });
  }

  /**
   * Retain when there are user turns not yet covered by lastRetainedTurn.
   * force=true ignores retainEveryNTurns (SessionEnd / dispose / deleted).
   */
  async function maybeRetainSession(
    sessionId: string,
    opts: { force: boolean; reason: string }
  ): Promise<void> {
    if (!config.autoRetain) return;

    const messages = await getSessionMessages(sessionId, config.retainToolCalls);
    if (!messages.length) return;

    const userTurns = countUserTurns(messages);
    const lastRetained = state.lastRetainedTurn.get(sessionId) || 0;
    const pending = userTurns - lastRetained;

    if (pending <= 0) {
      logger.debug(`${opts.reason}: nothing pending for ${sessionId}`);
      return;
    }
    if (!opts.force && pending < config.retainEveryNTurns) {
      logger.debug(
        `${opts.reason}: waiting for more turns (${pending}/${config.retainEveryNTurns})`
      );
      return;
    }

    try {
      await retainSession(sessionId, messages);
      state.lastRetainedTurn.set(sessionId, userTurns);
      logger.info(`Auto-retained ${messages.length} messages`, {
        session: sessionId,
        bank: bankId,
        reason: opts.reason,
        force: opts.force,
        userTurns,
      });
    } catch (e) {
      logger.error(`Auto-retain failed (${opts.reason})`, e);
    }
  }

  const event = async (input: EventInput): Promise<void> => {
    try {
      const { event: evt } = input;
      logger.debug(`event hook fired: type=${evt.type}`);

      if (evt.type === "session.idle") {
        const sessionId = (evt.properties as { sessionID?: string }).sessionID;
        if (sessionId) {
          trackSession(sessionId);
          await maybeRetainSession(sessionId, { force: false, reason: "session.idle" });
        }
        return;
      }

      // Claude Code SessionEnd equivalent: flush any pending turns.
      if (evt.type === "session.deleted") {
        const sessionId = extractSessionIdFromDeleted(
          evt.properties as Record<string, unknown>
        );
        if (sessionId) {
          trackSession(sessionId);
          await maybeRetainSession(sessionId, { force: true, reason: "session.deleted" });
          state.activeSessions.delete(sessionId);
          state.turnRecall.delete(sessionId);
        }
      }
    } catch (e) {
      logger.error("Event hook error", e);
    }
  };

  const dispose = async (): Promise<void> => {
    if (!config.autoRetain) return;
    const sessionIds = [...state.activeSessions];
    logger.debug(`dispose: force-retain ${sessionIds.length} active session(s)`);
    for (const sessionId of sessionIds) {
      await maybeRetainSession(sessionId, { force: true, reason: "dispose" });
    }
  };

  const compacting = async (input: CompactingInput, output: CompactingOutput): Promise<void> => {
    try {
      trackSession(input.sessionID);
      const retainMessages = await getSessionMessages(input.sessionID, config.retainToolCalls);
      if (retainMessages.length && config.autoRetain) {
        try {
          await retainSession(input.sessionID, retainMessages);
          state.lastRetainedTurn.delete(input.sessionID);
          logger.debug("Pre-compaction retain completed");
        } catch (e) {
          logger.error("Pre-compaction retain failed", e);
        }
      }

      const recallMessages = await getSessionMessages(input.sessionID, false);
      if (recallMessages.length) {
        const lastUserMsg = lastUserMessage(recallMessages);
        if (lastUserMsg) {
          const query = composeRecallQuery(
            lastUserMsg.content,
            recallMessages,
            config.recallContextTurns
          );
          const truncated = truncateRecallQuery(
            query,
            lastUserMsg.content,
            config.recallMaxQueryChars
          );
          const { context } = await recallForContext(truncated);
          if (context) {
            output.context.push(context);
          }
        }
      }
    } catch (e) {
      logger.error("Compaction hook error", e);
    }
  };

  /**
   * Shared per-turn recall: returns context string (or null) and updates turn cache.
   *
   * Claude Code alignment (recall.py):
   *   - Default recallContextTurns=1 → query is latest user prompt only
   *   - Does NOT re-fetch full session for every recall
   *   - Multi-turn prior context only when turns > 1 (from provided messages /
   *     transcript), not a full session.messages dump
   *
   * OpenCode synthetic-user path passes transform messages (already in hand).
   * System mode falls back to getSessionMessages (no transform payload).
   */
  async function ensureTurnRecall(
    sessionId: string,
    providedMessages?: readonly Message[]
  ): Promise<string | null> {
    trackSession(sessionId);

    const messages = providedMessages
      ? [...providedMessages]
      : await getSessionMessages(sessionId, false);

    if (providedMessages) {
      logger.debug(
        `ensureTurnRecall: using ${messages.length} transform message(s), no session fetch`
      );
    }

    const lastUser = lastUserMessage(messages);
    if (!lastUser) {
      logger.debug(`ensureTurnRecall: no user message yet for ${sessionId}`);
      return null;
    }

    const prompt = lastUser.content.trim();
    if (prompt.length < config.minRecallPromptChars) {
      logger.debug(
        `ensureTurnRecall: prompt too short (${prompt.length} < ${config.minRecallPromptChars}), skip`
      );
      return null;
    }

    const userTurns = countUserTurns(messages);
    const cached = state.turnRecall.get(sessionId);

    if (cached && cached.userTurnCount === userTurns) {
      logger.debug(`ensureTurnRecall: cache hit session ${sessionId} turn ${userTurns}`);
      return cached.context;
    }

    await ensureBankMission(hindsightClient, bankId, config, state.missionsSet, logger);

    // Claude: turns<=1 → query = prompt; turns>1 → compose from recent history.
    const query = composeRecallQuery(prompt, messages, config.recallContextTurns);
    const truncated = truncateRecallQuery(query, prompt, config.recallMaxQueryChars);
    logger.debug(`ensureTurnRecall: recalling turn ${userTurns}, queryLen=${truncated.length}`);

    const { context, ok } = await recallForContext(truncated);
    if (ok) {
      state.turnRecall.set(sessionId, { userTurnCount: userTurns, context });
      capMapSize(state.turnRecall, 1000);
    }
    return context;
  }

  const systemTransform = async (
    input: SystemTransformInput,
    output: SystemTransformOutput
  ): Promise<void> => {
    try {
      if (!config.autoRecall) return;
      if (config.recallInjectMode !== "system") return;
      const sessionId = input.sessionID;
      if (!sessionId) return;

      // System mode has no transform messages — fetch text-only history (legacy path).
      const context = await ensureTurnRecall(sessionId);
      if (context) {
        applyContextToSystem(output, context);
        logger.debug(`Injected per-turn recall into system for session ${sessionId}`);
      }
    } catch (e) {
      logger.error("System transform hook error", e);
    }
  };

  const messagesTransform = async (
    _input: Record<string, never>,
    output: MessagesTransformOutput
  ): Promise<void> => {
    try {
      if (!config.autoRecall) return;
      if (config.recallInjectMode !== "synthetic-user") return;

      const sessionId = sessionIdFromMessages(output);
      if (!sessionId) {
        logger.debug("messagesTransform: no sessionID on messages, skip");
        return;
      }

      // Claude-like: use messages already in the prompt pipeline — no full session API.
      const context = await ensureTurnRecall(sessionId, messagesFromTransformOutput(output));
      if (!context) return;

      const ok = applyContextToLatestUserMessage(output, context);
      if (ok) {
        logger.debug(
          `Injected per-turn recall as synthetic user part for session ${sessionId}`
        );
      } else {
        logger.debug(`messagesTransform: no user message to attach synthetic part`);
      }
    } catch (e) {
      logger.error("Messages transform hook error", e);
    }
  };

  return {
    event,
    dispose,
    "experimental.session.compacting": compacting,
    "experimental.chat.system.transform": systemTransform,
    "experimental.chat.messages.transform": messagesTransform,
  };
}
