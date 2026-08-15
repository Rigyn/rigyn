import type { ImageContent } from "@rigyn/models";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { errorMessage } from "../core/errors.js";
import { canonicalPublicImages } from "../core/public-image-content.js";
import type { ExtensionError } from "../extensions/direct.js";
import type { AgentSession } from "../service/agent-session.js";
import type { AgentSessionRuntime } from "../service/agent-session-runtime.js";
import { createAgentSessionRuntimeCommandActions } from "../service/runtime-command-actions.js";
import { escapeTerminal } from "../tools/output.js";
import { recoverNonInteractiveSession } from "./noninteractive-recovery.js";

export interface PrintModeOptions {
	mode: "text" | "json";
	messages?: readonly string[];
	initialMessage?: string;
	initialImages?: readonly ImageContent[];
	write?: (text: string) => void;
}

function safeDiagnostic(value: unknown): string {
	return escapeTerminal(defaultSecretRedactor.redact(errorMessage(value)));
}

function assistantFailure(session: AgentSession): string | undefined {
	const messages = session.state.messages;
	const assistant = [...messages].reverse().find((message) => message.role === "assistant");
	if (assistant?.role !== "assistant") return undefined;
	if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") return undefined;
	return assistant.errorMessage ?? `Request ${assistant.stopReason}`;
}

function finalAssistantText(session: AgentSession): string {
	const assistant = [...session.state.messages].reverse().find((message) => message.role === "assistant");
	if (assistant?.role !== "assistant") return "";
	return assistant.content
		.flatMap((block) => block.type === "text" ? [block.text] : [])
		.join("");
}

/** Run a caller-owned session as a one-shot text or JSON event stream. */
export async function runPrintMode(
	runtime: AgentSessionRuntime,
	options: PrintModeOptions,
): Promise<number> {
	const write = options.write ?? ((text: string): void => { process.stdout.write(text); });
	let unsubscribe = (): void => undefined;
	let bindingGeneration = 0;
	let headerPending = options.mode === "json";
	let status = 0;

	const reportExtensionError = (failure: ExtensionError): void => {
		const event = {
			type: "extension_error" as const,
			extensionPath: defaultSecretRedactor.redact(failure.extensionPath),
			event: failure.event,
			error: defaultSecretRedactor.redact(failure.error),
		};
		if (options.mode === "json") write(`${JSON.stringify(event)}\n`);
		else console.error(safeDiagnostic(`Extension error (${event.extensionPath}, ${event.event}): ${event.error}`));
	};

	const bind = async (session: AgentSession): Promise<void> => {
		const generation = ++bindingGeneration;
		await session.bindExtensions({
			mode: options.mode === "json" ? "json" : "print",
			commandContextActions: createAgentSessionRuntimeCommandActions(runtime, session),
			onError: reportExtensionError,
		});
		if (generation !== bindingGeneration) return;
		unsubscribe();
		unsubscribe = options.mode === "json"
			? session.subscribe((event) => { write(`${JSON.stringify(event)}\n`); })
			: (): void => undefined;
		if (headerPending) {
			headerPending = false;
			const header = session.sessionManager.getHeader();
			if (header !== null) write(`${JSON.stringify(header)}\n`);
		}
		await recoverNonInteractiveSession(session);
	};

	runtime.setBeforeSessionInvalidate(() => {
		bindingGeneration += 1;
		unsubscribe();
		unsubscribe = (): void => undefined;
	});
	runtime.setRebindSession(bind);

	try {
		await bind(runtime.session);

		const messages: Array<{ text: string; images?: readonly ImageContent[] }> = [];
		if (options.initialMessage !== undefined) {
			messages.push({
				text: options.initialMessage,
				...(options.initialImages === undefined ? {} : { images: options.initialImages }),
			});
		}
		for (const message of options.messages ?? []) messages.push({ text: message });

		for (const message of messages) {
			const images = message.images === undefined
				? undefined
				: canonicalPublicImages(message.images, "initialImages");
			await runtime.session.prompt(message.text, images === undefined ? {} : { images });
			const failure = assistantFailure(runtime.session);
			if (failure === undefined) continue;
			if (options.mode === "text") console.error(safeDiagnostic(failure));
			status = 1;
			break;
		}

		if (status === 0 && options.mode === "text") {
			const text = finalAssistantText(runtime.session);
			if (text !== "") write(`${text}\n`);
		}
	} catch (error) {
		status = 1;
		console.error(safeDiagnostic(error));
	} finally {
		bindingGeneration += 1;
		unsubscribe();
		runtime.setBeforeSessionInvalidate(undefined);
		runtime.setRebindSession(undefined);
		try {
			await runtime.dispose();
		} catch (error) {
			status = 1;
			console.error(safeDiagnostic(error));
		}
	}

	return status;
}
