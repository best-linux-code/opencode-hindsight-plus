/**
 * Knowledge pages tools — OpenCode wrappers around Hindsight mental-models.
 * Claude Code exposes these as agent_knowledge_* MCP tools.
 */

import { tool } from "@opencode-ai/plugin/tool";
import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import type { HindsightClient } from "@vectorize-io/hindsight-client";
import type { HindsightConfig } from "./config.js";
import { ensureBankMission } from "./bank.js";
import { Logger } from "./logger.js";

export interface PageTools {
  hindsight_page_list: ToolDefinition;
  hindsight_page_get: ToolDefinition;
  hindsight_page_create: ToolDefinition;
  hindsight_page_update: ToolDefinition;
  hindsight_page_delete: ToolDefinition;
  hindsight_page_refresh: ToolDefinition;
  [key: string]: ToolDefinition;
}

function asItems(response: unknown): Array<Record<string, unknown>> {
  if (!response || typeof response !== "object") return [];
  const items = (response as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
}

function formatPageSummary(page: Record<string, unknown>): string {
  const id = String(page.id ?? page.mental_model_id ?? "?");
  const name = String(page.name ?? "(unnamed)");
  const query = page.source_query ? String(page.source_query) : "";
  return query ? `- ${id}: ${name}\n  source_query: ${query}` : `- ${id}: ${name}`;
}

function formatPageDetail(page: Record<string, unknown>): string {
  const id = String(page.id ?? page.mental_model_id ?? "?");
  const name = String(page.name ?? "(unnamed)");
  const query = page.source_query != null ? String(page.source_query) : "";
  const content = page.content != null ? String(page.content) : "(no content yet)";
  const lines = [
    `id: ${id}`,
    `name: ${name}`,
    query ? `source_query: ${query}` : null,
    "",
    content,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

export function createPageTools(
  client: HindsightClient,
  bankId: string,
  config: HindsightConfig,
  missionsSet?: Set<string>,
  logger: Logger = new Logger({ silent: true })
): PageTools {
  const ensureMission = async () => {
    if (missionsSet) {
      await ensureBankMission(client, bankId, config, missionsSet, logger);
    }
  };

  const hindsight_page_list = tool({
    description:
      "List knowledge pages (IDs and names) in the current Hindsight bank. " +
      "Pages are synthesized long-lived docs rebuilt from memory via a source_query. " +
      "Use hindsight_page_get to read full content.",
    args: {},
    async execute() {
      await ensureMission();
      const response = await client.listMentalModels(bankId);
      const items = asItems(response);
      if (!items.length) return "No knowledge pages in this bank.";
      return `Knowledge pages (${items.length}) in bank "${bankId}":\n\n${items
        .map(formatPageSummary)
        .join("\n")}`;
    },
  });

  const hindsight_page_get = tool({
    description:
      "Read a knowledge page by id. Returns full synthesized content when available.",
    args: {
      page_id: tool.schema.string().describe("Knowledge page / mental-model id."),
    },
    async execute(args) {
      await ensureMission();
      const page = await client.getMentalModel(bankId, args.page_id);
      if (!page || typeof page !== "object") return `Page not found: ${args.page_id}`;
      return formatPageDetail(page as Record<string, unknown>);
    },
  });

  const hindsight_page_create = tool({
    description:
      "Create a knowledge page. source_query is re-asked after consolidations to rebuild " +
      "the page from observations (e.g. 'What are the key architecture decisions?').",
    args: {
      name: tool.schema.string().describe("Human-readable page title."),
      source_query: tool.schema
        .string()
        .describe("Question used to synthesize/refresh page content from memories."),
      page_id: tool.schema
        .string()
        .optional()
        .describe("Optional stable page id. Server generates one if omitted."),
    },
    async execute(args) {
      await ensureMission();
      const created = await client.createMentalModel(bankId, args.name, args.source_query, {
        id: args.page_id,
        trigger: { refreshAfterConsolidation: true },
      });
      const id =
        created && typeof created === "object"
          ? String(
              (created as { mental_model_id?: string; id?: string }).mental_model_id ??
                (created as { id?: string }).id ??
                args.page_id ??
                "?"
            )
          : String(args.page_id ?? "?");
      return `Knowledge page created.\nid: ${id}\nname: ${args.name}\nsource_query: ${args.source_query}\nContent generates in the background; use hindsight_page_get or hindsight_page_refresh shortly.`;
    },
  });

  const hindsight_page_update = tool({
    description: "Update a knowledge page name and/or source_query.",
    args: {
      page_id: tool.schema.string().describe("Knowledge page id."),
      name: tool.schema.string().optional().describe("New title."),
      source_query: tool.schema.string().optional().describe("New synthesis question."),
    },
    async execute(args) {
      if (!args.name && !args.source_query) {
        return "Nothing to update: provide name and/or source_query.";
      }
      await ensureMission();
      await client.updateMentalModel(bankId, args.page_id, {
        name: args.name,
        sourceQuery: args.source_query,
      });
      return `Knowledge page updated: ${args.page_id}`;
    },
  });

  const hindsight_page_delete = tool({
    description: "Permanently delete a knowledge page.",
    args: {
      page_id: tool.schema.string().describe("Knowledge page id to delete."),
    },
    async execute(args) {
      await ensureMission();
      await client.deleteMentalModel(bankId, args.page_id);
      return `Knowledge page deleted: ${args.page_id}`;
    },
  });

  const hindsight_page_refresh = tool({
    description:
      "Refresh a knowledge page now by re-running its source_query against current memories.",
    args: {
      page_id: tool.schema.string().describe("Knowledge page id to refresh."),
    },
    async execute(args) {
      await ensureMission();
      const refreshed = await client.refreshMentalModel(bankId, args.page_id);
      if (refreshed && typeof refreshed === "object" && "content" in refreshed) {
        return formatPageDetail(refreshed as Record<string, unknown>);
      }
      return `Refresh started for page ${args.page_id}. Use hindsight_page_get to read content when ready.`;
    },
  });

  return {
    hindsight_page_list,
    hindsight_page_get,
    hindsight_page_create,
    hindsight_page_update,
    hindsight_page_delete,
    hindsight_page_refresh,
  };
}
