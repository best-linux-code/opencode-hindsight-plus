/**
 * Gated live end-to-end test for the OpenCode Hindsight plugin.
 *
 * Drives the plugin's exported tools + hooks against a live Hindsight server
 * the way the OpenCode runtime would. Skipped by default; runs only when
 * HINDSIGHT_LIVE_E2E=1 (analogous to the `requires_real_llm` pytest marker
 * used by the Python integrations).
 *
 * Run with:
 *   HINDSIGHT_API_URL=http://127.0.0.1:8888 npm run test:e2e
 *
 * Requires:
 *   - A reachable Hindsight server (defaults to http://127.0.0.1:8888).
 *   - When pointing at the hosted backend: HINDSIGHT_API_TOKEN with a valid key.
 */
import { afterAll, describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";

import { HindsightPlugin } from "./index.js";
import { HindsightClient } from "@vectorize-io/hindsight-client";

const LIVE = process.env.HINDSIGHT_LIVE_E2E === "1";
const URL = process.env.HINDSIGHT_API_URL || "http://127.0.0.1:8888";
const EXTRACTION_MS = 10_000;

function newBank(label: string): string {
  return `e2e-opencode-${label}-${randomBytes(3).toString("hex")}`;
}

function mockOpencodeSessionMessages(messages: Array<{ role: string; content: string }>) {
  return {
    session: {
      async messages() {
        return {
          data: messages.map((m) => ({
            info: { role: m.role },
            parts: [{ type: "text", text: m.content }],
          })),
        };
      },
    },
  };
}

const describeLive = LIVE ? describe : describe.skip;

describeLive("live: OpenCode plugin against Hindsight", () => {
  const TOKEN = process.env.HINDSIGHT_API_TOKEN;
  const client = new HindsightClient(TOKEN ? { baseUrl: URL, apiKey: TOKEN } : { baseUrl: URL });
  const banks: string[] = [];

  function trackBank(label: string): string {
    const id = newBank(label);
    banks.push(id);
    return id;
  }

  afterAll(async () => {
    for (const bank of banks) {
      try {
        await client.deleteBank(bank);
      } catch {
        // bank may not exist if a test bailed early
      }
    }
  });

  it("retain → server-side extraction → recall via tools surfaces the stored fact", async () => {
    const bank = trackBank("tools");
    const plugin = await HindsightPlugin(
      {
        client: mockOpencodeSessionMessages([]) as any,
        directory: "/tmp/fake-project",
      } as any,
      { hindsightApiUrl: URL, bankId: bank, debug: false }
    );

    const retainOut = await plugin.tool!.hindsight_retain.execute(
      { content: "User's favourite programming language is Haskell." } as any,
      {} as any
    );
    expect(String(retainOut)).toMatch(/stored/i);

    await new Promise((r) => setTimeout(r, EXTRACTION_MS));

    const recallOut = await plugin.tool!.hindsight_recall.execute(
      { query: "favourite programming language" } as any,
      {} as any
    );
    expect(String(recallOut).toLowerCase()).toContain("haskell");
  }, 45_000);

  it("session.idle → auto-retain captures the transcript", async () => {
    const bank = trackBank("idle");
    const sessionId = "idle-test-session";
    const fakeMessages = [
      { role: "user", content: "I prefer dark mode and use VS Code." },
      { role: "assistant", content: "Noted, dark mode in VS Code." },
    ];

    const plugin = await HindsightPlugin(
      {
        client: mockOpencodeSessionMessages(fakeMessages) as any,
        directory: "/tmp/fake-project",
      } as any,
      {
        hindsightApiUrl: URL,
        bankId: bank,
        retainEveryNTurns: 1,
        debug: false,
      }
    );

    await plugin.event!({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as any);

    await new Promise((r) => setTimeout(r, EXTRACTION_MS));

    const direct = await client.recall(bank, "dark mode VS Code preferences", {
      types: ["observation", "world", "experience"],
      budget: "mid",
      maxTokens: 1024,
    });
    const texts = (direct.results || []).map((r) => r.text.toLowerCase()).join(" | ");
    expect(texts).toMatch(/vs code|dark mode/);
  }, 45_000);

  it("per-turn system transform injects memories relevant to the user prompt", async () => {
    const bank = trackBank("per-turn");
    const sessionId = "per-turn-prompt-session";

    await client.retain(
      bank,
      "The team's preferred deployment target is Fly.io for the hindsight-opencode plugin."
    );
    await new Promise((r) => setTimeout(r, EXTRACTION_MS));

    const plugin = await HindsightPlugin(
      {
        client: mockOpencodeSessionMessages([
          {
            role: "user",
            content: "Where should we deploy the hindsight-opencode plugin?",
          },
        ]) as any,
        directory: "/tmp/fake-project",
      } as any,
      { hindsightApiUrl: URL, bankId: bank, debug: false }
    );

    const sysOut = { system: ["You are a coding agent."] as string[] };
    await plugin["experimental.chat.system.transform"]!(
      { sessionID: sessionId, model: {} } as any,
      sysOut
    );

    expect(sysOut.system.length).toBe(1);
    expect(sysOut.system[0]).toMatch(/hindsight_memories/);
    expect(sysOut.system[0].toLowerCase()).toMatch(/fly\.io|deploy/);
  }, 45_000);
});
