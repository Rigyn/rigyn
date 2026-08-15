import { isProxy } from "node:util/types";

import type { JsonValue } from "./json.js";

export interface BoundedJsonSnapshotOptions {
  label: string;
  maximumBytes: number;
  maximumValues: number;
  maximumContainers: number;
  maximumDepth: number;
  ignoredNonEnumerableDataKeys?: readonly string[];
}

export interface BoundedJsonSnapshot {
  value: JsonValue;
  serialized: string;
  bytes: number;
}

type JsonContainer = JsonValue[] | Record<string, JsonValue>;

type SnapshotFrame =
  | {
    kind: "value";
    source: unknown;
    depth: number;
    parent?: JsonContainer;
    key?: string | number;
  }
  | { kind: "token"; value: string }
  | { kind: "exit"; source: object };

function boundedJsonStringToken(value: string, maximumBytes: number): { token: string; bytes: number } | undefined {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
      || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > maximumBytes) return undefined;
  }
  const token = JSON.stringify(value);
  return { token, bytes };
}

function assignSnapshotValue(
  parent: JsonContainer | undefined,
  key: string | number | undefined,
  value: JsonValue,
  selectRoot: (selected: JsonValue) => void,
): void {
  if (parent === undefined) {
    selectRoot(value);
    return;
  }
  if (Array.isArray(parent)) {
    parent[key as number] = value;
    return;
  }
  Object.defineProperty(parent, key as string, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function validatedLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function ignoredNonEnumerableDataKeys(options: BoundedJsonSnapshotOptions): ReadonlySet<string> {
  const selected = options.ignoredNonEnumerableDataKeys;
  if (selected === undefined) return new Set();
  if (isProxy(selected) || Object.getPrototypeOf(selected) !== Array.prototype || selected.length > 16) {
    throw new TypeError("ignoredNonEnumerableDataKeys must be a vanilla array of at most 16 unique strings");
  }
  const keys = Reflect.ownKeys(selected);
  if (keys.length !== selected.length + 1 || !keys.includes("length")) {
    throw new TypeError("ignoredNonEnumerableDataKeys must be a dense vanilla array");
  }
  const result = new Set<string>();
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string") {
      throw new TypeError("ignoredNonEnumerableDataKeys must not contain symbol keys");
    }
    const index = Number(key);
    const descriptor = Reflect.getOwnPropertyDescriptor(selected, key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= selected.length || String(index) !== key
      || descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)
      || typeof descriptor.value !== "string" || descriptor.value.length === 0
      || Buffer.byteLength(descriptor.value, "utf8") > 256
      || /[\u0000-\u001f\u007f-\u009f]/u.test(descriptor.value)
      || result.has(descriptor.value)) {
      throw new TypeError(
        "ignoredNonEnumerableDataKeys must contain unique non-empty printable strings of at most 256 UTF-8 bytes",
      );
    }
    result.add(descriptor.value);
  }
  if (result.size !== selected.length) {
    throw new TypeError("ignoredNonEnumerableDataKeys must be a dense vanilla array");
  }
  return result;
}

export function boundedJsonSnapshot(
  source: unknown,
  options: BoundedJsonSnapshotOptions,
): BoundedJsonSnapshot {
  if (typeof options.label !== "string" || options.label.length === 0 || options.label.length > 256
    || Buffer.byteLength(options.label, "utf8") > 256
    || /[\u0000-\u001f\u007f-\u009f]/u.test(options.label)) {
    throw new TypeError("Bounded JSON label must be a non-empty printable string of at most 256 UTF-8 bytes");
  }
  const maximumBytes = validatedLimit(options.maximumBytes, "maximumBytes");
  const maximumValues = validatedLimit(options.maximumValues, "maximumValues");
  const maximumContainers = validatedLimit(options.maximumContainers, "maximumContainers");
  const maximumDepth = validatedLimit(options.maximumDepth, "maximumDepth");
  const ignoredDataKeys = ignoredNonEnumerableDataKeys(options);
  const { label } = options;
  const active = new WeakSet<object>();
  const frames: SnapshotFrame[] = [{ kind: "value", source, depth: 0 }];
  const tokens: string[] = [];
  let values = 0;
  let containers = 0;
  let bytes = 0;
  let root: JsonValue = null;

  const fail: (message: string) => never = (message) => {
    throw new TypeError(`${label} ${message}`);
  };
  const addBytes = (added: number): void => {
    if (added > maximumBytes - bytes) fail(`exceeds ${maximumBytes} UTF-8 bytes`);
    bytes += added;
  };
  const stringToken = (value: string): string => {
    const selected = boundedJsonStringToken(value, maximumBytes - bytes);
    if (selected === undefined) fail(`exceeds ${maximumBytes} UTF-8 bytes`);
    addBytes(selected.bytes);
    return selected.token;
  };

  while (frames.length > 0) {
    const frame = frames.pop();
    if (frame === undefined) break;
    if (frame.kind === "token") {
      tokens.push(frame.value);
      continue;
    }
    if (frame.kind === "exit") {
      active.delete(frame.source);
      continue;
    }

    values += 1;
    if (values > maximumValues) fail(`exceeds ${maximumValues} JSON values`);
    if (frame.depth > maximumDepth) fail(`exceeds ${maximumDepth} levels`);
    const value = frame.source;
    if (value === null) {
      addBytes(4);
      tokens.push("null");
      assignSnapshotValue(frame.parent, frame.key, null, (selected) => { root = selected; });
      continue;
    }
    if (typeof value === "boolean") {
      const token = value ? "true" : "false";
      addBytes(token.length);
      tokens.push(token);
      assignSnapshotValue(frame.parent, frame.key, value, (selected) => { root = selected; });
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail("must contain only finite numbers");
      const selected = Object.is(value, -0) ? 0 : value;
      const token = JSON.stringify(selected);
      addBytes(token.length);
      tokens.push(token);
      assignSnapshotValue(frame.parent, frame.key, selected, (chosen) => { root = chosen; });
      continue;
    }
    if (typeof value === "string") {
      const token = stringToken(value);
      tokens.push(token);
      assignSnapshotValue(frame.parent, frame.key, value, (selected) => { root = selected; });
      continue;
    }
    if (typeof value !== "object") {
      fail("must contain only JSON values");
    }
    if (isProxy(value)) fail("must not contain proxies");
    if (active.has(value)) fail("must not contain cycles");

    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(value) as object | null;
    } catch {
      fail("could not be inspected safely");
    }
    const array = Array.isArray(value);
    if ((array && prototype !== Array.prototype)
      || (!array && prototype !== Object.prototype && prototype !== null)) {
      fail("must contain only plain objects and vanilla arrays");
    }
    containers += 1;
    if (containers > maximumContainers) fail(`exceeds ${maximumContainers} JSON containers`);

    let keys: PropertyKey[];
    let descriptors: Array<{ key: string | number; value: unknown }>;
    if (array) {
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
      if (!Number.isSafeInteger(length) || (length as number) < 0) {
        fail("must contain only dense vanilla arrays");
      }
      if ((length as number) > maximumValues - values) {
        fail(`exceeds ${maximumValues} JSON values`);
      }
      try {
        keys = Reflect.ownKeys(value);
      } catch {
        fail("could not be inspected safely");
      }
      descriptors = new Array<{ key: number; value: unknown }>(length as number);
      let elements = 0;
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string") fail("must not contain symbol keys");
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && descriptor.enumerable === false && "value" in descriptor
          && ignoredDataKeys.has(key)) {
          continue;
        }
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= (length as number) || String(index) !== key) {
          fail("must contain only dense arrays without extra properties");
        }
        if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
          fail("must contain only enumerable data properties");
        }
        descriptors[index] = { key: index, value: descriptor.value };
        elements += 1;
      }
      if (elements !== length) fail("must contain only dense arrays without extra properties");
      addBytes(2 + Math.max(0, (length as number) - 1));
    } else {
      try {
        keys = Reflect.ownKeys(value);
      } catch {
        fail("could not be inspected safely");
      }
      descriptors = [];
      for (const key of keys) {
        if (typeof key !== "string") fail("must not contain symbol keys");
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && descriptor.enumerable === false && "value" in descriptor
          && ignoredDataKeys.has(key)) {
          continue;
        }
        if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
          fail("must contain only enumerable data properties");
        }
        descriptors.push({ key, value: descriptor.value });
      }
      if (descriptors.length > maximumValues - values) fail(`exceeds ${maximumValues} JSON values`);
      addBytes(2 + Math.max(0, descriptors.length - 1) + descriptors.length);
    }

    const snapshot: JsonContainer = array
      ? new Array<JsonValue>(descriptors.length)
      : Object.create(null) as Record<string, JsonValue>;
    assignSnapshotValue(frame.parent, frame.key, snapshot, (selected) => { root = selected; });
    active.add(value);
    frames.push({ kind: "exit", source: value });
    frames.push({ kind: "token", value: array ? "]" : "}" });
    for (let index = descriptors.length - 1; index >= 0; index -= 1) {
      const descriptor = descriptors[index];
      if (descriptor === undefined) fail("must contain only dense arrays without extra properties");
      if (index < descriptors.length - 1) frames.push({ kind: "token", value: "," });
      frames.push({
        kind: "value",
        source: descriptor.value,
        depth: frame.depth + 1,
        parent: snapshot,
        key: descriptor.key,
      });
      if (!array) {
        frames.push({ kind: "token", value: ":" });
        frames.push({ kind: "token", value: stringToken(descriptor.key as string) });
      }
    }
    tokens.push(array ? "[" : "{");
  }

  const serialized = tokens.join("");
  if (Buffer.byteLength(serialized, "utf8") !== bytes) {
    throw new TypeError(`${label} could not be serialized safely`);
  }
  return { value: root, serialized, bytes };
}
