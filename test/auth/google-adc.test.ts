import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveGoogleApplicationDefaultCredentials } from "../../src/auth/google-adc.js";
import { SecretRedactor } from "../../src/auth/redaction.js";

const NOW = Date.parse("2026-01-01T00:00:00Z");

async function temporaryDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-google-auth-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("Google ADC refreshes an authorized_user file and carries quota project", async (context) => {
  const directory = await temporaryDirectory(context);
  const path = join(directory, "adc.json");
  await writeFile(
    path,
    JSON.stringify({
      type: "authorized_user",
      client_id: "oauth-client-id",
      client_secret: "oauth-client-secret",
      refresh_token: "oauth-refresh-token",
      quota_project_id: "billing-project",
    }),
  );
  const redactor = new SecretRedactor();
  let form: URLSearchParams | undefined;
  const token = await resolveGoogleApplicationDefaultCredentials({
    environment: { GOOGLE_APPLICATION_CREDENTIALS: path },
    homeDirectory: directory,
    now: () => NOW,
    redactor,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "https://oauth2.googleapis.com/token");
      form = new URLSearchParams(String(init?.body));
      return Response.json({ access_token: "authorized-user-access", expires_in: 3600 });
    }) as typeof fetch,
  });
  assert.equal(form?.get("grant_type"), "refresh_token");
  assert.equal(form?.get("client_secret"), "oauth-client-secret");
  assert.deepEqual(token, {
    accessToken: "authorized-user-access",
    expiresAt: NOW + 3_600_000,
    tokenType: "Bearer",
    source: "environment_file",
    quotaProjectId: "billing-project",
  });
  assert.doesNotMatch(
    redactor.redact("oauth-client-secret oauth-refresh-token authorized-user-access"),
    /oauth-client-secret|oauth-refresh-token|authorized-user-access/,
  );
});

test("Google ADC signs a standards-shaped RS256 service-account assertion", async (context) => {
  const directory = await temporaryDirectory(context);
  const path = join(directory, "service-account.json");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await writeFile(
    path,
    JSON.stringify({
      type: "service_account",
      client_email: "harness@example-project.iam.gserviceaccount.com",
      private_key: privateKeyPem,
      private_key_id: "key-id",
      project_id: "example-project",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  );
  let assertion = "";
  const token = await resolveGoogleApplicationDefaultCredentials({
    environment: { GOOGLE_APPLICATION_CREDENTIALS: path },
    homeDirectory: directory,
    now: () => NOW,
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      assertion = new URLSearchParams(String(init?.body)).get("assertion") ?? "";
      return Response.json({ access_token: "service-account-access", expires_in: 1800 });
    }) as typeof fetch,
  });
  const parts = assertion.split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  const claim = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(header, { alg: "RS256", typ: "JWT", kid: "key-id" });
  assert.equal(claim.iss, "harness@example-project.iam.gserviceaccount.com");
  assert.equal(claim.scope, "https://www.googleapis.com/auth/cloud-platform");
  assert.equal(claim.iat, Math.floor(NOW / 1000));
  assert.equal(claim.exp, Math.floor(NOW / 1000) + 3600);
  assert.equal(token?.projectId, "example-project");
  assert.equal(token?.serviceAccountEmail, "harness@example-project.iam.gserviceaccount.com");
});

test("Google external-account ADC exchanges a file token then impersonates a service account", async (context) => {
  const directory = await temporaryDirectory(context);
  const subjectPath = join(directory, "subject-token");
  const adcPath = join(directory, "external.json");
  await writeFile(subjectPath, "external-oidc-subject\n");
  await writeFile(
    adcPath,
    JSON.stringify({
      type: "external_account",
      audience: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/provider",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { file: subjectPath, format: { type: "text" } },
      service_account_impersonation_url:
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/agent%40example.iam.gserviceaccount.com:generateAccessToken",
      service_account_impersonation: { token_lifetime_seconds: 1800 },
      quota_project_id: "quota-project",
    }),
  );
  const calls: Array<{ url: string; authorization?: string; body: string }> = [];
  const token = await resolveGoogleApplicationDefaultCredentials({
    environment: { GOOGLE_APPLICATION_CREDENTIALS: adcPath },
    homeDirectory: directory,
    now: () => NOW,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push({
        url: String(input),
        ...(authorization === null ? {} : { authorization }),
        body: String(init?.body),
      });
      if (calls.length === 1) {
        return Response.json({ access_token: "federated-access", expires_in: 900, token_type: "Bearer" });
      }
      return Response.json({
        accessToken: "impersonated-access",
        expireTime: "2026-01-01T00:30:00Z",
      });
    }) as typeof fetch,
  });
  const stsForm = new URLSearchParams(calls[0]?.body);
  assert.equal(stsForm.get("subject_token"), "external-oidc-subject");
  assert.equal(calls[1]?.authorization, "Bearer federated-access");
  assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), {
    scope: ["https://www.googleapis.com/auth/cloud-platform"],
    lifetime: "1800s",
  });
  assert.deepEqual(token, {
    accessToken: "impersonated-access",
    expiresAt: Date.parse("2026-01-01T00:30:00Z"),
    tokenType: "Bearer",
    source: "environment_file:service_account_impersonation",
    serviceAccountEmail: "agent@example.iam.gserviceaccount.com",
    quotaProjectId: "quota-project",
  });
});

test("Google ADC falls back to metadata with the required flavor header", async (context) => {
  const directory = await temporaryDirectory(context);
  const token = await resolveGoogleApplicationDefaultCredentials({
    environment: {
      GOOGLE_CLOUD_PROJECT: "environment-project",
      GOOGLE_CLOUD_QUOTA_PROJECT: "environment-quota-project",
    },
    homeDirectory: directory,
    now: () => NOW,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(
        String(input),
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      );
      assert.equal(new Headers(init?.headers).get("metadata-flavor"), "Google");
      return Response.json(
        { access_token: "metadata-access", expires_in: 3599, token_type: "Bearer" },
        { headers: { "metadata-flavor": "Google" } },
      );
    }) as typeof fetch,
  });
  assert.equal(token?.source, "metadata");
  assert.equal(token?.accessToken, "metadata-access");
  assert.equal(token?.projectId, "environment-project");
  assert.equal(token?.quotaProjectId, "environment-quota-project");
});

test("Google external-account resolver rejects unsupported AWS credential sources", async (context) => {
  const directory = await temporaryDirectory(context);
  const path = join(directory, "aws-external.json");
  await writeFile(
    path,
    JSON.stringify({
      type: "external_account",
      audience: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/aws",
      subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { environment_id: "aws1" },
    }),
  );
  await assert.rejects(
    resolveGoogleApplicationDefaultCredentials({
      environment: { GOOGLE_APPLICATION_CREDENTIALS: path },
      homeDirectory: directory,
    }),
    /AWS credential sources are not supported/,
  );
});
