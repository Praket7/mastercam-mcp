import { z } from "zod";
import { categoryOf } from "../contracts.js";
import { TOOL_MANIFEST, type ToolManifestEntry } from "../tool-manifest.js";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  annotations: ToolAnnotations;
}

export const ToolEnvelopeSchema = z.object({
  ok: z.boolean(),
  tool: z.string(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
    remediation: z.string().optional()
  }).optional(),
  receipt: z.unknown().optional(),
  live: z.boolean().optional(),
  documentRevision: z.string().optional(),
  operationFingerprint: z.string().optional()
}).strict();

function outputEnvelope(dataSchema?: z.ZodTypeAny): z.ZodTypeAny {
  if (!dataSchema) return ToolEnvelopeSchema;
  return ToolEnvelopeSchema.extend({ data: dataSchema.optional() });
}

function annotationsForEntry(entry: ToolManifestEntry): ToolAnnotations {
  switch (entry.category) {
    case "read":
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: entry.idempotent };
    case "preview":
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: false };
    case "write":
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
    case "advanced":
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: false };
    default:
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOL_MANIFEST
  .filter(entry => entry.registered)
  .map(entry => ({
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: outputEnvelope(entry.outputDataSchema),
    annotations: annotationsForEntry(entry)
  }));

export function toolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find(definition => definition.name === name);
}

export function annotationsFor(name: string): ToolAnnotations {
  return toolDefinition(name)?.annotations ?? {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true
  };
}

export { categoryOf };
