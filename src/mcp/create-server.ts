import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import * as contractsModule from "../contracts.js";
import { allowed, DEFAULT_PROFILE, categoryOf, SUPPORTED_PROTOCOL_REVISIONS } from "../contracts.js";
import type { Profile } from "../contracts.js";
import type { Backend, ToolResult } from "../backend.js";
import { LiveBackend } from "../live-backend.js";
import { doctor } from "../diagnostics.js";
import { VERSION } from "../version.js";
import { compareJson, compareNc, setupSheet, validateMachine } from "../shop.js";
import { defaultPipe, selectedBackend } from "../platform.js";
import { TOOL_DEFINITIONS, ToolEnvelopeSchema } from "./registry.js";
import type { ToolDefinition } from "./registry.js";
import { mastercamError } from "../errors.js";

const READ_DEADLINE_MS = 30_000;
const WRITE_DEADLINE_MS = 90_000;
const ADVANCED_DEADLINE_MS = 120_000;

/**
 * The current native adapters are Stage A environment bridges. Keep MCP
 * discovery truthful: a live server must not advertise fixture-only tools.
 * Portable/mock mode continues to expose the complete registered contract.
 */
const LIVE_STAGE_A_TOOL_NAMES = new Set(["mastercam_status", "mastercam_capabilities"]);

export function advertisedToolDefinitions(
  backendKind: "mock" | "live"
): ToolDefinition[] {
  if (backendKind === "mock") return TOOL_DEFINITIONS;
  return TOOL_DEFINITIONS.filter(definition => LIVE_STAGE_A_TOOL_NAMES.has(definition.name));
}

function envelope(result: ToolResult, schema: z.ZodType = ToolEnvelopeSchema) {
  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    const failure = {
      ok: false,
      tool: result.tool,
      error: {
        code: "BACKEND_UNAVAILABLE",
        message: `Malformed tool output: ${parsed.error.message}`
      }
    };
    return {
      isError: true as const,
      structuredContent: failure,
      content: [{ type: "text" as const, text: JSON.stringify(failure) }]
    };
  }

  const structuredContent = parsed.data as Record<string, unknown>;
  return {
    ...(structuredContent.ok === false ? { isError: true as const } : {}),
    structuredContent,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }]
  };
}

function deadlineFor(category: ReturnType<typeof categoryOf>): number {
  if (category === "write") return WRITE_DEADLINE_MS;
  if (category === "advanced") return ADVANCED_DEADLINE_MS;
  return READ_DEADLINE_MS;
}

export function createMcpServer(
  backend: Backend,
  profile: Profile = DEFAULT_PROFILE,
  hardReadOnly = true
) {
  const backendKind: "mock" | "live" = backend instanceof LiveBackend ? "live" : "mock";
  const definitions = advertisedToolDefinitions(backendKind);
  const server = new McpServer(
    { name: "mastercam-mcp", version: VERSION },
    {
      instructions:
        backendKind === "live"
          ? "This native adapter is Stage A. Use mastercam_status and mastercam_capabilities only; broader live Mastercam mappings require licensed acceptance before they are advertised."
          : "Inspect before mutating. Mutations require preview_operation_parameters then apply_operation_parameter_preview with the returned approvalToken. Rollback uses the server-issued transactionId. Fixture data never proves live Mastercam behavior."
    }
  );

  // Fixture resources mirror the portable inspection contract. The current
  // live Stage-A adapter cannot serve these resources, so do not advertise
  // resources that would deterministically return UNSUPPORTED_CAPABILITY.
  if (backendKind === "mock") {
    server.registerResource(
      "active-part",
      "mastercam://active-part",
      { description: "Active part information from the fixture backend", mimeType: "application/json" },
      async () => {
        const data = await backend.call({ id: randomUUID(), tool: "get_active_part", arguments: {} });
        return {
          contents: [
            { uri: "mastercam://active-part", mimeType: "application/json", text: JSON.stringify(data) }
          ]
        };
      }
    );

    server.registerResource(
      "operations",
      "mastercam://operations",
      { description: "Operation listing from the fixture backend", mimeType: "application/json" },
      async () => {
        const data = await backend.call({ id: randomUUID(), tool: "list_operations", arguments: {} });
        return {
          contents: [
            { uri: "mastercam://operations", mimeType: "application/json", text: JSON.stringify(data) }
          ]
        };
      }
    );
  }

  server.registerResource(
    "diagnostics",
    "mastercam://diagnostics",
    { description: "Diagnostics for the active backend", mimeType: "application/json" },
    async () => {
      const data = await doctor(process.env.MASTERCAM_MCP_PIPE ?? defaultPipe(), selectedBackend());
      return {
        contents: [
          { uri: "mastercam://diagnostics", mimeType: "application/json", text: JSON.stringify(data) }
        ]
      };
    }
  );

  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      {
        ...(definition.title ? { title: definition.title } : {}),
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        annotations: definition.annotations
      },
      async (validatedArgs, ctx) => {
        const args = validatedArgs as Record<string, unknown>;
        const name = definition.name;
        const category = categoryOf(name);

        if (!allowed(name, profile, hardReadOnly)) {
          return envelope(
            {
              ok: false,
              tool: name,
              error: mastercamError(
                "PROFILE_DENIED",
                `Tool ${name} is not enabled by the server profile '${profile}'`
              )
            },
            definition.outputSchema
          );
        }

        const signal = ctx.mcpReq.signal;
        const abortController = new AbortController();
        const onExternalAbort = () => abortController.abort(signal.reason);
        signal.addEventListener("abort", onExternalAbort, { once: true });

        let timedOut = false;
        const deadlineMs = deadlineFor(category);
        const deadlineTimer = setTimeout(() => {
          timedOut = true;
          abortController.abort(new Error(`TIMEOUT: ${name} exceeded ${deadlineMs}ms deadline`));
        }, deadlineMs);
        deadlineTimer.unref?.();

        try {
          if (abortController.signal.aborted) {
            throw new Error("CANCELLED: request aborted before execution");
          }

          let result: ToolResult;
          if (name === "mastercam_doctor") {
            result = await doctor(process.env.MASTERCAM_MCP_PIPE ?? defaultPipe(), selectedBackend());
          } else if (
            name === "mastercam_help" ||
            name === "list_tool_categories" ||
            name === "mastercam_plan"
          ) {
            result = { ok: true, tool: name, data: helpPayload(name, profile, hardReadOnly) };
          } else if (name === "get_compatibility_matrix") {
            const { compatibilityReport } = await import("../compatibility.js");
            result = { ok: true, tool: name, data: compatibilityReport() };
          } else if (name === "generate_setup_sheet") {
            result = { ok: true, tool: name, data: setupSheet(args as never) };
          } else if (name === "compare_tool_databases") {
            result = { ok: true, tool: name, data: compareJson(args.left, args.right) };
          } else if (name === "compare_nc_files") {
            result = {
              ok: true,
              tool: name,
              data: compareNc(String(args.before ?? ""), String(args.after ?? ""))
            };
          } else if (name === "validate_machine_profile") {
            result = {
              ok: true,
              tool: name,
              data: validateMachine(
                (args.operation ?? {}) as Record<string, unknown>,
                (args.profile ?? {}) as Record<string, unknown>
              )
            };
          } else {
            result = await backend.call(
              {
                id: String(ctx.mcpReq.id ?? randomUUID()),
                tool: name,
                arguments: args ?? {}
              },
              { signal: abortController.signal }
            );
          }

          if (abortController.signal.aborted && !result.ok) {
            throw abortController.signal.reason instanceof Error
              ? abortController.signal.reason
              : new Error("CANCELLED: request aborted");
          }

          return envelope(result, definition.outputSchema);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isTimeout = timedOut || message.startsWith("TIMEOUT");
          const isAbort =
            signal.aborted ||
            abortController.signal.aborted ||
            message.startsWith("CANCELLED");

          return envelope(
            {
              ok: false,
              tool: name,
              error: isTimeout
                ? mastercamError("TIMEOUT", "Request deadline expired before completion")
                : isAbort
                  ? mastercamError("CANCELLED", "Request was cancelled before completion")
                  : mastercamError("BACKEND_UNAVAILABLE", message)
            },
            definition.outputSchema
          );
        } finally {
          clearTimeout(deadlineTimer);
          signal.removeEventListener("abort", onExternalAbort);
        }
      }
    );
  }

  return server;
}

function helpPayload(name: string, profile: Profile, hardReadOnly: boolean) {
  const { READ_TOOLS, PREVIEW_TOOLS, WRITE_TOOLS, ADVANCED_TOOLS, FORBIDDEN_TOOLS } =
    contractsModule;

  if (name === "mastercam_plan") {
    return {
      steps: [
        "inspect target",
        "preview_operation_parameters",
        "apply_operation_parameter_preview with approvalToken",
        "verify by rereading",
        "rollback_change with transactionId if needed"
      ],
      safeDefault: "read only",
      profile,
      hardReadOnly
    };
  }

  if (name === "list_tool_categories") {
    return {
      read: READ_TOOLS,
      preview: PREVIEW_TOOLS,
      write: WRITE_TOOLS,
      advanced: ADVANCED_TOOLS,
      forbidden: FORBIDDEN_TOOLS,
      profile,
      protocolRevisions: SUPPORTED_PROTOCOL_REVISIONS
    };
  }

  return {
    tools: TOOL_DEFINITIONS.map(definition => ({
      name: definition.name,
      description: definition.description,
      annotations: definition.annotations
    })),
    profile,
    hardReadOnly,
    protocolRevisions: SUPPORTED_PROTOCOL_REVISIONS,
    safety:
      "Fixture results never prove live Mastercam or machine safety; machine execution tools are permanently unavailable"
  };
}
