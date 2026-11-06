import { AssistantMessageEventStream, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

export const providerId = "lifecycle-test";

export default function (pi) {
  pi.registerProvider(providerId, {
    baseUrl: "https://invalid.example",
    apiKey: process.env.LIFECYCLE_TOKEN ?? "test-only-key",
    api: "openai-completions",
    models: [{
      id: "probe",
      name: "Lifecycle probe",
      reasoning: false,
      input: ["text"],
      contextWindow: 200000,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, _context, options) {
      const stream = new AssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage([fauxText(options?.headers?.["X-Fixture-Auth"] === "resolved:runtime-test-key"
          ? "native-header-auth"
          : options?.apiKey === "runtime-test-key" ? "runtime-auth"
            : options?.apiKey === "rotated-test-key" ? "rotated-auth" : "provider-ready")]),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  pi.on("session_shutdown", () => pi.unregisterProvider(providerId));
}
