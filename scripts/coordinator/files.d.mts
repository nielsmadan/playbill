export function hash(bytes: string | Uint8Array): string;
export function safePath(root: string, name: string): string;
export function writeJSON(
  root: string,
  name: string,
  value: unknown,
  exclusive?: boolean,
): void;
