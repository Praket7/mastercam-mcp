import { createHash } from "node:crypto";

export function computeDocumentFingerprint(operations: Array<{ id: number; [key: string]: unknown }>): string {
  const opHashes = operations.map(op => computeOperationFingerprint(op));
  return createHash("sha256").update(opHashes.sort().join("|")).digest("hex");
}

export function computeOperationFingerprint(operation: { id: number; [key: string]: unknown }): string {
  const { id, ...rest } = operation;
  const sorted = Object.keys(rest).sort().reduce((acc, key) => { acc[key] = rest[key]; return acc; }, {} as Record<string, unknown>);
  return createHash("sha256").update(JSON.stringify({ id, ...sorted })).digest("hex");
}

export function computePartFingerprint(part: { name: string; path: string; units: string; [key: string]: unknown }): string {
  return createHash("sha256").update(JSON.stringify(part, Object.keys(part).sort())).digest("hex");
}

export function isStale(storedRevision: string, currentRevision: string): boolean {
  return storedRevision !== currentRevision;
}

export function generateRevision(): string {
  return `rev-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}