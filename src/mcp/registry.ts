import * as z from "zod/v4";
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
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
}

export const ToolEnvelopeSchema = z.object({
  ok: z.boolean().describe("True when the tool completed successfully; false when the result contains an error."),
  tool: z.string().describe("Canonical MCP tool name that produced this response."),
  data: z.unknown().optional().describe("Tool-specific result data. Its shape is defined by the selected tool's output schema."),
  error: z.object({
    code: z.string().describe("Stable machine-readable error code for handling or diagnostics."),
    message: z.string().describe("Plain-language explanation of the failure."),
    retryable: z.boolean().optional().describe("Whether retrying the same request may succeed without changing its inputs."),
    remediation: z.string().optional().describe("Suggested action for resolving the reported failure, when available.")
  }).optional().describe("Failure details present when the tool did not complete successfully."),
  receipt: z.unknown().optional().describe("Server-issued transaction receipt when the tool applies a change."),
  live: z.boolean().optional().describe("True when this result came from the live Mastercam backend rather than a fixture."),
  documentRevision: z.string().optional().describe("Document revision associated with the result, when the backend exposes one."),
  operationFingerprint: z.string().optional().describe("Fingerprint of the exact operation state associated with the result, when available.")
}).strict();

function outputEnvelope(dataSchema?: z.ZodType): z.ZodType {
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
    title: entry.name.split("_").map(part => part[0]!.toUpperCase() + part.slice(1)).join(" "),
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
