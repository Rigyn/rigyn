import type { JsonValue } from "../core/json.js";
import type { ToolContext, ToolInputPreparer, ToolResult } from "../tools/types.js";
import { assertSupportedSchema } from "../tools/schema.js";
import type { RuntimeToolContext, RuntimeToolRegistration } from "./runtime.js";

export type TypedRuntimeToolRegistration<Input extends JsonValue> = Omit<
  RuntimeToolRegistration,
  "prepareInput" | "validate" | "resources" | "execute"
> & {
  prepareInput?: (
    input: JsonValue,
    context: ToolContext,
  ) => Input | Promise<Input>;
  validate?(input: Input): void;
  resources?(
    input: Input,
    context: ToolContext,
  ): ReturnType<NonNullable<RuntimeToolRegistration["resources"]>>;
  execute(input: Input, context: RuntimeToolContext): ToolResult | Promise<ToolResult>;
};

/**
 * Adds TypeScript input inference to the normal runtime-tool contract.
 * Runtime schema validation, resource coordination, output bounds, and
 * cancellation continue through the host's ordinary tool path.
 */
export function defineRuntimeTool<Input extends JsonValue>(
  registration: TypedRuntimeToolRegistration<Input>,
): RuntimeToolRegistration {
  assertSupportedSchema(registration.inputSchema);
  const prepareInput: ToolInputPreparer | undefined = registration.prepareInput;
  const validate = registration.validate;
  const resources = registration.resources;
  const execute = registration.execute;
  return {
    ...registration,
    ...(prepareInput === undefined ? {} : { prepareInput }),
    ...(validate === undefined
      ? {}
      : { validate: (input) => validate(input as Input) }),
    ...(resources === undefined
      ? {}
      : { resources: (input, context) => resources(input as Input, context) }),
    execute: (input, context) => execute(input as Input, context),
  };
}
