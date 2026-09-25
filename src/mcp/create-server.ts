import { randomBytes, randomUUID } from "node:crypto";
import { createRequestStateCodec, inputRequired, inputResponse, McpServer } from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import { allowed, DEFAULT_PROFILE, categoryOf, SUPPORTED_PROTOCOL_REVISIONS, FORBIDDEN_TOOLS } from "../contracts.js";
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
  AnalyzeToolpathRiskSchema,
  CalculateThreadTapSchema,
  GenerateOperationPacketSchema,
  PlanOdRoughFinishSchema,
  RecommendJobToolingSchema
} from "../job-intelligence.js";
import { defaultPipe, selectedBackend } from "../platform.js";
import { TOOL_DEFINITIONS, ToolEnvelopeSchema } from "./registry.js";
import type { ToolDefinition } from "./registry.js";
import { mastercamError } from "../errors.js";
import { loadShopToolLibrary, mergeActiveJobTools } from "../shop-tool-library.js";
import { analyzeNcProgram, AnalyzeNcProgramSchema } from "../nc-program.js";

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

/**
 * Portable/mock mode exposes the complete registered contract. Live mode
 * exposes only (a) native Stage-A capabilities that are genuinely mapped and
 * (b) utilities implemented entirely by the TypeScript server. It never
 * advertises an unverified Mastercam operation mapping.
 */
export function advertisedToolDefinitions(
  backendKind: "mock" | "live"
): ToolDefinition[] {
  if (backendKind === "mock") return TOOL_DEFINITIONS;
  const stageB = stageBReadsEnabled();
  return TOOL_DEFINITIONS.filter(
    definition =>
      LIVE_NATIVE_STAGE_A_TOOL_NAMES.has(definition.name) ||
      (stageB && LIVE_NATIVE_STAGE_B_READ_TOOL_NAMES.has(definition.name)) ||
      SERVER_LOCAL_TOOL_NAMES.has(definition.name)
  );
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
      requestState: { verify: operatorApprovalState.verify },
      instructions:
        backendKind === "live"
          ? stageBReadsEnabled()
            ? "The native adapter has opt-in Stage-B read-only programming-context extraction enabled. It remains IMPLEMENTED, not LIVE_READ_VERIFIED, until licensed acceptance passes. Server-local manufacturing intelligence remains available without implying additional native mappings."
            : "The native adapter is Stage A by default: only mastercam_status and mastercam_capabilities are native-backed. Stage-B programming-context extraction is installed but hidden until MASTERCAM_MCP_ENABLE_STAGE_B_READS=1 is set on a licensed acceptance workstation. Server-local manufacturing intelligence remains available."
          : "Inspect before mutating. Ground tooling/process suggestions in supplied job state. Use toolpath-risk, cycle-time, thread/tap, manufacturing_preflight, and regression tools as deterministic review evidence. plan_od_rough_finish is non-executable preview only. Mutations require preview_operation_parameters, explicit MCP client operator approval of the displayed exact change, then apply_operation_parameter_preview with the returned approvalToken. Rollback uses the server-issued transactionId. Fixture data never proves live Mastercam behavior."
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
          if (name === "mastercam_doctor") {
            result = await doctor(process.env.MASTERCAM_MCP_PIPE ?? defaultPipe(), selectedBackend());
          } else if (
            name === "mastercam_help" ||
            name === "list_tool_categories" ||
            name === "mastercam_plan"
          ) {
            result = {
              ok: true,
              tool: name,
              data: helpPayload(name, profile, hardReadOnly, definitions, backendKind)
            };
          } else if (name === "discover_capabilities") {
            result = {
              ok: true,
              tool: name,
              data: discoverCapabilitiesPayload(args, definitions, backendKind)
            };
          } else if (name === "get_compatibility_matrix") {
            const { compatibilityReport } = await import("../compatibility.js");
            result = { ok: true, tool: name, data: compatibilityReport() };
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
              throw new Error(`Job units (${parsed.units}) do not match configured shop tool-library units (${library.units})`);
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
            result = {
              ok: true,
              tool: name,
              data: analyzeCycleTime(AnalyzeCycleTimeSchema.parse(args))
            };
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
                throw new Error(`Job units (${parsed.units}) do not match configured shop tool-library units (${library.units})`);
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

function namesByCategory(definitions: ToolDefinition[], category: ReturnType<typeof categoryOf>) {
  return definitions
    .filter(definition => categoryOf(definition.name) === category)
    .map(definition => definition.name);
}

function helpPayload(
  name: string,
  profile: Profile,
  hardReadOnly: boolean,
  definitions: ToolDefinition[],
  backendKind: "mock" | "live"
) {
  const mutationAvailable = definitions.some(
    definition => definition.name === "apply_operation_parameter_preview"
  );

  if (name === "mastercam_plan") {
    return mutationAvailable
      ? {
          steps: [
            "inspect target",
            "manufacturing_preflight for deterministic blockers and unknowns",
            "preview_operation_parameters",
            "apply_operation_parameter_preview with approvalToken",
            "verify by rereading",
            "analyze_regeneration_impact when dependency evidence is available",
            "analyze_post_regression against an approved NC baseline before release",
            "rollback_change with transactionId if needed"
          ],
          safeDefault: "read only",
          profile,
          hardReadOnly,
          backend: backendKind
        }
      : {
          steps: [
            "mastercam_status",
            "mastercam_capabilities",
            "mastercam_doctor",
            "use server-local manufacturing_preflight / regeneration / post-regression tools on supplied evidence",
            "run acceptance --live on the licensed workstation before expecting operation mappings"
          ],
          safeDefault: "Stage A live environment only",
          mutationAvailable: false,
          profile,
          hardReadOnly,
          backend: backendKind
        };
  }

  if (name === "list_tool_categories") {
    return {
      read: namesByCategory(definitions, "read"),
      preview: namesByCategory(definitions, "preview"),
      write: namesByCategory(definitions, "write"),
      advanced: namesByCategory(definitions, "advanced"),
      forbidden: FORBIDDEN_TOOLS,
      profile,
      backend: backendKind,
      protocolRevisions: SUPPORTED_PROTOCOL_REVISIONS
    };
  }

  return {
    tools: definitions.map(definition => ({
      name: definition.name,
      description: definition.description,
      annotations: definition.annotations,
      execution:
        SERVER_LOCAL_TOOL_NAMES.has(definition.name)
          ? "server-local"
          : backendKind === "live"
            ? "native-stage-a"
            : "fixture"
    })),
    profile,
    hardReadOnly,
    backend: backendKind,
    protocolRevisions: SUPPORTED_PROTOCOL_REVISIONS,
    safety:
      backendKind === "live"
        ? "Only native Stage-A tools are backed by Mastercam today; server-local deterministic evidence utilities do not imply live operation mappings or prove machine safety."
        : "Fixture results never prove live Mastercam or machine safety; machine execution tools are permanently unavailable"
  };
}

function discoverCapabilitiesPayload(
  args: Record<string, unknown>,
  definitions: ToolDefinition[],
  backendKind: "mock" | "live"
) {
  const category = typeof args.category === "string" ? args.category : undefined;
  const available = definitions.map(definition => ({
    name: definition.name,
    category: categoryOf(definition.name),
    execution:
      SERVER_LOCAL_TOOL_NAMES.has(definition.name)
        ? "server-local"
        : backendKind === "live"
          ? "native-stage-a"
          : "fixture"
  }));
  const filtered = category
    ? available.filter(item => item.category === category)
    : available;

  return {
    backend: backendKind,
    ...(category ? { category } : {}),
    tools: filtered,
    nativeStage: backendKind === "live" ? "Stage A environment only" : "fixture",
    note:
      backendKind === "live"
        ? "Server-local deterministic evidence utilities remain available, but only mastercam_status and mastercam_capabilities are native-backed until licensed acceptance promotes additional mappings."
        : "Fixture capabilities are synthetic contract implementations, not live Mastercam verification."
  };
}
