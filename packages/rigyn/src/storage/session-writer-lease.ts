import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config/paths.js";
import { readControlFileSync } from "./control-file.js";

interface SessionWriterOwner {
	pid: number;
	token: string;
}

const PRIVATE_LOCK_DIRECTORY_MODE = 0o700;
const PRIVATE_LOCK_FILE_MODE = 0o600;

export interface SessionWriterLease {
	readonly path: string;
	bindToFile(): void;
	release(): void;
}

function preparePrivateAgentDirectory(): void {
	const directory = getAgentDir();
	mkdirSync(directory, { recursive: true, mode: PRIVATE_LOCK_DIRECTORY_MODE });
	if (process.platform !== "win32") chmodSync(directory, PRIVATE_LOCK_DIRECTORY_MODE);
}

function fileIdentity(path: string): string {
	const details = statSync(path, { bigint: true });
	if (details.ino <= 0n) {
		throw new Error(`Session file identity is unavailable and cannot be locked safely: ${path}`);
	}
	return `${details.dev}:${details.ino}`;
}

function identityLockPath(identity: string): string {
	const digest = createHash("sha256").update(identity).digest("hex");
	return join(getAgentDir(), "writer-locks", `${digest}.writer-lock`);
}

function lockPath(path: string): string {
	return `${path}.writer-lock`;
}

function ownerPath(path: string): string {
	return `${path}/owner.json`;
}

function readOwner(path: string): SessionWriterOwner | undefined {
	try {
		const value = JSON.parse(readControlFileSync(ownerPath(path))) as Partial<SessionWriterOwner>;
		if (
			!Number.isSafeInteger(value.pid)
			|| (value.pid as number) <= 0
			|| typeof value.token !== "string"
			|| value.token.length === 0
		) {
			return undefined;
		}
		return { pid: value.pid as number, token: value.token };
	} catch {
		return undefined;
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function installLock(path: string, owner: SessionWriterOwner): boolean {
	const candidate = `${path}.${process.pid}.${randomUUID()}.tmp`;
	mkdirSync(candidate, { mode: PRIVATE_LOCK_DIRECTORY_MODE });
	try {
		writeFileSync(ownerPath(candidate), `${JSON.stringify(owner)}\n`, {
			encoding: "utf8",
			mode: PRIVATE_LOCK_FILE_MODE,
		});
		if (process.platform !== "win32") {
			chmodSync(candidate, PRIVATE_LOCK_DIRECTORY_MODE);
			chmodSync(ownerPath(candidate), PRIVATE_LOCK_FILE_MODE);
		}
		try {
			renameSync(candidate, path);
			return true;
		} catch (error) {
			if (!existsSync(path)) throw error;
			return false;
		}
	} finally {
		rmSync(candidate, { recursive: true, force: true });
	}
}

function retireDeadLock(path: string, owner: SessionWriterOwner): void {
	const retired = `${path}.retired.${process.pid}.${randomUUID()}`;
	try {
		renameSync(path, retired);
	} catch (error) {
		if (!existsSync(path)) return;
		throw error;
	}
	const movedOwner = readOwner(retired);
	if (movedOwner?.token !== owner.token) {
		if (!existsSync(path)) {
			try {
				renameSync(retired, path);
			} catch {
				// Preserve the moved ownership record for diagnosis.
			}
		}
		throw new Error(`Session writer ownership changed while acquiring ${path}`);
	}
	rmSync(retired, { recursive: true, force: true });
}

function acquireLock(
	target: string,
	owner: SessionWriterOwner,
	sessionPath: string,
	secureParent = false,
): () => void {
	const parent = dirname(target);
	mkdirSync(parent, { recursive: true, mode: PRIVATE_LOCK_DIRECTORY_MODE });
	if (secureParent && process.platform !== "win32") chmodSync(parent, PRIVATE_LOCK_DIRECTORY_MODE);

	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (installLock(target, owner)) {
			let released = false;
			return (): void => {
				if (released) return;
				released = true;
				if (readOwner(target)?.token === owner.token) {
					rmSync(target, { recursive: true, force: true });
				}
			};
		}
		const existing = readOwner(target);
		if (existing === undefined) {
			throw new Error(`Session file has an unreadable active writer record: ${sessionPath}`);
		}
		if (processIsAlive(existing.pid)) {
			throw new Error(`Session file already has an active writer: ${sessionPath}`);
		}
		retireDeadLock(target, existing);
	}

	throw new Error(`Session file already has an active writer: ${sessionPath}`);
}

export function acquireSessionWriterLeaseSync(path: string): SessionWriterLease {
	preparePrivateAgentDirectory();
	const owner: SessionWriterOwner = { pid: process.pid, token: randomUUID() };
	const releasePathLock = acquireLock(lockPath(path), owner, path);
	let identity: string | undefined;
	let releaseIdentityLock: (() => void) | undefined;
	let released = false;

	const bindToFile = (): void => {
		if (released) throw new Error(`Session writer lease is released: ${path}`);
		const currentIdentity = fileIdentity(path);
		if (identity !== undefined) {
			if (currentIdentity !== identity) {
				throw new Error(`Session file changed while acquiring its writer lease: ${path}`);
			}
			return;
		}
		const release = acquireLock(identityLockPath(currentIdentity), owner, path, true);
		identity = currentIdentity;
		releaseIdentityLock = release;
	};

	try {
		if (existsSync(path)) bindToFile();
	} catch (error) {
		releaseIdentityLock?.();
		releasePathLock();
		throw error;
	}

	return {
		path,
		bindToFile,
		release(): void {
			if (released) return;
			released = true;
			releaseIdentityLock?.();
			releasePathLock();
		},
	};
}
