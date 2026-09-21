import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as contractsModule from "../contracts.js";
import { allowed, DEFAULT_PROFILE, categoryOf, SUPPORTED_PROTOCOL_REVISIONS } from "../contracts.js";
import type { Profile } from "../contracts.js";
import type { Backend } from "../backend.js";
import { doctor } from "../diagnostics.js";
import { VERSION } from "../version.js";
import { compareJson, compareNc, setupSheet, validateMachine } from "../shop.js";
import { defaultPipe, selectedBackend } from "../platform.js";
import { TOOL_DEFINITIONS, ToolEnvelopeSchema } from "./registry.js";
import { AuditLog } from "../audit/audit-log.js";
import { mastercamError } from "../errors.js";

const READ_DEADLINE_MS = 30_000;

function envelope(result: { ok: boolean; tool: string; data?: unknown; error?: unknown; receipt?: unknown; live?: boolean; documentRevision?: string; operationFingerprint?: string }) {
  const parsed = ToolEnvelopeSchema.safeParse(result);
  const data = parsed.success ? parsed.data : result;
  return {
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data) }]
  };
}

export function createMcpServer(backend: Backend, profile: Profile = DEFAULT_PROFILE, hardReadOnly = true, audit?: AuditLog) {
  const server = new McpServer(
    { name: "mastercam-mcp", version: VERSION },
    {
      instructions:
        "Inspect before mutating. Mutations require preview_operation_parameters then apply_operation_parameter_preview with the returned approvalToken. Rollback uses the server-issued transactionId. Fixture data never proves live Mastercam behavior.",
      capabilities: { logging: {} }
    }
  );

  server.registerResource("active-part", "mastercam://active-part", { description: "Active part information from Mastercam", mimeType: "application/json" }, async () => {
    const data = await backend.call({ id: randomUUID(), tool: "get_active_part", arguments: {} });
    return { contents: [{ uri: "mastercam://active-part", mimeType: "application/json", text: JSON.stringify(data) }] };
  });
  server.registerResource("operations", "mastercam://operations", { description: "Operation listing from Mastercam", mimeType: "application/json" }, async () => {
    const data = await backend.call({ id: randomUUID(), tool: "list_operations", arguments: {} });
    return { contents: [{ uri: "mastercam://operations", mimeType: "application/json", text: JSON.stringify(data) }] };
  });
  server.registerResource("diagnostics", "mastercam://diagnostics", { description: "Diagnostics for the active backend", mimeType: "application/json" }, async () => {
    const data = await doctor(process.env.MASTERCAM_MCP_PIPE ?? defaultPipe(), selectedBackend());
    return { contents: [{ uri: "mastercam://diagnostics", mimeType: "application/json", text: JSON.stringify(data) }] };
  });

  for (const definition of TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations
      },
      async (args: Record<string, unknown>, extra) => {
        const name = definition.name;
        const category = categoryOf(name);
        if (!allowed(name, profile, hardReadOnly)) {
          return {
            isError: true,
            ...envelope({ ok: false, tool: name, error: mastercamError("PROFILE_DENIED", `Tool ${name} is not enabled by the server profile '${profile}'`) })
          };
        }
        // Request-scoped deadline: an AbortController fires if the call exceeds
        // the read deadline or the client cancels, and handlers receive it.
        const signal = extra.signal;
        let timedOut = false;
        const deadlineTimer = setTimeout(() => { timedOut = true; }, READ_DEADLINE_MS);
        deadlineTimer.unref?.();
        signal?.addEventListener("abort", () => clearTimeout(deadlineTimer), { once: true });
        try {
          let result: { ok: boolean; tool: string; data?: unknown; error?: unknown; receipt?: unknown; live?: boolean; documentRevision?: string; operationFingerprint?: string };
          if (name === "mastercam_doctor") {
            result = await doctor(process.env.MASTERCAM_MCP_PIPE ?? defaultPipe(), selectedBackend());
          } else if (name === "mastercam_help" || name === "list_tool_categories" || name === "mastercam_plan") {
            result = { ok: true, tool: name, data: helpPayload(name, profile, hardReadOnly) };
          } else if (name === "get_compatibility_matrix") {
            const { compatibilityReport } = await import("../compatibility.js");
            result = { ok: true, tool: name, data: compatibilityReport() };
          } else if (name === "generate_setup_sheet") {
            result = { ok: true, tool: name, data: setupSheet(args as never) };
          } else if (name === "compare_tool_databases") {
            result = { ok: true, tool: name, data: compareJson(args.left, args.right) };
          } else if (name === "compare_nc_files") {
            result = { ok: true, tool: name, data: compareNc(String(args.before ?? ""), String(args.after ?? "")) };
          } else if (name === "validate_machine_profile") {
            result = { ok: true, tool: name, data: validateMachine((args.operation ?? {}) as Record<string, unknown>, (args.profile ?? {}) as Record<string, unknown>) };
          } else {
            result = await backend.call({ id: randomUUID(), tool: name, arguments: args ?? {} });
          }
          if (category === "write") {
            audit?.record({ requestId: extra.requestId ?? randomUUID(), tool: name, target: (args ?? {}) as Record<string, unknown>, policy: { profile, hardReadOnly } });
          }
          return envelope(result);
        } catch (error) {
          clearTimeout(deadlineTimer);
          const message = error instanceof Error ? error.message : String(error);
          const isTimeout = timedOut || message.startsWith("TIMEOUT");
          const isAbort = signal?.aborted === true || message.startsWith("CANCELLED");
          return {
            isError: true,
            ...envelope({
              ok: false,
              tool: name,
              error: isAbort
                ? mastercamError("CANCELLED", "Request was cancelled before completion")
                : mastercamError(isTimeout ? "TIMEOUT" : "BACKEND_UNAVAILABLE", message)
            })
          };
        }
        clearTimeout(deadlineTimer);
      }
    );
  }
  return server;
}

function helpPayload(name: string, profile: Profile, hardReadOnly: boolean) {
  const { READ_TOOLS, PREVIEW_TOOLS, WRITE_TOOLS, ADVANCED_TOOLS, FORBIDDEN_TOOLS } = contractsModule;
  if (name === "mastercam_plan") {
    return {
      steps: ["inspect target", "preview_operation_parameters", "apply_operation_parameter_preview with approvalToken", "verify by rereading", "rollback_change with transactionId if needed"],
      safeDefault: "read only",
      profile,
      hardReadOnly
    };
  }
  if (name === "list_tool_categories") {
    return { read: READ_TOOLS, preview: PREVIEW_TOOLS, write: WRITE_TOOLS, advanced: ADVANCED_TOOLS, forbidden: FORBIDDEN_TOOLS, profile, protocolRevisions: SUPPORTED_PROTOCOL_REVISIONS };
  }
  return {
    tools: TOOL_DEFINITIONS.map(definition => ({ name: definition.name, description: definition.description, annotations: definition.annotations })),
    profile,
    hardReadOnly,
    safety: "Fixture results never prove live Mastercam or machine safety; machine execution tools are permanently unavailable"
  };
}
