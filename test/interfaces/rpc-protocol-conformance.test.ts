import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RPC_METHOD_NAMES,
  RPC_NOTIFICATION_NAMES,
  RPC_ERROR_CODES,
  renderRpcErrorReference,
  renderRpcMethodReference,
  renderRpcNotificationReference,
} from "../../src/interfaces/rpc-protocol.js";

function methodHandlerRegistry(source: string): string | undefined {
  const normalized = source.replaceAll("\r\n", "\n");
  return /#createMethodHandlers\(\): RpcMethodHandlerRegistry \{\n    return \{\n([\s\S]*?)\n    \} satisfies RpcMethodHandlerRegistry;/u.exec(normalized)?.[1];
}

test("typed protocol exhaustively matches dispatcher methods and emitted notifications", async () => {
  const source = await readFile(new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url), "utf8");
  const registry = methodHandlerRegistry(source);
  assert.ok(registry, "dispatcher must define a typed method registry");
  const crlfSource = source.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
  assert.ok(methodHandlerRegistry(crlfSource), "dispatcher registry discovery must support CRLF source");
  const methods = [...registry.matchAll(/^      "([^"]+)":/gmu)].map((match) => match[1]!);
  assert.equal(new Set(methods).size, methods.length, "dispatcher contains duplicate method registrations");
  assert.deepEqual([...methods].sort(), [...RPC_METHOD_NAMES].sort());
  assert.doesNotMatch(source, /switch\s*\(\s*request\.method\s*\)/u);

  const notifications = new Set([
    ...[...source.matchAll(/#notify\(\s*[^,]+,\s*"([^"]+)"/gu)].map((match) => match[1]!),
    ...[...source.matchAll(/\.notification\("([^"]+)"/gu)].map((match) => match[1]!),
  ]);
  assert.deepEqual([...notifications].sort(), [...RPC_NOTIFICATION_NAMES].sort());
});

test("published RPC method reference is rendered from the typed contract", async () => {
  const documentation = (await readFile(new URL("../../docs/rpc.md", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const section = /<!-- rpc-methods:start -->\n([\s\S]*?)\n<!-- rpc-methods:end -->/u.exec(documentation)?.[1];
  assert.equal(section, renderRpcMethodReference());
});

test("published RPC notification and error references are rendered from the typed contract", async () => {
  const documentation = (await readFile(new URL("../../docs/rpc.md", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const notifications = /<!-- rpc-notifications:start -->\n([\s\S]*?)\n<!-- rpc-notifications:end -->/u.exec(documentation)?.[1];
  const errors = /<!-- rpc-errors:start -->\n([\s\S]*?)\n<!-- rpc-errors:end -->/u.exec(documentation)?.[1];
  assert.equal(notifications, renderRpcNotificationReference());
  assert.equal(errors, renderRpcErrorReference());
});

test("RPC server and dispatcher use the published error codes", async () => {
  const server = await readFile(new URL("../../src/cli/rpc.ts", import.meta.url), "utf8");
  const dispatcher = await readFile(new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url), "utf8");
  assert.match(server, /RPC_ERROR_CODES\.parse/u);
  assert.match(server, /RPC_ERROR_CODES\.invalidParams/u);
  assert.match(dispatcher, /RPC_ERROR_CODES\.methodNotFound/u);
  assert.deepEqual(RPC_ERROR_CODES, { parse: -32700, methodNotFound: -32601, invalidParams: -32602 });
});
