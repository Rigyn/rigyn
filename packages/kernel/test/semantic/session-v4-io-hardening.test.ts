import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	parseSessionV4Bytes,
	parseSessionV4CommitDraft,
	readSessionV4File,
	readSessionV4FileSync,
	SESSION_V4_MAX_COMMIT_COUNT,
	SESSION_V4_MAX_JSON_DEPTH,
	SESSION_V4_MAX_JSON_VALUE_COUNT,
	SessionV4SyncWriter,
	SessionV4ValidationError,
	SessionV4Writer,
	type SessionV4Commit,
	type SessionV4Header,
} from "../../src/session-v4/index.js";

const sessionModule = new URL("../../src/session-v4/index.ts", import.meta.url).href;

const TIME = "2026-07-29T12:00:00.000Z";
const HEADER: SessionV4Header = {
	record: "session",
	version: 4,
	sessionId: "session-io",
	createdAt: TIME,
	workspace: "/workspace",
	cwd: "/workspace",
};

function directory(): string {
	return mkdtempSync(join(tmpdir(), "rigyn-session-v4-io-"));
}

function nameCommit(id = "commit-1", name = "name"): SessionV4Commit {
	return {
		record: "commit",
		sequence: 1,
		commitId: id,
		committedAt: TIME,
		changes: [{ type: "session_name", name }],
	};
}

function encoded(header: SessionV4Header, ...commits: SessionV4Commit[]): Buffer {
	return Buffer.from(
		`${[header, ...commits].map((value) => JSON.stringify(value)).join("\n")}\n`,
		"utf8",
	);
}

function isBoundedValidationError(error: unknown): boolean {
	assert.ok(error instanceof SessionV4ValidationError);
	assert.equal(error instanceof RangeError, false);
	return true;
}

test("session writers create private storage and secure reopened files under permissive umasks", {
	skip: process.platform === "win32" ? "POSIX permission bits do not apply on Windows" : false,
}, () => {
	const source = [
		`import { SessionV4SyncWriter, SessionV4Writer } from ${JSON.stringify(sessionModule)};`,
		'import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";',
		'import { tmpdir } from "node:os";',
		'import { dirname, join } from "node:path";',
		"process.umask(Number.parseInt(process.argv[1], 8));",
		'const root = mkdtempSync(join(tmpdir(), "rigyn-session-v4-permissions-"));',
		"const mode = (path) => statSync(path).mode & 0o777;",
		`const header = ${JSON.stringify(HEADER)};`,
		"try {",
		'  const syncPath = join(root, "sync", "session.jsonl");',
		"  const syncCreated = SessionV4SyncWriter.create(syncPath, header);",
		"  syncCreated.close();",
		"  const sync = { directory: mode(dirname(syncPath)), created: mode(syncPath) };",
		"  chmodSync(syncPath, 0o666);",
		"  const syncReopened = SessionV4SyncWriter.open(syncPath);",
		"  syncReopened.close();",
		"  sync.reopened = mode(syncPath);",
		'  const asyncPath = join(root, "async", "session.jsonl");',
		"  const asyncCreated = await SessionV4Writer.create(asyncPath, header);",
		"  await asyncCreated.close();",
		"  const asynchronous = { directory: mode(dirname(asyncPath)), created: mode(asyncPath) };",
		"  chmodSync(asyncPath, 0o666);",
		"  const asyncReopened = await SessionV4Writer.open(asyncPath);",
		"  await asyncReopened.close();",
		"  asynchronous.reopened = mode(asyncPath);",
		"  process.stdout.write(JSON.stringify({ sync, asynchronous }));",
		"} finally {",
		"  rmSync(root, { recursive: true, force: true });",
		"}",
	].join("\n");

	for (const mask of ["000", "002"]) {
		const child = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "--eval", source, mask],
			{ encoding: "utf8" },
		);
		assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
		assert.deepEqual(JSON.parse(child.stdout), {
			sync: { directory: 0o700, created: 0o600, reopened: 0o600 },
			asynchronous: { directory: 0o700, created: 0o600, reopened: 0o600 },
		});
	}
});

test("strict validation bounds JSON nesting without leaking a RangeError", () => {
	let data: unknown = null;
	for (let depth = 0; depth <= SESSION_V4_MAX_JSON_DEPTH; depth += 1) data = [data];

	assert.throws(
		() => parseSessionV4CommitDraft({
			commitId: "deep",
			committedAt: TIME,
			changes: [{
				type: "run_checkpoint",
				operationId: "operation",
				checkpointId: "checkpoint",
				createdAt: TIME,
				data,
			}],
		}),
		isBoundedValidationError,
	);
});

test("strict validation bounds the total JSON value count", () => {
	assert.throws(
		() => parseSessionV4CommitDraft({
			commitId: "wide",
			committedAt: TIME,
			changes: [{
				type: "run_checkpoint",
				operationId: "operation",
				checkpointId: "checkpoint",
				createdAt: TIME,
				data: new Array(SESSION_V4_MAX_JSON_VALUE_COUNT).fill(null),
			}],
		}),
		isBoundedValidationError,
	);
});

test("prepared tool call ids and indexes are required, bounded, and preserved", () => {
	const prepared = {
		type: "tool_effect_prepared" as const,
		effectId: "effect",
		operationId: "operation",
		invocationId: "invocation",
		callId: "provider-call",
		toolName: "read",
		policy: "repeatable" as const,
		effectiveInput: { path: "README.md" },
		inputHash: "input-hash",
		resultNodeId: "result",
		step: 0,
		index: 0,
		assistantNodeId: "assistant",
		toolsetFingerprint: "tools",
		preparedAt: TIME,
	};
	const parsed = parseSessionV4CommitDraft({
		commitId: "prepared",
		committedAt: TIME,
		changes: [prepared],
	});
	assert.equal(parsed.changes[0]?.type, "tool_effect_prepared");
	if (parsed.changes[0]?.type !== "tool_effect_prepared") assert.fail("expected prepared tool effect");
	assert.equal(parsed.changes[0].callId, "provider-call");
	assert.equal(parsed.changes[0].index, 0);

	const missing = { ...prepared } as Partial<typeof prepared>;
	delete missing.callId;
	assert.throws(
		() => parseSessionV4CommitDraft({
			commitId: "missing-call",
			committedAt: TIME,
			changes: [missing],
		}),
		/changes\[0\]\.callId is required/u,
	);
	assert.throws(
		() => parseSessionV4CommitDraft({
			commitId: "empty-call",
			committedAt: TIME,
			changes: [{ ...prepared, callId: "" }],
		}),
		/changes\[0\]\.callId must not be empty/u,
	);
	assert.throws(
		() => parseSessionV4CommitDraft({
			commitId: "oversized-call",
			committedAt: TIME,
			changes: [{ ...prepared, callId: "é".repeat(513) }],
		}),
		/changes\[0\]\.callId must contain at most 1024 UTF-8 bytes/u,
	);
	const missingIndex = { ...prepared } as Partial<typeof prepared>;
	delete missingIndex.index;
	assert.throws(
		() => parseSessionV4CommitDraft({
			commitId: "missing-index",
			committedAt: TIME,
			changes: [missingIndex],
		}),
		/changes\[0\]\.index is required/u,
	);
	assert.throws(
		() => parseSessionV4CommitDraft({
			commitId: "negative-index",
			committedAt: TIME,
			changes: [{ ...prepared, index: -1 }],
		}),
		/changes\[0\]\.index must be a safe integer greater than or equal to 0/u,
	);
});

test("the commit limit counts every LF-complete row, including identical repeats", () => {
	const row = `${JSON.stringify(nameCommit())}\n`;
	const bytes = Buffer.from(
		`${JSON.stringify(HEADER)}\n${row.repeat(SESSION_V4_MAX_COMMIT_COUNT + 1)}`,
		"utf8",
	);
	assert.throws(
		() => parseSessionV4Bytes(bytes),
		new RegExp(`exceeds ${SESSION_V4_MAX_COMMIT_COUNT} commits`, "u"),
	);
});

test("readers and writers retain the physical row count independently of idempotent commits", async () => {
	const root = directory();
	const syncPath = join(root, "sync.jsonl");
	const asyncPath = join(root, "async.jsonl");
	const repeated = encoded(HEADER, nameCommit(), nameCommit());
	try {
		writeFileSync(syncPath, repeated);
		const parsed = readSessionV4FileSync(syncPath);
		assert.equal(parsed.commits.length, 1);
		assert.equal(parsed.commitRows, 2);
		const syncWriter = SessionV4SyncWriter.open(syncPath);
		syncWriter.append({
			commitId: "commit-2",
			committedAt: TIME,
			changes: [{ type: "session_name", name: "sync" }],
		});
		syncWriter.close();
		assert.equal(readSessionV4FileSync(syncPath).commitRows, 3);

		writeFileSync(asyncPath, repeated);
		const asyncWriter = await SessionV4Writer.open(asyncPath);
		await asyncWriter.append({
			commitId: "commit-2",
			committedAt: TIME,
			changes: [{ type: "session_name", name: "async" }],
		});
		await asyncWriter.close();
		assert.equal(readSessionV4FileSync(asyncPath).commitRows, 3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("session readers and writers reject a FIFO without blocking", {
	skip: process.platform === "win32" ? "POSIX FIFO probe" : false,
}, () => {
	const root = directory();
	const path = join(root, "session.jsonl");
	try {
		execFileSync("mkfifo", [path]);
		const source = [
			`import { readSessionV4File, readSessionV4FileSync, SessionV4SyncWriter, SessionV4Writer } from ${JSON.stringify(sessionModule)};`,
			"const operations = [",
			"  () => readSessionV4FileSync(process.argv[1]),",
			"  () => readSessionV4File(process.argv[1]),",
			"  () => SessionV4SyncWriter.open(process.argv[1]),",
			"  () => SessionV4Writer.open(process.argv[1]),",
			"] ;",
			"for (const operation of operations) {",
			"  try { await operation(); process.exit(3); }",
			"  catch (error) { if (!/regular file/u.test(error instanceof Error ? error.message : String(error))) process.exit(4); }",
			"}",
		].join("\n");
		const child = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "--eval", source, path],
			{ encoding: "utf8", timeout: 2_000 },
		);
		assert.equal(child.error, undefined, String(child.error));
		assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("session readers require regular files and explicit reads preserve symlink aliases", {
	skip: process.platform === "win32" ? "file symlinks require optional Windows privileges" : false,
}, async () => {
	const root = directory();
	const path = join(root, "session.jsonl");
	const alias = join(root, "alias.jsonl");
	const directoryPath = join(root, "directory.jsonl");
	try {
		writeFileSync(path, encoded(HEADER));
		symlinkSync(path, alias, "file");
		mkdirSync(directoryPath);
		assert.equal(readSessionV4FileSync(alias).state.header.sessionId, HEADER.sessionId);
		assert.equal((await readSessionV4File(alias)).state.header.sessionId, HEADER.sessionId);
		assert.throws(() => readSessionV4FileSync(alias, { followSymlinks: false }));
		assert.throws(() => readSessionV4FileSync(directoryPath), /regular file/u);
		assert.throws(() => readSessionV4FileSync("/dev/null"), /regular file/u);
		assert.throws(() => SessionV4SyncWriter.open("/dev/null"), /regular file/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("synchronous writer remains bound to its opened file when the path is replaced", () => {
	const root = directory();
	const path = join(root, "session.jsonl");
	const openedPath = join(root, "opened.jsonl");
	try {
		const created = SessionV4SyncWriter.create(path, HEADER);
		created.close();
		const writer = SessionV4SyncWriter.open(path);
		renameSync(path, openedPath);
		const replacement = SessionV4SyncWriter.create(path, {
			...HEADER,
			sessionId: "replacement-sync",
		});
		replacement.close();

		writer.append({
			commitId: "opened-commit",
			committedAt: TIME,
			changes: [{ type: "session_name", name: "opened" }],
		});
		writer.close();

		assert.equal(readSessionV4FileSync(openedPath).state.name, "opened");
		assert.equal(readSessionV4FileSync(path).state.name, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("asynchronous writer remains bound to its opened file when the path is replaced", async () => {
	const root = directory();
	const path = join(root, "session.jsonl");
	const openedPath = join(root, "opened.jsonl");
	try {
		const created = await SessionV4Writer.create(path, HEADER);
		await created.close();
		const writer = await SessionV4Writer.open(path);
		renameSync(path, openedPath);
		const replacement = await SessionV4Writer.create(path, {
			...HEADER,
			sessionId: "replacement-async",
		});
		await replacement.close();

		await writer.append({
			commitId: "opened-commit",
			committedAt: TIME,
			changes: [{ type: "session_name", name: "opened" }],
		});
		await writer.close();

		assert.equal(readSessionV4FileSync(openedPath).state.name, "opened");
		assert.equal(readSessionV4FileSync(path).state.name, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
