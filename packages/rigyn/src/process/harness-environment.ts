export const ACTIVE_HARNESS_ENV = "RIGYN_ACTIVE";

/** Marks only executable CLI processes so child commands can detect the active harness. */
export function markActiveHarness(environment: NodeJS.ProcessEnv = process.env): void {
  environment[ACTIVE_HARNESS_ENV] = "true";
}
