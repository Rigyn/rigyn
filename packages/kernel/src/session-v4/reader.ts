import { closeSync, constants, openSync } from "node:fs";
import { open } from "node:fs/promises";
import {
	readSessionV4DescriptorSnapshot,
	readSessionV4DescriptorSnapshotSync,
} from "./descriptor-snapshot.js";
import {
	SESSION_V4_MAX_COMMIT_COUNT,
	SESSION_V4_MAX_FILE_BYTES,
	SESSION_V4_MAX_RECORD_BYTES,
} from "./limits.js";
import { applySessionV4CommitOwned, createSessionV4State } from "./reduce.js";
import type { SessionV4Commit, SessionV4ReadResult } from "./types.js";
import {
	parseSessionV4Commit,
	parseSessionV4Header,
	SessionV4ValidationError,
} from "./validate.js";

const NONBLOCK = constants.O_NONBLOCK ?? 0;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

interface SessionV4ReadFileOptions {
	followSymlinks?: boolean;
}

function readFlags(options: SessionV4ReadFileOptions): number {
	return constants.O_RDONLY | NONBLOCK | (options.followSymlinks === false ? NOFOLLOW : 0);
}

function invalid(message: string, cause?: unknown): never {
	const error = new SessionV4ValidationError(message);
	if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause, enumerable: false });
	throw error;
}

function parseLine(line: string, lineNumber: number): unknown {
	if (line.length === 0) invalid(`line ${lineNumber} must not be empty`);
	if (line.endsWith("\r")) invalid(`line ${lineNumber} must use an LF terminator`);
	try {
		return JSON.parse(line) as unknown;
	} catch (error) {
		return invalid(`line ${lineNumber} is not valid JSON`, error);
	}
}

export function parseSessionV4Bytes(input: Uint8Array): SessionV4ReadResult {
	if (input.byteLength > SESSION_V4_MAX_FILE_BYTES) {
		invalid(`session data exceeds ${SESSION_V4_MAX_FILE_BYTES} bytes`);
	}
	const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	const lastLf = bytes.lastIndexOf(0x0a);
	if (lastLf < 0) invalid("the header must be LF-terminated");
	const committedBytes = lastLf + 1;
	let lineCount = 0;
	for (let index = 0; index < committedBytes; index += 1) {
		if (bytes[index] === 0x0a) lineCount += 1;
	}
	const commitRows = lineCount - 1;
	if (commitRows > SESSION_V4_MAX_COMMIT_COUNT) {
		invalid(`session data exceeds ${SESSION_V4_MAX_COMMIT_COUNT} commits`);
	}
	let committedText: string;
	try {
		committedText = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, committedBytes));
	} catch (error) {
		return invalid("committed data must be valid UTF-8", error);
	}
	const lines = committedText.slice(0, -1).split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		if (Buffer.byteLength(lines[index] as string, "utf8") > SESSION_V4_MAX_RECORD_BYTES) {
			invalid(`line ${index + 1} exceeds ${SESSION_V4_MAX_RECORD_BYTES} bytes`);
		}
	}
	const firstLine = lines[0];
	if (firstLine === undefined || firstLine.length === 0) invalid("the header is missing");
	const header = parseSessionV4Header(parseLine(firstLine, 1));
	const state = createSessionV4State(header);
	const commits: SessionV4Commit[] = [];
	for (let index = 1; index < lines.length; index += 1) {
		const commit = parseSessionV4Commit(parseLine(lines[index] as string, index + 1), `line ${index + 1}`);
		if (applySessionV4CommitOwned(state, commit)) commits.push(commit);
	}
	return {
		state,
		commits,
		commitRows,
		committedBytes,
		trailingBytes: bytes.byteLength - committedBytes,
	};
}

export async function readSessionV4File(
	path: string,
	options: SessionV4ReadFileOptions = {},
): Promise<SessionV4ReadResult> {
	const handle = await open(path, readFlags(options));
	try {
		return parseSessionV4Bytes(await readSessionV4DescriptorSnapshot(handle, "session data"));
	} finally {
		await handle.close();
	}
}

export function readSessionV4FileSync(
	path: string,
	options: SessionV4ReadFileOptions = {},
): SessionV4ReadResult {
	const fd = openSync(path, readFlags(options));
	try {
		return parseSessionV4Bytes(readSessionV4DescriptorSnapshotSync(fd, "session data"));
	} finally {
		closeSync(fd);
	}
}
