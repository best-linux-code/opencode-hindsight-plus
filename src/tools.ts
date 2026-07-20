/**
 * Custom tool definitions for the Hindsight OpenCode plugin.
 *
 * Registers hindsight_retain, hindsight_recall, and hindsight_reflect
 * as tools the agent can call explicitly.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { tool } from "@opencode-ai/plugin/tool";
import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import type { HindsightClient } from "@vectorize-io/hindsight-client";
import type { HindsightConfig } from "./config.js";
import {
  formatMemories,
  formatCurrentTime,
  buildRetainTemplateVars,
  resolveRetainTags,
  resolveRetainMetadata,
  sanitizeForRetain,
} from "./content.js";
import { ensureBankMission } from "./bank.js";
import { createPageTools } from "./pages.js";
import { Logger } from "./logger.js";

export interface HindsightTools {
  hindsight_retain: ToolDefinition;
  hindsight_recall: ToolDefinition;
  hindsight_reflect: ToolDefinition;
  hindsight_bank_current: ToolDefinition;
  hindsight_ingest: ToolDefinition;
  hindsight_ingest_file: ToolDefinition;
  // Index signature so the object is assignable to OpenCode's Hooks.tool
  // (Record<string, ToolDefinition>) without losing the specific keys above.
  [key: string]: ToolDefinition;
}

function toDocumentId(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 200) || "document";
}

export function createTools(
  client: HindsightClient,
  bankId: string,
  config: HindsightConfig,
  missionsSet?: Set<string>,
  logger: Logger = new Logger({ silent: true })
): HindsightTools {
  const hindsight_retain = tool({
    description:
      "Store information in long-term memory. Use this to remember important facts, " +
      "user preferences, project context, decisions, and anything worth recalling in future sessions. " +
      "Be specific — include who, what, when, and why.",
    args: {
      content: tool.schema
        .string()
        .describe("The information to remember. Be specific and self-contained."),
      context: tool.schema
        .string()
        .optional()
        .describe("Optional context about where this information came from."),
    },
    async execute(args, ctx) {
      if (missionsSet) {
        await ensureBankMission(client, bankId, config, missionsSet, logger);
      }
      const sessionId =
        ctx && typeof ctx === "object" && typeof (ctx as { sessionID?: unknown }).sessionID === "string"
          ? (ctx as { sessionID: string }).sessionID
          : "";
      const vars = buildRetainTemplateVars({ sessionId, bankId });
      const tags = resolveRetainTags(config.retainTags, vars);
      const metadata = resolveRetainMetadata(config.retainMetadata, vars);
      await client.retain(bankId, args.content, {
        context: args.context || config.retainContext,
        tags,
        metadata,
      });
      return "Memory stored successfully.";
    },
  });

  const hindsight_recall = tool({
    description:
      "Search long-term memory for relevant information. Use this proactively before " +
      "answering questions about past conversations, user preferences, project history, " +
      "or any topic where prior context would help. When in doubt, recall first.",
    args: {
      query: tool.schema
        .string()
        .describe("Natural language search query. Be specific about what you need to know."),
    },
    async execute(args) {
      const recallOpts = {
        budget: config.recallBudget as "low" | "mid" | "high",
        maxTokens: config.recallMaxTokens,
        types: config.recallTypes,
        tags: config.recallTags.length ? config.recallTags : undefined,
        tagsMatch: config.recallTags.length ? config.recallTagsMatch : undefined,
      };
      const response = await client.recall(bankId, args.query, recallOpts);
      let results = response.results || [];
      for (const extraBank of config.recallAdditionalBanks) {
        if (!extraBank || extraBank === bankId) continue;
        try {
          const extra = await client.recall(extraBank, args.query, recallOpts);
          results = results.concat(extra.results || []);
        } catch {
          /* optional bank */
        }
      }
      if (!results.length) return "No relevant memories found.";

      const formatted = formatMemories(results);
      return `Found ${results.length} relevant memories (as of ${formatCurrentTime()} UTC):\n\n${formatted}`;
    },
  });

  const hindsight_reflect = tool({
    description:
      "Generate a thoughtful answer using long-term memory. Unlike recall (which returns " +
      "raw memories), reflect synthesizes memories into a coherent answer. Use for questions " +
      'like "What do you know about this user?" or "Summarize our project decisions."',
    args: {
      query: tool.schema.string().describe("The question to answer using long-term memory."),
      context: tool.schema
        .string()
        .optional()
        .describe("Optional additional context to guide the reflection."),
    },
    async execute(args) {
      if (missionsSet) {
        await ensureBankMission(client, bankId, config, missionsSet, logger);
      }
      const response = await client.reflect(bankId, args.query, {
        context: args.context,
        budget: config.recallBudget as "low" | "mid" | "high",
      });

      return response.text || "No relevant information found to reflect on.";
    },
  });

  const hindsight_bank_current = tool({
    description:
      "Get the current Hindsight memory bank ID this session is bound to " +
      "(Claude agent_knowledge_get_current_bank).",
    args: {},
    async execute() {
      return `Current memory bank: ${bankId}`;
    },
  });

  const hindsight_ingest = tool({
    description:
      "Upload text content into the memory bank as a named document " +
      "(Claude agent_knowledge_ingest). Pass full raw content — do not summarize first. " +
      "Re-ingesting the same title replaces the document.",
    args: {
      title: tool.schema.string().describe("Document title; becomes the document ID."),
      content: tool.schema.string().describe("Full raw text content to store."),
    },
    async execute(args) {
      if (missionsSet) {
        await ensureBankMission(client, bankId, config, missionsSet, logger);
      }
      const cleaned = sanitizeForRetain(args.content);
      if (!cleaned.trim()) return "Error: content is empty after sanitization.";
      const documentId = toDocumentId(args.title);
      await client.retain(bankId, cleaned, {
        documentId,
        context: config.retainContext,
      });
      return `Ingested document "${documentId}" into bank ${bankId}.`;
    },
  });

  const hindsight_ingest_file = tool({
    description:
      "Ingest a file from disk into the memory bank " +
      "(Claude agent_knowledge_ingest_file). Filename (without extension) becomes the document ID.",
    args: {
      file_path: tool.schema.string().describe("Absolute or relative path to a UTF-8 text file."),
    },
    async execute(args) {
      if (missionsSet) {
        await ensureBankMission(client, bankId, config, missionsSet, logger);
      }
      let raw: string;
      try {
        raw = readFileSync(args.file_path, "utf-8");
      } catch (e) {
        return `Error: cannot read file: ${e instanceof Error ? e.message : String(e)}`;
      }
      const cleaned = sanitizeForRetain(raw);
      if (!cleaned.trim()) return `Error: file is empty: ${args.file_path}`;
      const base = basename(args.file_path).replace(/\.[^.]+$/, "");
      const documentId = toDocumentId(base);
      await client.retain(bankId, cleaned, {
        documentId,
        context: config.retainContext,
      });
      return `Ingested file "${args.file_path}" as document "${documentId}" into bank ${bankId}.`;
    },
  });

  const base: HindsightTools = {
    hindsight_retain,
    hindsight_recall,
    hindsight_reflect,
    hindsight_bank_current,
    hindsight_ingest,
    hindsight_ingest_file,
  };

  if (!config.enableKnowledgePages) {
    return base;
  }

  return {
    ...base,
    ...createPageTools(client, bankId, config, missionsSet, logger),
  };
}
