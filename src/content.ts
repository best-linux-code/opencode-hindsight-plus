/**
 * Content processing utilities.
 *
 * Port of the Claude Code plugin's content.py:
 *   - Memory tag stripping (anti-feedback-loop)
 *   - Recall query composition and truncation
 *   - Memory formatting for context injection
 *   - Retention transcript formatting
 */

/** Strip <hindsight_memories> and <relevant_memories> blocks to prevent retain feedback loops. */
export function stripMemoryTags(content: string): string {
  content = content.replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, "");
  content = content.replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/g, "");
  return content;
}

/**
 * Fold a fresh `<hindsight_memories>` block into a system section.
 * Replaces any previous block so per-turn recall does not stack forever.
 */
export function injectHindsightMemories(systemSection: string, context: string): string {
  const base = stripMemoryTags(systemSection)
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return base ? `${base}\n\n${context}` : context;
}

export interface RecallResult {
  text: string;
  type?: string | null;
  mentioned_at?: string | null;
}

/** Format recall results into human-readable text for context injection. */
export function formatMemories(results: RecallResult[]): string {
  if (!results.length) return "";
  return results
    .map((r) => {
      const typeStr = r.type ? ` [${r.type}]` : "";
      const dateStr = r.mentioned_at ? ` (${r.mentioned_at})` : "";
      return `- ${r.text}${typeStr}${dateStr}`;
    })
    .join("\n\n");
}

/** Format current UTC time for recall context. */
export function formatCurrentTime(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}

export interface Message {
  role: string;
  content: string;
}

/** Minimal OpenCode tool-part shape used when retainToolCalls is enabled. */
export interface ToolPartLike {
  type: string;
  tool?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    title?: string;
  };
}

const TOOL_INPUT_MAX = 500;
const TOOL_OUTPUT_MAX = 1000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** True for hindsight operational tools — skip to avoid retain feedback loops. */
export function isHindsightOperationalTool(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith("hindsight_") ||
    lower.includes("hindsight_retain") ||
    lower.includes("hindsight_recall") ||
    lower.includes("hindsight_reflect") ||
    /(?:^|__)(?:agent_knowledge_|knowledge_)/.test(lower)
  );
}

/**
 * Format an OpenCode tool part for retention transcripts.
 * Returns null when the part should be skipped.
 */
export function formatToolPartForRetain(part: ToolPartLike): string | null {
  if (part.type !== "tool") return null;
  const name = (part.tool || "unknown").trim();
  if (!name || isHindsightOperationalTool(name)) return null;

  const state = part.state;
  const input = state?.input ?? {};
  let inputJson: string;
  try {
    inputJson = JSON.stringify(input);
  } catch {
    inputJson = String(input);
  }
  inputJson = truncate(inputJson, TOOL_INPUT_MAX);

  const lines = [`[tool_call: ${name}]`, `input: ${inputJson}`];
  if (state?.title) lines.push(`title: ${state.title}`);

  if (state?.status === "completed" && typeof state.output === "string" && state.output) {
    lines.push(`output: ${truncate(state.output, TOOL_OUTPUT_MAX)}`);
  } else if (state?.status === "error" && state.error) {
    lines.push(`error: ${truncate(state.error, TOOL_OUTPUT_MAX)}`);
  } else if (state?.status) {
    lines.push(`status: ${state.status}`);
  }

  lines.push("[tool_call:end]");
  return lines.join("\n");
}

/**
 * Build message content from OpenCode parts (text + optional tool parts).
 */
export function buildMessageContent(
  parts: ReadonlyArray<{ type: string; text?: string } & Partial<ToolPartLike>>,
  includeToolCalls: boolean
): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      chunks.push(part.text);
      continue;
    }
    if (includeToolCalls && part.type === "tool") {
      const formatted = formatToolPartForRetain(part);
      if (formatted) chunks.push(formatted);
    }
  }
  return chunks.join("\n\n");
}

/**
 * Compose a multi-turn recall query from conversation history.
 *
 * When recallContextTurns > 1, includes prior context above the latest query.
 */
export function composeRecallQuery(
  latestQuery: string,
  messages: Message[],
  recallContextTurns: number
): string {
  const latest = latestQuery.trim();
  if (recallContextTurns <= 1 || !messages.length) return latest;

  const contextual = sliceLastTurnsByUserBoundary(messages, recallContextTurns);
  const contextLines: string[] = [];

  for (const msg of contextual) {
    const content = stripMemoryTags(msg.content).trim();
    if (!content) continue;
    if (msg.role === "user" && content === latest) continue;
    contextLines.push(`${msg.role}: ${content}`);
  }

  if (!contextLines.length) return latest;

  return ["Prior context:", contextLines.join("\n"), latest].join("\n\n");
}

/**
 * Truncate a composed recall query to maxChars.
 * Preserves the latest user message, drops oldest context lines first.
 */
export function truncateRecallQuery(query: string, latestQuery: string, maxChars: number): string {
  if (maxChars <= 0 || query.length <= maxChars) return query;

  const latest = latestQuery.trim();
  const latestOnly = latest.length > maxChars ? latest.slice(0, maxChars) : latest;

  if (!query.includes("Prior context:")) return latestOnly;

  const contextMarker = "Prior context:\n\n";
  const markerIndex = query.indexOf(contextMarker);
  if (markerIndex === -1) return latestOnly;

  const suffix = "\n\n" + latest;
  const suffixIndex = query.lastIndexOf(suffix);
  if (suffixIndex === -1) return latestOnly;
  if (suffix.length >= maxChars) return latestOnly;

  const contextBody = query.slice(markerIndex + contextMarker.length, suffixIndex);
  const contextLines = contextBody.split("\n").filter(Boolean);

  const kept: string[] = [];
  for (let i = contextLines.length - 1; i >= 0; i--) {
    kept.unshift(contextLines[i]);
    const candidate = `${contextMarker}${kept.join("\n")}${suffix}`;
    if (candidate.length > maxChars) {
      kept.shift();
      break;
    }
  }

  if (kept.length) return `${contextMarker}${kept.join("\n")}${suffix}`;
  return latestOnly;
}

/** Slice messages to the last N turns, where a turn starts at a user message. */
export function sliceLastTurnsByUserBoundary(messages: Message[], turns: number): Message[] {
  if (!messages.length || turns <= 0) return [];

  let userTurnsSeen = 0;
  let startIndex = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen >= turns) {
        startIndex = i;
        break;
      }
    }
  }

  return startIndex === -1 ? [...messages] : messages.slice(startIndex);
}

export interface RetainTemplateVars {
  session_id: string;
  bank_id: string;
  timestamp: string;
  user_id: string;
}

export interface ResolveRetainTemplatesInput {
  sessionId: string;
  bankId: string;
  messageCount?: number;
  userId?: string;
  now?: Date;
}

/** Build template vars for retain tags/metadata (Claude Code retain.py). */
export function buildRetainTemplateVars(input: ResolveRetainTemplatesInput): RetainTemplateVars {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    session_id: input.sessionId,
    bank_id: input.bankId,
    timestamp,
    user_id: input.userId ?? process.env.HINDSIGHT_USER_ID ?? "",
  };
}

export function applyTemplateString(value: string, vars: RetainTemplateVars): string {
  let out = value;
  for (const [key, val] of Object.entries(vars) as Array<[keyof RetainTemplateVars, string]>) {
    out = out.split(`{${key}}`).join(val);
  }
  return out;
}

/**
 * Resolve retainTags with template vars.
 * Drops empty tags and tags whose value after `:` is empty (e.g. `user:` when user_id unset).
 */
export function resolveRetainTags(
  rawTags: readonly string[],
  vars: RetainTemplateVars
): string[] | undefined {
  if (!rawTags.length) return undefined;
  const tags: string[] = [];
  for (const original of rawTags) {
    const resolved = applyTemplateString(original, vars).trim();
    if (!resolved) continue;
    const colon = resolved.indexOf(":");
    if (colon !== -1 && resolved.slice(colon + 1) === "") continue;
    tags.push(resolved);
  }
  return tags.length ? tags : undefined;
}

/** Resolve retainMetadata templates and merge session defaults. */
export function resolveRetainMetadata(
  rawMetadata: Record<string, string>,
  vars: RetainTemplateVars,
  messageCount?: number
): Record<string, string> {
  const metadata: Record<string, string> = {
    retained_at: vars.timestamp,
    session_id: vars.session_id,
  };
  if (messageCount !== undefined) {
    metadata.message_count = String(messageCount);
  }
  for (const [key, value] of Object.entries(rawMetadata)) {
    metadata[key] = applyTemplateString(String(value), vars);
  }
  return metadata;
}

/**
 * Format messages into a retention transcript.
 *
 * Uses [role: ...]...[role:end] markers for structured retention.
 */
export function prepareRetentionTranscript(
  messages: Message[],
  retainFullWindow: boolean = false
): { transcript: string | null; messageCount: number } {
  if (!messages.length) return { transcript: null, messageCount: 0 };

  let targetMessages: Message[];
  if (retainFullWindow) {
    targetMessages = messages;
  } else {
    // Default: retain only the last turn
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return { transcript: null, messageCount: 0 };
    targetMessages = messages.slice(lastUserIdx);
  }

  const parts: string[] = [];
  for (const msg of targetMessages) {
    const content = stripMemoryTags(msg.content).trim();
    if (!content) continue;
    parts.push(`[role: ${msg.role}]\n${content}\n[${msg.role}:end]`);
  }

  if (!parts.length) return { transcript: null, messageCount: 0 };

  const transcript = parts.join("\n\n");
  if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };

  return { transcript, messageCount: parts.length };
}
