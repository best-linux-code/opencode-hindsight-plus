import { afterAll, describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { createTools } from "./tools.js";
import { makeConfig } from "./test-helpers.js";

const LIVE = process.env.HINDSIGHT_LIVE_E2E === "1";
const describeLive = LIVE ? describe : describe.skip;
const URL = process.env.HINDSIGHT_API_URL || "http://127.0.0.1:8888";
const BANK = `pages-e2e-${randomBytes(3).toString("hex")}`;
const client = new HindsightClient({ baseUrl: URL });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ctx = {
  sessionID: "sess-pages",
  messageID: "msg-1",
  agent: "default",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => ({}),
} as any;

describeLive("live: knowledge pages (mental-models)", () => {
  afterAll(async () => {
    try {
      await client.deleteBank(BANK);
    } catch {}
  });

  it("create → list → get → refresh → delete", async () => {
    await client.retain(
      BANK,
      "Payment processing uses Stripe Checkout; customer_id is stored in Postgres."
    );
    await sleep(8000);

    const tools = createTools(client, BANK, makeConfig({ enableKnowledgePages: true }));
    const created = String(
      await tools.hindsight_page_create.execute(
        {
          name: "Payments",
          source_query: "How does payment processing work in this project?",
          page_id: "payments",
        },
        ctx
      )
    );
    expect(created.toLowerCase()).toMatch(/created|payments/);

    const listed = String(await tools.hindsight_page_list.execute({}, ctx));
    expect(listed).toMatch(/payments|Payments/i);

    await sleep(5000);
    const got = String(await tools.hindsight_page_get.execute({ page_id: "payments" }, ctx));
    expect(got).toMatch(/payments|stripe|postgres|Generating|content/i);

    await tools.hindsight_page_refresh.execute({ page_id: "payments" }, ctx);
    const deleted = String(
      await tools.hindsight_page_delete.execute({ page_id: "payments" }, ctx)
    );
    expect(deleted.toLowerCase()).toContain("deleted");

    const listed2 = String(await tools.hindsight_page_list.execute({}, ctx));
    expect(listed2.toLowerCase()).toMatch(/no knowledge pages|0\)/);
  }, 60_000);
});
