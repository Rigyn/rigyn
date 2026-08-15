import type { CustomMessage } from "@rigyn/kernel";
import type { Component } from "@rigyn/terminal";

import type { CustomEntry } from "../session-contract.js";
import type { Theme } from "../../tui/theme.js";

export interface MessageRenderOptions {
  expanded: boolean;
  /** Current host transcript padding, for renderer alignment. */
  outputPad: number;
}
export interface EntryRenderOptions { expanded: boolean }

type Renderer<TValue, TOptions> = (
  value: TValue,
  options: TOptions,
  theme: Theme,
) => Component | undefined;

export type MessageRenderer<T = unknown> = Renderer<CustomMessage<T>, MessageRenderOptions>;

export type EntryRenderer<T = unknown> = Renderer<CustomEntry<T>, EntryRenderOptions>;

type MarkdownMessageKind = "user" | "assistant" | "assistant-thinking";

export interface MarkdownTransformContext {
  messageType: MarkdownMessageKind;
  isStreaming: boolean;
  availableWidth: number;
}

export type MarkdownTransformer = (markdown: string, context: Readonly<MarkdownTransformContext>) => string;
