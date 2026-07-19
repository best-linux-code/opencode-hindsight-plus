import { describe, it, expect, vi } from "vitest";
import { createPageTools } from "./pages.js";
import { createTools } from "./tools.js";
import { makeConfig } from "./test-helpers.js";

const mockContext = {
  sessionID: "sess-1",
  messageID: "msg-1",
  agent: "default",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: vi.fn(),
  ask: vi.fn(),
};

function makeClient() {
  return {
    listMentalModels: vi.fn().mockResolvedValue({
      items: [
        { id: "mm-1", name: "Architecture", source_query: "What are architecture decisions?" },
      ],
    }),
    getMentalModel: vi.fn().mockResolvedValue({
      id: "mm-1",
      name: "Architecture",
      source_query: "What are architecture decisions?",
      content: "We use hexagonal architecture.",
    }),
    createMentalModel: vi.fn().mockResolvedValue({ mental_model_id: "mm-new" }),
    updateMentalModel: vi.fn().mockResolvedValue({}),
    deleteMentalModel: vi.fn().mockResolvedValue(undefined),
    refreshMentalModel: vi.fn().mockResolvedValue({
      id: "mm-1",
      name: "Architecture",
      content: "Refreshed content.",
    }),
    createBank: vi.fn().mockResolvedValue({}),
    retain: vi.fn(),
    recall: vi.fn(),
    reflect: vi.fn(),
  } as any;
}

describe("createPageTools", () => {
  it("lists pages compactly", async () => {
    const client = makeClient();
    const tools = createPageTools(client, "bank", makeConfig());
    const out = await tools.hindsight_page_list.execute({}, mockContext);
    expect(client.listMentalModels).toHaveBeenCalledWith("bank");
    expect(String(out)).toContain("mm-1");
    expect(String(out)).toContain("Architecture");
  });

  it("gets page content", async () => {
    const client = makeClient();
    const tools = createPageTools(client, "bank", makeConfig());
    const out = await tools.hindsight_page_get.execute({ page_id: "mm-1" }, mockContext);
    expect(client.getMentalModel).toHaveBeenCalledWith("bank", "mm-1");
    expect(String(out)).toContain("hexagonal architecture");
  });

  it("creates a page with source_query", async () => {
    const client = makeClient();
    const tools = createPageTools(client, "bank", makeConfig());
    const out = await tools.hindsight_page_create.execute(
      { name: "Prefs", source_query: "What preferences does the user have?", page_id: "prefs" },
      mockContext
    );
    expect(client.createMentalModel).toHaveBeenCalledWith(
      "bank",
      "Prefs",
      "What preferences does the user have?",
      expect.objectContaining({ id: "prefs" })
    );
    expect(String(out)).toContain("mm-new");
  });

  it("updates, refreshes, and deletes pages", async () => {
    const client = makeClient();
    const tools = createPageTools(client, "bank", makeConfig());

    await tools.hindsight_page_update.execute(
      { page_id: "mm-1", name: "Arch v2" },
      mockContext
    );
    expect(client.updateMentalModel).toHaveBeenCalledWith(
      "bank",
      "mm-1",
      expect.objectContaining({ name: "Arch v2" })
    );

    const refreshed = await tools.hindsight_page_refresh.execute(
      { page_id: "mm-1" },
      mockContext
    );
    expect(client.refreshMentalModel).toHaveBeenCalledWith("bank", "mm-1");
    expect(String(refreshed)).toContain("Refreshed content");

    const deleted = await tools.hindsight_page_delete.execute({ page_id: "mm-1" }, mockContext);
    expect(client.deleteMentalModel).toHaveBeenCalledWith("bank", "mm-1");
    expect(String(deleted)).toContain("deleted");
  });
});

describe("createTools knowledge pages gate", () => {
  it("includes page tools when enableKnowledgePages is true", () => {
    const tools = createTools(makeClient(), "bank", makeConfig({ enableKnowledgePages: true }));
    expect(tools.hindsight_page_list).toBeDefined();
    expect(tools.hindsight_page_create).toBeDefined();
  });

  it("omits page tools when enableKnowledgePages is false", () => {
    const tools = createTools(makeClient(), "bank", makeConfig({ enableKnowledgePages: false }));
    expect(tools.hindsight_page_list).toBeUndefined();
    expect(tools.hindsight_retain).toBeDefined();
  });
});
