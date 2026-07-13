import type { JsonValue } from "../core/json.js";

export function inputObject(value: JsonValue): { [key: string]: JsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool input must be an object");
  return value;
}

export function stringInput(object: { [key: string]: JsonValue }, key: string, fallback?: string): string {
  const value = object[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

export function numberInput(object: { [key: string]: JsonValue }, key: string, fallback: number): number {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

export function booleanInput(object: { [key: string]: JsonValue }, key: string, fallback: boolean): boolean {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

export function stringArrayInput(object: { [key: string]: JsonValue }, key: string): string[] | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${key} must be an array of strings`);
  return value as string[];
}
