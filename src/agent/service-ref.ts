export type ServiceScope = "host" | "contribution";
type Methods<T> = { readonly [K in keyof T]: T[K] extends (...args: any[]) => any ? true : never };
declare const serviceType: unique symbol;
export type ServiceRef<T extends object> = {
  readonly id: string; readonly version: number; readonly name: string; readonly scope: ServiceScope;
  readonly methods: Methods<T>;
  readonly [serviceType]?: (value: T) => T;
};
type AnyRef = ServiceRef<any>;

export function createServiceRef<T extends object>(input: { id: string; version: number; scope: ServiceScope; methods: Methods<T> }): ServiceRef<T> {
  const ref = { ...input, name: `${input.id}/v${input.version}`, methods: Object.freeze({ ...input.methods }) };
  serviceSignature(ref); return Object.freeze(ref);
}
export function serviceSignature(ref: AnyRef): string {
  if (!ref || typeof ref.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(ref.id)
    || !Number.isSafeInteger(ref.version) || ref.version < 1 || ref.version > 999
    || ref.name !== `${ref.id}/v${ref.version}` || !["host", "contribution"].includes(ref.scope)
    || !ref.methods || typeof ref.methods !== "object" || Array.isArray(ref.methods)) throw new Error("Invalid plugin service reference");
  const methods = Object.keys(ref.methods).sort();
  if (!methods.length || methods.length > 32 || methods.some(name => !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name)
    || ["constructor", "prototype", "__proto__", "then"].includes(name) || ref.methods[name] !== true)) throw new Error("Invalid plugin service methods");
  return JSON.stringify([ref.id, ref.version, ref.scope, methods]);
}
