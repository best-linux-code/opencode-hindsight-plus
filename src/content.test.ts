import { describe, it, expect } from "vitest";
import {
  stripMemoryTags,
  injectHindsightMemories,
  formatMemories,
  formatCurrentTime,
  composeRecallQuery,
  truncateRecallQuery,
  sliceLastTurnsByUserBoundary,
  prepareRetentionTranscript,
  formatToolPartForRetain,
  buildMessageContent,
  isHindsightOperationalTool,
  buildRetainTemplateVars,
  resolveRetainTags,
  resolveRetainMetadata,
  applyTemplateString,
  sanitizeForRetain,
} from "./content.js";

describe("sanitizeForRetain", () => {
  it("strips NUL and other C0 controls but keeps newlines", () => {
    expect(sanitizeForRetain("a\u0000b\nc\td")).toBe("ab\nc\td");
  });

  it("strips NUL from retention transcript", () => {
    const { transcript } = prepareRetentionTranscript(
      [{ role: "user", content: "hello\u0000 world enough" }],
      true
    );
    expect(transcript).toBeTruthy();
    expect(transcript).not.toContain("\u0000");
    expect(transcript).toContain("hello world enough");
  });
});

describe("stripMemoryTags", () => {
  it("removes <hindsight_memories> blocks", () => {
    const input = "before <hindsight_memories>secret</hindsight_memories> after";
    expect(stripMemoryTags(input)).toBe("before  after");
  });

  it("removes <relevant_memories> blocks", () => {
    const input = "before <relevant_memories>\nmultiline\n</relevant_memories> after";
    expect(stripMemoryTags(input)).toBe("before  after");
  });

  it("removes multiple blocks", () => {
    const input =
      "<hindsight_memories>a</hindsight_memories> middle <relevant_memories>b</relevant_memories>";
    expect(stripMemoryTags(input)).toBe(" middle ");
  });

  it("returns unchanged if no tags", () => {
    expect(stripMemoryTags("hello world")).toBe("hello world");
  });
});

describe("injectHindsightMemories", () => {
  it("appends a block to an empty system section", () => {
    const block = "<hindsight_memories>\nA\n</hindsight_memories>";
    expect(injectHindsightMemories("", block)).toBe(block);
  });

  it("replaces an existing block instead of stacking", () => {
    const oldBlock = "<hindsight_memories>\nold\n</hindsight_memories>";
    const newBlock = "<hindsight_memories>\nnew\n</hindsight_memories>";
    const system = `You are helpful.\n\n${oldBlock}`;
    const result = injectHindsightMemories(system, newBlock);
    expect(result).toContain("You are helpful.");
    expect(result).toContain("new");
    expect(result).not.toContain("old");
    expect((result.match(/<hindsight_memories>/g) || []).length).toBe(1);
  });
});

describe("retain tag/metadata templates", () => {
  const vars = buildRetainTemplateVars({
    sessionId: "sess-abc",
    bankId: "my-bank",
    userId: "alice",
    now: new Date("2026-07-19T12:00:00.000Z"),
  });

  it("resolves {session_id} {bank_id} {timestamp} {user_id}", () => {
    expect(applyTemplateString("session:{session_id}", vars)).toBe("session:sess-abc");
    expect(applyTemplateString("{bank_id}", vars)).toBe("my-bank");
    expect(applyTemplateString("{timestamp}", vars)).toBe("2026-07-19T12:00:00Z");
    expect(applyTemplateString("user:{user_id}", vars)).toBe("user:alice");
  });

  it("drops empty namespace tags like user: when user_id unset", () => {
    const emptyUser = buildRetainTemplateVars({
      sessionId: "s1",
      bankId: "b1",
      userId: "",
      now: new Date("2026-07-19T12:00:00.000Z"),
    });
    const tags = resolveRetainTags(["{session_id}", "user:{user_id}", "shared"], emptyUser);
    expect(tags).toEqual(["s1", "shared"]);
  });

  it("merges default metadata with templated user metadata", () => {
    const meta = resolveRetainMetadata(
      { project: "{bank_id}", who: "user:{user_id}" },
      vars,
      4
    );
    expect(meta.session_id).toBe("sess-abc");
    expect(meta.retained_at).toBe("2026-07-19T12:00:00Z");
    expect(meta.message_count).toBe("4");
    expect(meta.project).toBe("my-bank");
    expect(meta.who).toBe("user:alice");
  });
});

describe("formatToolPartForRetain / buildMessageContent", () => {
  it("formats completed tool calls", () => {
    const formatted = formatToolPartForRetain({
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "pwd" },
        output: "/tmp\n",
        title: "pwd",
      },
    });
    expect(formatted).toContain("[tool_call: bash]");
    expect(formatted).toContain("pwd");
    expect(formatted).toContain("/tmp");
    expect(formatted).toContain("[tool_call:end]");
  });

  it("skips hindsight operational tools", () => {
    expect(isHindsightOperationalTool("hindsight_recall")).toBe(true);
    expect(
      formatToolPartForRetain({
        type: "tool",
        tool: "hindsight_recall",
        state: { status: "completed", input: { query: "x" }, output: "y" },
      })
    ).toBeNull();
  });

  it("includes tools only when includeToolCalls is true", () => {
    const parts = [
      { type: "text", text: "hello" },
      {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { path: "a.ts" }, output: "code" },
      },
    ];
    expect(buildMessageContent(parts, false)).toBe("hello");
    expect(buildMessageContent(parts, true)).toContain("[tool_call: read]");
  });
});

describe("formatMemories", () => {
  it("formats recall results with type and date", () => {
    const results = [
      { text: "User likes Python", type: "world", mentioned_at: "2025-01-01" },
      { text: "Met at conference", type: "experience", mentioned_at: "2025-03-15" },
    ];
    const formatted = formatMemories(results);
    expect(formatted).toContain("- User likes Python [world] (2025-01-01)");
    expect(formatted).toContain("- Met at conference [experience] (2025-03-15)");
  });

  it("handles missing type and date", () => {
    const results = [{ text: "Some fact" }];
    expect(formatMemories(results)).toBe("- Some fact");
  });

  it("returns empty string for empty array", () => {
    expect(formatMemories([])).toBe("");
  });

  it("separates entries with double newlines", () => {
    const results = [{ text: "A" }, { text: "B" }];
    expect(formatMemories(results)).toBe("- A\n\n- B");
  });
});

describe("formatCurrentTime", () => {
  it("returns UTC time in YYYY-MM-DD HH:MM format", () => {
    const time = formatCurrentTime();
    expect(time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("composeRecallQuery", () => {
  const messages = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
    { role: "user", content: "What is my name?" },
  ];

  it("returns latest query when contextTurns <= 1", () => {
    expect(composeRecallQuery("What is my name?", messages, 1)).toBe("What is my name?");
  });

  it("returns latest query when messages empty", () => {
    expect(composeRecallQuery("query", [], 3)).toBe("query");
  });

  it("includes prior context when contextTurns > 1", () => {
    const result = composeRecallQuery("What is my name?", messages, 3);
    expect(result).toContain("Prior context:");
    expect(result).toContain("user: Hello");
    expect(result).toContain("assistant: Hi there");
    expect(result).toContain("What is my name?");
  });

  it("does not duplicate latest query in context", () => {
    const result = composeRecallQuery("What is my name?", messages, 3);
    // "What is my name?" should appear once at the end, not also as "user: What is my name?"
    const matches = result.match(/What is my name\?/g);
    expect(matches?.length).toBe(1);
  });
});

describe("truncateRecallQuery", () => {
  it("returns query unchanged if within limit", () => {
    expect(truncateRecallQuery("short", "short", 100)).toBe("short");
  });

  it("truncates to latest when no prior context", () => {
    const latest = "my query";
    expect(truncateRecallQuery(latest, latest, 5)).toBe("my qu");
  });

  it("drops oldest context lines first", () => {
    const query = "Prior context:\n\nuser: old\nassistant: older\nuser: recent\n\nlatest";
    const result = truncateRecallQuery(query, "latest", 50);
    expect(result).toContain("latest");
    // Should have dropped some old context
    expect(result.length).toBeLessThanOrEqual(50);
  });
});

describe("sliceLastTurnsByUserBoundary", () => {
  const messages = [
    { role: "user", content: "A" },
    { role: "assistant", content: "B" },
    { role: "user", content: "C" },
    { role: "assistant", content: "D" },
    { role: "user", content: "E" },
  ];

  it("returns last N turns", () => {
    const result = sliceLastTurnsByUserBoundary(messages, 2);
    expect(result.length).toBe(3); // user:C, assistant:D, user:E
    expect(result[0].content).toBe("C");
  });

  it("returns all messages if turns > available", () => {
    const result = sliceLastTurnsByUserBoundary(messages, 10);
    expect(result.length).toBe(5);
  });

  it("returns empty for zero turns", () => {
    expect(sliceLastTurnsByUserBoundary(messages, 0)).toEqual([]);
  });

  it("returns empty for empty messages", () => {
    expect(sliceLastTurnsByUserBoundary([], 2)).toEqual([]);
  });
});

describe("prepareRetentionTranscript", () => {
  const messages = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
    { role: "user", content: "How are you?" },
    { role: "assistant", content: "I am doing well" },
  ];

  it("retains last turn by default", () => {
    const { transcript, messageCount } = prepareRetentionTranscript(messages);
    expect(messageCount).toBe(2);
    expect(transcript).toContain("[role: user]");
    expect(transcript).toContain("How are you?");
    expect(transcript).toContain("I am doing well");
    expect(transcript).not.toContain("Hello");
  });

  it("retains full window when requested", () => {
    const { transcript, messageCount } = prepareRetentionTranscript(messages, true);
    expect(messageCount).toBe(4);
    expect(transcript).toContain("Hello");
    expect(transcript).toContain("How are you?");
  });

  it("returns null for empty messages", () => {
    const { transcript, messageCount } = prepareRetentionTranscript([]);
    expect(transcript).toBeNull();
    expect(messageCount).toBe(0);
  });

  it("strips memory tags from content", () => {
    const msgs = [
      { role: "user", content: "Query <hindsight_memories>data</hindsight_memories>" },
      { role: "assistant", content: "Response" },
    ];
    const { transcript } = prepareRetentionTranscript(msgs);
    expect(transcript).not.toContain("hindsight_memories");
    expect(transcript).toContain("Query");
  });

  it("skips messages with empty content after stripping", () => {
    const msgs = [
      { role: "user", content: "<hindsight_memories>only tags</hindsight_memories>" },
      { role: "assistant", content: "Response" },
    ];
    const { transcript, messageCount } = prepareRetentionTranscript(msgs, true);
    expect(messageCount).toBe(1); // only assistant message
    expect(transcript).toContain("Response");
  });
});
