import { type TUnsafe, Type } from "typebox";

export function StringEnum<const T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...(options?.description === undefined ? {} : { description: options.description }), ...(options?.default === undefined ? {} : { default: options.default }) });
}
