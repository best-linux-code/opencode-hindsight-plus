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
  state?: ToolPartLike["state"];
};

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

    const { transcript } = prepareRetentionTranscript(targetMessages, true);
    if (!transcript) return;

    await ensureBankMission(hindsightClient, bankId, config, state.missionsSet, logger);
    await hindsightClient.retain(bankId, transcript, {
      documentId,
      context: config.retainContext,
      tags: config.retainTags.length ? config.retainTags : undefined,
      metadata: Object.keys(config.retainMetadata).length
        ? { ...config.retainMetadata, session_id: sessionId }
        : { session_id: sessionId },
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

  const systemTransform = async (
    input: SystemTransformInput,
    output: SystemTransformOutput
  ): Promise<void> => {
    try {
      if (!config.autoRecall) return;
      const sessionId = input.sessionID;
      if (!sessionId) return;

      trackSession(sessionId);

      // Recall queries stay text-only (no tool dumps).
      const messages = await getSessionMessages(sessionId, false);
      const lastUser = lastUserMessage(messages);
      if (!lastUser) {
        logger.debug(`systemTransform: no user message yet for ${sessionId}`);
        return;
      }

      const prompt = lastUser.content.trim();
      if (prompt.length < config.minRecallPromptChars) {
        logger.debug(
          `systemTransform: prompt too short (${prompt.length} < ${config.minRecallPromptChars}), skip`
        );
        return;
      }

      const userTurns = countUserTurns(messages);
      const cached = state.turnRecall.get(sessionId);

      if (cached && cached.userTurnCount === userTurns) {
        if (cached.context) {
          applyContextToSystem(output, cached.context);
          logger.debug(`Re-injected cached recall for session ${sessionId} turn ${userTurns}`);
        }
        return;
      }

      await ensureBankMission(hindsightClient, bankId, config, state.missionsSet, logger);

      const query = composeRecallQuery(prompt, messages, config.recallContextTurns);
      const truncated = truncateRecallQuery(query, prompt, config.recallMaxQueryChars);
      logger.debug(
        `systemTransform: recalling for turn ${userTurns}, queryLen=${truncated.length}`
      );

      const { context, ok } = await recallForContext(truncated);

      if (ok) {
        state.turnRecall.set(sessionId, { userTurnCount: userTurns, context });
        capMapSize(state.turnRecall, 1000);
      }

      if (context) {
        applyContextToSystem(output, context);
        logger.debug(`Injected per-turn recall for session ${sessionId} turn ${userTurns}`);
      }
    } catch (e) {
      logger.error("System transform hook error", e);
    }
  };

  return {
    event,
    dispose,
    "experimental.session.compacting": compacting,
    "experimental.chat.system.transform": systemTransform,
  };
}
