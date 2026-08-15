import type { ExtensionMode, ExtensionUIContext } from "../../host.js";

export type ProjectTrustEventDecision = "yes" | "no" | "undecided";

export interface ProjectTrustEvent {
  type: "project_trust";
  cwd: string;
}

export interface ProjectTrustEventResult {
  trusted: ProjectTrustEventDecision;
  remember?: boolean;
}

export interface ProjectTrustContext {
  readonly cwd: string;
  readonly mode: ExtensionMode;
  readonly hasUI: boolean;
  readonly ui: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;
}

export interface ResourcesDiscoverEvent {
  type: "resources_discover";
  cwd: string;
  reason: "startup" | "refresh";
}

export interface ResourcesDiscoverResult {
  skillPaths?: string[];
  promptPaths?: string[];
  themePaths?: string[];
}

export interface TrustResourceEventMap {
  resources_discover: ResourcesDiscoverEvent;
  project_trust: ProjectTrustEvent;
}

export interface TrustResourceEventResultMap {
  resources_discover: ResourcesDiscoverResult | void;
  project_trust: ProjectTrustEventResult | void;
}
