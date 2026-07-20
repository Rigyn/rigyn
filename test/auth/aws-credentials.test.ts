import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveAwsDefaultCredentials } from "../../src/auth/aws-credentials.js";
import { SecretRedactor } from "../../src/auth/redaction.js";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const EXPIRATION = "2026-01-01T01:00:00Z";

async function temporaryDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-aws-auth-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("AWS resolves complete environment credentials first and registers secrets", async () => {
  const redactor = new SecretRedactor();
  const credential = await resolveAwsDefaultCredentials({
    environment: {
      AWS_ACCESS_KEY_ID: "environment-access-key",
      AWS_SECRET_ACCESS_KEY: "environment-secret-key",
      AWS_SESSION_TOKEN: "environment-session-token",
    },
    fetch: async () => {
      throw new Error("network must not be called");
    },
    redactor,
  });
  assert.deepEqual(credential, {
    accessKeyId: "environment-access-key",
    secretAccessKey: "environment-secret-key",
    sessionToken: "environment-session-token",
    source: "environment",
  });
  assert.equal(
    redactor.redact("environment-access-key environment-secret-key environment-session-token"),
    "[REDACTED] [REDACTED] [REDACTED]",
  );
});

test("AWS merges profile files and credentials-file static keys take precedence", async (context) => {
  const directory = await temporaryDirectory(context);
  const credentialsPath = join(directory, "credentials");
  const configPath = join(directory, "config");
  await writeFile(
    credentialsPath,
    "[dev]\naws_access_key_id = profile-access\naws_secret_access_key = profile-secret\naws_session_token = profile-session\n",
  );
  await writeFile(
    configPath,
    "[profile dev]\naws_access_key_id = ignored-access\naws_secret_access_key = ignored-secret\nregion = us-west-2\n",
  );
  const credential = await resolveAwsDefaultCredentials({
    environment: {
      AWS_PROFILE: "dev",
      AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
      AWS_CONFIG_FILE: configPath,
    },
    homeDirectory: directory,
  });
  assert.deepEqual(credential, {
    accessKeyId: "profile-access",
    secretAccessKey: "profile-secret",
    sessionToken: "profile-session",
    source: "profile:dev:static",
  });
});

test("AWS delegates source-profile role assumption to the official profile chain", async (context) => {
  const directory = await temporaryDirectory(context);
  const credentialsPath = join(directory, "credentials");
  const configPath = join(directory, "config");
  await writeFile(credentialsPath, "[source]\naws_access_key_id = source-access\naws_secret_access_key = source-secret\n");
  await writeFile(
    configPath,
    "[profile delegated]\nrole_arn = arn:aws:iam::123456789012:role/Delegated\nsource_profile = source\nregion = ca-central-1\n",
  );
  let received: Record<string, unknown> | undefined;
  const redactor = new SecretRedactor();
  const credential = await resolveAwsDefaultCredentials({
    environment: {
      AWS_PROFILE: "delegated",
      AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
      AWS_CONFIG_FILE: configPath,
    },
    homeDirectory: directory,
    redactor,
    profileChainResolver: async (input) => {
      received = input as unknown as Record<string, unknown>;
      return {
        accessKeyId: "assumed-access",
        secretAccessKey: "assumed-secret",
        sessionToken: "assumed-session",
        expiresAt: NOW + 3_600_000,
      };
    },
  });
  assert.equal(received?.profile, "delegated");
  assert.equal(received?.credentialsFilepath, credentialsPath);
  assert.equal(received?.configFilepath, configPath);
  assert.equal(received?.region, "ca-central-1");
  assert.deepEqual(credential, {
    accessKeyId: "assumed-access",
    secretAccessKey: "assumed-secret",
    sessionToken: "assumed-session",
    expiresAt: NOW + 3_600_000,
    source: "profile:delegated:official-chain",
  });
  assert.equal(redactor.redact("assumed-access assumed-secret assumed-session"), "[REDACTED] [REDACTED] [REDACTED]");
});

test("AWS delegates IAM Identity Center profiles to the official profile chain", async (context) => {
  const directory = await temporaryDirectory(context);
  const configPath = join(directory, "config");
  await writeFile(
    configPath,
    [
      "[profile workforce]",
      "sso_session = company",
      "sso_account_id = 123456789012",
      "sso_role_name = Developer",
      "region = us-east-2",
      "",
      "[sso-session company]",
      "sso_start_url = https://example.awsapps.com/start",
      "sso_region = us-east-1",
      "",
    ].join("\n"),
  );
  let calls = 0;
  const credential = await resolveAwsDefaultCredentials({
    environment: { AWS_PROFILE: "workforce", AWS_CONFIG_FILE: configPath },
    homeDirectory: directory,
    profileChainResolver: async ({ profile, region }) => {
      calls += 1;
      assert.equal(profile, "workforce");
      assert.equal(region, "us-east-2");
      return { accessKeyId: "sso-access", secretAccessKey: "sso-secret", source: "sso-cache" };
    },
  });
  assert.equal(calls, 1);
  assert.equal(credential?.source, "sso-cache");
});

test("AWS credential_process is tokenized without a shell and has bounded inputs", async (context) => {
  const directory = await temporaryDirectory(context);
  const configPath = join(directory, "config");
  await writeFile(
    configPath,
    '[profile process]\ncredential_process = "/opt/credential helper" --account "hello world"\n',
  );
  let call: { command: string; args?: readonly string[]; environment?: NodeJS.ProcessEnv } | undefined;
  const credential = await resolveAwsDefaultCredentials({
    environment: {
      AWS_PROFILE: "process",
      AWS_CONFIG_FILE: configPath,
      AUTH_MUST_NOT_LEAK: "parent-secret",
      PATH: "/usr/bin",
    },
    homeDirectory: directory,
    now: () => NOW,
    processRunner: async (options) => {
      call = options;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          Version: 1,
          AccessKeyId: "process-access",
          SecretAccessKey: "process-secret",
          SessionToken: "process-session",
          Expiration: EXPIRATION,
          AccountId: "123456789012",
        }),
        stderr: "",
      };
    },
  });
  assert.deepEqual(call?.command, "/opt/credential helper");
  assert.deepEqual(call?.args, ["--account", "hello world"]);
  assert.equal(call?.environment?.AWS_PROFILE, "process");
  assert.equal(call?.environment?.AUTH_MUST_NOT_LEAK, undefined);
  assert.deepEqual(credential, {
    accessKeyId: "process-access",
    secretAccessKey: "process-secret",
    sessionToken: "process-session",
    expiresAt: Date.parse(EXPIRATION),
    accountId: "123456789012",
    source: "profile:process:credential_process",
  });
});

test("AWS exchanges a web identity token using unsigned regional STS", async (context) => {
  const directory = await temporaryDirectory(context);
  const tokenPath = join(directory, "web-token");
  await writeFile(tokenPath, "oidc-web-identity-token\n");
  let endpoint = "";
  let body = "";
  const credential = await resolveAwsDefaultCredentials({
    environment: {
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/harness",
      AWS_ROLE_SESSION_NAME: "harness-session",
      AWS_WEB_IDENTITY_TOKEN_FILE: tokenPath,
      AWS_REGION: "ca-central-1",
    },
    homeDirectory: directory,
    now: () => NOW,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      endpoint = String(input);
      body = String(init?.body);
      return new Response(
        `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>` +
          `<AccessKeyId>sts-access</AccessKeyId><SecretAccessKey>sts-secret</SecretAccessKey>` +
          `<SessionToken>sts-session</SessionToken><Expiration>${EXPIRATION}</Expiration>` +
          `</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
      );
    }) as typeof fetch,
  });
  assert.equal(endpoint, "https://sts.ca-central-1.amazonaws.com/");
  const parameters = new URLSearchParams(body);
  assert.equal(parameters.get("Action"), "AssumeRoleWithWebIdentity");
  assert.equal(parameters.get("WebIdentityToken"), "oidc-web-identity-token");
  assert.deepEqual(credential, {
    accessKeyId: "sts-access",
    secretAccessKey: "sts-secret",
    sessionToken: "sts-session",
    expiresAt: Date.parse(EXPIRATION),
    source: "environment:web_identity",
  });
});

test("AWS container credentials prefer the token file and constrain HTTP endpoints", async (context) => {
  const directory = await temporaryDirectory(context);
  const tokenPath = join(directory, "container-token");
  await writeFile(tokenPath, "Bearer file-token\n");
  let endpoint = "";
  let authorization = "";
  const credential = await resolveAwsDefaultCredentials({
    environment: {
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task?id=one",
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: tokenPath,
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "Bearer ignored-token",
    },
    homeDirectory: directory,
    now: () => NOW,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      endpoint = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({
        AccessKeyId: "container-access",
        SecretAccessKey: "container-secret",
        Token: "container-session",
        Expiration: EXPIRATION,
      });
    }) as typeof fetch,
  });
  assert.equal(endpoint, "http://169.254.170.2/v2/credentials/task?id=one");
  assert.equal(authorization, "Bearer file-token");
  assert.equal(credential?.source, "container");

  await assert.rejects(
    resolveAwsDefaultCredentials({
      environment: { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://example.com/credentials" },
      homeDirectory: directory,
    }),
    /HTTPS or an AWS\/loopback metadata host/,
  );
});

test("AWS EC2 fallback uses IMDSv2 and never falls back to IMDSv1", async (context) => {
  const directory = await temporaryDirectory(context);
  const calls: Array<{ url: string; method: string; token?: string }> = [];
  const credential = await resolveAwsDefaultCredentials({
    environment: {},
    homeDirectory: directory,
    now: () => NOW,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const token = headers.get("x-aws-ec2-metadata-token");
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        ...(token === null ? {} : { token }),
      });
      if (calls.length === 1) return new Response("imds-v2-token");
      if (calls.length === 2) return new Response("instance-role\n");
      return Response.json({
        Code: "Success",
        AccessKeyId: "imds-access",
        SecretAccessKey: "imds-secret",
        Token: "imds-session",
        Expiration: EXPIRATION,
      });
    }) as typeof fetch,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], {
    url: "http://169.254.169.254/latest/api/token",
    method: "PUT",
  });
  assert.equal(calls[1]?.token, "imds-v2-token");
  assert.equal(calls[2]?.token, "imds-v2-token");
  assert.equal(credential?.source, "imds_v2");
});

test("AWS rejects partial configured credentials instead of silently changing identities", async () => {
  await assert.rejects(
    resolveAwsDefaultCredentials({ environment: { AWS_ACCESS_KEY_ID: "only-access" } }),
    /incomplete/,
  );
});
