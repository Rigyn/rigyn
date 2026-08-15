import { Socket } from "node:net";

const marker = Symbol.for("rigyn.offline-release-network-guard");

function isLoopback(hostname) {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return normalized === "localhost"
    || normalized === "localhost."
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || normalized.startsWith("127.")
    || normalized.startsWith("::ffff:127.");
}

function connectHost(args) {
  const first = args[0];
  if (typeof first === "number") return typeof args[1] === "string" ? args[1] : "localhost";
  if (first !== null && typeof first === "object") {
    if (typeof first.path === "string") return undefined;
    if (first.port !== undefined) {
      if (typeof first.hostname === "string") return first.hostname;
      if (typeof first.host === "string") return first.host;
      return "localhost";
    }
  }
  return undefined;
}

if (Reflect.get(globalThis, marker) !== true) {
  const nativeFetch = globalThis.fetch;
  const nativeConnect = Socket.prototype.connect;

  globalThis.fetch = async (input, init) => {
    const value = input instanceof Request ? input.url : String(input);
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && !isLoopback(url.hostname)) {
      throw new Error(`External network access is disabled in the offline release evaluation: ${url.origin}`);
    }
    return await nativeFetch(input, init);
  };

  Socket.prototype.connect = function guardedConnect(...args) {
    const hostname = connectHost(args);
    if (hostname !== undefined && !isLoopback(hostname)) {
      throw new Error(`External network access is disabled in the offline release evaluation: ${hostname}`);
    }
    return nativeConnect.apply(this, args);
  };

  Object.defineProperty(globalThis, marker, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
}
