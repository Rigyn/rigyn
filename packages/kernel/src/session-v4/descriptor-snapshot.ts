import { fstatSync, readSync, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { SESSION_V4_MAX_FILE_BYTES } from "./limits.js";
import { SessionV4ValidationError } from "./validate.js";

type SessionV4SizeLabel = "session" | "session data";

interface DescriptorSnapshotPlan {
	details: Stats;
	bytes: Buffer;
	label: SessionV4SizeLabel;
}

function tooLarge(label: SessionV4SizeLabel): never {
	throw new SessionV4ValidationError(`${label} exceeds ${SESSION_V4_MAX_FILE_BYTES} bytes`);
}

function planDescriptorSnapshot(details: Stats, label: SessionV4SizeLabel): DescriptorSnapshotPlan {
	if (!details.isFile()) throw new SessionV4ValidationError("session path must be a regular file");
	if (details.size > SESSION_V4_MAX_FILE_BYTES) tooLarge(label);
	return {
		details,
		bytes: Buffer.allocUnsafe(Math.min(details.size + 1, SESSION_V4_MAX_FILE_BYTES + 1)),
		label,
	};
}

function finishDescriptorSnapshot(
	plan: DescriptorSnapshotPlan,
	bytesRead: number,
	after: Stats,
): Buffer {
	if (bytesRead > SESSION_V4_MAX_FILE_BYTES || after.size > SESSION_V4_MAX_FILE_BYTES) {
		tooLarge(plan.label);
	}
	if (
		bytesRead !== plan.details.size ||
		after.size !== plan.details.size ||
		after.dev !== plan.details.dev ||
		after.ino !== plan.details.ino ||
		after.mtimeMs !== plan.details.mtimeMs
	) {
		throw new SessionV4ValidationError("session file changed while being read");
	}
	return plan.bytes.subarray(0, bytesRead);
}

export async function readSessionV4DescriptorSnapshot(
	handle: FileHandle,
	label: SessionV4SizeLabel,
	prepare?: () => void | Promise<void>,
): Promise<Buffer> {
	const plan = planDescriptorSnapshot(await handle.stat(), label);
	await prepare?.();
	let offset = 0;
	while (offset < plan.bytes.length) {
		const { bytesRead } = await handle.read(plan.bytes, offset, plan.bytes.length - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return finishDescriptorSnapshot(plan, offset, await handle.stat());
}

export function readSessionV4DescriptorSnapshotSync(
	fd: number,
	label: SessionV4SizeLabel,
	prepare?: () => void,
): Buffer {
	const plan = planDescriptorSnapshot(fstatSync(fd), label);
	prepare?.();
	let offset = 0;
	while (offset < plan.bytes.length) {
		const bytesRead = readSync(fd, plan.bytes, offset, plan.bytes.length - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return finishDescriptorSnapshot(plan, offset, fstatSync(fd));
}
