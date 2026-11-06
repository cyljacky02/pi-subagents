/** Real SDK lifecycle: a child's provider teardown must not change another session. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../../src/agent-manager.js";
import { runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import type { AgentConfig } from "../../src/types.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/lifecycle-provider.mjs", import.meta.url));
const CHILD_CONFIG = {
  name: "runtime-child",
  description: "Provider lifecycle probe",
  builtinToolNames: ["read"],
  extensions: true,
  skills: false,
  persistSession: false,
  systemPrompt: "Reply briefly.",
  promptMode: "replace",
  inheritContext: false,
  runInBackground: false,
  isolated: false,
} satisfies AgentConfig;

vi.setConfig({ testTimeout: 30_000 });

describe("child provider lifecycle isolation", () => {
  let directory: string;
  let context: ExtensionContext;
  let extension: ExtensionAPI;
  let parent: AgentSession;
  let parentRuntime: ModelRuntime;
  const sessions: AgentSession[] = [];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "subagents-provider-lifecycle-"));
    const cwd = join(directory, "project");
    const agentDir = join(directory, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", directory);
    vi.stubEnv("PI_OFFLINE", "1");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      packages: [],
      extensions: [FIXTURE],
      compaction: { enabled: false },
      retry: { enabled: false },
    }));
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "lifecycle-test": { modelOverrides: { probe: { contextWindow: 1_050_000, maxTokens: 128_000 } } },
      },
    }));
    registerAgents(new Map([["runtime-child", CHILD_CONFIG]]));
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [(pi) => {
        extension = pi;
        pi.on("session_start", (_event, ctx) => { context = ctx; });
      }],
    });
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    parentRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    ({ session: parent } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime: parentRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: [],
    }));
    sessions.push(parent);
    await parent.bindExtensions({});
    const model = context.modelRegistry.find("lifecycle-test", "probe");
    expect(model).toBeDefined();
    await parent.setModel(model!);
  });

  afterEach(async () => {
    for (const session of sessions.splice(0).reverse()) {
      try {
        await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session.dispose();
      }
    }
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps the parent and sibling usable after a child unregisters its provider", async () => {
    const first = await runAgent(context, "runtime-child", "Reply.", { pi: extension });
    sessions.push(first.session);
    expect(first.failure).toBeUndefined();
    expect(first.responseText).toBe("provider-ready");
    expect(first.session.model).toMatchObject({ contextWindow: 1_050_000, maxTokens: 128_000 });
    const sibling = await runAgent(context, "runtime-child", "Reply.", { pi: extension });
    sessions.push(sibling.session);
    expect(sibling.failure).toBeUndefined();

    await first.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

    await sibling.session.prompt("Reply again.");
    const lastMessage = sibling.session.messages.at(-1);
    expect(lastMessage?.role === "assistant" ? lastMessage.errorMessage : undefined).toBeUndefined();
    expect(sibling.session.getLastAssistantText()).toBe("provider-ready");
    await parent.prompt("Reply again.");
    expect(parent.getLastAssistantText()).toBe("provider-ready");
  });

  it("inherits runtime auth when the child loads no extensions", async () => {
    registerAgents(new Map([["runtime-child", { ...CHILD_CONFIG, isolated: true }]]));
    await parentRuntime.setRuntimeApiKey("lifecycle-test", "runtime-test-key");
    await parent.prompt("Verify runtime auth.");
    expect(parent.getLastAssistantText()).toBe("runtime-auth");

    const result = await runAgent(context, "runtime-child", "Reply.", { pi: extension });
    sessions.push(result.session);
    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("runtime-auth");
  });

  it("inherits a native runtime credential before its resolver transforms it into headers", async () => {
    registerAgents(new Map([["runtime-child", { ...CHILD_CONFIG, isolated: true }]]));
    const config = parentRuntime.getRegisteredProviderConfig("lifecycle-test")!;
    const model = { ...context.model!, provider: "native-header-fixture" };
    parentRuntime.registerNativeProvider({
      id: model.provider,
      name: "Native header fixture",
      auth: { apiKey: {
        name: "Fixture",
        resolve: async ({ credential }) => credential?.key
          ? { auth: { headers: { "X-Fixture-Auth": `resolved:${credential.key}` } } }
          : undefined,
      } },
      getModels: () => [model],
      stream: (requestModel, transcript) => config.streamSimple!(requestModel, transcript),
      streamSimple: config.streamSimple!,
    });
    await parentRuntime.setRuntimeApiKey(model.provider, "runtime-test-key");
    await parent.setModel(model);
    await parent.prompt("Verify native auth.");
    expect(parent.getLastAssistantText()).toBe("native-header-auth");

    const result = await runAgent(context, "runtime-child", "Reply.", { pi: extension });
    sessions.push(result.session);
    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("native-header-auth");
  });

  it("inherits a virtual router while keeping its conversation state session-local", async () => {
    registerAgents(new Map([["runtime-child", { ...CHILD_CONFIG, isolated: true }]]));
    const states: number[] = [];
    parentRuntime.registerVirtualModel({
      provider: "router-fixture",
      id: "smart",
      name: "Smart fixture",
      thinkingLevels: ["off", "high"],
      route: ({ state }) => {
        const count = typeof state === "number" ? state : 0;
        states.push(count);
        return { model: context.modelRegistry.find("lifecycle-test", "probe")!, thinkingLevel: "off", state: count + 1 };
      },
    });
    await parent.setModel(parentRuntime.getModel("router-fixture", "smart")!);
    await parent.prompt("Parent router turn.");
    expect(parent.getLastAssistantText()).toBe("provider-ready");

    const result = await runAgent(context, "runtime-child", "Child router turn.", { pi: extension });
    sessions.push(result.session);
    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("provider-ready");
    await result.session.prompt("Child follow-up.");
    expect(result.session.getLastAssistantText()).toBe("provider-ready");
    await parent.prompt("Parent follow-up.");
    expect(parent.getLastAssistantText()).toBe("provider-ready");
    expect(states).toEqual([0, 0, 1, 1]);
  });

  it("does not refresh a parent-owned native provider while starting an isolated child", async () => {
    registerAgents(new Map([["runtime-child", { ...CHILD_CONFIG, isolated: true }]]));
    const config = parentRuntime.getRegisteredProviderConfig("lifecycle-test")!;
    let catalog = [{ ...context.model!, provider: "native-fixture", maxTokens: 2048 }];
    const native: Provider = {
      id: "native-fixture",
      name: "Native fixture",
      auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "test-only-key" } }) } },
      getModels: () => catalog,
      stream: (model, transcript) => config.streamSimple!(model, transcript),
      streamSimple: config.streamSimple!,
      refreshModels: async (refresh) => {
        await refresh.publish({ update: () => {
          catalog = catalog.map((model) => ({ ...model, maxTokens: model.maxTokens + 1 }));
        } });
      },
    };
    parentRuntime.registerNativeProvider(native);
    await parentRuntime.refresh({ allowNetwork: false });
    const model = parentRuntime.getModel("native-fixture", "probe")!;
    const before = model.maxTokens;

    const result = await runAgent(context, "runtime-child", "Reply.", { pi: extension, model });
    sessions.push(result.session);
    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("provider-ready");
    expect(parentRuntime.getModel("native-fixture", "probe")?.maxTokens).toBe(before);
  });

  it("keeps the parent usable after the manager's ten-minute session eviction", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const manager = new AgentManager();
    try {
      const id = manager.spawn(extension, context, "runtime-child", "Reply.", {
        description: "Eviction probe",
        isBackground: true,
      });
      await manager.getRecord(id)!.promise;
      expect(manager.getRecord(id)?.status).toBe("completed");

      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(manager.getRecord(id)).toBeUndefined();
      await parent.prompt("Reply after eviction.");
      expect(parent.getLastAssistantText()).toBe("provider-ready");
    } finally {
      await manager.dispose();
      vi.useRealTimers();
    }
  });

  it("reloads a child's token without changing the parent's provider", async () => {
    const child = await runAgent(context, "runtime-child", "Reply.", { pi: extension });
    sessions.push(child.session);
    expect(child.responseText).toBe("provider-ready");

    vi.stubEnv("LIFECYCLE_TOKEN", "rotated-test-key");
    await child.session.reload();
    await child.session.prompt("Reply with the new configuration.");
    expect(child.session.getLastAssistantText()).toBe("rotated-auth");
    await parent.prompt("Reply with the original configuration.");
    expect(parent.getLastAssistantText()).toBe("provider-ready");
  });
});
