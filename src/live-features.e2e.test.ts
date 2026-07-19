import { afterAll, describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { createHooks, type PluginState } from "./hooks.js";
import { makeConfig } from "./test-helpers.js";

const LIVE = process.env.HINDSIGHT_LIVE_E2E === "1";
const describeLive = LIVE ? describe : describe.skip;
const URL = process.env.HINDSIGHT_API_URL || "http://127.0.0.1:8888";
const BANK = `live-feat-${randomBytes(3).toString("hex")}`;
const banks: string[] = [BANK];
const client = new HindsightClient({ baseUrl: URL });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeState(): PluginState {
  return {
    turnCount: 0,
    missionsSet: new Set(),
    turnRecall: new Map(),
    lastRetainedTurn: new Map(),
    activeSessions: new Set(),
  };
}

function makeOpencode(messages: any[]) {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  };
}

describeLive("live: retainToolCalls + SessionEnd flush", () => {
  afterAll(async () => {
    for (const b of banks) {
      try {
        await client.deleteBank(b);
      } catch {}
    }
  });

  it("session.deleted force-retains when under retainEveryNTurns", async () => {
    const marker = `DELETE-FORCE-${Date.now()}`;
    const messages = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: `User prefers dark theme code ${marker}.` }],
      },
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text: `Noted dark theme ${marker}.` }],
      },
    ];
    const state = makeState();
    const hooks = createHooks(
      client as any,
      BANK,
      makeConfig({ retainEveryNTurns: 10, retainToolCalls: true }),
      state,
      makeOpencode(messages)
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-del" } },
    });
    expect(state.lastRetainedTurn.has("sess-del")).toBe(false);

    await hooks.event({
      event: { type: "session.deleted", properties: { info: { id: "sess-del" } } },
    });
    expect(state.lastRetainedTurn.get("sess-del")).toBe(1);

    await sleep(10000);
    const recall = await client.recall(BANK, `dark theme code ${marker}`, {
      budget: "mid",
      maxTokens: 512,
      types: ["observation", "world", "experience"],
    });
    const texts = (recall.results || []).map((r) => r.text.toLowerCase()).join(" | ");
    expect(texts).toMatch(/dark|theme/);
  }, 45_000);

  it("retainToolCalls puts tool output into retained transcript", async () => {
    const bank = `${BANK}-tools`;
    banks.push(bank);
    const marker = `TOOL-MARKER-${Date.now()}`;
    let transcript = "";
    const wrapped = {
      retain: async (b: string, content: string, opts: any) => {
        transcript = content;
        return client.retain(b, content, opts);
      },
      recall: (...a: any[]) => (client as any).recall(...a),
      reflect: async () => ({ text: "" }),
      createBank: async () => ({}),
    };
    const messages = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "Run deploy check" }],
      },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "Running." },
          {
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "echo deploy" },
              output: `deploy-ok\n${marker}\n`,
              title: "echo",
            },
          },
          {
            type: "tool",
            tool: "hindsight_retain",
            state: {
              status: "completed",
              input: { content: "SHOULD-NOT-APPEAR" },
              output: "ok",
            },
          },
        ],
      },
    ];
    const hooks = createHooks(
      wrapped as any,
      bank,
      makeConfig({ retainEveryNTurns: 1, retainToolCalls: true }),
      makeState(),
      makeOpencode(messages)
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-tool" } },
    });

    expect(transcript).toContain("[tool_call: bash]");
    expect(transcript).toContain(marker);
    expect(transcript).not.toContain("SHOULD-NOT-APPEAR");
    expect(transcript).not.toContain("hindsight_retain");
  }, 30_000);

  it("dispose force-retains tracked pending sessions", async () => {
    const bank = `${BANK}-dispose`;
    banks.push(bank);
    const marker = `DISPOSE-${Date.now()}`;
    const messages = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: `User likes Rust language marker ${marker}.` }],
      },
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text: `Noted Rust ${marker}.` }],
      },
    ];
    const state = makeState();
    const hooks = createHooks(
      client as any,
      bank,
      makeConfig({ retainEveryNTurns: 10, retainToolCalls: true }),
      state,
      makeOpencode(messages)
    );

    await hooks["experimental.chat.system.transform"](
      { sessionID: "sess-dispose", model: {} },
      { system: ["base"] }
    );
    expect(state.activeSessions.has("sess-dispose")).toBe(true);

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-dispose" } },
    });
    expect(state.lastRetainedTurn.has("sess-dispose")).toBe(false);

    await hooks.dispose();
    expect(state.lastRetainedTurn.get("sess-dispose")).toBe(1);

    await sleep(10000);
    const recall = await client.recall(bank, `Rust language marker ${marker}`, {
      budget: "mid",
      maxTokens: 512,
      types: ["observation", "world", "experience"],
    });
    const texts = (recall.results || []).map((r) => r.text.toLowerCase()).join(" | ");
    expect(texts).toMatch(/rust/);
  }, 45_000);
});
