import type { AutocompleteProvider } from "./autocomplete.js";
import type { Component } from "./tui.js";

/** Interchangeable text editor surface understood by the raw TUI host. */
export interface EditorComponent extends Component {
  getText(): string;
  setText(text: string): void;
  handleInput(data: string): void;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  addToHistory?(text: string): void;
  insertTextAtCursor?(text: string): void;
  getExpandedText?(): string;
  setAutocompleteProvider?(provider: AutocompleteProvider): void;
  borderColor?: (text: string) => string;
  setPaddingX?(padding: number): void;
  setAutocompleteMaxVisible?(maximum: number): void;
}
