/**
 * Hook implementations for the Hindsight OpenCode plugin.
 *
 * Aligned with Claude Code hindsight-memory:
 *   - experimental.chat.system.transform → per-user-turn auto-recall
 *     (Claude Code: UserPromptSubmit + additionalContext)
 *   - event (session.idle) → auto-retain after the assistant finishes
 *     (Claude Code: Stop hook)
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
  type Message,
} from "./content.js";
import { ensureBankMission } from "./bank.js";

/** Cached recall for one user turn (reused across tool-loop system transforms). */
export interface TurnRecallCache {
  userTurnCount: number;
  /** Formatted context, or null when API succeeded with zero results. */
  context: string | null;
}

export interface PluginState {
  turnCount: number;
  missionsSet: Set<string>;
  /** Per-session last successful per-turn recall (Claude Code UserPromptSubmit). */
  turnRecall: Map<string, TurnRecallCache>;
  /** Track last retained turn count per session to avoid duplicates */
  lastRetainedTurn: Map<string, number>;
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

type OpencodeClient = {
  session: {
    messages: (params: { path: { id: string } }) => Promise<{
      data?: Array<{
        info: { role: string };
        parts: Array<{ type: string; text?: string }>;
      }>;
      error?: unknown;
      request?: unknown;
      response?: unknown;
    }>;
  };
};

export interface HindsightHooks {
  event: (input: EventInput) => Promise<void>;
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

  async function getSessionMessages(sessionId: string): Promise<Message[]> {
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
        const textParts = msg.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text!);
        if (textParts.length) {
          messages.push({ role, content: textParts.join("\n") });
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

  async function handleSessionIdle(sessionId: string): Promise<void> {
    logger.debug(`handleSessionIdle called for session ${sessionId}`);
    if (!config.autoRetain) return;

    const messages = await getSessionMessages(sessionId);
    if (!messages.length) return;

    const userTurns = countUserTurns(messages);
    const lastRetained = state.lastRetainedTurn.get(sessionId) || 0;
    logger.debug(
      `handleSessionIdle: userTurns=${userTurns}, lastRetained=${lastRetained}, retainEveryNTurns=${config.retainEveryNTurns}`
    );

    if (userTurns - lastRetained < config.retainEveryNTurns) return;

    try {
      await retainSession(sessionId, messages);
      state.lastRetainedTurn.set(sessionId, userTurns);
      logger.info(`Auto-retained ${messages.length} messages`, {
        session: sessionId,
        bank: bankId,
      });
    } catch (e) {
      logger.error("Auto-retain failed", e);
    }
  }

  const event = async (input: EventInput): Promise<void> => {
    try {
      const { event: evt } = input;
      logger.debug(`event hook fired: type=${evt.type}`);

      if (evt.type === "session.idle") {
        const sessionId = (evt.properties as { sessionID?: string }).sessionID;
        if (sessionId) {
          await handleSessionIdle(sessionId);
        }
      }
    } catch (e) {
      logger.error("Event hook error", e);
    }
  };

  const compacting = async (input: CompactingInput, output: CompactingOutput): Promise<void> => {
    try {
      const messages = await getSessionMessages(input.sessionID);
      if (messages.length && config.autoRetain) {
        try {
          await retainSession(input.sessionID, messages);
          state.lastRetainedTurn.delete(input.sessionID);
          logger.debug("Pre-compaction retain completed");
        } catch (e) {
          logger.error("Pre-compaction retain failed", e);
        }
      }

      if (messages.length) {
        const lastUserMsg = lastUserMessage(messages);
        if (lastUserMsg) {
          const query = composeRecallQuery(
            lastUserMsg.content,
            messages,
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
   * Per-user-turn auto-recall (Claude Code UserPromptSubmit).
   *
   * OpenCode may re-run system.transform on every model call inside a tool
   * loop. We call Hindsight only when the user-turn count advances; within the
   * same turn we re-inject the cached block without another API round-trip.
   */
  const systemTransform = async (
    input: SystemTransformInput,
    output: SystemTransformOutput
  ): Promise<void> => {
    try {
      if (!config.autoRecall) return;
      const sessionId = input.sessionID;
      if (!sessionId) return;

      const messages = await getSessionMessages(sessionId);
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

      // Same user turn → re-inject cache (tool loop / multi-step model calls).
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

      // Only cache after a successful API round-trip so transient failures retry.
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
    "experimental.session.compacting": compacting,
    "experimental.chat.system.transform": systemTransform,
  };
}
