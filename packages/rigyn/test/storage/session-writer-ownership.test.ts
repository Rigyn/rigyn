import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	mkdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "../../src/storage/session-manager.js";
import { acquireSessionWriterLeaseSync } from "../../src/storage/session-writer-lease.js";

const managerModule = new URL("../../src/storage/session-manager.ts", import.meta.url).href;
const MAX_CONTROL_FILE_BYTES = 4 * 1024;

function ownerRecord(bytes: number): string {
	const value = JSON.stringify({ pid: process.pid, token: "replacement" });
	assert.ok(value.length <= bytes);
	return value.padEnd(bytes, " ");
}

function openInChild(
	path: string,
	close: boolean,
	overrides: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
	const environment = { ...process.env, ...overrides };
	delete environment.NODE_TEST_CONTEXT;
	const source = [
		`import { SessionManager } from ${JSON.stringify(managerModule)};`,
		"try {",
		`  const manager = SessionManager.open(${JSON.stringify(path)});`,
		...(close ? ["  manager.closeV4Store();"] : []),
		'  process.stdout.write("acquired\\n");',
		"} catch (error) {",
		"  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\\n`);",
		"  process.exitCode = 2;",
		"}",
	].join("\n");
	return spawnSync(
		process.execPath,
		["--import", "tsx", "--input-type=module", "--eval", source],
		{ encoding: "utf8", env: environment },
	);
}

test("identity writer locks honor RIGYN_HOME without touching HOME", async () => {
	const root = await mkdtemp(join(tmpdir(), "rigyn-session-owner-home-"));
	const home = join(root, "untouched-home");
	const agentDirectory = join(root, "agent");
	const path = join(root, "sessions", "session.jsonl");
	try {
		const acquired = openInChild(path, true, { HOME: home, RIGYN_HOME: agentDirectory });
		assert.equal(acquired.status, 0, String(acquired.stderr));
		assert.equal(acquired.stdout, "acquired\n");
		assert.equal(existsSync(home), false);
		assert.equal(existsSync(join(agentDirectory, "writer-locks")), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function assertChildBlocked(path: string): void {
	const blocked = openInChild(path, true);
	assert.equal(blocked.status, 2, String(blocked.stderr));
	assert.match(`${blocked.stdout}${blocked.stderr}`, /active writer/u);
}

function appendMarker(manager: SessionManager, id: string): void {
	manager.appendMessage({
		id,
		role: "user",
		content: [{ type: "text", text: id }],
		createdAt: new Date().toISOString(),
	});
}

function assertMarker(manager: SessionManager, id: string): void {
	assert.equal(JSON.stringify(manager.getEntries()).includes(id), true);
}

test("a persistent SessionManager owns its file across processes until close", async () => {
	const root = await mkdtemp(join(tmpdir(), "rigyn-session-owner-"));
	const path = join(root, "session.jsonl");
	const manager = SessionManager.open(path, root, root);
	try {
		assert.equal(existsSync(`${path}.writer-lock`), true);
		assert.throws(() => SessionManager.open(path), /active writer/u);
		assertChildBlocked(path);
	} finally {
		manager.closeV4Store();
	}

	try {
		assert.equal(existsSync(`${path}.writer-lock`), false);
		const acquired = openInChild(path, true);
		assert.equal(acquired.status, 0, String(acquired.stderr));
		assert.equal(acquired.stdout, "acquired\n");
		assert.equal(existsSync(`${path}.writer-lock`), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("real and symbolic-link paths share one writer lease", async () => {
	const root = await mkdtemp(join(tmpdir(), "rigyn-session-owner-symlink-"));
	const path = join(root, "session.jsonl");
	const alias = join(root, "session-link.jsonl");
	const manager = SessionManager.open(path, root, root);
	try {
		symlinkSync(path, alias, "file");
		assert.throws(() => SessionManager.open(alias), /active writer/u);
		assert.equal(existsSync(`${alias}.writer-lock`), false);
		assertChildBlocked(alias);
		appendMarker(manager, "symlink-owner-commit");
	} finally {
		manager.closeV4Store();
	}

	try {
		const aliasOwner = SessionManager.open(alias);
		assert.throws(() => SessionManager.open(path), /active writer/u);
		assertMarker(aliasOwner, "symlink-owner-commit");
		aliasOwner.closeV4Store();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("hard-link paths share one writer lease", async () => {
	const root = await mkdtemp(join(tmpdir(), "rigyn-session-owner-hardlink-"));
	const path = join(root, "session.jsonl");
	const alias = join(root, "session-hardlink.jsonl");
	const manager = SessionManager.open(path, root, root);
	try {
		linkSync(path, alias);
		assert.throws(() => SessionManager.open(alias), /active writer/u);
		assert.equal(existsSync(`${alias}.writer-lock`), false);
		assertChildBlocked(alias);
		appendMarker(manager, "hardlink-owner-commit");
	} finally {
		manager.closeV4Store();
	}

	try {
		const aliasOwner = SessionManager.open(alias);
		assert.throws(() => SessionManager.open(path), /active writer/u);
		assertMarker(aliasOwner, "hardlink-owner-commit");
		aliasOwner.closeV4Store();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("renaming an owned session does not create a second writer", async () => {
	const root = await mkdtemp(join(tmpdir(), "rigyn-session-owner-rename-"));
	const path = join(root, "session.jsonl");
	const renamed = join(root, "renamed.jsonl");
	const manager = SessionManager.open(path, root, root);
	try {
		renameSync(path, renamed);
		assert.throws(() => SessionManager.open(renamed), /active writer/u);
		assert.equal(existsSync(`${renamed}.writer-lock`), false);
		assertChildBlocked(renamed);
		appendMarker(manager, "renamed-owner-commit");
	} finally {
		manager.closeV4Store();
	}

	try {
		const reopened = SessionManager.open(renamed);
		assertMarker(reopened, "renamed-owner-commit");
		reopened.closeV4Store();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a dead process writer record is reclaimed before reopening", async () => {
	const root = await mkdtemp(join(tmpdir(), "rigyn-session-owner-stale-"));
	const path = join(root, "session.jsonl");
	try {
		const created = SessionManager.open(path, root, root);
		created.closeV4Store();

		const abandoned = openInChild(path, false);
		assert.equal(abandoned.status, 0, String(abandoned.stderr));
		assert.equal(existsSync(`${path}.writer-lock`), true);

		const recovered = SessionManager.open(path);
		assert.equal(recovered.getSessionFile(), path);
		recovered.closeV4Store();
		assert.equal(existsSync(`${path}.writer-lock`), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("writer owner reads accept 4 KiB and reject larger or non-regular records", async () => {
	for (const [bytes, expected] of [
		[MAX_CONTROL_FILE_BYTES, /active writer/u],
		[MAX_CONTROL_FILE_BYTES + 1, /unreadable active writer record/u],
	] as const) {
		const root = await mkdtemp(join(tmpdir(), "rigyn-session-owner-boundary-"));
		const path = join(root, "session.jsonl");
		const lock = `${path}.writer-lock`;
		try {
			mkdirSync(lock);
			writeFileSync(join(lock, "owner.json"), ownerRecord(bytes));
			assert.throws(() => SessionManager.open(path), expected);
			assert.equal(statSync(join(lock, "owner.json")).size, bytes);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	const root = await mkdtemp(join(tmpdir(), "rigyn-session-owner-nonregular-"));
	const path = join(root, "session.jsonl");
	const lock = `${path}.writer-lock`;
	try {
		mkdirSync(join(lock, "owner.json"), { recursive: true });
		assert.throws(() => SessionManager.open(path), /unreadable active writer record/u);
		assert.equal(statSync(join(lock, "owner.json")).isDirectory(), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("writer lease release preserves replaced bounded and non-regular owners", async () => {
	for (const bytes of [MAX_CONTROL_FILE_BYTES, MAX_CONTROL_FILE_BYTES + 1]) {
		const root = await mkdtemp(join(tmpdir(), "rigyn-session-owner-release-"));
		const path = join(root, "session.jsonl");
		const lock = `${path}.writer-lock`;
		const owner = join(lock, "owner.json");
		try {
			const lease = acquireSessionWriterLeaseSync(path);
			const replacement = join(root, "replacement.json");
			writeFileSync(replacement, ownerRecord(bytes));
			renameSync(replacement, owner);
			lease.release();
			assert.equal(statSync(owner).size, bytes);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	const root = await mkdtemp(join(tmpdir(), "rigyn-session-owner-release-directory-"));
	const path = join(root, "session.jsonl");
	const lock = `${path}.writer-lock`;
	const owner = join(lock, "owner.json");
	try {
		const lease = acquireSessionWriterLeaseSync(path);
		rmSync(owner);
		mkdirSync(owner);
		lease.release();
		assert.equal(statSync(owner).isDirectory(), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
