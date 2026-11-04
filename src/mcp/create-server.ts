import { randomBytes, randomUUID } from "node:crypto";
import { createRequestStateCodec, inputRequired, inputResponse, McpServer } from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import type { AuditLog } from "../audit/audit-log.js";
import { allowed, DEFAULT_PROFILE, categoryOf } from "../contracts.js";
import type { Profile } from "../contracts.js";
import type { Backend, ToolResult } from "../backend.js";
import { LiveBackend } from "../live-backend.js";
import {
  SERVER_LOCAL_TOOL_NAMES,
  LIVE_NATIVE_STAGE_A_TOOL_NAMES,
  LIVE_NATIVE_STAGE_B_READ_TOOL_NAMES,
  stageBReadsEnabled
} from "../execution-surface.js";
import { doctor } from "../diagnostics.js";
import { VERSION } from "../version.js";
import { compareNc, compareToolDatabases, setupSheet, validateMachine } from "../shop.js";
import {
  analyzePostRegression,
  analyzeRegenerationImpact,
  manufacturingPreflight,
  ManufacturingPreflightSchema,
  PostRegressionSchema,
  RegenerationImpactSchema
} from "../manufacturing-intelligence.js";
import {
  analyzeCycleTime,
  analyzeToolpathRisk,
  calculateThreadTap,
  generateOperationPacket,
  planOdRoughFinish,
  recommendJobTooling,
  AnalyzeCycleTimeSchema,
  CycleTimeToolSchema,
  AnalyzeToolpathRiskSchema,
  CalculateThreadTapSchema,
  GenerateOperationPacketSchema,
  PlanOdRoughFinishSchema,
  RecommendJobToolingSchema
} from "../job-intelligence.js";
import { defaultPipe, selectedBackend } from "../platform.js";
import { TOOL_DEFINITIONS, ToolEnvelopeSchema } from "./registry.js";
import type { ToolDefinition } from "./registry.js";
import { ERROR_CODES, mastercamError, MastercamErrorImpl, isMastercamError, type ErrorCode } from "../errors.js";
import { ZodError } from "zod/v4";
import { loadShopToolLibrary, mergeActiveJobTools } from "../shop-tool-library.js";
import { analyzeNcProgram, AnalyzeNcProgramSchema } from "../nc-program.js";
import { COMPACT_TOOL_NAMES } from "../tool-manifest.js";
import { capability } from "../capabilities.js";

const READ_DEADLINE_MS = 30_000;
const WRITE_DEADLINE_MS = 90_000;
const ADVANCED_DEADLINE_MS = 120_000;
const pendingMutationPreviews = new Map<string, Record<string, unknown>>();
interface OperatorApprovalState {
  token: string;
  operationId: unknown;
  before: unknown;
  after: unknown;
  documentRevision: unknown;
  operationFingerprint: unknown;
  expiresAt: unknown;
}
const operatorApprovalState = createRequestStateCodec<OperatorApprovalState>({
  key: randomBytes(32),
  ttlSeconds: 600,
  bind: ctx => ctx.http?.authInfo?.clientId ?? ctx.http?.req?.headers.get("authorization") ?? ctx.sessionId ?? "local-stdio"
});

function rememberMutationPreview(data: unknown): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const preview = data as Record<string, unknown>;
  if (typeof preview.approvalToken !== "string" || typeof preview.expiresAt !== "string") return;
  const expiry = Date.parse(preview.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return;
  for (const [token, record] of pendingMutationPreviews) {
    if (Date.parse(String(record.expiresAt)) <= Date.now()) pendingMutationPreviews.delete(token);
  }
  pendingMutationPreviews.set(preview.approvalToken, preview);
  while (pendingMutationPreviews.size > 500) {
    const oldest = pendingMutationPreviews.keys().next().value;
    if (oldest === undefined) break;
    pendingMutationPreviews.delete(oldest);
  }
}

function approvalPrompt(preview: Record<string, unknown>): string {
  return [
    `Approve this Mastercam change for operation ${String(preview.operationId)}?`,
    `Before: ${JSON.stringify(preview.before)}`,
    `After: ${JSON.stringify(preview.after)}`,
    `Document revision: ${String(preview.documentRevision)}`,
    `Operation fingerprint: ${String(preview.operationFingerprint)}`,
    `Approval expires: ${String(preview.expiresAt)}`,
    "The MCP client must show this request to the operator and return an explicit yes."
  ].join("\n");
}

function approvalStateMatches(
  preview: Record<string, unknown>,
  token: string,
  state: OperatorApprovalState | undefined
): boolean {
  return Boolean(state && state.token === token &&
    state.operationId === preview.operationId &&
    state.documentRevision === preview.documentRevision &&
    state.operationFingerprint === preview.operationFingerprint &&
    state.expiresAt === preview.expiresAt &&
    JSON.stringify(state.before) === JSON.stringify(preview.before) &&
    JSON.stringify(state.after) === JSON.stringify(preview.after));
}

/** Full mode exposes specialist tools; the compact default narrows that catalog. Live mode
 * exposes only native mappings that exist and utilities implemented by this server. */
export function advertisedToolDefinitions(
  backendKind: "mock" | "live",
  toolAllowlist?: readonly string[],
  toolset: "compact" | "full" = "compact"
): ToolDefinition[] {
  const stageB = stageBReadsEnabled();
  const available = backendKind === "mock" ? TOOL_DEFINITIONS : TOOL_DEFINITIONS.filter(
    definition =>
      LIVE_NATIVE_STAGE_A_TOOL_NAMES.has(definition.name) ||
      (stageB && LIVE_NATIVE_STAGE_B_READ_TOOL_NAMES.has(definition.name)) ||
      SERVER_LOCAL_TOOL_NAMES.has(definition.name)
  );
  if (toolAllowlist === undefined) {
    return toolset === "full" ? available : available.filter(definition => COMPACT_TOOL_NAMES.has(definition.name));
  }

  // Selection only narrows the existing execution surface. A configured name
  // cannot enable a forbidden tool or a native mapping the backend hides.
  const registered = new Set(TOOL_DEFINITIONS.map(definition => definition.name));
  for (const name of toolAllowlist) {
    if (!registered.has(name)) {
      throw new Error(`MASTERCAM_MCP_TOOLS contains an unknown or unregistered tool: ${name}`);
    }
  }
  const selected = new Set(toolAllowlist);
  return available.filter(definition => selected.has(definition.name));
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

function errorForToolFailure(error: unknown, timedOut: boolean, aborted: boolean) {
  const message = error instanceof Error ? error.message : String(error);
  if (timedOut || message.startsWith("TIMEOUT")) {
    return mastercamError("TIMEOUT", "Request deadline expired before completion");
  }
  if (aborted || message.startsWith("CANCELLED")) {
    return mastercamError("CANCELLED", "Request was cancelled before completion");
  }
  if (isMastercamError(error)) {
    return mastercamError(error.code, error.message, {
      retryable: error.retryable,
      ...(error.remediation ? { remediation: error.remediation } : {})
    });
  }
  if (error instanceof ZodError) {
    const details = error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
    return mastercamError("VALIDATION_FAILED", details);
  }
  const prefixed = message.match(/^([A-Z][A-Z0-9_]+):\s*(.*)$/);
  const code = prefixed?.[1];
  if (code && ERROR_CODES.includes(code as ErrorCode)) {
    return mastercamError(code as ErrorCode, prefixed?.[2] || code);
  }
  return mastercamError("BACKEND_UNAVAILABLE", message);
}

export function createMcpServer(
  backend: Backend,
  profile: Profile = DEFAULT_PROFILE,
  hardReadOnly = true,
  toolAllowlist?: readonly string[],
  toolset: "compact" | "full" = "compact",
  auditLog?: AuditLog
) {
  const backendKind: "mock" | "live" = backend instanceof LiveBackend ? "live" : "mock";
  const definitions = advertisedToolDefinitions(backendKind, toolAllowlist, toolset)
    .filter(definition => allowed(definition.name, profile, hardReadOnly));
  const server = new McpServer(
    { name: "mastercam-mcp", version: VERSION },
    {
      requestState: { verify: operatorApprovalState.verify },
      instructions: [
        toolset === "compact" && toolAllowlist === undefined ? "The compact toolset is active. Set MASTERCAM_MCP_TOOLSET=full to expose specialist inspection and analysis tools, or MASTERCAM_MCP_TOOLS to select a custom set." : "",
        "The tool list reflects the active server profile and hard-read-only setting. A selected tool appears only when both settings permit it.",
        backendKind === "live"
          ? stageBReadsEnabled()
            ? "Native Stage-B reads remain IMPLEMENTED, not LIVE_READ_VERIFIED, until licensed acceptance passes. Server-local analysis does not imply additional native mappings."
            : "Only Stage-A connection reporting is native-backed by default. Enable MASTERCAM_MCP_ENABLE_STAGE_B_READS=1 on a licensed workstation to expose Stage-B read candidates."
          : "Fixture results are synthetic and do not prove live Mastercam behavior.",
        "Use get_job_context for a single bounded job snapshot. The report marks unavailable sections instead of treating missing data as zero. NC and toolpath analyses flag unknown motion and are not machine simulation.",
        "Mutations require preview_operation_parameters, explicit MCP client approval of the exact change, then apply_operation_parameter_preview with its approvalToken. Use verify_change to reread values and rollback_change with the transactionId if needed. plan_od_rough_finish is a non-executable preview."
      ].filter(Boolean).join(" ")
    }
  );

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

          if (name === "apply_operation_parameter_preview") {
            const token = typeof args.approvalToken === "string" ? args.approvalToken : "";
            const preview = pendingMutationPreviews.get(token);
            if (!preview || Date.parse(String(preview.expiresAt)) <= Date.now()) {
              pendingMutationPreviews.delete(token);
              return envelope({
                ok: false,
                tool: name,
                error: mastercamError("APPROVAL_TOKEN_INVALID", "A fresh preview is required before operator approval")
              }, definition.outputSchema);
            }
            const state = ctx.mcpReq.requestState<OperatorApprovalState>();
            if (state && !approvalStateMatches(preview, token, state)) {
              pendingMutationPreviews.delete(token);
              return envelope({
                ok: false,
                tool: name,
                error: mastercamError("APPROVAL_REQUIRED", "Approval state does not match this preview, client session, or document revision")
              }, definition.outputSchema);
            }
            const response = inputResponse(ctx.mcpReq.inputResponses, "operatorApproval");
            if (response.kind !== "missing" && (!state || !approvalStateMatches(preview, token, state))) {
              pendingMutationPreviews.delete(token);
              return envelope({
                ok: false,
                tool: name,
                error: mastercamError("APPROVAL_REQUIRED", "Operator input is missing its signed preview request state")
              }, definition.outputSchema);
            }
            if (response.kind === "missing") {
              return inputRequired({
                requestState: await operatorApprovalState.mint({
                  token,
                  operationId: preview.operationId,
                  before: preview.before,
                  after: preview.after,
                  documentRevision: preview.documentRevision,
                  operationFingerprint: preview.operationFingerprint,
                  expiresAt: preview.expiresAt
                }, ctx),
                inputRequests: {
                  operatorApproval: inputRequired.elicit({
                    message: approvalPrompt(preview),
                    requestedSchema: {
                      type: "object",
                      properties: { confirm: { type: "boolean", title: "I approve this exact change" } },
                      required: ["confirm"]
                    }
                  })
                }
              });
            }
            if (response.kind !== "elicit" || response.action !== "accept" || response.content?.confirm !== true) {
              pendingMutationPreviews.delete(token);
              return envelope({
                ok: false,
                tool: name,
                error: mastercamError("APPROVAL_REQUIRED", "The operator declined or did not confirm this exact change")
              }, definition.outputSchema);
            }
            pendingMutationPreviews.delete(token);
          }

          let result: ToolResult;
          if (name === "get_server_readiness") {
            const [diagnostics, connection, capabilities] = await Promise.all([
              doctor(process.env.MASTERCAM_MCP_PIPE ?? defaultPipe(), selectedBackend()),
              backend.call({ id: randomUUID(), tool: "mastercam_status", arguments: {} }, { signal: abortController.signal }),
              backend.call({ id: randomUUID(), tool: "mastercam_capabilities", arguments: {} }, { signal: abortController.signal })
            ]);
            result = {
              ok: diagnostics.ok && connection.ok && capabilities.ok,
              tool: name,
              data: {
                diagnostics: diagnostics.data,
                connection: connection.ok ? connection.data : { error: connection.error },
                capabilities: capabilities.ok ? capabilities.data : { error: capabilities.error }
              }
            };
          } else if (name === "get_job_context") {
            const routes: Record<string, string> = {
              part: "get_active_part", geometry: "get_geometry_summary", machine: "get_machine_context",
              stock: "get_stock", wcs: "get_wcs", post: "get_post_processor",
              operations: "get_programming_context", tools: "list_tools"
            };
            const sections = args.sections as string[];
            const entries = await Promise.all(sections.map(async section => {
              try {
                const response = await backend.call({ id: randomUUID(), tool: routes[section]!, arguments: {} }, { signal: abortController.signal });
                return [section, response.ok
                  ? { status: "available", sourceTool: response.tool, live: response.live === true, data: response.data, ...(response.documentRevision ? { documentRevision: response.documentRevision } : {}) }
                  : { status: "unavailable", error: response.error }] as const;
              } catch (error) {
                return [section, { status: "unavailable", error: { code: "BACKEND_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) } }] as const;
              }
            }));
            const context = Object.fromEntries(entries);
            result = {
              ok: true,
              tool: name,
              data: { sections: context, unavailable: entries.filter(([, value]) => value.status === "unavailable").map(([section]) => section) }
            };
          } else if (name === "get_audit_history") {
            if (auditLog) {
              result = {
                ok: true,
                tool: name,
                data: await auditLog.getRecentEntries(typeof args.limit === "number" ? args.limit : 50)
              };
            } else if (backendKind === "mock") {
              result = await backend.call({ id: randomUUID(), tool: name, arguments: args }, { signal: abortController.signal });
            } else {
              result = {
                ok: false,
                tool: name,
                error: mastercamError("CAPABILITY_UNAVAILABLE", "The server did not provide its audit log reader")
              };
            }
          } else if (name === "discover_capabilities") {
            result = {
              ok: true,
              tool: name,
              data: discoverCapabilitiesPayload(args, definitions, backendKind)
            };
          } else if (name === "generate_setup_sheet") {
            result = { ok: true, tool: name, data: setupSheet(args as never) };
          } else if (name === "compare_tool_databases") {
            result = { ok: true, tool: name, data: compareToolDatabases(args.left, args.right) };
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
          } else if (name === "manufacturing_preflight") {
            result = {
              ok: true,
              tool: name,
              data: manufacturingPreflight(ManufacturingPreflightSchema.parse(args))
            };
          } else if (name === "analyze_regeneration_impact") {
            result = {
              ok: true,
              tool: name,
              data: analyzeRegenerationImpact(RegenerationImpactSchema.parse(args))
            };
          } else if (name === "analyze_post_regression") {
            result = {
              ok: true,
              tool: name,
              data: analyzePostRegression(PostRegressionSchema.parse(args))
            };
          } else if (name === "recommend_job_tooling") {
            const parsed = RecommendJobToolingSchema.parse(args);
            const library = loadShopToolLibrary();
            let activeTools: unknown[] = [];
            if (!(Array.isArray(args.tools) && args.tools.length > 0)) {
              const active = await backend.call({ id: randomUUID(), tool: "list_tools", arguments: {} }, { signal: abortController.signal });
              activeTools = active.ok && Array.isArray(active.data) ? active.data : [];
            }
            const candidates = Array.isArray(args.tools) && args.tools.length > 0
              ? parsed.tools
              : mergeActiveJobTools(library, activeTools)?.tools ?? [];
            if (parsed.units && library?.units && parsed.units !== library.units) {
              throw new MastercamErrorImpl(
                "VALIDATION_FAILED",
                `Job units (${parsed.units}) do not match configured shop tool-library units (${library.units})`,
                { remediation: "Use one unit system for the job and configured shop tool catalog, or supply tool records in the job units." }
              );
            }
            result = {
              ok: true,
              tool: name,
              data: recommendJobTooling({ ...parsed, units: parsed.units ?? library?.units, tools: candidates })
            };
          } else if (name === "analyze_toolpath_risk") {
            result = {
              ok: true,
              tool: name,
              data: analyzeToolpathRisk(AnalyzeToolpathRiskSchema.parse(args))
            };
          } else if (name === "analyze_nc_program") {
            result = { ok: true, tool: name, data: analyzeNcProgram(AnalyzeNcProgramSchema.parse(args)) };
          } else if (name === "analyze_cycle_time") {
            const parsed = CycleTimeToolSchema.parse(args);
            if (parsed.source === "active_operations") {
              result = await backend.call({
                id: randomUUID(), tool: "estimate_cycle_time", arguments: { operationIds: parsed.operationIds }
              }, { signal: abortController.signal });
            } else {
              const events = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "source"));
              result = { ok: true, tool: name, data: analyzeCycleTime(AnalyzeCycleTimeSchema.parse(events)) };
            }
          } else if (name === "generate_operation_packet") {
            const parsed = GenerateOperationPacketSchema.parse(args);
            let operations = parsed.operations;
            const notes = [...parsed.notes];
            if (operations === undefined) {
              const active = await backend.call({ id: randomUUID(), tool: "list_operations", arguments: { limit: 500 } }, { signal: abortController.signal });
              operations = active.ok && Array.isArray(active.data)
                ? active.data.flatMap((value, index) => {
                    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
                    const operation = value as Record<string, unknown>;
                    const id = operation.id ?? operation.operationId;
                    const name = typeof operation.name === "string" ? operation.name : undefined;
                    if ((typeof id !== "number" && typeof id !== "string") || !name) return [];
                    const feed = operation.feedRate ?? operation.feed;
                    const spindle = operation.spindleSpeed;
                    const number = (quantity: unknown): number | undefined => {
                      if (typeof quantity === "number" && Number.isFinite(quantity) && quantity > 0) return quantity;
                      if (quantity && typeof quantity === "object" && "value" in quantity) {
                        const value = (quantity as { value?: unknown }).value;
                        if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
                      }
                      return undefined;
                    };
                    return [{
                      id,
                      name,
                      ...(typeof operation.type === "string" ? { type: operation.type } : {}),
                      ...(typeof operation.tool === "number" ? { toolNumber: operation.tool } : {}),
                      ...(typeof operation.wcs === "string" ? { wcs: operation.wcs } : {}),
                      ...(typeof operation.plane === "string" ? { plane: operation.plane } : {}),
                      ...(number(feed) !== undefined ? { feedRate: number(feed) } : {}),
                      ...(number(spindle) !== undefined ? { spindleRpm: number(spindle) } : {}),
                      ...(typeof operation.depth === "number" ? { depth: operation.depth } : {}),
                      ...(typeof operation.toolpathDirty === "boolean" ? { toolpathDirty: operation.toolpathDirty } : {}),
                      notes: [`Source: active Mastercam operation ${index + 1}`]
                    }];
                  })
                : [];
              if (operations.length === 0) notes.push("No active operation data was available; this packet is an empty template. Supply an operation tree or enable a supported live adapter.");
            }
            const library = loadShopToolLibrary();
            let tools = parsed.tools;
            if (tools.length === 0) {
              const active = await backend.call({ id: randomUUID(), tool: "list_tools", arguments: {} }, { signal: abortController.signal });
              tools = mergeActiveJobTools(library, active.ok && Array.isArray(active.data) ? active.data : [])?.tools ?? [];
            }
            result = {
              ok: true,
              tool: name,
              data: generateOperationPacket({ ...parsed, operations, tools, notes })
            };
          } else if (name === "calculate_thread_tap") {
            result = {
              ok: true,
              tool: name,
              data: calculateThreadTap(CalculateThreadTapSchema.parse(args))
            };
          } else if (name === "plan_od_rough_finish") {
            const parsed = PlanOdRoughFinishSchema.parse(args);
            let tools = parsed.tools;
            if (tools.length === 0) {
              const library = loadShopToolLibrary();
              if (library?.units && parsed.units !== library.units) {
                throw new MastercamErrorImpl(
                  "VALIDATION_FAILED",
                  `Job units (${parsed.units}) do not match configured shop tool-library units (${library.units})`,
                  { remediation: "Use one unit system for the job and configured shop tool catalog, or supply tool records in the job units." }
                );
              }
              const active = await backend.call({ id: randomUUID(), tool: "list_tools", arguments: {} }, { signal: abortController.signal });
              tools = mergeActiveJobTools(library, active.ok && Array.isArray(active.data) ? active.data : [])?.tools ?? [];
            }
            result = {
              ok: true,
              tool: name,
              data: planOdRoughFinish({ ...parsed, tools })
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

          if (name === "preview_operation_parameters" && result.ok) rememberMutationPreview(result.data);

          // Cancellation/deadline is authoritative even if a backend ignores
          // AbortSignal and returns a late successful result.
          if (abortController.signal.aborted) {
            throw abortController.signal.reason instanceof Error
              ? abortController.signal.reason
              : new Error("CANCELLED: request aborted");
          }

          return envelope(result, definition.outputSchema);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isAbort =
            signal.aborted ||
            abortController.signal.aborted ||
            message.startsWith("CANCELLED");

          return envelope(
            {
              ok: false,
              tool: name,
              error: errorForToolFailure(error, timedOut, isAbort)
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

export function discoverCapabilitiesPayload(
  args: Record<string, unknown>,
  definitions: ToolDefinition[],
  backendKind: "mock" | "live"
) {
  const category = typeof args.category === "string" ? args.category : undefined;
  const stageBEnabled = backendKind === "live" && stageBReadsEnabled();
  const available = definitions.map(definition => {
    const metadata = capability(definition.name);
    return {
      name: definition.name,
      category: categoryOf(definition.name),
      readsActiveDocument: metadata?.readsActiveDocument ?? false,
      requiresActiveDocument: metadata?.requiresActiveDocument ?? false,
      requiresExactTarget: metadata?.requiresExactTarget ?? false,
      requiresApproval: metadata?.requiresApproval ?? false,
      requiresRegeneration: metadata?.requiresRegeneration ?? false,
      idempotent: metadata?.idempotent ?? false,
      execution:
        SERVER_LOCAL_TOOL_NAMES.has(definition.name)
          ? "server-local"
          : backendKind === "live" && LIVE_NATIVE_STAGE_B_READ_TOOL_NAMES.has(definition.name)
            ? "native-stage-b"
            : backendKind === "live"
              ? "native-stage-a"
              : "fixture"
    };
  });
  const filtered = category
    ? available.filter(item => item.category === category)
    : available;

  return {
    backend: backendKind,
    ...(category ? { category } : {}),
    tools: filtered,
    nativeStage: backendKind === "live"
      ? stageBEnabled
        ? "Stage A environment checks with opt-in Stage B read candidates"
        : "Stage A environment checks only"
      : "fixture",
    note:
      backendKind === "live"
        ? stageBEnabled
          ? "Stage-B read candidates are enabled and labeled separately from TypeScript-handled workflows. They remain IMPLEMENTED, not LIVE_READ_VERIFIED, until licensed acceptance passes. Composite workflows may still report unavailable sections."
          : "Only Stage-A environment checks are native-backed by default. TypeScript-handled workflows may request backend data and report unavailable sections when no mapping exists."
        : "Fixture capabilities are synthetic contract implementations, not live Mastercam verification."
  };
}
