import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHooks, type PluginState } from "./hooks.js";
import { makeConfig } from "./test-helpers.js";

function makeSystemConfig(overrides: Parameters<typeof makeConfig>[0] = {}) {
  return makeConfig({ recallInjectMode: "system", ...overrides });
}

function makeState(): PluginState {
  return {
    turnCount: 0,
    missionsSet: new Set(),
    turnRecall: new Map(),
    lastRetainedTurn: new Map(),
    activeSessions: new Set(),
  };
}

function makeClient() {
  return {
    retain: vi.fn().mockResolvedValue({}),
    recall: vi.fn().mockResolvedValue({ results: [] }),
    reflect: vi.fn().mockResolvedValue({ text: "" }),
    createBank: vi.fn().mockResolvedValue({}),
  } as any;
}

function makeOpencodeClient(
  messages: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }> = []
) {
  return {
    session: {
      messages: vi.fn().mockResolvedValue({ data: messages }),
    },
  };
}

function userMsg(text: string) {
  return { info: { role: "user" }, parts: [{ type: "text", text }] };
}

function assistantMsg(text: string) {
  return { info: { role: "assistant" }, parts: [{ type: "text", text }] };
}

describe("createHooks", () => {
  it("returns all required hooks", () => {
    const hooks = createHooks(
      makeClient(),
      "bank",
      makeConfig(),
      makeState(),
      makeOpencodeClient()
    );
    expect(hooks.event).toBeDefined();
    expect(hooks["experimental.session.compacting"]).toBeDefined();
    expect(hooks["experimental.chat.system.transform"]).toBeDefined();
    expect(hooks["experimental.chat.messages.transform"]).toBeDefined();
  });
});

describe("event hook — session.idle", () => {
  it("auto-retains conversation on session.idle with document_id", async () => {
    const client = makeClient();
    const messages = [userMsg("Hello"), assistantMsg("Hi there")];
    const opencodeClient = makeOpencodeClient(messages);
    const state = makeState();
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ retainEveryNTurns: 1 }),
      state,
      opencodeClient
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-1" } },
    });

    expect(client.retain).toHaveBeenCalledTimes(1);
    expect(client.retain.mock.calls[0][0]).toBe("bank");
    const opts = client.retain.mock.calls[0][2];
    expect(opts.documentId).toBe("sess-1");
    expect(opts.metadata.session_id).toBe("sess-1");
  });

  it("passes retainTags from config to retain call", async () => {
    const client = makeClient();
    const messages = [userMsg("Hello"), assistantMsg("Hi there")];
    const opencodeClient = makeOpencodeClient(messages);
    const state = makeState();
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ retainTags: ["user:alice", "shared"], retainEveryNTurns: 1 }),
      state,
      opencodeClient
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-1" } },
    });

    expect(client.retain).toHaveBeenCalledTimes(1);
    const opts = client.retain.mock.calls[0][2];
    expect(opts.tags).toEqual(["user:alice", "shared"]);
  });

  it("resolves retainTags templates including {session_id} and {bank_id}", async () => {
    const client = makeClient();
    const messages = [userMsg("Hello"), assistantMsg("Hi there")];
    const hooks = createHooks(
      client,
      "my-bank",
      makeConfig({
        retainEveryNTurns: 1,
        retainTags: ["{session_id}", "bank:{bank_id}"],
      }),
      makeState(),
      makeOpencodeClient(messages)
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-xyz" } },
    });

    const opts = client.retain.mock.calls[0][2];
    expect(opts.tags).toEqual(["sess-xyz", "bank:my-bank"]);
    expect(opts.metadata.session_id).toBe("sess-xyz");
    expect(opts.metadata.retained_at).toBeTruthy();
    expect(opts.metadata.message_count).toBe("2");
  });

  it("skips retain when autoRetain is false", async () => {
    const client = makeClient();
    const messages = [userMsg("Hello"), assistantMsg("Hi")];
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ autoRetain: false }),
      makeState(),
      makeOpencodeClient(messages)
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-1" } },
    });

    expect(client.retain).not.toHaveBeenCalled();
  });

  it("uses chunked document_id with overlap in last-turn mode", async () => {
    const client = makeClient();
    const messages = [
      userMsg("Turn 1"),
      assistantMsg("Reply 1"),
      userMsg("Turn 2"),
      assistantMsg("Reply 2"),
    ];
    const config = makeConfig({
      retainMode: "last-turn",
      retainEveryNTurns: 1,
      retainOverlapTurns: 1,
    });
    const state = makeState();
    const hooks = createHooks(client, "bank", config, state, makeOpencodeClient(messages));

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-1" } },
    });

    expect(client.retain).toHaveBeenCalledTimes(1);
    const opts = client.retain.mock.calls[0][2];
    expect(opts.documentId).toMatch(/^sess-1-\d+$/);
  });

  it("respects retainEveryNTurns (Claude turn % N gate)", async () => {
    const client = makeClient();
    const messages = [userMsg("Only one turn"), assistantMsg("ok")];
    const state = makeState();
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ retainEveryNTurns: 3 }),
      state,
      makeOpencodeClient(messages)
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-1" } },
    });

    expect(client.retain).not.toHaveBeenCalled();
  });

  it("retains when userTurns is a multiple of retainEveryNTurns", async () => {
    const client = makeClient();
    const messages = [
      userMsg("turn one hello"),
      assistantMsg("ok1"),
      userMsg("turn two hello"),
      assistantMsg("ok2"),
      userMsg("turn three hello"),
      assistantMsg("ok3"),
    ];
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ retainEveryNTurns: 3 }),
      makeState(),
      makeOpencodeClient(messages)
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-1" } },
    });

    expect(client.retain).toHaveBeenCalledTimes(1);
  });

  it("includes tool parts in retain transcript when retainToolCalls is true", async () => {
    const client = makeClient();
    const messages = [
      userMsg("List the files"),
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "Listing now." },
          {
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls" },
              output: "README.md\nsrc\n",
              title: "ls",
            },
          },
        ],
      },
    ];
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ retainEveryNTurns: 1, retainToolCalls: true }),
      makeState(),
      makeOpencodeClient(messages)
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-1" } },
    });

    expect(client.retain).toHaveBeenCalledTimes(1);
    const transcript = client.retain.mock.calls[0][1] as string;
    expect(transcript).toContain("[tool_call: bash]");
    expect(transcript).toContain("ls");
    expect(transcript).toContain("README.md");
  });

  it("skips hindsight_* tool parts to avoid feedback loops", async () => {
    const client = makeClient();
    const messages = [
      userMsg("Remember this preference"),
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "Stored." },
          {
            type: "tool",
            tool: "hindsight_retain",
            state: {
              status: "completed",
              input: { content: "secret feedback" },
              output: "ok",
            },
          },
        ],
      },
    ];
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ retainEveryNTurns: 1, retainToolCalls: true }),
      makeState(),
      makeOpencodeClient(messages)
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-1" } },
    });

    const transcript = client.retain.mock.calls[0][1] as string;
    expect(transcript).not.toContain("hindsight_retain");
    expect(transcript).not.toContain("secret feedback");
    expect(transcript).toContain("Stored.");
  });
});

describe("event hook — session.deleted (SessionEnd flush)", () => {
  it("force-retains pending turns even when under retainEveryNTurns", async () => {
    const client = makeClient();
    const messages = [userMsg("Only one turn so far"), assistantMsg("ok")];
    const state = makeState();
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ retainEveryNTurns: 10 }),
      state,
      makeOpencodeClient(messages)
    );

    await hooks.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "sess-end" } },
      },
    });

    expect(client.retain).toHaveBeenCalledTimes(1);
    expect(state.lastRetainedTurn.get("sess-end")).toBe(1);
    expect(state.activeSessions.has("sess-end")).toBe(false);
  });

  it("does not re-retain when already fully retained", async () => {
    const client = makeClient();
    const messages = [userMsg("Done"), assistantMsg("ok")];
    const state = makeState();
    state.lastRetainedTurn.set("sess-end", 1);
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ retainEveryNTurns: 10 }),
      state,
      makeOpencodeClient(messages)
    );

    await hooks.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "sess-end" } },
      },
    });

    expect(client.retain).not.toHaveBeenCalled();
  });
});

describe("dispose — force-retain active sessions", () => {
  it("force-retains pending turns for tracked sessions", async () => {
    const client = makeClient();
    const messages = [userMsg("Pending flush on dispose"), assistantMsg("ok")];
    const state = makeState();
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ retainEveryNTurns: 10, recallInjectMode: "system" }),
      state,
      makeOpencodeClient(messages)
    );

    await hooks["experimental.chat.system.transform"](
      { sessionID: "sess-d", model: {} },
      { system: [] }
    );
    expect(state.activeSessions.has("sess-d")).toBe(true);

    await hooks.dispose();

    expect(client.retain).toHaveBeenCalledTimes(1);
    expect(state.lastRetainedTurn.get("sess-d")).toBe(1);
  });
});

describe("compacting hook", () => {
  it("retains then injects query-specific memories into compaction context", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "Important fact", type: "observation" }],
    });
    const messages = [userMsg("What about X?"), assistantMsg("...")];
    const output = { context: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      makeState(),
      makeOpencodeClient(messages)
    );

    await hooks["experimental.session.compacting"]({ sessionID: "sess-1" }, output);

    expect(client.retain).toHaveBeenCalled();
    expect(client.recall).toHaveBeenCalled();
    expect(output.context.length).toBeGreaterThan(0);
    expect(output.context[0]).toContain("hindsight_memories");
    expect(output.context[0]).toContain("Important fact");
  });

  it("pre-compaction retain includes documentId and session metadata", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({ results: [] });
    const messages = [userMsg("Hello"), assistantMsg("Hi")];
    const output = { context: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      makeState(),
      makeOpencodeClient(messages)
    );

    await hooks["experimental.session.compacting"]({ sessionID: "sess-1" }, output);

    expect(client.retain).toHaveBeenCalledTimes(1);
    const opts = client.retain.mock.calls[0][2];
    expect(opts.documentId).toBe("sess-1");
    expect(opts.metadata.session_id).toBe("sess-1");
  });

  it("pre-compaction retain passes retainTags from config", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({ results: [] });
    const messages = [userMsg("Hello"), assistantMsg("Hi")];
    const output = { context: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ retainTags: ["user:alice", "auto-tag"] }),
      makeState(),
      makeOpencodeClient(messages)
    );

    await hooks["experimental.session.compacting"]({ sessionID: "sess-1" }, output);

    expect(client.retain).toHaveBeenCalledTimes(1);
    const opts = client.retain.mock.calls[0][2];
    expect(opts.tags).toEqual(["user:alice", "auto-tag"]);
  });

  it("pre-compaction retain uses chunked documentId in last-turn mode", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({ results: [] });
    const messages = [userMsg("Hello"), assistantMsg("Hi")];
    const config = makeConfig({ retainMode: "last-turn", retainEveryNTurns: 1 });
    const output = { context: [] as string[] };
    const hooks = createHooks(client, "bank", config, makeState(), makeOpencodeClient(messages));

    await hooks["experimental.session.compacting"]({ sessionID: "sess-1" }, output);

    const opts = client.retain.mock.calls[0][2];
    expect(opts.documentId).toMatch(/^sess-1-\d+$/);
  });

  it("resets lastRetainedTurn so idle-retain resumes after compaction", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({ results: [] });
    const messages = [userMsg("Hello"), assistantMsg("Hi")];
    const state = makeState();
    state.lastRetainedTurn.set("sess-1", 10);
    const output = { context: [] as string[] };
    const hooks = createHooks(client, "bank", makeConfig(), state, makeOpencodeClient(messages));

    await hooks["experimental.session.compacting"]({ sessionID: "sess-1" }, output);

    expect(state.lastRetainedTurn.has("sess-1")).toBe(false);
  });

  it("does not throw on error", async () => {
    const client = makeClient();
    client.recall.mockRejectedValue(new Error("Failed"));
    const messages = [userMsg("Test")];
    const output = { context: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      makeState(),
      makeOpencodeClient(messages)
    );

    await expect(
      hooks["experimental.session.compacting"]({ sessionID: "s" }, output)
    ).resolves.not.toThrow();
  });
});

describe("system transform hook — per-turn recall (Claude Code aligned)", () => {
  it("recalls using the latest user prompt as the query", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "User is a developer", type: "observation" }],
    });
    const state = makeState();
    const output = { system: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeSystemConfig(),
      state,
      makeOpencodeClient([userMsg("What did we decide about auth?")])
    );

    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    expect(client.recall).toHaveBeenCalledTimes(1);
    expect(client.recall.mock.calls[0][1]).toBe("What did we decide about auth?");
    expect(output.system[0]).toContain("hindsight_memories");
    expect(output.system[0]).toContain("User is a developer");
    expect(state.turnRecall.get("sess-1")?.userTurnCount).toBe(1);
  });

  it("appends recall into the existing first system section, not a new one", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "User is a developer", type: "observation" }],
    });
    const state = makeState();
    const output = { system: ["You are a helpful coding assistant."] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeSystemConfig(),
      state,
      makeOpencodeClient([userMsg("Continue the refactor plan")])
    );

    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    expect(output.system.length).toBe(1);
    expect(output.system[0]).toContain("You are a helpful coding assistant.");
    expect(output.system[0]).toContain("hindsight_memories");
  });

  it("re-injects cached context on same user turn without a second API call", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "Cached memory", type: "observation" }],
    });
    const state = makeState();
    const messages = [userMsg("Implement the login form")];
    const hooks = createHooks(client, "bank", makeSystemConfig(), state, makeOpencodeClient(messages));

    const output1 = { system: ["base"] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output1);
    expect(client.recall).toHaveBeenCalledTimes(1);
    expect(output1.system[0]).toContain("Cached memory");

    // Tool-loop / second model call within the same user turn
    const output2 = { system: ["base"] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output2);
    expect(client.recall).toHaveBeenCalledTimes(1);
    expect(output2.system[0]).toContain("Cached memory");
  });

  it("recalls again when a new user turn arrives", async () => {
    const client = makeClient();
    client.recall
      .mockResolvedValueOnce({ results: [{ text: "Mem A", type: "observation" }] })
      .mockResolvedValueOnce({ results: [{ text: "Mem B", type: "observation" }] });

    const state = makeState();
    const opencodeClient = makeOpencodeClient([userMsg("First question about auth")]);
    const hooks = createHooks(client, "bank", makeSystemConfig(), state, opencodeClient);

    const output1 = { system: ["base"] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output1);
    expect(client.recall.mock.calls[0][1]).toBe("First question about auth");
    expect(output1.system[0]).toContain("Mem A");

    opencodeClient.session.messages.mockResolvedValue({
      data: [
        userMsg("First question about auth"),
        assistantMsg("Auth uses JWT."),
        userMsg("Now switch to database schema"),
      ],
    });

    const output2 = { system: ["base"] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output2);
    expect(client.recall).toHaveBeenCalledTimes(2);
    expect(client.recall.mock.calls[1][1]).toBe("Now switch to database schema");
    expect(output2.system[0]).toContain("Mem B");
    expect(output2.system[0]).not.toContain("Mem A");
  });

  it("replaces previous hindsight block instead of stacking", async () => {
    const client = makeClient();
    client.recall
      .mockResolvedValueOnce({ results: [{ text: "Old mem", type: "observation" }] })
      .mockResolvedValueOnce({ results: [{ text: "New mem", type: "observation" }] });
    const state = makeState();
    const opencodeClient = makeOpencodeClient([userMsg("Topic one about foo")]);
    const hooks = createHooks(client, "bank", makeSystemConfig(), state, opencodeClient);

    const output1 = { system: ["sys"] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output1);

    opencodeClient.session.messages.mockResolvedValue({
      data: [userMsg("Topic one about foo"), assistantMsg("ok"), userMsg("Topic two about bar")],
    });

    // Simulate OpenCode reusing system that already has a block (should still replace)
    const output2 = { system: [output1.system[0]] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output2);

    const blockCount = (output2.system[0].match(/<hindsight_memories>/g) || []).length;
    expect(blockCount).toBe(1);
    expect(output2.system[0]).toContain("New mem");
    expect(output2.system[0]).not.toContain("Old mem");
  });

  it("skips prompts shorter than minRecallPromptChars", async () => {
    const client = makeClient();
    const state = makeState();
    const output = { system: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeSystemConfig({ minRecallPromptChars: 5 }),
      state,
      makeOpencodeClient([userMsg("hi")])
    );

    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    expect(client.recall).not.toHaveBeenCalled();
    expect(output.system.length).toBe(0);
  });

  it("skips when there is no user message yet", async () => {
    const client = makeClient();
    const output = { system: [] as string[] };
    const hooks = createHooks(client, "bank", makeSystemConfig(), makeState(), makeOpencodeClient([]));

    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    expect(client.recall).not.toHaveBeenCalled();
  });

  it("retries recall on next transform after transient API failure", async () => {
    const client = makeClient();
    client.recall.mockRejectedValueOnce(new Error("Connection refused"));
    client.recall.mockResolvedValueOnce({
      results: [{ text: "Found it", type: "observation" }],
    });
    const state = makeState();
    const messages = [userMsg("Retry this query please")];
    const hooks = createHooks(client, "bank", makeSystemConfig(), state, makeOpencodeClient(messages));

    const output1 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output1);
    expect(output1.system.length).toBe(0);
    expect(state.turnRecall.has("sess-1")).toBe(false);

    const output2 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output2);
    expect(output2.system[0]).toContain("Found it");
    expect(state.turnRecall.has("sess-1")).toBe(true);
  });

  it("caches empty recall so the same turn does not re-query", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({ results: [] });
    const state = makeState();
    const messages = [userMsg("No memories expected here")];
    const hooks = createHooks(client, "bank", makeSystemConfig(), state, makeOpencodeClient(messages));

    await hooks["experimental.chat.system.transform"](
      { sessionID: "sess-1", model: {} },
      { system: [] }
    );
    await hooks["experimental.chat.system.transform"](
      { sessionID: "sess-1", model: {} },
      { system: [] }
    );

    expect(client.recall).toHaveBeenCalledTimes(1);
    expect(state.turnRecall.get("sess-1")?.context).toBeNull();
  });

  it("skips when autoRecall is false", async () => {
    const client = makeClient();
    const state = makeState();
    const output = { system: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeSystemConfig({ autoRecall: false }),
      state,
      makeOpencodeClient([userMsg("Should not recall this")])
    );

    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    expect(output.system.length).toBe(0);
    expect(client.recall).not.toHaveBeenCalled();
  });

  it("composes multi-turn query when recallContextTurns > 1", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({ results: [] });
    const messages = [
      userMsg("We use Postgres"),
      assistantMsg("Noted"),
      userMsg("What database did we choose?"),
    ];
    const hooks = createHooks(
      client,
      "bank",
      makeSystemConfig({ recallContextTurns: 2 }),
      makeState(),
      makeOpencodeClient(messages)
    );

    await hooks["experimental.chat.system.transform"](
      { sessionID: "sess-1", model: {} },
      { system: [] }
    );

    const query = client.recall.mock.calls[0][1] as string;
    expect(query).toContain("Prior context:");
    expect(query).toContain("What database did we choose?");
  });

  it("skips system inject when recallInjectMode is synthetic-user", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "Should not go to system", type: "observation" }],
    });
    const output = { system: ["base"] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ recallInjectMode: "synthetic-user" }),
      makeState(),
      makeOpencodeClient([userMsg("What is our deploy target?")])
    );

    await hooks["experimental.chat.system.transform"](
      { sessionID: "sess-1", model: {} },
      output
    );

    expect(client.recall).not.toHaveBeenCalled();
    expect(output.system[0]).toBe("base");
  });
});

describe("messages transform — synthetic-user inject", () => {
  it("appends synthetic hindsight part on latest user message", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "Deploy on Fly.io", type: "observation" }],
    });
    const opencodeClient = makeOpencodeClient([]);
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ recallInjectMode: "synthetic-user" }),
      makeState(),
      opencodeClient
    );

    const output = {
      messages: [
        {
          info: { role: "user" as const, sessionID: "sess-1" },
          parts: [{ type: "text", text: "Where do we deploy?" }],
        },
      ],
    };

    await hooks["experimental.chat.messages.transform"]({}, output);

    expect(client.recall).toHaveBeenCalledTimes(1);
    expect(client.recall.mock.calls[0][1]).toContain("Where do we deploy?");
    expect(opencodeClient.session.messages).not.toHaveBeenCalled();
    expect(output.messages[0].parts.length).toBe(2);
    const syn = output.messages[0].parts[1];
    expect(syn.synthetic).toBe(true);
    expect(syn.text).toContain("hindsight_memories");
    expect(syn.text).toContain("Fly.io");
  });

  it("replaces previous synthetic hindsight part instead of stacking", async () => {
    const client = makeClient();
    client.recall
      .mockResolvedValueOnce({ results: [{ text: "Old", type: "observation" }] })
      .mockResolvedValueOnce({ results: [{ text: "New", type: "observation" }] });
    const opencodeClient = makeOpencodeClient([]);
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ recallInjectMode: "synthetic-user" }),
      makeState(),
      opencodeClient
    );

    const output1 = {
      messages: [
        {
          info: { role: "user" as const, sessionID: "sess-1" },
          parts: [{ type: "text", text: "Topic one about alpha" }],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]({}, output1);

    const output2 = {
      messages: [
        {
          info: { role: "user" as const, sessionID: "sess-1" },
          parts: [{ type: "text", text: "Topic one about alpha" }],
        },
        {
          info: { role: "assistant" as const, sessionID: "sess-1" },
          parts: [{ type: "text", text: "ok" }],
        },
        {
          info: { role: "user" as const, sessionID: "sess-1" },
          parts: [
            { type: "text", text: "Topic two about beta" },
            {
              type: "text",
              text: output1.messages[0].parts[1].text,
              synthetic: true,
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]({}, output2);

    expect(opencodeClient.session.messages).not.toHaveBeenCalled();
    const lastUser = output2.messages[2];
    const memParts = lastUser.parts.filter(
      (p) => typeof p.text === "string" && p.text.includes("<hindsight_memories>")
    );
    expect(memParts.length).toBe(1);
    expect(memParts[0].text).toContain("New");
    expect(memParts[0].text).not.toContain("Old");
    expect(memParts[0].synthetic).toBe(true);
  });

  it("composes multi-turn query from transform messages without session fetch", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "mem", type: "observation" }],
    });
    const opencodeClient = makeOpencodeClient([]);
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ recallInjectMode: "synthetic-user", recallContextTurns: 2 }),
      makeState(),
      opencodeClient
    );

    await hooks["experimental.chat.messages.transform"](
      {},
      {
        messages: [
          {
            info: { role: "user", sessionID: "sess-1" },
            parts: [{ type: "text", text: "First question about alpha" }],
          },
          {
            info: { role: "assistant", sessionID: "sess-1" },
            parts: [{ type: "text", text: "alpha answer" }],
          },
          {
            info: { role: "user", sessionID: "sess-1" },
            parts: [{ type: "text", text: "Second question about beta" }],
          },
        ],
      }
    );

    expect(opencodeClient.session.messages).not.toHaveBeenCalled();
    const query = client.recall.mock.calls[0][1] as string;
    expect(query).toContain("Prior context:");
    expect(query).toContain("Second question about beta");
    expect(query).toContain("First question about alpha");
  });

  it("does nothing in system inject mode", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "x", type: "observation" }],
    });
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ recallInjectMode: "system" }),
      makeState(),
      makeOpencodeClient([userMsg("hello there friend")])
    );
    const output = {
      messages: [
        {
          info: { role: "user" as const, sessionID: "sess-1" },
          parts: [{ type: "text", text: "hello there friend" }],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]({}, output);
    expect(client.recall).not.toHaveBeenCalled();
    expect(output.messages[0].parts.length).toBe(1);
  });
});


describe("recallAdditionalBanks", () => {
  it("merges memories from additional banks on synthetic-user inject", async () => {
    const client = makeClient();
    client.recall
      .mockResolvedValueOnce({ results: [{ text: "Primary fact", type: "observation" }] })
      .mockResolvedValueOnce({ results: [{ text: "Shared profile", type: "observation" }] });
    const hooks = createHooks(
      client,
      "primary-bank",
      makeConfig({
        recallInjectMode: "synthetic-user",
        recallAdditionalBanks: ["profile-bank"],
      }),
      makeState(),
      makeOpencodeClient([])
    );
    const output = {
      messages: [
        {
          info: { role: "user" as const, sessionID: "sess-1" },
          parts: [{ type: "text", text: "What do we know about deploy?" }],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]({}, output);
    expect(client.recall).toHaveBeenCalledTimes(2);
    expect(client.recall.mock.calls[0][0]).toBe("primary-bank");
    expect(client.recall.mock.calls[1][0]).toBe("profile-bank");
    const syn = output.messages[0].parts.find(
      (p) => typeof p.text === "string" && p.text.includes("hindsight_memories")
    );
    expect(syn?.text).toContain("Primary fact");
    expect(syn?.text).toContain("Shared profile");
  });
});


describe("injectToast", () => {
  it("shows TUI toast only on fresh inject when injectToast is true", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "Toast fact", type: "observation" }],
    });
    const showToast = vi.fn();
    const opencodeClient = {
      ...makeOpencodeClient([]),
      tui: { showToast },
    };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ recallInjectMode: "synthetic-user", injectToast: true }),
      makeState(),
      opencodeClient as any
    );
    const output = {
      messages: [
        {
          info: { role: "user" as const, sessionID: "sess-1" },
          parts: [{ type: "text", text: "Where do we deploy toast?" }],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]({}, output);
    expect(showToast).toHaveBeenCalledTimes(1);
    // OpenCode/OMO style: body-wrapped toast payload
    expect(showToast.mock.calls[0][0]).toMatchObject({
      body: {
        title: "Hindsight",
        variant: "info",
      },
    });
    expect(showToast.mock.calls[0][0].body.message).toContain("chars");

    // Tool-loop cache re-apply: no second toast
    await hooks["experimental.chat.messages.transform"]({}, output);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("does not toast when injectToast is false", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "Silent", type: "observation" }],
    });
    const showToast = vi.fn();
    const opencodeClient = {
      ...makeOpencodeClient([]),
      tui: { showToast },
    };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ recallInjectMode: "synthetic-user", injectToast: false }),
      makeState(),
      opencodeClient as any
    );
    await hooks["experimental.chat.messages.transform"](
      {},
      {
        messages: [
          {
            info: { role: "user" as const, sessionID: "sess-1" },
            parts: [{ type: "text", text: "No toast please here" }],
          },
        ],
      }
    );
    expect(showToast).not.toHaveBeenCalled();
  });
});
