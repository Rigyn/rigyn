import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import type { JsonValue } from "../../src/core/json.js";
import {
  assertSchema,
  assertSupportedSchema,
  coerceSchemaValue,
  validateSchema,
} from "../../src/tools/schema.js";

function jsonSchema(value: unknown): Record<string, JsonValue> {
  return value as Record<string, JsonValue>;
}

test("TypeBox tool schemas coerce nested unions, intersections, tuples, and recursive references", () => {
  const recursive = Type.Cyclic({
    node: Type.Object({
      value: Type.Number(),
      next: Type.Union([Type.Ref("node"), Type.Null()]),
    }),
  }, "node");
  const schema = Type.Object({
    count: Type.Number({ minimum: 1, maximum: 10 }),
    enabled: Type.Boolean(),
    tuple: Type.Tuple([Type.Integer(), Type.Boolean()]),
    union: Type.Union([Type.Integer({ minimum: 10 }), Type.Literal("ready")]),
    intersection: Type.Intersect([
      Type.Object({ left: Type.Number() }),
      Type.Object({ right: Type.Boolean() }),
    ]),
    extras: Type.Object({}, { additionalProperties: Type.Integer() }),
    optionalDefault: Type.Optional(Type.Number({ default: 7 })),
    recursive,
  });
  const input = {
    count: "4",
    enabled: "true",
    tuple: ["3", "false"],
    union: "11",
    intersection: { left: "2.5", right: "true" },
    extras: { first: "8", second: false },
    recursive: { value: "1", next: { value: "2", next: null } },
  };

  assert.deepEqual(assertSchema(jsonSchema(schema), input), {
    count: 4,
    enabled: true,
    tuple: [3, false],
    union: 11,
    intersection: { left: 2.5, right: true },
    extras: { first: 8, second: 0 },
    recursive: { value: 1, next: { value: 2, next: null } },
  });
  assert.deepEqual(input, {
    count: "4",
    enabled: "true",
    tuple: ["3", "false"],
    union: "11",
    intersection: { left: "2.5", right: "true" },
    extras: { first: "8", second: false },
    recursive: { value: "1", next: { value: "2", next: null } },
  });
});

test("serialized JSON schemas coerce objects, arrays, tuples, combinators, and schema-valued extras", () => {
  const schema = jsonSchema({
    type: "object",
    additionalProperties: false,
    required: ["nested", "tuple", "intersection", "choice", "exclusive", "extras", "typedUnion"],
    properties: {
      nested: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["score"],
          properties: { score: { type: "number", minimum: 0, maximum: 5 } },
        },
      },
      tuple: {
        type: "array",
        items: [{ type: "integer" }, { type: "boolean" }],
        additionalItems: false,
        minItems: 2,
        maxItems: 2,
      },
      intersection: {
        allOf: [
          { type: "object", required: ["left"], properties: { left: { type: "number" } } },
          { type: "object", required: ["right"], properties: { right: { type: "boolean" } } },
        ],
      },
      choice: { anyOf: [{ type: "integer", minimum: 10 }, { type: "string", pattern: "^ready$" }] },
      exclusive: { oneOf: [{ type: "boolean" }, { type: "integer", minimum: 2 }] },
      extras: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
      typedUnion: { type: ["number", "string"] },
    },
  });
  const input = {
    nested: [{ score: "2.5" }],
    tuple: ["4", "true"],
    intersection: { left: "3", right: "false" },
    choice: "11",
    exclusive: "true",
    extras: { first: "9", second: true },
    typedUnion: "1",
  };

  assert.deepEqual(assertSchema(schema, input), {
    nested: [{ score: 2.5 }],
    tuple: [4, true],
    intersection: { left: 3, right: false },
    choice: 11,
    exclusive: true,
    extras: { first: 9, second: 1 },
    typedUnion: "1",
  });
  assert.deepEqual(validateSchema(schema, input), []);
});

test("plain JSON primitive coercion follows serialized-schema compatibility rules", () => {
  const cases: Array<[Record<string, JsonValue>, JsonValue, JsonValue]> = [
    [jsonSchema({ type: "number" }), "42", 42],
    [jsonSchema({ type: "number" }), true, 1],
    [jsonSchema({ type: "number" }), null, 0],
    [jsonSchema({ type: "integer" }), "42", 42],
    [jsonSchema({ type: "boolean" }), "true", true],
    [jsonSchema({ type: "boolean" }), "false", false],
    [jsonSchema({ type: "boolean" }), 1, true],
    [jsonSchema({ type: "boolean" }), 0, false],
    [jsonSchema({ type: "string" }), null, ""],
    [jsonSchema({ type: "string" }), true, "true"],
    [jsonSchema({ type: "null" }), "", null],
    [jsonSchema({ type: ["number", "string"] }), "1", "1"],
    [jsonSchema({ type: ["boolean", "number"] }), "1", 1],
  ];
  for (const [schema, input, expected] of cases) {
    assert.deepEqual(assertSchema(schema, input), expected);
  }

  for (const [schema, input] of [
    [jsonSchema({ type: "boolean" }), "1"],
    [jsonSchema({ type: "null" }), "null"],
    [jsonSchema({ type: "integer" }), "42.1"],
  ] as Array<[Record<string, JsonValue>, JsonValue]>) {
    assert.throws(() => assertSchema(schema, input), /must/u);
  }
});

test("serialized recursive references are validated and coerced without changing the source", () => {
  const schema = jsonSchema({
    $defs: {
      node: {
        $id: "node",
        type: "object",
        additionalProperties: false,
        required: ["value", "next"],
        properties: {
          value: { type: "number" },
          next: { anyOf: [{ $ref: "node" }, { type: "null" }] },
        },
      },
    },
    $ref: "node",
  });
  const source = { value: "1", next: { value: "2", next: null } };
  assert.deepEqual(coerceSchemaValue(schema, source), { value: 1, next: { value: 2, next: null } });
  assert.deepEqual(assertSchema(schema, source), { value: 1, next: { value: 2, next: null } });
  assert.deepEqual(source, { value: "1", next: { value: "2", next: null } });
});

test("defaults remain annotations and compiler errors replace the old keyword allowlist", () => {
  const optional = jsonSchema({
    type: "object",
    properties: { count: { type: "number", default: 7 } },
  });
  const required = jsonSchema({
    type: "object",
    required: ["count"],
    properties: { count: { type: "number", default: 7 } },
  });
  assert.deepEqual(assertSchema(optional, {}), {});
  assert.throws(() => assertSchema(required, {}), /count.*required|required.*count/u);

  assert.doesNotThrow(() => assertSupportedSchema(jsonSchema({
    type: "number",
    exclusiveMinimum: 1,
    multipleOf: 2,
    unevaluatedProperties: false,
  })));
  assert.throws(
    () => assertSupportedSchema(jsonSchema({ type: "string", pattern: "[" })),
    /Invalid tool schema.*regular expression/u,
  );
});

test("constraints and additional-property policy report precise nested paths", () => {
  const schema = jsonSchema({
    type: "object",
    additionalProperties: false,
    required: ["name", "values"],
    properties: {
      name: { type: "string", minLength: 3, pattern: "^[a-z]+$" },
      values: { type: "array", minItems: 2, maxItems: 3, items: { type: "integer", minimum: 1 } },
    },
  });
  const issues = validateSchema(schema, { name: "A", values: [0], extra: true });
  assert.ok(issues.some((issue) => issue.path === "$.name" && /length|pattern/u.test(issue.message)));
  assert.ok(issues.some((issue) => issue.path === "$.values" && /items/u.test(issue.message)));
  assert.ok(issues.some((issue) => issue.path === "$.values[0]" && /minimum|greater|>=/u.test(issue.message)));
  assert.ok(issues.some((issue) => issue.path === "$" && /additional/u.test(issue.message)));
});
