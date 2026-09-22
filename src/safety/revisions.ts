import { fingerprintOperation, documentRevision } from "./approval.js";
export { fingerprintOperation as computeOperationFingerprint, fingerprintOperation, documentRevision };
export { documentRevision as generateRevision } from "./approval.js";
export function isStale(a: string, b: string): boolean {
  return a !== b;
}
export function computeDocumentFingerprint(ops: Array<{ id: number; [k: string]: unknown }>): string {
  return documentRevision(ops);
}
