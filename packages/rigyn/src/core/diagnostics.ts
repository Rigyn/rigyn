type ResourceKind = "extension" | "skill" | "prompt" | "theme";
type ResourceDiagnosticKind = "warning" | "error" | "collision";

interface ResourceCollisionIdentity {
	name: string;
	resourceType: ResourceKind;
}

interface ResourceCollisionLocations {
	loserPath: string;
	winnerPath: string;
	loserSource?: string;
	winnerSource?: string;
}

interface ResourceDiagnosticDescription {
  message: string;
  type: ResourceDiagnosticKind;
}

interface ResourceDiagnosticLocation {
  code?: string;
  path?: string;
	source?: string;
}

export interface ResourceCollision extends ResourceCollisionIdentity, ResourceCollisionLocations {}

export interface ResourceDiagnostic extends ResourceDiagnosticDescription, ResourceDiagnosticLocation {
  collision?: ResourceCollision;
}
