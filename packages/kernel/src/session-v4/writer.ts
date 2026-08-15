import {
	closeSync,
	constants,
	fchmodSync,
	ftruncateSync,
	fsyncSync,
	mkdirSync,
	openSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	readSessionV4DescriptorSnapshot,
	readSessionV4DescriptorSnapshotSync,
} from "./descriptor-snapshot.js";
import {
	SESSION_V4_MAX_COMMIT_COUNT,
	SESSION_V4_MAX_FILE_BYTES,
	SESSION_V4_MAX_RECORD_BYTES,
} from "./limits.js";
import {
	applySessionV4CommitOwned,
	cloneSessionV4State,
	createSessionV4State,
	validateSessionV4CommitTransition,
} from "./reduce.js";
import { parseSessionV4Bytes } from "./reader.js";
import type {
	SessionV4Commit,
	SessionV4CommitDraft,
	SessionV4CommitListener,
	SessionV4Header,
	SessionV4State,
} from "./types.js";
import {
	parseSessionV4CommitDraft,
	parseSessionV4Header,
	SessionV4ValidationError,
} from "./validate.js";

const NONBLOCK = constants.O_NONBLOCK ?? 0;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

interface PreparedCommit {
	commit: SessionV4Commit;
	bytes: Buffer;
}

function sameDraft(commit: SessionV4Commit, draft: SessionV4CommitDraft): boolean {
	return (
		commit.commitId === draft.commitId &&
		commit.committedAt === draft.committedAt &&
		isDeepStrictEqual(commit.changes, draft.changes)
	);
}

function prepareCommit(state: SessionV4State, input: SessionV4CommitDraft): SessionV4Commit | PreparedCommit {
	const draft = parseSessionV4CommitDraft(input);
	const existing = state.commits.get(draft.commitId);
	if (existing !== undefined) {
		if (sameDraft(existing, draft)) return structuredClone(existing);
		throw new SessionV4ValidationError(
			`commit id ${JSON.stringify(draft.commitId)} is already used with different content`,
		);
	}
	const commit: SessionV4Commit = {
		record: "commit",
		sequence: state.sequence + 1,
		commitId: draft.commitId,
		committedAt: draft.committedAt,
		changes: draft.changes,
	};
	validateSessionV4CommitTransition(state, commit);
	const bytes = Buffer.from(`${JSON.stringify(commit)}\n`, "utf8");
	if (bytes.length - 1 > SESSION_V4_MAX_RECORD_BYTES) {
		throw new SessionV4ValidationError(`commit exceeds ${SESSION_V4_MAX_RECORD_BYTES} bytes`);
	}
	if (commit.sequence > SESSION_V4_MAX_COMMIT_COUNT) {
		throw new SessionV4ValidationError(`session exceeds ${SESSION_V4_MAX_COMMIT_COUNT} commits`);
	}
	return {
		commit,
		bytes,
	};
}

function publish(
	listeners: Set<SessionV4CommitListener>,
	commit: SessionV4Commit,
	state: SessionV4State,
): void {
	for (const listener of [...listeners]) {
		try {
			listener(structuredClone(commit), cloneSessionV4State(state));
		} catch {
			// A listener observes durable state. Its failure cannot roll that state back.
		}
	}
}

async function writeAll(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
	let written = 0;
	while (written < bytes.length) {
		const result = await handle.write(bytes, written, bytes.length - written, position + written);
		if (result.bytesWritten === 0) throw new Error("session write made no progress");
		written += result.bytesWritten;
	}
}

function writeAllSync(fd: number, bytes: Buffer, position: number): void {
	let written = 0;
	while (written < bytes.length) {
		const count = writeSync(fd, bytes, written, bytes.length - written, position + written);
		if (count === 0) throw new Error("session write made no progress");
		written += count;
	}
}

function directorySyncUnavailable(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "EBADF" || code === "EINVAL" || code === "EISDIR" || code === "ENOTSUP" || code === "EPERM";
}

async function syncParentDirectory(path: string): Promise<void> {
	let handle: FileHandle;
	try {
		handle = await open(dirname(path), "r");
	} catch (error) {
		if (directorySyncUnavailable(error)) return;
		throw error;
	}
	try {
		await handle.sync();
	} catch (error) {
		if (!directorySyncUnavailable(error)) throw error;
	} finally {
		await handle.close();
	}
}

function syncParentDirectorySync(path: string): void {
	let fd: number;
	try {
		fd = openSync(dirname(path), "r");
	} catch (error) {
		if (directorySyncUnavailable(error)) return;
		throw error;
	}
	try {
		fsyncSync(fd);
	} catch (error) {
		if (!directorySyncUnavailable(error)) throw error;
	} finally {
		closeSync(fd);
	}
}

export class SessionV4Writer {
	readonly path: string;
	#handle: FileHandle;
	#state: SessionV4State;
	#offset: number;
	#commitRows: number;
	#listeners = new Set<SessionV4CommitListener>();
	#tail: Promise<void> = Promise.resolve();
	#closed = false;
	#fault: unknown;

	private constructor(path: string, handle: FileHandle, state: SessionV4State, offset: number, commitRows: number) {
		this.path = path;
		this.#handle = handle;
		this.#state = state;
		this.#offset = offset;
		this.#commitRows = commitRows;
	}

	static async create(path: string, input: SessionV4Header): Promise<SessionV4Writer> {
		const header = parseSessionV4Header(input);
		await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		const handle = await open(path, "wx+", PRIVATE_FILE_MODE);
		const bytes = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
		try {
			if (process.platform !== "win32") await handle.chmod(PRIVATE_FILE_MODE);
			await writeAll(handle, bytes, 0);
			await handle.sync();
			await syncParentDirectory(path);
			return new SessionV4Writer(path, handle, createSessionV4State(header), bytes.length, 0);
		} catch (error) {
			await handle.close().catch(() => undefined);
			await unlink(path).catch(() => undefined);
			throw error;
		}
	}

	static async open(path: string): Promise<SessionV4Writer> {
		const handle = await open(path, constants.O_RDWR | NONBLOCK);
		try {
			const bytes = await readSessionV4DescriptorSnapshot(
				handle,
				"session",
				process.platform === "win32" ? undefined : () => handle.chmod(PRIVATE_FILE_MODE),
			);
			const parsed = parseSessionV4Bytes(bytes);
			if (parsed.trailingBytes > 0) {
				await handle.truncate(parsed.committedBytes);
				await handle.sync();
			}
			return new SessionV4Writer(path, handle, parsed.state, parsed.committedBytes, parsed.commitRows);
		} catch (error) {
			await handle.close().catch(() => undefined);
			throw error;
		}
	}

	get state(): SessionV4State {
		return cloneSessionV4State(this.#state);
	}

	/** @internal Provides a callback-scoped view of writer-owned state. */
	inspectState<T>(inspect: (state: SessionV4State) => T): T {
		return inspect(this.#state);
	}

	subscribe(listener: SessionV4CommitListener): () => void {
		if (this.#closed) throw new Error("session writer is closed");
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	append(input: SessionV4CommitDraft): Promise<SessionV4Commit> {
		if (this.#closed) return Promise.reject(new Error("session writer is closed"));
		const draft = parseSessionV4CommitDraft(input);
		const operation = this.#tail.then(() => this.#appendNow(draft));
		this.#tail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async #appendNow(draft: SessionV4CommitDraft): Promise<SessionV4Commit> {
		const prepared = prepareCommit(this.#state, draft);
		if (!("bytes" in prepared)) return prepared;
		if (this.#fault !== undefined) throw new Error("session writer is faulted", { cause: this.#fault });
		if (this.#offset + prepared.bytes.length > SESSION_V4_MAX_FILE_BYTES) {
			throw new SessionV4ValidationError(`session exceeds ${SESSION_V4_MAX_FILE_BYTES} bytes`);
		}
		if (this.#commitRows >= SESSION_V4_MAX_COMMIT_COUNT) {
			throw new SessionV4ValidationError(`session exceeds ${SESSION_V4_MAX_COMMIT_COUNT} commits`);
		}
		try {
			await writeAll(this.#handle, prepared.bytes, this.#offset);
			await this.#handle.sync();
		} catch (error) {
			this.#fault = error;
			throw error;
		}
		this.#offset += prepared.bytes.length;
		this.#commitRows += 1;
		try {
			if (!applySessionV4CommitOwned(this.#state, prepared.commit)) {
				throw new Error("a newly persisted session commit was already present in memory");
			}
		} catch (error) {
			this.#fault = error;
			throw new Error("session state could not accept its durable commit", { cause: error });
		}
		publish(this.#listeners, prepared.commit, this.#state);
		return structuredClone(prepared.commit);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#tail;
		await this.#handle.close();
		this.#listeners.clear();
	}
}

export class SessionV4SyncWriter {
	readonly path: string;
	#fd: number;
	#state: SessionV4State;
	#offset: number;
	#commitRows: number;
	#listeners = new Set<SessionV4CommitListener>();
	#closed = false;
	#fault: unknown;

	private constructor(path: string, fd: number, state: SessionV4State, offset: number, commitRows: number) {
		this.path = path;
		this.#fd = fd;
		this.#state = state;
		this.#offset = offset;
		this.#commitRows = commitRows;
	}

	static create(path: string, input: SessionV4Header): SessionV4SyncWriter {
		const header = parseSessionV4Header(input);
		mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		const fd = openSync(path, "wx+", PRIVATE_FILE_MODE);
		const bytes = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
		try {
			if (process.platform !== "win32") fchmodSync(fd, PRIVATE_FILE_MODE);
			writeAllSync(fd, bytes, 0);
			fsyncSync(fd);
			syncParentDirectorySync(path);
			return new SessionV4SyncWriter(path, fd, createSessionV4State(header), bytes.length, 0);
		} catch (error) {
			try {
				closeSync(fd);
			} catch {}
			try {
				unlinkSync(path);
			} catch {}
			throw error;
		}
	}

	static open(path: string): SessionV4SyncWriter {
		const fd = openSync(path, constants.O_RDWR | NONBLOCK);
		try {
			const bytes = readSessionV4DescriptorSnapshotSync(
				fd,
				"session",
				process.platform === "win32" ? undefined : () => fchmodSync(fd, PRIVATE_FILE_MODE),
			);
			const parsed = parseSessionV4Bytes(bytes);
			if (parsed.trailingBytes > 0) {
				ftruncateSync(fd, parsed.committedBytes);
				fsyncSync(fd);
			}
			return new SessionV4SyncWriter(path, fd, parsed.state, parsed.committedBytes, parsed.commitRows);
		} catch (error) {
			closeSync(fd);
			throw error;
		}
	}

	get state(): SessionV4State {
		return cloneSessionV4State(this.#state);
	}

	/** @internal Provides a callback-scoped view of writer-owned state. */
	inspectState<T>(inspect: (state: SessionV4State) => T): T {
		return inspect(this.#state);
	}

	subscribe(listener: SessionV4CommitListener): () => void {
		if (this.#closed) throw new Error("session writer is closed");
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	append(input: SessionV4CommitDraft): SessionV4Commit {
		if (this.#closed) throw new Error("session writer is closed");
		const prepared = prepareCommit(this.#state, input);
		if (!("bytes" in prepared)) return prepared;
		if (this.#fault !== undefined) throw new Error("session writer is faulted", { cause: this.#fault });
		if (this.#offset + prepared.bytes.length > SESSION_V4_MAX_FILE_BYTES) {
			throw new SessionV4ValidationError(`session exceeds ${SESSION_V4_MAX_FILE_BYTES} bytes`);
		}
		if (this.#commitRows >= SESSION_V4_MAX_COMMIT_COUNT) {
			throw new SessionV4ValidationError(`session exceeds ${SESSION_V4_MAX_COMMIT_COUNT} commits`);
		}
		try {
			writeAllSync(this.#fd, prepared.bytes, this.#offset);
			fsyncSync(this.#fd);
		} catch (error) {
			this.#fault = error;
			throw error;
		}
		this.#offset += prepared.bytes.length;
		this.#commitRows += 1;
		try {
			if (!applySessionV4CommitOwned(this.#state, prepared.commit)) {
				throw new Error("a newly persisted session commit was already present in memory");
			}
		} catch (error) {
			this.#fault = error;
			throw new Error("session state could not accept its durable commit", { cause: error });
		}
		publish(this.#listeners, prepared.commit, this.#state);
		return structuredClone(prepared.commit);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		closeSync(this.#fd);
		this.#listeners.clear();
	}
}
