import { valid, validRange } from "semver";

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,62}$/u;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}|[a-z0-9][a-z0-9._-]{0,127})$/u;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SRI = /^(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/u;

export type ExtensionGallerySource =
  | { kind: "npm"; package: string; version: string; integrity: string }
  | { kind: "git"; repository: string; revision: string };

export interface ExtensionGalleryContributionCounts {
  runtime: number;
  tools: number;
  commands: number;
  skills: number;
  prompts: number;
  themes: number;
  providers: number;
}

export interface ExtensionGalleryMedia {
  kind: "image" | "video";
  url: string;
  alt?: string;
}

export interface ExtensionGalleryPackage {
  id: string;
  name: string;
  version: string;
  description?: string;
  source: ExtensionGallerySource;
  compatibility: { hostVersion: string };
  contributions: ExtensionGalleryContributionCounts;
  readme: string;
  homepage?: string;
  media: ExtensionGalleryMedia[];
  publishedAt: string;
  integrity: {
    status: "verified" | "declared" | "unverified";
    digest?: string;
  };
  provenance: {
    status: "verified" | "publisher-asserted" | "unknown";
    detail?: string;
  };
  securityWarnings: string[];
  dependencyCount: number;
}

export interface ExtensionGalleryIndex {
  schemaVersion: 1;
  packages: ExtensionGalleryPackage[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function allowed(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown keys: ${unknown.join(", ")}`);
}

function string(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value) > maximum) {
    throw new Error(`${label} must be a non-empty string no larger than ${maximum} bytes`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : string(value, label, maximum);
}

function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be an array with at most ${maximum} entries`);
  return value;
}

function integer(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from 0 through ${maximum}`);
  }
  return value as number;
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`${label} is invalid`);
  return value as T;
}

function timestamp(value: unknown, label: string): string {
  const selected = string(value, label, 64);
  if (!Number.isFinite(Date.parse(selected)) || new Date(selected).toISOString() !== selected) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return selected;
}

function httpsUrl(value: unknown, label: string): string {
  const selected = string(value, label, 4096);
  let parsed: URL;
  try {
    parsed = new URL(selected);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    throw new Error(`${label} must be a credential-free HTTPS URL without a fragment`);
  }
  return parsed.href;
}

function source(value: unknown, label: string): ExtensionGallerySource {
  const input = object(value, label);
  const kind = choice(input.kind, ["npm", "git"] as const, `${label}.kind`);
  if (kind === "npm") {
    allowed(input, ["kind", "package", "version", "integrity"], label);
    const packageName = string(input.package, `${label}.package`, 214);
    if (!NPM_NAME.test(packageName)) throw new Error(`${label}.package is invalid`);
    const version = string(input.version, `${label}.version`, 128);
    if (valid(version, { loose: false }) === null) throw new Error(`${label}.version must be an exact semantic version`);
    const integrity = string(input.integrity, `${label}.integrity`, 512);
    if (!SRI.test(integrity)) throw new Error(`${label}.integrity must be an SRI sha256, sha384, or sha512 digest`);
    return { kind, package: packageName, version, integrity };
  }
  allowed(input, ["kind", "repository", "revision"], label);
  const repository = httpsUrl(input.repository, `${label}.repository`);
  const revision = string(input.revision, `${label}.revision`, 64);
  if (!GIT_REVISION.test(revision)) throw new Error(`${label}.revision must be a full lowercase Git commit ID`);
  return { kind, repository, revision };
}

function contributions(value: unknown, label: string): ExtensionGalleryContributionCounts {
  const input = object(value, label);
  const keys = ["runtime", "tools", "commands", "skills", "prompts", "themes", "providers"] as const;
  allowed(input, keys, label);
  return Object.fromEntries(keys.map((key) => [key, integer(input[key], `${label}.${key}`, 10_000)])) as unknown as ExtensionGalleryContributionCounts;
}

function media(value: unknown, label: string): ExtensionGalleryMedia[] {
  return array(value, label, 16).map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const input = object(entry, itemLabel);
    allowed(input, ["kind", "url", "alt"], itemLabel);
    const alt = optionalString(input.alt, `${itemLabel}.alt`, 512);
    return {
      kind: choice(input.kind, ["image", "video"] as const, `${itemLabel}.kind`),
      url: httpsUrl(input.url, `${itemLabel}.url`),
      ...(alt === undefined ? {} : { alt }),
    };
  }).sort((left, right) => left.url.localeCompare(right.url) || left.kind.localeCompare(right.kind));
}

function packageEntry(value: unknown, index: number): ExtensionGalleryPackage {
  const label = `packages[${index}]`;
  const input = object(value, label);
  allowed(input, [
    "id", "name", "version", "description", "source", "compatibility", "contributions", "readme", "homepage",
    "media", "publishedAt", "integrity", "provenance", "securityWarnings", "dependencyCount",
  ], label);
  const id = string(input.id, `${label}.id`, 63);
  if (!IDENTIFIER.test(id)) throw new Error(`${label}.id is invalid`);
  const version = string(input.version, `${label}.version`, 128);
  if (valid(version, { loose: false }) === null) throw new Error(`${label}.version must be an exact semantic version`);
  const packageSource = source(input.source, `${label}.source`);
  if (packageSource.kind === "npm" && packageSource.version !== version) {
    throw new Error(`${label}.source.version must match ${label}.version`);
  }
  const compatibility = object(input.compatibility, `${label}.compatibility`);
  allowed(compatibility, ["hostVersion"], `${label}.compatibility`);
  const hostVersion = string(compatibility.hostVersion, `${label}.compatibility.hostVersion`, 256);
  if (validRange(hostVersion, { loose: false }) === null) throw new Error(`${label}.compatibility.hostVersion is invalid`);
  const integrity = object(input.integrity, `${label}.integrity`);
  allowed(integrity, ["status", "digest"], `${label}.integrity`);
  const digest = optionalString(integrity.digest, `${label}.integrity.digest`, 512);
  if (digest !== undefined && !SRI.test(digest)) throw new Error(`${label}.integrity.digest must be an SRI digest`);
  const integrityStatus = choice(integrity.status, ["verified", "declared", "unverified"] as const, `${label}.integrity.status`);
  if (integrityStatus === "verified" && digest === undefined) throw new Error(`${label}.integrity.digest is required when status is verified`);
  const provenance = object(input.provenance, `${label}.provenance`);
  allowed(provenance, ["status", "detail"], `${label}.provenance`);
  const provenanceDetail = optionalString(provenance.detail, `${label}.provenance.detail`, 1024);
  const description = optionalString(input.description, `${label}.description`, 2048);
  const homepage = input.homepage === undefined ? undefined : httpsUrl(input.homepage, `${label}.homepage`);
  const warnings = array(input.securityWarnings, `${label}.securityWarnings`, 64)
    .map((warning, warningIndex) => string(warning, `${label}.securityWarnings[${warningIndex}]`, 1024));
  if (new Set(warnings).size !== warnings.length) throw new Error(`${label}.securityWarnings contains duplicates`);
  return {
    id,
    name: string(input.name, `${label}.name`, 256),
    version,
    ...(description === undefined ? {} : { description }),
    source: packageSource,
    compatibility: { hostVersion },
    contributions: contributions(input.contributions, `${label}.contributions`),
    readme: httpsUrl(input.readme, `${label}.readme`),
    ...(homepage === undefined ? {} : { homepage }),
    media: media(input.media, `${label}.media`),
    publishedAt: timestamp(input.publishedAt, `${label}.publishedAt`),
    integrity: { status: integrityStatus, ...(digest === undefined ? {} : { digest }) },
    provenance: {
      status: choice(provenance.status, ["verified", "publisher-asserted", "unknown"] as const, `${label}.provenance.status`),
      ...(provenanceDetail === undefined ? {} : { detail: provenanceDetail }),
    },
    securityWarnings: [...warnings].sort((left, right) => left.localeCompare(right)),
    dependencyCount: integer(input.dependencyCount, `${label}.dependencyCount`, 100_000),
  };
}

export function parseExtensionGalleryIndex(value: unknown): ExtensionGalleryIndex {
  const input = object(value, "gallery index");
  allowed(input, ["schemaVersion", "packages"], "gallery index");
  if (input.schemaVersion !== 1) throw new Error("gallery index schemaVersion must be 1");
  const packages = array(input.packages, "packages", 4096).map(packageEntry)
    .sort((left, right) => left.id.localeCompare(right.id));
  const seen = new Set<string>();
  for (const entry of packages) {
    if (seen.has(entry.id)) throw new Error(`gallery index contains duplicate package ID: ${entry.id}`);
    seen.add(entry.id);
  }
  return { schemaVersion: 1, packages };
}

export function extensionGalleryInstallSource(entry: ExtensionGalleryPackage): string {
  return entry.source.kind === "npm"
    ? `npm:${entry.source.package}@${entry.source.version}`
    : `git:${entry.source.repository}#${entry.source.revision}`;
}
