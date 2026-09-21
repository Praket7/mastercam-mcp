import { z } from "zod";

export const MastercamInstallationSchema = z.object({
  version: z.string(),
  root: z.string(),
  executable: z.string(),
  chooks: z.string(),
  netHookAssemblies: z.array(z.string()),
  confidence: z.enum(["detected", "partial"]),
  productVersion: z.string().optional(),
  runtimeFamily: z.enum(["net48", "net10"]).optional()
}).strict();

export const CapabilityEntrySchema = z.object({
  name: z.string(),
  supported: z.boolean(),
  mode: z.enum(["read", "write"]),
  riskClass: z.enum(["inspect", "edit", "advanced"]),
  requiresActiveDocument: z.boolean(),
  requiresSelectedOperation: z.boolean(),
  requiresRegeneration: z.boolean(),
  introducedAdapterVersion: z.number().int().positive(),
  mastercamReleaseSupport: z.array(z.string()),
  verificationStatus: z.enum(["source_only", "fixture_tested", "live_read_verified", "live_write_verified", "live_regression_verified"]),
  reason: z.string().optional()
}).strict();

export const CapabilityRegistrySchema = z.object({
  adapterVersion: z.string(),
  mastercamVersion: z.string(),
  runtime: z.enum(["net48", "net10"]),
  tools: z.record(CapabilityEntrySchema)
}).strict();

export const GetCompatibilityMatrixSchema = z.object({}).strict();
export type GetCompatibilityMatrixInput = z.infer<typeof GetCompatibilityMatrixSchema>;

export const CompatibilityMatrixEntrySchema = z.object({
  release: z.string(),
  runtime: z.string(),
  status: z.enum(["supported", "adapter_required", "planned_verification", "incompatible"]),
  evidence: z.string(),
  adapterName: z.string().optional()
}).strict();

export const CompatibilityReportSchema = z.object({
  matrix: z.array(CompatibilityMatrixEntrySchema),
  detected: z.array(MastercamInstallationSchema),
  liveMappingsVerified: z.boolean(),
  note: z.string()
}).strict();

export const GetVersionReportSchema = z.object({}).strict();
export type GetVersionReportInput = z.infer<typeof GetVersionReportSchema>;

export const VersionReportSchema = z.object({
  mastercam: z.string(),
  netHook: z.string(),
  supported: z.array(z.string()),
  liveMappingsVerified: z.boolean(),
  adapterVersion: z.string(),
  protocolVersion: z.number().int().positive()
}).strict();

export const ClientSetupCheckSchema = z.object({}).strict();
export type ClientSetupCheckInput = z.infer<typeof ClientSetupCheckSchema>;

export const ClientSetupCheckOutputSchema = z.object({
  codex: z.enum(["configured", "not_configured", "not_checked"]),
  claude: z.enum(["configured", "not_configured", "not_checked"]),
  http: z.enum(["available", "configured", "not_configured"]),
  guidance: z.string()
}).strict();

export const AuditEntrySchema = z.object({
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  requestId: z.string(),
  transactionId: z.string().optional(),
  tool: z.string(),
  target: z.record(z.unknown()),
  policy: z.record(z.unknown()),
  beforeHash: z.string().optional(),
  afterHash: z.string().optional(),
  verified: z.boolean(),
  previousEntryHash: z.string().optional(),
  entryHash: z.string()
}).strict();

export const GetAuditHistorySchema = z.object({
  limit: z.number().int().positive().max(1000).default(100),
  tool: z.string().optional(),
  operationId: z.union([z.string(), z.number()]).optional()
}).strict();
export type GetAuditHistoryInput = z.infer<typeof GetAuditHistorySchema>;

export const GetAuditHistoryOutputSchema = z.object({
  entries: z.array(AuditEntrySchema),
  total: z.number().int().nonnegative()
}).strict();
export type GetAuditHistoryOutput = z.infer<typeof GetAuditHistoryOutputSchema>;

export const MastercamDoctorSchema = z.object({
  pipe: z.string(),
  backend: z.enum(["mock", "pipe"])
}).strict();
export type MastercamDoctorInput = z.infer<typeof MastercamDoctorSchema>;

export const DoctorCheckSchema = z.object({
  ok: z.boolean(),
  value: z.unknown(),
  required: z.string().optional()
}).strict();

export const DoctorOutputSchema = z.object({
  ok: z.boolean(),
  tool: z.literal("mastercam_doctor"),
  data: z.object({
    checks: z.object({
      node: DoctorCheckSchema,
      platform: DoctorCheckSchema,
      pipe: DoctorCheckSchema,
      dotnet: DoctorCheckSchema,
      mastercam: DoctorCheckSchema
    }),
    backend: z.enum(["mock", "pipe"]),
    installations: z.array(MastercamInstallationSchema),
    compatibility: CompatibilityReportSchema,
    guidance: z.string()
  })
}).strict();
export type MastercamDoctorOutput = z.infer<typeof DoctorOutputSchema>;