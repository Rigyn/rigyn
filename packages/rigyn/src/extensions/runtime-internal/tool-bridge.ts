import {
  immutableRuntimeToolRenderView,
  type RuntimeToolRenderer,
  type RuntimeToolRenderBridge,
  type RuntimeToolRendererBinding,
  type RuntimeToolRendererFailure,
  type RuntimeToolRenderView,
  type RuntimeUiBlock,
  type RuntimeUiRenderContext,
} from "../../tui/components.js";
import {
  DIRECT_TOOL_RENDER_RESULT,
  type RuntimeDirectToolRenderContent,
} from "../../tui/tool-render-view.js";
import { boundedRuntimeFailureMessage } from "./generation-lifecycle.js";

const MAX_RENDERER_FAILURE_DIAGNOSTICS = 128;

export interface DirectRuntimeToolRenderer extends RuntimeToolRenderer {
  [DIRECT_TOOL_RENDER_RESULT](
    view: Readonly<RuntimeToolRenderView>,
    content: RuntimeDirectToolRenderContent,
    context: RuntimeUiRenderContext,
    bridge?: RuntimeToolRenderBridge,
  ): RuntimeUiBlock | undefined;
}

export interface DirectToolRendererBridgeDiagnostic {
  name: string;
  slot: RuntimeToolRendererFailure["slot"];
  message: string;
}

export function createDirectToolRendererBridge(
  renderers: ReadonlyMap<string, DirectRuntimeToolRenderer>,
  onDiagnostic?: (diagnostic: DirectToolRendererBridgeDiagnostic) => void,
): RuntimeToolRendererBinding | undefined {
  if (renderers.size === 0) return undefined;
  const failureKeys = new Set<string>();
  const reportError = (failure: RuntimeToolRendererFailure): void => {
    const detail = boundedRuntimeFailureMessage(failure.cause);
    const key = `${failure.name}\0${failure.slot}\0${detail}`;
    if (failureKeys.has(key) || failureKeys.size >= MAX_RENDERER_FAILURE_DIAGNOSTICS) return;
    failureKeys.add(key);
    try {
      onDiagnostic?.({
        name: failure.name,
        slot: failure.slot,
        message: `Runtime tool ${failure.slot} renderer failed for ${failure.name}: ${detail}`,
      });
    } catch {
      // Diagnostic observers cannot destabilize the renderer fallback.
    }
  };
  const invoke = (
    name: string,
    slot: "call" | "result",
    render: (renderer: DirectRuntimeToolRenderer) => RuntimeUiBlock | undefined,
  ): RuntimeUiBlock | undefined => {
    const renderer = renderers.get(name);
    if (renderer === undefined) return undefined;
    try {
      return render(renderer);
    } catch (cause) {
      reportError({ name, slot, cause });
      return undefined;
    }
  };
  return {
    has: (name) => renderers.has(name),
    renderShell: (name) => renderers.get(name)?.renderShell,
    renderCall: (name, view, context, bridge) =>
      invoke(name, "call", (renderer) =>
        renderer.renderCall?.(immutableRuntimeToolRenderView(view), context, bridge)),
    renderResult: (name, view, context, bridge) =>
      invoke(name, "result", (renderer) =>
        renderer.renderResult?.(immutableRuntimeToolRenderView(view), context, bridge)),
    [DIRECT_TOOL_RENDER_RESULT]: (name, view, content, context, bridge) =>
      invoke(name, "result", (renderer) => renderer[DIRECT_TOOL_RENDER_RESULT](
        immutableRuntimeToolRenderView(view),
        content,
        context,
        bridge,
      )),
    reconcile(liveCallIds) {
      for (const renderer of new Set(renderers.values())) {
        try {
          renderer.reconcile?.(liveCallIds);
        } catch (cause) {
          reportError({ name: "*", slot: "reconcile", cause });
        }
      }
    },
    dispose() {
      for (const renderer of new Set(renderers.values())) {
        try {
          renderer.dispose?.();
        } catch (cause) {
          reportError({ name: "*", slot: "dispose", cause });
        }
      }
    },
    reportError,
  };
}
