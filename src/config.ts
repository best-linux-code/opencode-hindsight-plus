/**
 * Configuration management for the Hindsight OpenCode plugin.
 *
 * Loading order (later entries win):
 *   1. Built-in defaults
 *   2. User config file (~/.hindsight/opencode.json)
 *   3. Plugin options (from opencode.json plugin tuple)
 *   4. Environment variable overrides
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Default API URL used when no override is supplied via env, file, or plugin options. */
export const DEFAULT_HINDSIGHT_API_URL = "https://api.hindsight.vectorize.io";

export interface HindsightConfig {
  // Recall
  autoRecall: boolean;
  recallBudget: string;
  recallMaxTokens: number;
  recallTypes: string[];
  recallContextTurns: number;
  recallMaxQueryChars: number;
  /** Skip auto-recall when the latest user prompt is shorter than this (Claude Code: 5). */
  minRecallPromptChars: number;
  /**
   * Where to inject recalled memories:
   * - system: fold into system[0] (default; most provider-safe)
   * - synthetic-user: append synthetic text part on latest user message (Claude-like hidden context experiment)
   */
  recallInjectMode: "system" | "synthetic-user";
  recallPromptPreamble: string;
  recallTags: string[];
  recallTagsMatch: "any" | "all" | "any_strict" | "all_strict";

  // Retain
  autoRetain: boolean;
  retainMode: string;
  retainEveryNTurns: number;
  retainOverlapTurns: number;
  /** Include tool call/result parts in retained transcripts (coding-context quality). */
  retainToolCalls: boolean;
  retainContext: string;
  retainTags: string[];
  retainMetadata: Record<string, string>;

  // Connection
  hindsightApiUrl: string | null;
  hindsightApiToken: string | null;

  // Bank
  bankId: string | null;
  bankIdPrefix: string;
  dynamicBankId: boolean;
  dynamicBankGranularity: string[];
  bankMission: string;
  retainMission: string | null;
  agentName: string;

  // Misc
  /** Register knowledge page tools (Hindsight mental-models / Claude agent_knowledge pages). */
  enableKnowledgePages: boolean;
  debug: boolean;
}

const DEFAULTS: HindsightConfig = {
  // Recall — defaults aligned with Claude Code hindsight-memory plugin
  autoRecall: true,
  recallBudget: "mid",
  recallMaxTokens: 1024,
  // Observations are consolidated beliefs; reduces duplicate raw facts per turn.
  recallTypes: ["observation"],
  recallContextTurns: 1,
  recallMaxQueryChars: 800,
  minRecallPromptChars: 5,
  recallInjectMode: "system",
  recallTags: [],
  recallTagsMatch: "any",
  recallPromptPreamble:
    "Relevant memories from past conversations (prioritize recent when " +
    "conflicting). Only use memories that are directly useful to continue " +
    "this conversation; ignore the rest:",

  // Retain — defaults aligned with Claude Code (Stop every N turns)
  autoRetain: true,
  retainMode: "full-session",
  retainEveryNTurns: 10,
  retainOverlapTurns: 2,
  // Plus default true: coding agents benefit from tool trajectory memory.
  // Claude Code ships false; set false here to match Claude exactly.
  retainToolCalls: true,
  retainContext: "opencode",
  // Claude Code default shape; templates: {session_id} {bank_id} {timestamp} {user_id}
  retainTags: ["{session_id}"],
  retainMetadata: {},

  // Connection
  hindsightApiUrl: DEFAULT_HINDSIGHT_API_URL,
  hindsightApiToken: null,

  bankId: null,
  bankIdPrefix: "",
  dynamicBankId: true,
  dynamicBankGranularity: ["gitProject"],
  bankMission:
    "You are an OpenCode AI coding agent. Focus on technical discussions, decisions, " +
    "and context relevant to the user's projects.",
  retainMission:
    "Extract technical decisions, architectural choices, user preferences, project context, " +
    "and people/tool relationships. Ignore routine greetings and transient operational details.",
  agentName: "opencode",

  // Misc
  enableKnowledgePages: true,
  debug: false,
};

/** Env var → config key + type mapping */
const ENV_OVERRIDES: Record<string, [keyof HindsightConfig, "string" | "bool" | "int"]> = {
  HINDSIGHT_API_URL: ["hindsightApiUrl", "string"],
  HINDSIGHT_API_TOKEN: ["hindsightApiToken", "string"],
  HINDSIGHT_BANK_ID: ["bankId", "string"],
  HINDSIGHT_AGENT_NAME: ["agentName", "string"],
  HINDSIGHT_AUTO_RECALL: ["autoRecall", "bool"],
  HINDSIGHT_AUTO_RETAIN: ["autoRetain", "bool"],
  HINDSIGHT_RETAIN_MODE: ["retainMode", "string"],
  HINDSIGHT_RECALL_BUDGET: ["recallBudget", "string"],
  HINDSIGHT_RECALL_MAX_TOKENS: ["recallMaxTokens", "int"],
  HINDSIGHT_RECALL_MAX_QUERY_CHARS: ["recallMaxQueryChars", "int"],
  HINDSIGHT_RECALL_CONTEXT_TURNS: ["recallContextTurns", "int"],
  HINDSIGHT_MIN_RECALL_PROMPT_CHARS: ["minRecallPromptChars", "int"],
  HINDSIGHT_RECALL_INJECT_MODE: ["recallInjectMode", "string"],
  HINDSIGHT_DYNAMIC_BANK_ID: ["dynamicBankId", "bool"],
  HINDSIGHT_BANK_MISSION: ["bankMission", "string"],
  HINDSIGHT_BANK_ID_PREFIX: ["bankIdPrefix", "string"],
  HINDSIGHT_ENABLE_KNOWLEDGE_PAGES: ["enableKnowledgePages", "bool"],
  HINDSIGHT_RETAIN_EVERY_N_TURNS: ["retainEveryNTurns", "int"],
  HINDSIGHT_RETAIN_OVERLAP_TURNS: ["retainOverlapTurns", "int"],
  HINDSIGHT_RETAIN_TOOL_CALLS: ["retainToolCalls", "bool"],
  HINDSIGHT_RECALL_TAGS: ["recallTags", "string"],
  HINDSIGHT_RETAIN_TAGS: ["retainTags", "string"],
  HINDSIGHT_RECALL_TAGS_MATCH: ["recallTagsMatch", "string"],
  HINDSIGHT_RECALL_PROMPT_PREAMBLE: ["recallPromptPreamble", "string"],
  HINDSIGHT_RETAIN_CONTEXT: ["retainContext", "string"],
  // NOTE: `debug` is intentionally NOT an env override. It is a proper config
  // option set via opencode.json plugin options or ~/.hindsight/opencode.json,
  // because env vars are unreliable to set for OpenCode's plugin runtime
  // (notably on Windows).
};

function castEnv(value: string, typ: "string" | "bool" | "int"): string | boolean | number | null {
  if (typ === "bool") return ["true", "1", "yes"].includes(value.toLowerCase());
  if (typ === "int") {
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }
  return value;
}

function loadSettingsFile(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function loadConfig(pluginOptions?: Record<string, unknown>): HindsightConfig {
  // 1. Start with defaults
  const config: Record<string, unknown> = { ...DEFAULTS };

  // 2. User config file (~/.hindsight/opencode.json)
  const userConfigPath = join(homedir(), ".hindsight", "opencode.json");
  const fileConfig = loadSettingsFile(userConfigPath);
  for (const [key, value] of Object.entries(fileConfig)) {
    if (value !== null && value !== undefined) {
      config[key] = value;
    }
  }

  // 3. Plugin options (from opencode.json: ["@vectorize-io/opencode-hindsight", { ... }])
  if (pluginOptions) {
    for (const [key, value] of Object.entries(pluginOptions)) {
      if (value !== null && value !== undefined) {
        config[key] = value;
      }
    }
  }

  // 4. Environment variable overrides (highest priority)
  for (const [envName, [key, typ]] of Object.entries(ENV_OVERRIDES)) {
    const val = process.env[envName];
    if (val !== undefined) {
      const castVal = castEnv(val, typ);
      if (castVal !== null) {
        config[key] = castVal;
      }
    }
  }

  // Array env vars (comma-separated)
  const recallTagsEnv = process.env["HINDSIGHT_RECALL_TAGS"];
  if (recallTagsEnv !== undefined) {
    config["recallTags"] = recallTagsEnv
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  const recallTagsMatchEnv = process.env["HINDSIGHT_RECALL_TAGS_MATCH"];
  if (recallTagsMatchEnv !== undefined) {
    config["recallTagsMatch"] = recallTagsMatchEnv;
  }

  const retainTagsEnv = process.env["HINDSIGHT_RETAIN_TAGS"];
  if (retainTagsEnv !== undefined) {
    config["retainTags"] = retainTagsEnv
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  const result = config as unknown as HindsightConfig;

  // Validate enum-like fields to catch typos early
  const VALID_RETAIN_MODES = ["full-session", "last-turn"];
  if (!VALID_RETAIN_MODES.includes(result.retainMode)) {
    console.error(
      `[Hindsight] Unknown retainMode "${result.retainMode}" — ` +
        `valid: ${VALID_RETAIN_MODES.join(", ")}. Falling back to "full-session".`
    );
    result.retainMode = "full-session";
  }

  const VALID_TAGS_MATCH = ["any", "all", "any_strict", "all_strict"];
  if (!VALID_TAGS_MATCH.includes(result.recallTagsMatch)) {
    console.error(
      `[Hindsight] Unknown recallTagsMatch "${result.recallTagsMatch}" — ` +
        `valid: ${VALID_TAGS_MATCH.join(", ")}. Falling back to "any".`
    );
    result.recallTagsMatch = "any";
  }

  const VALID_BUDGETS = ["low", "mid", "high"];
  if (!VALID_BUDGETS.includes(result.recallBudget)) {
    console.error(
      `[Hindsight] Unknown recallBudget "${result.recallBudget}" — ` +
        `valid: ${VALID_BUDGETS.join(", ")}. Falling back to "mid".`
    );
    result.recallBudget = "mid";
  }

  const VALID_INJECT_MODES = ["system", "synthetic-user"];
  if (!VALID_INJECT_MODES.includes(result.recallInjectMode)) {
    console.error(
      `[Hindsight] Unknown recallInjectMode "${result.recallInjectMode}" — ` +
        `valid: ${VALID_INJECT_MODES.join(", ")}. Falling back to "system".`
    );
    result.recallInjectMode = "system";
  }

  return result;
}
