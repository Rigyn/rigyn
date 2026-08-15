import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveAzureDefaultCredential } from "../../src/auth/azure-identity.js";
import { SecretRedactor } from "../../src/auth/redaction.js";

const NOW = Date.parse("2026-01-01T00:00:00Z");

async function temporaryDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-azure-auth-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("Azure exchanges service-principal environment credentials", async () => {
  const redactor = new SecretRedactor();
  let form: URLSearchParams | undefined;
  const token = await resolveAzureDefaultCredential({
    environment: {
      AZURE_TENANT_ID: "tenant-id",
      AZURE_CLIENT_ID: "client-id",
      AZURE_CLIENT_SECRET: "client-secret-value",
    },
    now: () => NOW,
    redactor,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token");
      form = new URLSearchParams(String(init?.body));
      return Response.json({ access_token: "entra-access", token_type: "Bearer", expires_in: 3600 });
    }) as typeof fetch,
  });
  assert.equal(form?.get("grant_type"), "client_credentials");
  assert.equal(form?.get("scope"), "https://cognitiveservices.azure.com/.default");
  assert.equal(form?.get("client_secret"), "client-secret-value");
  assert.equal(token?.source, "environment:client_secret");
  assert.doesNotMatch(redactor.redact("client-secret-value entra-access"), /client-secret-value|entra-access/);
});

test("Azure workload identity reads a bounded assertion file", async (context) => {
  const directory = await temporaryDirectory(context);
  const tokenPath = join(directory, "federated-token");
  await writeFile(tokenPath, "federated-jwt-assertion\n");
  let form: URLSearchParams | undefined;
  const token = await resolveAzureDefaultCredential({
    environment: {
      AZURE_TENANT_ID: "tenant-id",
      AZURE_CLIENT_ID: "client-id",
      AZURE_FEDERATED_TOKEN_FILE: tokenPath,
    },
    now: () => NOW,
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      form = new URLSearchParams(String(init?.body));
      return Response.json({ access_token: "workload-access", expires_in: 1800 });
    }) as typeof fetch,
  });
  assert.equal(form?.get("client_assertion"), "federated-jwt-assertion");
  assert.equal(
    form?.get("client_assertion_type"),
    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
  );
  assert.equal(token?.source, "environment:workload_identity");
});

test("Azure App Service managed identity uses only the loopback endpoint and rotating header", async () => {
  let requested = "";
  let identityHeader = "";
  const token = await resolveAzureDefaultCredential({
    environment: {
      IDENTITY_ENDPOINT: "http://127.0.0.1:41741/MSI/token",
      IDENTITY_HEADER: "rotating-identity-header",
      AZURE_CLIENT_ID: "user-assigned-client",
    },
    now: () => NOW,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requested = String(input);
      identityHeader = new Headers(init?.headers).get("x-identity-header") ?? "";
      return Response.json({
        access_token: "app-service-access",
        expires_on: String(Math.floor((NOW + 3_600_000) / 1000)),
        client_id: "user-assigned-client",
      });
    }) as typeof fetch,
  });
  const url = new URL(requested);
  assert.equal(url.searchParams.get("api-version"), "2019-08-01");
  assert.equal(url.searchParams.get("resource"), "https://cognitiveservices.azure.com");
  assert.equal(url.searchParams.get("client_id"), "user-assigned-client");
  assert.equal(identityHeader, "rotating-identity-header");
  assert.equal(token?.source, "app_service_managed_identity");
});

test("Azure VM managed identity uses the fixed IMDS endpoint and Metadata header", async () => {
  let endpoint = "";
  const token = await resolveAzureDefaultCredential({
    environment: {},
    now: () => NOW,
    allowAzureCli: false,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      endpoint = String(input);
      assert.equal(new Headers(init?.headers).get("metadata"), "true");
      return Response.json({
        access_token: "imds-access",
        expires_on: Math.floor((NOW + 3_600_000) / 1000),
      });
    }) as typeof fetch,
  });
  const url = new URL(endpoint);
  assert.equal(url.origin, "http://169.254.169.254");
  assert.equal(url.pathname, "/metadata/identity/oauth2/token");
  assert.equal(url.searchParams.get("api-version"), "2018-02-01");
  assert.equal(token?.source, "imds_managed_identity");
});

test("Azure CLI is a shell-free final fallback with a minimal environment", async () => {
  let call: { command: string; args?: readonly string[]; environment?: NodeJS.ProcessEnv } | undefined;
  const token = await resolveAzureDefaultCredential({
    environment: {
      PATH: "/usr/bin",
      AZURE_CONFIG_DIR: "/safe/azure-config",
      AUTH_MUST_NOT_LEAK: "parent-secret",
    },
    now: () => NOW,
    fetch: (async () => new Response("not available", { status: 404 })) as typeof fetch,
    processRunner: async (options) => {
      call = options;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          accessToken: "cli-access",
          expires_on: Math.floor((NOW + 3_600_000) / 1000),
          tenant: "cli-tenant",
        }),
        stderr: "",
      };
    },
  });
  assert.equal(call?.command, "az");
  assert.deepEqual(call?.args, [
    "account",
    "get-access-token",
    "--scope",
    "https://cognitiveservices.azure.com/.default",
    "--output",
    "json",
    "--only-show-errors",
  ]);
  assert.equal(call?.environment?.AZURE_CONFIG_DIR, "/safe/azure-config");
  assert.equal(call?.environment?.AUTH_MUST_NOT_LEAK, undefined);
  assert.equal(token?.source, "azure_cli");
});

test("Azure refuses to send the App Service identity header to a non-loopback endpoint", async () => {
  await assert.rejects(
    resolveAzureDefaultCredential({
      environment: {
        IDENTITY_ENDPOINT: "https://example.com/token",
        IDENTITY_HEADER: "must-not-leak",
      },
      fetch: async () => {
        throw new Error("network must not be called");
      },
    }),
    /loopback/,
  );
});
