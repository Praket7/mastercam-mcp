import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { allowed, READ_TOOLS, WRITE_TOOLS, ADVANCED_TOOLS, HIGH_RISK_TOOLS } from "./contracts.js";
import type { Backend } from "./backend.js";
import { doctor } from "./diagnostics.js";
import { VERSION } from "./version.js";
import { compatibilityReport } from "./compatibility.js";
import { compareJson, compareNc, setupSheet, validateMachine } from "./shop.js";
import { defaultPipe, selectedBackend } from "./platform.js";
import { GetActivePartSchema, ActivePartSchema, GetStockSchema, GetWcssSchema, ListToolsSchema, GetPostProcessorSchema, CaptureViewSchema, GetToolpathStatusSchema, ListMachineGroupsSchema } from "./schemas/inspection.js";
import { ListOperationsSchema, OperationSchema, GetOperationSchema, FindOperationsSchema, ExplainOperationSchema, GetOperationRisksSchema, GetOperationParametersSchema } from "./schemas/operations.js";
import { PreviewOperationParametersSchema, PreviewOperationParametersOutputSchema, ApplyOperationParameterPreviewSchema, ApplyOperationParameterPreviewOutputSchema, VerifyChangeSchema, VerifyChangeOutputSchema, RollbackChangeSchema, RollbackChangeOutputSchema, RegenerateToolpathSchema, RegenerateToolpathOutputSchema } from "./schemas/mutations.js";
import { RunSimulationSchema, RunSimulationOutputSchema, DetectCollisionsSchema, DetectCollisionsOutputSchema, EstimateCycleTimeSchema, EstimateCycleTimeOutputSchema, CompareToolpathsSchema, CompareToolpathsOutputSchema } from "./schemas/simulation.js";
import { SetupSheetInputSchema, SetupSheetOutputSchema, CompareToolDatabasesSchema, CompareToolDatabasesOutputSchema, CompareNcFilesSchema, CompareNcFilesOutputSchema, ValidateMachineProfileSchema, ValidateMachineProfileOutputSchema } from "./schemas/shop.js";
import { GetCompatibilityMatrixSchema, CompatibilityReportSchema, GetVersionReportSchema, VersionReportSchema, ClientSetupCheckSchema, ClientSetupCheckOutputSchema, GetAuditHistorySchema, GetAuditHistoryOutputSchema, MastercamDoctorSchema, DoctorOutputSchema } from "./schemas/diagnostics.js";
import { OperationIdSchema } from "./schemas/common.js";

const descriptions: Record<string, string> = {
  mastercam_doctor: "Check local prerequisites, configuration, and named pipe readiness",
  mastercam_help: "Explain the available Mastercam MCP tools and safety levels",
  list_tool_categories: "List tools by read, write, advanced, and high risk category",
  mastercam_plan: "Create a safe inspect, preview, confirm, apply, and verify plan",
  discover_capabilities: "Show the available capabilities and the next safe action",
  get_compatibility_matrix: "Show supported Mastercam releases and verification status",
  find_operations: "Search operations by name, type, tool, or machine group",
  explain_operation: "Explain an operation in plain language with its inputs and risks",
  get_operation_risks: "Report verification scope and risks for an operation",
  verify_change: "Reread an operation and verify a requested change",
  get_machine_context: "Return machine, stock, workholding, and coordinate context",
  get_fixture_info: "Describe the active fixture and replay capabilities",
  generate_setup_sheet: "Create a revision ready setup sheet from inspection data",
  compare_tool_databases: "Compare two tool database snapshots without changing either file",
  compare_nc_files: "Compare two NC text files and summarize safety relevant changes",
  validate_machine_profile: "Validate an operation against a declared machine profile",
  get_version_report: "Report detected Mastercam and NET Hook compatibility",
  client_setup_check: "Validate client configuration readiness",
  get_audit_history: "Show local change receipts and rollback history",
  inspect: "Inspect a target and return its current values",
  measure: "Measure one named value on a Mastercam target",
  assert: "Verify that a measured value matches an expected value",
  preview_operation_parameters: "Preview a change with before, after, regeneration, and rollback information",
  apply_operation_parameter_preview: "Apply a previously previewed parameter change",
  rollback_change: "Rollback a previously applied change using its transaction receipt",
  regenerate_toolpath: "Regenerate toolpaths for selected operations",
  run_simulation: "Run a full simulation with collision detection",
  detect_collisions: "Detect collisions for selected operations",
  capture_view: "Capture a visual view of the operation",
  estimate_cycle_time: "Estimate cycle time for an operation",
  compare_toolpaths: "Compare two toolpaths for differences",
  get_active_part: "Get the active Mastercam part document",
  get_geometry_summary: "Get a summary of geometry in the active part",
  get_selection: "Get currently selected operations",
  list_machine_groups: "List available machine groups",
  list_operations: "List all operations in the active part",
  get_operation: "Get detailed information about a specific operation",
  get_operation_parameters: "Get feed, speed, and other parameters for an operation",
  get_stock: "Get stock dimensions and material",
  get_wcs: "Get work coordinate system information",
  list_tools: "List tools in the active part",
  get_toolpath_status: "Get toolpath generation status for an operation",
  get_post_processor: "Get post processor information"
};

const readOnlyAnnotation = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const writeAnnotation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
const advancedAnnotation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
const highRiskAnnotation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };

function createTextContent(text: string) {
  return { type: "text" as const, text };
}

async function progress(extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }, tool: string, progressValue: number, total: number, message: string) {
  const token = extra._meta?.progressToken;
  if (token === undefined) return;
  await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: progressValue, total, message: `${tool}: ${message}` } } as never);
}

function makeHandler(backend: Backend, tool: string) {
  return async (args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
    await progress(extra, tool, 1, 3, "started");
    try {
      const result = await backend.call({ id: randomUUID(), tool, arguments: args });
      await progress(extra, tool, 3, 3, "completed");
      return { content: [createTextContent(JSON.stringify(result))], structuredContent: result as Record<string, unknown> };
    } catch (error) {
      await progress(extra, tool, 3, 3, "failed");
      return { isError: true, content: [createTextContent(JSON.stringify({ ok: false, error: { code: "BACKEND_UNAVAILABLE", message: String(error) } }))] };
    }
  };
}

function makeSimpleHandler(result: unknown, tool: string) {
  return async (_args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
    await progress(extra, tool, 3, 3, "completed");
    return { content: [createTextContent(JSON.stringify({ ok: true, tool, data: result }))], structuredContent: { ok: true, tool, data: result } as Record<string, unknown> };
  };
}

export function createMcpServer(backend: Backend, profile: string, hardReadOnly: boolean) {
  const server = new McpServer({ name: "mastercam-mcp", version: VERSION });

  server.registerResource("active-part", "mastercam://active-part", { description: "Live active part information from Mastercam", mimeType: "application/json" }, async () => {
    const data = await backend.call({ id: randomUUID(), tool: "get_active_part", arguments: {} });
    return { contents: [{ uri: "mastercam://active-part", mimeType: "application/json", text: JSON.stringify(data) }] };
  });

  server.registerResource("operations", "mastercam://operations", { description: "Live operations list from Mastercam", mimeType: "application/json" }, async () => {
    const data = await backend.call({ id: randomUUID(), tool: "list_operations", arguments: {} });
    return { contents: [{ uri: "mastercam://operations", mimeType: "application/json", text: JSON.stringify(data) }] };
  });

  server.registerResource("diagnostics", "mastercam://diagnostics", { description: "Live diagnostics from Mastercam", mimeType: "application/json" }, async () => {
    const data = await doctor(process.env["MASTERCAM_MCP_PIPE"] ?? defaultPipe(), selectedBackend());
    return { contents: [{ uri: "mastercam://diagnostics", mimeType: "application/json", text: JSON.stringify(data) }] };
  });

  interface ToolConfig {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  annotations: typeof readOnlyAnnotation | typeof writeAnnotation | typeof advancedAnnotation | typeof highRiskAnnotation;
  handler: (args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown> } | { isError: true; content: Array<{ type: "text"; text: string }> }>;
}

const toolConfigs = [
    {
      name: "mastercam_doctor",
      description: descriptions.mastercam_doctor,
      inputSchema: MastercamDoctorSchema,
      outputSchema: DoctorOutputSchema,
      annotations: readOnlyAnnotation,
      handler: async (_args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
        const result = await doctor(process.env["MASTERCAM_MCP_PIPE"] ?? defaultPipe(), selectedBackend());
        await progress(extra, "mastercam_doctor", 3, 3, "completed");
        return { content: [createTextContent(JSON.stringify(result))], structuredContent: result as Record<string, unknown> };
      }
    },
    {
      name: "mastercam_help",
      description: descriptions.mastercam_help,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("mastercam_help"), data: z.record(z.string()) }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeSimpleHandler(descriptions, "mastercam_help")
    },
    {
      name: "list_tool_categories" as const,
      description: descriptions.list_tool_categories,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("list_tool_categories"), data: z.object({ read: z.array(z.string()), write: z.array(z.string()), advanced: z.array(z.string()), highRisk: z.array(z.string()) }) }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeSimpleHandler({ read: READ_TOOLS, write: WRITE_TOOLS, advanced: ADVANCED_TOOLS, highRisk: HIGH_RISK_TOOLS }, "list_tool_categories")
    },
    {
      name: "mastercam_plan" as const,
      description: descriptions.mastercam_plan,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("mastercam_plan"), data: z.object({ steps: z.array(z.string()), safeDefault: z.string() }) }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeSimpleHandler({ steps: ["inspect target", "preview requested change", "request confirmation", "apply change", "verify result"], safeDefault: "read only" }, "mastercam_plan")
    },
    {
      name: "discover_capabilities" as const,
      description: descriptions.discover_capabilities,
      inputSchema: z.object({ category: z.string().optional() }).strict(),
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("discover_capabilities"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "discover_capabilities")
    },
    {
      name: "get_compatibility_matrix" as const,
      description: descriptions.get_compatibility_matrix,
      inputSchema: GetCompatibilityMatrixSchema,
      outputSchema: CompatibilityReportSchema,
      annotations: readOnlyAnnotation,
      handler: async (_args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
        const result = { ok: true, tool: "get_compatibility_matrix", data: compatibilityReport() };
        await progress(extra, "get_compatibility_matrix", 3, 3, "completed");
        return { content: [createTextContent(JSON.stringify(result))], structuredContent: result as Record<string, unknown> };
      }
    },
    {
      name: "find_operations" as const,
      description: descriptions.find_operations,
      inputSchema: FindOperationsSchema,
      outputSchema: z.array(OperationSchema),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "find_operations")
    },
    {
      name: "explain_operation" as const,
      description: descriptions.explain_operation,
      inputSchema: ExplainOperationSchema,
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("explain_operation"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "explain_operation")
    },
    {
      name: "get_operation_risks" as const,
      description: descriptions.get_operation_risks,
      inputSchema: GetOperationRisksSchema,
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("get_operation_risks"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_operation_risks")
    },
    {
      name: "verify_change" as const,
      description: descriptions.verify_change,
      inputSchema: VerifyChangeSchema,
      outputSchema: VerifyChangeOutputSchema,
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "verify_change")
    },
    {
      name: "get_machine_context" as const,
      description: descriptions.get_machine_context,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("get_machine_context"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_machine_context")
    },
    {
      name: "mastercam_doctor" as const,
      description: descriptions.mastercam_doctor,
      inputSchema: MastercamDoctorSchema,
      outputSchema: DoctorOutputSchema,
      annotations: readOnlyAnnotation,
      handler: async (_args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
        const result = await doctor(process.env["MASTERCAM_MCP_PIPE"] ?? defaultPipe(), selectedBackend());
        await progress(extra, "mastercam_doctor", 3, 3, "completed");
        return { content: [createTextContent(JSON.stringify(result))], structuredContent: result as Record<string, unknown> };
      }
    },
    {
      name: "mastercam_help" as const,
      description: descriptions.mastercam_help,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("mastercam_help"), data: z.record(z.string()) }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeSimpleHandler(descriptions, "mastercam_help")
    },
    {
      name: "list_tool_categories" as const,
      description: descriptions.list_tool_categories,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("list_tool_categories"), data: z.object({ read: z.array(z.string()), write: z.array(z.string()), advanced: z.array(z.string()), highRisk: z.array(z.string()) }) }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeSimpleHandler({ read: READ_TOOLS, write: WRITE_TOOLS, advanced: ADVANCED_TOOLS, highRisk: HIGH_RISK_TOOLS }, "list_tool_categories")
    },
    {
      name: "mastercam_plan" as const,
      description: descriptions.mastercam_plan,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("mastercam_plan"), data: z.object({ steps: z.array(z.string()), safeDefault: z.string() }) }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeSimpleHandler({ steps: ["inspect target", "preview requested change", "request confirmation", "apply change", "verify result"], safeDefault: "read only" }, "mastercam_plan")
    },
    {
      name: "discover_capabilities" as const,
      description: descriptions.discover_capabilities,
      inputSchema: z.object({ category: z.string().optional() }).strict(),
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("discover_capabilities"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "discover_capabilities")
    },
    {
      name: "get_compatibility_matrix" as const,
      description: descriptions.get_compatibility_matrix,
      inputSchema: GetCompatibilityMatrixSchema,
      outputSchema: CompatibilityReportSchema,
      annotations: readOnlyAnnotation,
      handler: async (_args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
        const result = { ok: true, tool: "get_compatibility_matrix", data: compatibilityReport() };
        await progress(extra, "get_compatibility_matrix", 3, 3, "completed");
        return { content: [createTextContent(JSON.stringify(result))], structuredContent: result as Record<string, unknown> };
      }
    },
    {
      name: "find_operations" as const,
      description: descriptions.find_operations,
      inputSchema: FindOperationsSchema,
      outputSchema: z.array(OperationSchema),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "find_operations")
    },
    {
      name: "explain_operation" as const,
      description: descriptions.explain_operation,
      inputSchema: ExplainOperationSchema,
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("explain_operation"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "explain_operation")
    },
    {
      name: "get_operation_risks" as const,
      description: descriptions.get_operation_risks,
      inputSchema: GetOperationRisksSchema,
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("get_operation_risks"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_operation_risks")
    },
    {
      name: "get_machine_context" as const,
      description: descriptions.get_machine_context,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("get_machine_context"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_machine_context")
    },
    {
      name: "get_fixture_info" as const,
      description: descriptions.get_fixture_info,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("get_fixture_info"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_fixture_info")
    },
    {
      name: "generate_setup_sheet" as const,
      description: descriptions.generate_setup_sheet,
      inputSchema: SetupSheetInputSchema,
      outputSchema: SetupSheetOutputSchema,
      annotations: readOnlyAnnotation,
      handler: async (args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
        const result = { ok: true, tool: "generate_setup_sheet", data: setupSheet(args as any) };
        await progress(extra, "generate_setup_sheet", 3, 3, "completed");
        return { content: [createTextContent(JSON.stringify(result))], structuredContent: result as Record<string, unknown> };
      }
    },
    {
      name: "compare_tool_databases" as const,
      description: descriptions.compare_tool_databases,
      inputSchema: CompareToolDatabasesSchema,
      outputSchema: CompareToolDatabasesOutputSchema,
      annotations: readOnlyAnnotation,
      handler: async (args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
        const result = { ok: true, tool: "compare_tool_databases", data: compareJson(args.left, args.right) };
        await progress(extra, "compare_tool_databases", 3, 3, "completed");
        return { content: [createTextContent(JSON.stringify(result))], structuredContent: result as Record<string, unknown> };
      }
    },
    {
      name: "compare_nc_files" as const,
      description: descriptions.compare_nc_files,
      inputSchema: CompareNcFilesSchema,
      outputSchema: CompareNcFilesOutputSchema,
      annotations: readOnlyAnnotation,
      handler: async (args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
        const result = { ok: true, tool: "compare_nc_files", data: compareNc(String(args.before ?? ""), String(args.after ?? "")) };
        await progress(extra, "compare_nc_files", 3, 3, "completed");
        return { content: [createTextContent(JSON.stringify(result))], structuredContent: result as Record<string, unknown> };
      }
    },
    {
      name: "validate_machine_profile" as const,
      description: descriptions.validate_machine_profile,
      inputSchema: ValidateMachineProfileSchema,
      outputSchema: ValidateMachineProfileOutputSchema,
      annotations: readOnlyAnnotation,
      handler: async (args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
        const result = { ok: true, tool: "validate_machine_profile", data: validateMachine((args.operation ?? {}) as Record<string, unknown>, (args.profile ?? {}) as Record<string, unknown>) };
        await progress(extra, "validate_machine_profile", 3, 3, "completed");
        return { content: [createTextContent(JSON.stringify(result))], structuredContent: result as Record<string, unknown> };
      }
    },
    {
      name: "get_version_report" as const,
      description: descriptions.get_version_report,
      inputSchema: GetVersionReportSchema,
      outputSchema: VersionReportSchema,
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_version_report")
    },
    {
      name: "client_setup_check" as const,
      description: descriptions.client_setup_check,
      inputSchema: ClientSetupCheckSchema,
      outputSchema: ClientSetupCheckOutputSchema,
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "client_setup_check")
    },
    {
      name: "get_audit_history" as const,
      description: descriptions.get_audit_history,
      inputSchema: GetAuditHistorySchema,
      outputSchema: GetAuditHistoryOutputSchema,
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_audit_history")
    },
    {
      name: "inspect" as const,
      description: descriptions.inspect,
      inputSchema: GetOperationSchema,
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("inspect"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "inspect")
    },
    {
      name: "measure" as const,
      description: descriptions.measure,
      inputSchema: z.object({ operationId: OperationIdSchema.optional(), path: z.string().min(1).default("operation.feedRate") }).strict(),
      outputSchema: z.object({ ok: z.boolean(), tool: z.literal("measure"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "measure")
    },
    {
      name: "assert" as const,
      description: descriptions.assert,
      inputSchema: z.object({ operationId: OperationIdSchema.optional(), path: z.string().min(1).default("operation.feedRate"), equals: z.unknown() }).strict(),
      outputSchema: z.object({ ok: z.boolean(), tool: z.literal("assert"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "assert")
    },
    {
      name: "preview_operation_parameters" as const,
      description: descriptions.preview_operation_parameters,
      inputSchema: PreviewOperationParametersSchema,
      outputSchema: PreviewOperationParametersOutputSchema,
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "preview_operation_parameters")
    },
    {
      name: "apply_operation_parameter_preview" as const,
      description: "Apply a previously previewed parameter change",
      inputSchema: ApplyOperationParameterPreviewSchema,
      outputSchema: ApplyOperationParameterPreviewOutputSchema,
      annotations: writeAnnotation,
      handler: async (args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
        const dryRun = Boolean(args.dryRun);
        if (!allowed("apply_operation_parameter_preview", profile as any, hardReadOnly, dryRun)) return { isError: true, content: [createTextContent(JSON.stringify({ ok: false, error: { code: "PROFILE_DENIED", message: `Tool apply_operation_parameter_preview is not enabled by the server profile` } }))] };
        if (!dryRun && !args.approvalToken) return { isError: true, content: [createTextContent(JSON.stringify({ ok: false, error: { code: "APPROVAL_TOKEN_REQUIRED", message: "Tool apply_operation_parameter_preview requires approvalToken from preview_operation_parameters" } }))] };
        return makeHandler(backend, "apply_operation_parameter_preview")(args, extra);
      }
    },
    {
      name: "rollback_change" as const,
      description: descriptions.rollback_change,
      inputSchema: RollbackChangeSchema,
      outputSchema: RollbackChangeOutputSchema,
      annotations: writeAnnotation,
      handler: async (args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
        const dryRun = Boolean(args.dryRun);
        if (!allowed("rollback_change", profile as any, hardReadOnly, dryRun)) return { isError: true, content: [createTextContent(JSON.stringify({ ok: false, error: { code: "PROFILE_DENIED", message: `Tool rollback_change is not enabled by the server profile` } }))] };
        return makeHandler(backend, "rollback_change")(args, extra);
      }
    },
    {
      name: "regenerate_toolpath" as const,
      description: descriptions.regenerate_toolpath,
      inputSchema: RegenerateToolpathSchema,
      outputSchema: RegenerateToolpathOutputSchema,
      annotations: advancedAnnotation,
      handler: async (args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
        const dryRun = Boolean(args.dryRun);
        if (!allowed("regenerate_toolpath", profile as any, hardReadOnly, dryRun)) return { isError: true, content: [createTextContent(JSON.stringify({ ok: false, error: { code: "PROFILE_DENIED", message: `Tool regenerate_toolpath is not enabled by the server profile` } }))] };
        return makeHandler(backend, "regenerate_toolpath")(args, extra);
      }
    },
    {
      name: "run_simulation" as const,
      description: descriptions.run_simulation,
      inputSchema: RunSimulationSchema,
      outputSchema: RunSimulationOutputSchema,
      annotations: advancedAnnotation,
      handler: async (args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
        const dryRun = Boolean(args.dryRun);
        if (!allowed("run_simulation", profile as any, hardReadOnly, dryRun)) return { isError: true, content: [createTextContent(JSON.stringify({ ok: false, error: { code: "PROFILE_DENIED", message: `Tool run_simulation is not enabled by the server profile` } }))] };
        return makeHandler(backend, "run_simulation")(args, extra);
      }
    },
    {
      name: "detect_collisions" as const,
      description: descriptions.detect_collisions,
      inputSchema: DetectCollisionsSchema,
      outputSchema: DetectCollisionsOutputSchema,
      annotations: advancedAnnotation,
      handler: async (args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number | undefined }; sendNotification: (notification: never) => Promise<void> }) => {
        const dryRun = Boolean(args.dryRun);
        if (!allowed("detect_collisions", profile as any, hardReadOnly, dryRun)) return { isError: true, content: [createTextContent(JSON.stringify({ ok: false, error: { code: "PROFILE_DENIED", message: `Tool detect_collisions is not enabled by the server profile` } }))] };
        return makeHandler(backend, "detect_collisions")(args, extra);
      }
    },
    {
      name: "capture_view" as const,
      description: descriptions.capture_view,
      inputSchema: CaptureViewSchema,
      outputSchema: z.object({ ok: z.boolean(), tool: z.literal("capture_view"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "capture_view")
    },
    {
      name: "estimate_cycle_time" as const,
      description: descriptions.estimate_cycle_time,
      inputSchema: EstimateCycleTimeSchema,
      outputSchema: EstimateCycleTimeOutputSchema,
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "estimate_cycle_time")
    },
    {
      name: "compare_toolpaths" as const,
      description: descriptions.compare_toolpaths,
      inputSchema: CompareToolpathsSchema,
      outputSchema: CompareToolpathsOutputSchema,
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "compare_toolpaths")
    },
    {
      name: "get_active_part" as const,
      description: descriptions.get_active_part,
      inputSchema: GetActivePartSchema,
      outputSchema: ActivePartSchema,
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_active_part")
    },
    {
      name: "get_geometry_summary" as const,
      description: descriptions.get_geometry_summary,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("get_geometry_summary"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_geometry_summary")
    },
    {
      name: "get_selection" as const,
      description: descriptions.get_selection,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("get_selection"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_selection")
    },
    {
      name: "list_machine_groups" as const,
      description: descriptions.list_machine_groups,
      inputSchema: ListMachineGroupsSchema,
      outputSchema: z.array(z.object({ id: z.string(), name: z.string(), type: z.enum(["mill", "lathe", "mill_turn", "router", "wire", "other"]) })),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "list_machine_groups")
    },
    {
      name: "list_operations" as const,
      description: descriptions.list_operations,
      inputSchema: ListOperationsSchema,
      outputSchema: z.array(OperationSchema),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "list_operations")
    },
    {
      name: "get_operation" as const,
      description: descriptions.get_operation,
      inputSchema: GetOperationSchema,
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("get_operation"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_operation")
    },
    {
      name: "get_operation_parameters" as const,
      description: descriptions.get_operation_parameters,
      inputSchema: GetOperationParametersSchema,
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("get_operation_parameters"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_operation_parameters")
    },
    {
      name: "get_stock" as const,
      description: descriptions.get_stock,
      inputSchema: GetStockSchema,
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("get_stock"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_stock")
    },
    {
      name: "get_wcs" as const,
      description: descriptions.get_wcs,
      inputSchema: GetWcssSchema,
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("get_wcs"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_wcs")
    },
    {
      name: "list_tools" as const,
      description: descriptions.list_tools,
      inputSchema: ListToolsSchema,
      outputSchema: z.array(z.object({ number: z.number().int().positive(), name: z.string(), diameter: z.number().positive().optional(), length: z.number().positive().optional(), units: z.enum(["mm", "in"]), type: z.string().optional(), holder: z.string().optional(), fluteCount: z.number().int().positive().optional(), coolant: z.boolean().optional() })),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "list_tools")
    },
    {
      name: "get_toolpath_status" as const,
      description: descriptions.get_toolpath_status,
      inputSchema: GetToolpathStatusSchema,
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("get_toolpath_status"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_toolpath_status")
    },
    {
      name: "get_post_processor" as const,
      description: descriptions.get_post_processor,
      inputSchema: GetPostProcessorSchema,
      outputSchema: z.object({ ok: z.literal(true), tool: z.literal("get_post_processor"), data: z.unknown() }).strict(),
      annotations: readOnlyAnnotation,
      handler: makeHandler(backend, "get_post_processor")
    }
  ];

  for (const config of toolConfigs) {
    server.registerTool(config.name, {
      description: config.description,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      annotations: config.annotations
    }, config.handler);
  }

  return server;
}