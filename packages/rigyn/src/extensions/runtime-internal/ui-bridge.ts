import type {
  RuntimeAdvancedUiOperation,
  RuntimeInitialUiOperation,
} from "../runtime.js";

export const MAX_RETAINED_RUNTIME_UI_OPERATIONS = 512;

function advancedOperationKey(operation: RuntimeAdvancedUiOperation): string {
  if (operation.type === "component") {
    return JSON.stringify([operation.ownerKey, operation.type, operation.slot, operation.key]);
  }
  if (operation.type === "key_observer") {
    return JSON.stringify([operation.ownerKey, operation.type, operation.key]);
  }
  return JSON.stringify([operation.ownerKey, operation.type]);
}

function retainsAdvancedState(operation: RuntimeAdvancedUiOperation): boolean {
  if (operation.type === "component") return operation.factory !== undefined;
  if (operation.type === "working_indicator") return operation.value !== undefined;
  if (operation.type === "hidden_reasoning_label") return operation.value !== undefined;
  if (operation.type === "tool_output_expanded") return operation.expanded !== undefined;
  return operation.observer !== undefined;
}

export function pruneAbortedInitialUiOperations(operations: RuntimeInitialUiOperation[]): void {
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    if (operations[index]!.signal.aborted) operations.splice(index, 1);
  }
}

export function pruneAbortedAdvancedUiOperations(operations: RuntimeAdvancedUiOperation[]): void {
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    if (operations[index]!.signal.aborted) operations.splice(index, 1);
  }
}

export function assertAdvancedUiOperationCapacity(
  operations: readonly RuntimeAdvancedUiOperation[],
  operation: RuntimeAdvancedUiOperation,
  knownIndex?: number,
): void {
  const index = knownIndex ?? operations.findIndex((entry) =>
    advancedOperationKey(entry) === advancedOperationKey(operation));
  if (
    index < 0
    && retainsAdvancedState(operation)
    && operations.length >= MAX_RETAINED_RUNTIME_UI_OPERATIONS
  ) {
    throw new Error(`Runtime extension initial advanced UI exceeds ${MAX_RETAINED_RUNTIME_UI_OPERATIONS} operations`);
  }
}

export function retainAdvancedUiOperation(
  operations: RuntimeAdvancedUiOperation[],
  operation: RuntimeAdvancedUiOperation,
): void {
  pruneAbortedAdvancedUiOperations(operations);
  const key = advancedOperationKey(operation);
  const index = operations.findIndex((entry) => advancedOperationKey(entry) === key);
  assertAdvancedUiOperationCapacity(operations, operation, index);
  if (index >= 0) operations.splice(index, 1);
  if (retainsAdvancedState(operation)) operations.push(operation);
}
