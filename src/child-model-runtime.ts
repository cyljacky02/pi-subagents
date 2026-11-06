/** Session-local provider registrations seeded from the spawning session. */
import { join } from "node:path";
import { type CredentialStore, getSupportedThinkingLevels, type Provider } from "@earendil-works/pi-ai";
import { type ModelRegistry, ModelRuntime, type VirtualModelDefinition } from "@earendil-works/pi-coding-agent";

interface InheritedRuntimeState {
  readonly credentials?: CredentialStore & { readonly store?: CredentialStore };
  readonly modelsPath?: string;
  readonly virtualModels?: ReadonlyMap<string, ReadonlyMap<string, Pick<VirtualModelDefinition, "route">>>;
}

/** Copy configuration data without dropping stream/auth callbacks. */
function copyProviderData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyProviderData) as T;
  if (value !== null && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyProviderData(entry)])) as T;
  }
  return value;
}

/** Native providers have no fork contract: inherit a catalog snapshot, not its mutable refresh closure. */
function snapshotNativeProvider(provider: Provider): Provider {
  const models = copyProviderData(provider.getModels());
  const allModels = copyProviderData(provider.getAllModels?.() ?? models);
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    headers: copyProviderData(provider.headers),
    auth: copyProviderData(provider.auth),
    getModels: () => models,
    getAllModels: () => allModels,
    filterModels: provider.filterModels?.bind(provider),
    filterAllModels: provider.filterAllModels?.bind(provider),
    stream: provider.stream.bind(provider),
    streamSimple: provider.streamSimple.bind(provider),
    fetchDeferred: provider.fetchDeferred?.bind(provider),
    cancelDeferred: provider.cancelDeferred?.bind(provider),
    generateImages: provider.generateImages?.bind(provider),
    classify: provider.classify?.bind(provider),
  };
}

export async function createChildModelRuntime(parent: ModelRegistry, agentDir: string): Promise<ModelRuntime> {
  // Pi has no public fork interface. Confine the compatibility read here:
  // share only the underlying credential source, never the parent's runtime,
  // provider maps, or runtime-key overlay. Verified against Pi 1.1 and 1.5.
  const source = (parent as unknown as { runtime?: InheritedRuntimeState }).runtime;
  const credentials = source?.credentials;
  const runtime = await ModelRuntime.create({
    credentials: credentials?.store ?? credentials,
    authPath: join(agentDir, "auth.json"),
    modelsPath: source && Object.hasOwn(source, "modelsPath") ? source.modelsPath ?? null : join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  const models = parent.getAll?.() ?? [];
  // Register routers first: a later physical catalog refresh may have added an
  // identically named model, which the parent's virtual registration hides.
  for (const model of models) {
    if (model.api !== "pi-virtual") continue;
    const router = source?.virtualModels?.get(model.provider)?.get(model.id);
    if (!router) throw new Error(`Cannot inherit virtual model ${model.provider}/${model.id}: unsupported Pi SDK layout.`);
    runtime.registerVirtualModel({
      provider: model.provider,
      id: model.id,
      name: model.name,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingLevels: getSupportedThinkingLevels(model),
      route: router.route,
    });
  }
  const providers = parent.getRegisteredProviderIds?.() ?? [];
  for (const id of providers) {
    const native = parent.getRegisteredNativeProvider(id);
    if (native) runtime.registerNativeProvider(snapshotNativeProvider(native));
    const config = parent.getRegisteredProviderConfig(id);
    if (config) runtime.registerProvider(id, copyProviderData(config));
  }
  // Runtime overrides (for example --api-key) are not in auth.json. Copy only
  // explicit overrides, never a resolved OAuth token or a !command result.
  const authProviders = new Set([
    ...providers,
    ...models.map((model) => model.provider),
  ]);
  for (const id of authProviders) {
    if (parent.getProviderAuthStatus?.(id).source !== "runtime") continue;
    const credential = await credentials?.read(id);
    if (credential?.type !== "api_key" || credential.key === undefined) {
      throw new Error(`Cannot inherit runtime credentials for ${id}: this Pi SDK does not expose its credential source.`);
    }
    await runtime.setRuntimeApiKey(id, credential.key);
  }
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}
