/**
 * `base-64` ships no types. Only `decode` is used (to read the JWT payload
 * during auth hydration), so that's all this declares — a full `any` module
 * shim would silently accept typos in the rest of the surface.
 */
declare module 'base-64' {
  export function decode(input: string): string;
  export function encode(input: string): string;
}
