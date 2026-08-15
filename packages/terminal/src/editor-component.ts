import type { AutocompleteProvider } from "./autocomplete.js";
import type { Component } from "./tui.js";
export interface EditorComponent extends Component {
  handleInput(data: string): void;
  getText(): string;
  getExpandedText(): string;
  setText(value: string): void;
  setAutocompleteProvider?(provider: AutocompleteProvider): void;
  isShowingAutocomplete?(): boolean;
  setPaddingX?(value: number): void;
  getPaddingX?(): number;
  setAutocompleteMaxVisible?(value: number): void;
  getAutocompleteMaxVisible?(): number;
  insertTextAtCursor?(value: string): void;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}
