import type {
  ProviderWireLifecycleHost,
  ProviderWireLifecycleScope,
} from "../../providers/wire.js";
import type { RuntimeExtensionHost } from "../runtime.js";
import type { RuntimeRequesterSession } from "./event-projection.js";

export function bindDirectProviderWireLifecycle(
  host: RuntimeExtensionHost,
  wire: ProviderWireLifecycleHost,
): () => void {
  const requester = (scope: ProviderWireLifecycleScope): RuntimeRequesterSession => ({
    threadId: scope.threadId,
    runId: scope.runId,
    ...(scope.branch === undefined ? {} : { branch: scope.branch }),
    step: scope.step,
  });
  return wire.registerLifecycle({
    async beforeHeaders(request, signal) {
      if (request.transport === "websocket" && request.phase === "frame") return;
      if (!host.hasListeners("before_provider_headers")) return;
      const headers: Record<string, string | null> = { ...request.headers };
      await host.applyBeforeProviderHeaders(headers, signal, requester(request));
      return { headers };
    },
    async beforeRequest(request, signal) {
      if (!host.hasListeners("before_provider_request")) return;
      return {
        body: await host.applyBeforeProviderRequestPayload(request.body, requester(request), signal),
      };
    },
    async afterResponse(response, signal) {
      if (response.transport === "websocket" && response.phase === "frame") return;
      if (!host.hasListeners("after_provider_response")) return;
      await host.observeAfterProviderResponse(
        response.status,
        response.headers,
        requester(response),
        signal,
      );
    },
  });
}
