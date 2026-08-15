import type { JsonValue } from "../core/json.js";
import type { ResourceClaim, ToolExecutionContext, ToolInvocation } from "./types.js";

/** Exact, immutable tool effect presented to the host immediately before dispatch. */
export interface ToolAuthorizationRequest {
  readonly invocation: Readonly<ToolInvocation>;
  readonly resources: readonly Readonly<ResourceClaim>[];
  readonly backendId: string;
  readonly recovered: boolean;
}

export type ToolAuthorizationDecision =
  | { readonly decision: "allow_once" }
  | { readonly decision: "deny"; readonly reason?: string };

export type ToolAuthorizationOwner =
  | { readonly kind: "builtin" }
  | { readonly kind: "host" }
  | {
      readonly kind: "extension";
      readonly extensionId: string;
      readonly sourcePath: string;
      readonly scope?: "builtin" | "user" | "project" | "invocation";
    };

/** Bounded host context for one model-requested tool authorization decision. */
export interface ToolAuthorizationContext {
  readonly signal: AbortSignal;
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly owner: ToolAuthorizationOwner;
  readonly branch?: string;
  readonly step?: number;
}

/** Host-owned, invocation-scoped tool authorization boundary. */
export type ToolAuthorizationHandler = (
  request: ToolAuthorizationRequest,
  context: ToolAuthorizationContext,
) => Promise<ToolAuthorizationDecision> | ToolAuthorizationDecision;

function freezeJson(value: JsonValue): JsonValue {
  const selected = structuredClone(value);
  if (selected === null || typeof selected !== "object") return selected;
  const pending: object[] = [selected];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object" && !Object.isFrozen(child)) pending.push(child);
    }
    Object.freeze(current);
  }
  return selected;
}

/** @internal Build a callback-safe snapshot without exposing coordinator-owned objects. */
export function toolAuthorizationRequest(
  invocation: ToolInvocation,
  resources: readonly ResourceClaim[],
  backendId: string,
  recovered: boolean,
): ToolAuthorizationRequest {
  const selectedInvocation = Object.freeze({
    ...invocation,
    input: freezeJson(invocation.input),
  });
  const selectedResources = Object.freeze(resources.map((claim) => Object.freeze({ ...claim })));
  return Object.freeze({
    invocation: selectedInvocation,
    resources: selectedResources,
    backendId,
    recovered,
  });
}

/** @internal Project execution state without exposing mutable coordinator services. */
export function toolAuthorizationContext(
  context: ToolExecutionContext,
  owner: ToolAuthorizationOwner,
): ToolAuthorizationContext {
  const selectedOwner = Object.freeze({ ...owner });
  return Object.freeze({
    signal: context.signal,
    workspaceRoot: context.workspace.root,
    runId: context.runId,
    threadId: context.threadId,
    toolCallId: context.toolCallId,
    owner: selectedOwner,
    ...(context.branch === undefined ? {} : { branch: context.branch }),
    ...(context.step === undefined ? {} : { step: context.step }),
  });
}

/** @internal Reject malformed host decisions instead of treating them as approval. */
export function validateToolAuthorizationDecision(value: unknown): ToolAuthorizationDecision {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool authorization returned an invalid decision");
  }
  const decision = value as Record<string, unknown>;
  if (decision["decision"] === "allow_once" && Object.keys(decision).length === 1) {
    return Object.freeze({ decision: "allow_once" });
  }
  if (
    decision["decision"] === "deny" &&
    Object.keys(decision).every((key) => key === "decision" || key === "reason") &&
    (decision["reason"] === undefined || typeof decision["reason"] === "string")
  ) {
    const reason = decision["reason"];
    if (typeof reason === "string") {
      if (reason.includes("\0") || Buffer.byteLength(reason, "utf8") > 4 * 1024) {
        throw new Error("Tool authorization denial reason is invalid");
      }
      return Object.freeze({ decision: "deny", reason });
    }
    return Object.freeze({ decision: "deny" });
  }
  throw new Error("Tool authorization returned an invalid decision");
}
