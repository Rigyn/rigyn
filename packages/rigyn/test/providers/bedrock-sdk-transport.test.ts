import assert from "node:assert/strict";
import test from "node:test";

import { openBedrockSdkStream } from "../../src/providers/bedrock-sdk-transport.js";

test("Bedrock SDK transport advertises HTTP/1.1 through the host-owned request handler", async () => {
  let capturedConfig: Record<string, unknown> | undefined;
  let capturedCommand: Record<string, unknown> | undefined;
  let destroyed = false;

  class FakeBedrockRuntimeClient {
    readonly middlewareStack = {
      add(): void {},
    };

    constructor(config: Record<string, unknown>) {
      capturedConfig = config;
    }

    async send(command: { input: Record<string, unknown> }): Promise<{
      $metadata: { requestId: string };
      stream: AsyncIterable<never>;
    }> {
      capturedCommand = command.input;
      return {
        $metadata: { requestId: "request-sdk" },
        stream: (async function* (): AsyncGenerator<never> {})(),
      };
    }

    destroy(): void {
      destroyed = true;
    }
  }

  class FakeConverseStreamCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }

  const opened = await openBedrockSdkStream({
    modelId: "model-test",
    body: { messages: [{ role: "user", content: [{ text: "hello" }] }] },
    region: "us-east-1",
    endpoint: "https://bedrock-runtime.us-east-1.amazonaws.com",
    headers: new Headers(),
    credentials: { accessKeyId: "access", secretAccessKey: "secret" },
    signal: new AbortController().signal,
    fetch: () => {
      throw new Error("the fake SDK must not perform network I/O");
    },
    onResponse(): void {},
    loadSdk: async () => ({
      BedrockRuntimeClient: FakeBedrockRuntimeClient,
      ConverseStreamCommand: FakeConverseStreamCommand,
    }) as unknown as typeof import("@aws-sdk/client-bedrock-runtime"),
  });

  const requestHandler = capturedConfig?.requestHandler as {
    metadata?: { handlerProtocol?: string };
  } | undefined;
  assert.equal(requestHandler?.metadata?.handlerProtocol, "http/1.1");
  assert.equal(capturedConfig?.region, "us-east-1");
  assert.deepEqual(capturedCommand, {
    modelId: "model-test",
    messages: [{ role: "user", content: [{ text: "hello" }] }],
  });
  assert.equal(opened.requestId, "request-sdk");
  for await (const _event of opened.stream) {
    // Consume the owned stream so its client is disposed.
  }
  assert.equal(destroyed, true);
});
