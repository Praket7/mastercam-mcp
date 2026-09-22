import { randomUUID } from "node:crypto";
import { MastercamErrorImpl } from "./errors.js";
import { sha256Of, AuditLog, newApprovalToken } from "./audit/audit-log.js";
import { ApprovalLedger, fingerprintOperation, documentRevision } from "./safety/approval.js";
import { KeyedLocks } from "./scheduler/locks.js";
import { Scheduler } from "./scheduler/request-scheduler.js";
import { feedToMmPerMinute, sameFeed, formatFeed, formatSpindle } from "./schemas/units.js";
import type { FeedRate, SpindleSpeed } from "./schemas/units.js";
import type { QuantitySnapshot } from "./safety/approval.js";

/** Envelope returned by every backend tool call. */
export interface ToolResult {
  ok: boolean;
  tool: string;
  data?: unknown;
  error?: { code: string; message: string; retryable?: boolean; remediation?: string };
  receipt?: unknown;
  live?: boolean;
  documentRevision?: string;
  operationFingerprint?: string;
}

export interface Request { id: string; tool: string; arguments?: Record<string, unknown> }

export interface Backend {
  call(request: Request, options?: { signal?: AbortSignal }): Promise<ToolResult>;
  close?(): Promise<void>;
}

export interface FixtureOperation {
  id: number;
  name: string;
  type: string;
  feed: FeedRate | number | undefined;
  spindleSpeed?: SpindleSpeed | number;
  tool?: number;
  toolpathDirty?: boolean;
  [extra: string]: unknown;
}

export interface Fixture {
  feed?: number;
  operations?: Array<Record<string, unknown>>;
}

const MM_PER_MIN = "mm/min" as const;
const RPM = "rpm" as const;

function toFeed(value: unknown): FeedRate {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return { value, unit: MM_PER_MIN };
  // Already a structured quantity: keep it, validating the shape.
  if (value && typeof value === "object") {
    const candidate = value as { value?: unknown; unit?: unknown };
    if (typeof candidate.value === "number" && Number.isFinite(candidate.value) && candidate.value > 0 && typeof candidate.unit === "string") {
      return { value: candidate.value, unit: candidate.unit as FeedRate["unit"] };
    }
  }
  return { value: 35, unit: MM_PER_MIN };
}

function toSpeed(value: unknown): SpindleSpeed {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return { value, unit: RPM };
  if (value && typeof value === "object") {
    const candidate = value as { value?: unknown; unit?: unknown };
    if (typeof candidate.value === "number" && Number.isFinite(candidate.value) && candidate.value > 0 && typeof candidate.unit === "string") {
      return { value: candidate.value, unit: candidate.unit as SpindleSpeed["unit"] };
    }
  }
  return { value: 12000, unit: RPM };
}

function operationFeed(operation: Record<string, unknown>): FeedRate {
  return toFeed(operation.feed);
}

function operationSpeed(operation: Record<string, unknown>): SpindleSpeed {
  return toSpeed(operation.spindleSpeed);
}

function errorResult(tool: string, error: MastercamErrorImpl | Error): ToolResult {
  if (error instanceof MastercamErrorImpl) {
    return { ok: false, tool, error: { code: error.code, message: error.message, retryable: error.retryable, ...(error.remediation ? { remediation: error.remediation } : {}) } };
  }
  // Errors thrown as "CODE: message" (e.g. from the approval ledger) keep their code.
  const match = /^([A-Z_]+):\s*(.+)$/.exec(error.message);
  if (match) {
    const code = match[1] ?? "BACKEND_UNAVAILABLE";
    const message = match[2] ?? error.message;
    const retryable = code === "TIMEOUT" || code === "BACKEND_UNAVAILABLE" || code === "RATE_LIMITED";
    return { ok: false, tool, error: { code, message, retryable } };
  }
  return { ok: false, tool, error: { code: "BACKEND_UNAVAILABLE", message: error.message, retryable: true } };
}

function applyQuantity(op: Record<string, unknown>, changes: QuantitySnapshot): { feedRate: FeedRate; spindleSpeed: SpindleSpeed } {
  if (changes.feedRate !== undefined) {
    if (!Number.isFinite(changes.feedRate.value) || changes.feedRate.value <= 0) throw new MastercamErrorImpl("INVALID_QUANTITY", "feedRate.value must be finite and positive");
    op.feed = { ...changes.feedRate };
  }
  if (changes.spindleSpeed !== undefined) {
    if (!Number.isFinite(changes.spindleSpeed.value) || changes.spindleSpeed.value <= 0) throw new MastercamErrorImpl("INVALID_QUANTITY", "spindleSpeed.value must be finite and positive");
    op.spindleSpeed = { ...changes.spindleSpeed };
  }
  return { feedRate: operationFeed(op), spindleSpeed: operationSpeed(op) };
}

export class MockBackend implements Backend {
  private operations: Array<Record<string, unknown>>;
  private selected: number[] = [];
  private readonly audit: AuditLog;
  private readonly ledger = new ApprovalLedger();
  private readonly locks = new KeyedLocks();
  private readonly scheduler = new Scheduler({ maxConcurrentReads: 8 });
  private readonly documentKey: string;
  private revision: string;

  constructor(fixture?: Fixture, audit?: AuditLog) {
    this.audit = audit ?? new AuditLog();
    const initialFeed = fixture?.feed !== undefined && Number.isFinite(fixture.feed) && fixture.feed > 0 ? fixture.feed : 35;
    this.operations = fixture?.operations?.length
      ? fixture.operations.map((operation, index) => ({
          id: typeof operation.id === "number" ? operation.id : index + 1,
          ...operation,
          feed: toFeed(operation.feed ?? initialFeed),
          spindleSpeed: operation.spindleSpeed !== undefined ? toSpeed(operation.spindleSpeed) : toSpeed(12000)
        }))
      : [{ id: 4, name: "Facing", type: "mill", feed: toFeed(initialFeed), spindleSpeed: toSpeed(12000), tool: 1 }];
    this.documentKey = "doc:fixture";
    this.revision = documentRevision(this.operations);
  }

  get documentKeyForTests(): string { return this.documentKey; }

  async call(request: Request): Promise<ToolResult> {
    try {
      return await this.dispatch(request);
    } catch (error) {
      return errorResult(request.tool, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async dispatch(request: Request): Promise<ToolResult> {
    const args = (request.arguments ?? {}) as Record<string, unknown>;
    const tool = request.tool;

    // ---- environment -------------------------------------------------
    if (tool === "mastercam_status") return this.ok(request, { connected: true, backend: "mock", version: "fixture", live: false });
    if (tool === "mastercam_capabilities") return this.ok(request, this.capabilities());
    if (tool === "discover_capabilities") return this.ok(request, this.discoverCapabilities(args));
    if (tool === "get_active_part") return this.ok(request, { name: "fixture-part", path: "fixture://active-part", units: "mm", modified: false, documentRevision: this.revision });
    if (tool === "get_geometry_summary") return this.ok(request, { solids: 1, surfaces: 6, curves: 12, boundingBox: { x: 100, y: 80, z: 25, unit: "mm" }, units: "mm" });
    if (tool === "get_selection") return this.ok(request, { operationIds: this.selected, count: this.selected.length });
    if (tool === "list_machine_groups" || tool === "get_machine_groups") return this.ok(request, [{ id: "mill", name: "Mill machine group", type: "mill" }]);
    if (tool === "list_operations") return this.ok(request, this.operations.map(item => ({ ...item, feed: operationFeed(item), spindleSpeed: operationSpeed(item) })));
    if (tool === "find_operations") {
      const query = String(args.query ?? "").toLowerCase();
      return this.ok(request, this.operations.filter(item => !query || JSON.stringify(item).toLowerCase().includes(query)).map(item => ({ ...item, feed: operationFeed(item), spindleSpeed: operationSpeed(item) })));
    }
    if (tool === "get_operation" || tool === "inspect") {
      const op = this.resolveTarget(args);
      return this.ok(request, { ...op, feed: operationFeed(op), spindleSpeed: operationSpeed(op), documentRevision: this.revision, operationFingerprint: this.fingerprint(op) });
    }
    if (tool === "explain_operation") {
      const op = this.resolveTarget(args);
      return this.ok(request, {
        operationId: op.id,
        summary: `${String(op.name ?? "Unnamed operation")} uses a ${String(op.type ?? "machine")} strategy`,
        inputs: { name: op.name, type: op.type, feed: operationFeed(op), spindleSpeed: operationSpeed(op), tool: op.tool ?? 1 },
        verification: { toolpath: op.toolpathDirty === true ? "dirty" : "generated", collisions: "not_checked", live: false },
        nextActions: ["Review operation parameters", "Preview any feed or speed change", "Confirm only after rereading the target"]
      });
    }
    if (tool === "get_operation_risks") {
      const op = this.resolveTarget(args);
      return this.ok(request, {
        operationId: op.id,
        riskLevel: "review_required",
        checks: [
          { name: "toolpath", state: op.toolpathDirty === true ? "dirty" : "generated" },
          { name: "collision", state: "not_checked" },
          { name: "holder clearance", state: "not_verified" },
          { name: "machine kinematics", state: "not_verified" }
        ],
        warnings: ["Fixture data cannot prove live Mastercam or machine safety"],
        requiresConfirmation: true
      });
    }
    if (tool === "get_operation_parameters") {
      const op = this.resolveTarget(args);
      return this.ok(request, { operationId: op.id, parameters: { feedRate: operationFeed(op), spindleSpeed: operationSpeed(op), stepdown: 2 }, documentRevision: this.revision });
    }
    if (tool === "get_stock") return this.ok(request, { dimensions: { x: 110, y: 90, z: 30, unit: "mm" }, units: "mm" });
    if (tool === "get_wcs") return this.ok(request, { name: "WCS 1", origin: [0, 0, 0], axes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } });
    if (tool === "list_tools") return this.ok(request, [{ number: 1, name: "6mm flat end mill", diameter: 6, units: "mm" }]);
    if (tool === "get_tool") {
      const number = Number(args.toolId ?? 1);
      if (!Number.isFinite(number) || number !== 1) throw new MastercamErrorImpl("OPERATION_NOT_FOUND", `Tool ${String(args.toolId)} was not found`);
      return this.ok(request, { number: 1, name: "6mm flat end mill", diameter: 6, units: "mm" });
    }
    if (tool === "get_toolpath_status") {
      const op = this.resolveTarget(args);
      return this.ok(request, { operationId: op.id, generated: op.toolpathDirty !== true, valid: true, collisionState: "not_checked" });
    }
    if (tool === "get_dirty_toolpaths") return this.ok(request, { operationIds: this.operations.filter(op => op.toolpathDirty === true).map(op => op.id) });
    if (tool === "get_selected_entities") return this.ok(request, { operationIds: this.selected, count: this.selected.length });
    if (tool === "get_post_processor") return this.ok(request, { name: "fixture-post", extension: ".nc", machine: "mock-mill" });
    if (tool === "get_machine_context") return this.ok(request, { machine: { name: "fixture mill", type: "mill", axes: 3 }, stock: { x: 110, y: 90, z: 30, unit: "mm" }, workholding: { state: "fixture_placeholder", verified: false }, wcs: "WCS 1", safety: "not_verified" });
    if (tool === "estimate_cycle_time") return this.ok(request, { operationIds: this.targetIds(args), seconds: 42, confidence: "fixture" });
    if (tool === "compare_toolpaths") return this.ok(request, { changed: false, added: 0, removed: 0, modified: 0 });
    if (tool === "capture_view") {
      return this.ok(request, {
        format: "svg",
        placeholder: true,
        image: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='100%25' height='100%25' fill='%23222'/><text x='16' y='95' fill='white'>Mock Mastercam view</text></svg>",
        note: "Mock placeholder; live capture transmits bounded image content"
      });
    }
    if (tool === "get_programming_context") return this.ok(request, this.programmingContext());
    if (tool === "verify_change") {
      const op = this.resolveTarget(args);
      const expected = args.expected as { feedRate?: unknown; spindleSpeed?: unknown } | undefined;
      const documentRevision = typeof args.documentRevision === "string" ? args.documentRevision : undefined;

      if (!expected || typeof expected !== "object") {
        throw new MastercamErrorImpl("VALIDATION_FAILED", "verify_change requires an expected object containing feedRate or spindleSpeed");
      }

      const currentFeed = operationFeed(op);
      const currentSpeed = operationSpeed(op);
      const checks: Record<string, any> = {};
      let overallPass = true;

      if (expected.feedRate) {
        const exp = toFeed(expected.feedRate);
        const pass = sameFeed(currentFeed, exp);
        checks.feedRate = { pass, expected: exp, actual: currentFeed };
        if (!pass) overallPass = false;
      }

      if (expected.spindleSpeed) {
        const exp = toSpeed(expected.spindleSpeed);
        const pass = currentSpeed.value === exp.value && currentSpeed.unit === exp.unit;
        checks.spindleSpeed = { pass, expected: exp, actual: currentSpeed };
        if (!pass) overallPass = false;
      }

      if (Object.keys(checks).length === 0) {
        throw new MastercamErrorImpl("VALIDATION_FAILED", "verify_change expected object must contain feedRate or spindleSpeed");
      }

      if (documentRevision && documentRevision !== this.revision) {
        overallPass = false;
        checks.documentRevision = { pass: false, expected: documentRevision, actual: this.revision };
      }

      return {
        ok: overallPass,
        tool: request.tool,
        data: {
          pass: overallPass,
          operationId: op.id,
          checks,
          reread: true,
          documentRevision: this.revision,
          verification: overallPass ? "verified" : "mismatch"
        }
      };
    }

    if (tool === "measure") {
      const op = this.resolveTarget(args);
      const path = String(args.path ?? "operation.feed");
      const value = path.endsWith("spindleSpeed") ? operationSpeed(op).value : operationFeed(op).value;
      return this.ok(request, { path, value, operationId: op.id });
    }
    if (tool === "assert") {
      const op = this.resolveTarget(args);
      const path = String(args.path ?? "operation.feed");
      const value = path.endsWith("spindleSpeed") ? operationSpeed(op).value : operationFeed(op).value;
      const pass = args.equals !== undefined && value === Number(args.equals);
      return { ok: pass, tool: request.tool, data: { pass, path, actual: value, expected: args.equals, operationId: op.id } };
    }

    // ---- mutation workflow -------------------------------------------
    if (tool === "preview_operation_parameters") return this.scheduler.schedule({ lane: "read", documentKey: this.documentKey, run: () => this.previewOperation(request, args) });
    if (tool === "apply_operation_parameter_preview") return this.scheduler.schedule({ lane: "mutation", documentKey: this.documentKey, run: () => this.applyPreview(request, args) });
    if (tool === "rollback_change") return this.scheduler.schedule({ lane: "mutation", documentKey: this.documentKey, run: () => this.rollback(request, args) });

    // ---- advanced ------------------------------------------------------
    if (tool === "regenerate_toolpath") return this.scheduler.schedule({ lane: "mutation", documentKey: this.documentKey, run: () => this.regenerate(request, args) });
    if (tool === "run_simulation") return this.ok(request, { state: "complete", seconds: 3, collisions: 0, warnings: [], provenance: { fixture: true, note: "Fixture simulation is not evidence of live machine safety" } });
    if (tool === "detect_collisions") return this.ok(request, { collisions: [], checkedOperations: this.targetIds(args) });

    // ---- diagnostics / shop -------------------------------------------
    if (tool === "get_version_report") return this.ok(request, { mastercam: "fixture", netHook: "fixture", supported: ["mock"], liveMappingsVerified: false });
    if (tool === "get_fixture_info") return this.ok(request, { backend: "mock", fixture: true, replayable: true, liveMastercamRequired: false, limitations: ["Geometry and kinematics are synthetic", "Collision results are not evidence of machine safety"] });
    if (tool === "get_audit_history") return this.ok(request, { note: "Audit entries are append-only on disk; see MASTERCAM_MCP_AUDIT_PATH", documentRevision: this.revision });

    return { ok: false, tool, error: { code: "UNSUPPORTED_TOOL", message: `Tool ${tool} is not implemented by the mock backend`, remediation: "See mastercam_capabilities for supported tools" } };
  }

  // ---- mutation internals ---------------------------------------------

  private async previewOperation(request: Request, args: Record<string, unknown>): Promise<ToolResult> {
    const op = this.requireExactTarget(args.operationId);
    const changes: { feedRate?: FeedRate; spindleSpeed?: SpindleSpeed } = {};
    if (args.changes && typeof args.changes === "object") {
      const c = args.changes as Record<string, unknown>;
      if (c.feedRate !== undefined) changes.feedRate = c.feedRate as FeedRate;
      if (c.spindleSpeed !== undefined) changes.spindleSpeed = c.spindleSpeed as SpindleSpeed;
    }
    if (changes.feedRate === undefined && changes.spindleSpeed === undefined) {
      throw new MastercamErrorImpl("VALIDATION_FAILED", "At least one of feedRate or spindleSpeed must be provided");
    }
    const before: { feedRate?: FeedRate; spindleSpeed?: SpindleSpeed } = {
      ...(changes.feedRate !== undefined ? { feedRate: operationFeed(op) } : {}),
      ...(changes.spindleSpeed !== undefined ? { spindleSpeed: operationSpeed(op) } : {})
    };
    const after: { feedRate?: FeedRate; spindleSpeed?: SpindleSpeed } = {
      ...(changes.feedRate !== undefined ? { feedRate: changes.feedRate } : {}),
      ...(changes.spindleSpeed !== undefined ? { spindleSpeed: changes.spindleSpeed } : {})
    };
    const operationFingerprint = this.fingerprint(op);
    const preview = this.ledger.createPreview({
      tool: "preview_operation_parameters",
      operationId: typeof op.id === "number" ? op.id : Number(op.id),
      changes,
      before,
      after,
      documentRevision: this.revision,
      operationFingerprint,
      beforeHash: sha256Of(before),
      afterHash: sha256Of(after),
      requiresRegeneration: true
    });
    this.audit.record({ requestId: request.id, tool: request.tool, target: { operationId: op.id }, policy: { action: "preview" }, beforeHash: preview.beforeHash, afterHash: preview.afterHash });
    return this.ok(request, {
      operationId: op.id,
      before,
      after,
      risks: ["Fixture preview; live writes require a verified adapter"],
      requiresRegeneration: true,
      approvalToken: preview.approvalToken,
      expiresAt: new Date(preview.expiresAt).toISOString(),
      documentRevision: this.revision,
      operationFingerprint
    });
  }

  private async applyPreview(request: Request, args: Record<string, unknown>): Promise<ToolResult> {
    const token = String(args.approvalToken ?? "");
    if (!token) throw new MastercamErrorImpl("APPROVAL_TOKEN_INVALID", "approvalToken is required");
    const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
    if (idempotencyKey) {
      const targetOp = this.requireExactTarget(args.operationId);
      const targetHash = this.fingerprint(targetOp);
      const argHash = sha256Of(args.changes);
      const seen = this.ledger.idempotencyKeySeen(idempotencyKey, request.tool, targetHash, argHash);
      if (seen) {
        return this.ok(request, this.applyReceipt(seen, true));
      }
    }
    // Re-derive the live fingerprint and document revision: CAS gate. The token alone is not enough.
    const probe = this.ledger.peekPreview(token);
    const op = this.requireExactTarget(probe.operationId);
    const currentFingerprint = this.fingerprint(op);
    const preview = this.ledger.consumePreview(token, { operationFingerprint: currentFingerprint, documentRevision: this.revision });
    const changed = applyQuantity(op, preview.changes);
    this.revision = documentRevision(this.operations);
    const applied = this.ledger.recordApply(preview);
    if (idempotencyKey) {
      const targetOp = this.requireExactTarget(args.operationId);
      const targetHash = this.fingerprint(targetOp);
      const argHash = sha256Of(args.changes);
      this.ledger.rememberIdempotency(idempotencyKey, request.tool, targetHash, argHash, applied);
    }
    const transactionId = applied.transactionId;
    const rollback = this.ledger.createRollback(transactionId);
    this.audit.record({
      requestId: request.id,
      transactionId,
      tool: request.tool,
      target: { operationId: op.id },
      policy: { action: "apply", idempotencyKey },
      beforeHash: applied.beforeHash,
      afterHash: applied.afterHash,
      verified: true
    });
    return this.ok(request, {
      applied: true,
      operationId: op.id,
      before: applied.before,
      after: changed,
      requiresRegeneration: applied.requiresRegeneration,
      transactionId,
      rollback: { transactionId: rollback.transactionId, expiresAt: new Date(rollback.expiresAt).toISOString() },
      documentRevision: this.revision,
      operationFingerprint: this.fingerprint(op)
    });
  }

  private async rollback(request: Request, args: Record<string, unknown>): Promise<ToolResult> {
    const transactionId = String(args.transactionId ?? "");
    if (!transactionId) throw new MastercamErrorImpl("APPROVAL_TOKEN_INVALID", "transactionId is required");
    const record = this.ledger.peekRollback(transactionId);
    const op = this.requireExactTarget(record.operationId);
    // CAS: current state must still match what the transaction produced.
    const currentFeed = operationFeed(op);
    const currentSpeed = operationSpeed(op);
    const after = record.restoredSource ?? record.restored;
    const matchesAfter =
      (after.feedRate === undefined || sameFeed(currentFeed, after.feedRate as FeedRate)) &&
      (after.spindleSpeed === undefined || currentSpeed.value === after.spindleSpeed.value);
    if (!matchesAfter) {
      throw new MastercamErrorImpl("STALE_PREVIEW", "Operation state changed after the transaction; rollback refused");
    }
    // Only consume after CAS passes
    this.ledger.consumeRollback(transactionId);
    const restored = applyQuantity(op, record.restored);
    this.revision = documentRevision(this.operations);
    this.audit.record({ requestId: request.id, transactionId: record.transactionId, tool: request.tool, target: { operationId: op.id }, policy: { action: "rollback" }, verified: true });
    return this.ok(request, {
      applied: true,
      operationId: op.id,
      restored,
      transactionId: record.transactionId,
      rollbackOf: record.rollbackOf,
      documentRevision: this.revision
    });
  }

  private async regenerate(request: Request, args: Record<string, unknown>): Promise<ToolResult> {
    const ids = Array.isArray(args.operationIds) ? (args.operationIds as number[]) : [];
    const targets = ids.length ? ids.map(id => this.requireExactTarget(id)) : [];
    for (const op of targets) op.toolpathDirty = false;
    this.audit.record({ requestId: request.id, tool: request.tool, target: { operationIds: targets.map(op => op.id) }, policy: { action: "regenerate" } });
    return this.ok(request, { operationIds: targets.map(op => op.id), regenerated: true, progress: ["queued", "generating", "complete"] });
  }

  private applyChanges(op: Record<string, unknown>, changes: { feedRate?: FeedRate; spindleSpeed?: SpindleSpeed }): { feedRate: FeedRate; spindleSpeed: SpindleSpeed } {
    return applyQuantity(op, changes);
  }

  // ---- helpers ---------------------------------------------------------

  /** BUG-01 fix: never fall back to the first operation. */
  private resolveTarget(args: Record<string, unknown>): Record<string, unknown> {
    if (args.operationId === undefined) {
      if (this.operations.length === 1) return this.operations[0]!;
      throw new MastercamErrorImpl("TARGET_REQUIRED", "operationId is required when more than one operation exists");
    }
    const id = Number(args.operationId);
    const op = this.operations.find(item => item.id === id);
    if (!op) throw new MastercamErrorImpl("OPERATION_NOT_FOUND", `Operation ${String(args.operationId)} was not found`);
    return op;
  }

  private requireExactTarget(id: unknown): Record<string, unknown> {
    if (id === undefined || id === null) {
      // With exactly one operation the target is unambiguous by definition;
      // otherwise mutations require an explicit id (audit BUG-01).
      if (this.operations.length === 1) return this.operations[0]!;
      throw new MastercamErrorImpl("TARGET_REQUIRED", "operationId is required when more than one operation exists");
    }
    const numeric = Number(id);
    const op = this.operations.find(item => item.id === numeric);
    if (!op) throw new MastercamErrorImpl("OPERATION_NOT_FOUND", `Operation ${String(id)} was not found`);
    return op;
  }

  private targetIds(args: Record<string, unknown>): number[] {
    if (Array.isArray(args.operationIds) && args.operationIds.length) return (args.operationIds as number[]).map(Number);
    return this.operations.map(op => typeof op.id === "number" ? op.id : Number(op.id));
  }

  private fingerprint(op: Record<string, unknown>): string {
    return fingerprintOperation(Number(op.id), { feed: op.feed, spindleSpeed: op.spindleSpeed, tool: op.tool, toolpathDirty: op.toolpathDirty });
  }

  private ok(request: Request, data: unknown): ToolResult {
    return { ok: true, tool: request.tool, data, live: false, documentRevision: this.revision };
  }

  private capabilities() {
    const readTools = ["mastercam_status", "mastercam_capabilities", "get_active_part", "list_operations", "get_operation", "find_operations", "explain_operation", "get_operation_risks", "get_operation_parameters", "get_stock", "get_wcs", "list_tools", "get_machine_context", "get_programming_context", "get_dirty_toolpaths"];
    const mutationTools = ["preview_operation_parameters", "apply_operation_parameter_preview", "rollback_change", "regenerate_toolpath"];
    return {
      profile: "mock",
      live: false,
      fixture: true,
      verificationTier: "IMPLEMENTED",
      supported: { read: readTools, mutation: mutationTools },
      unavailable: ["run_simulation", "detect_collisions", "post_program", "cycle_start"],
      note: "Fixture data is synthetic and cannot prove live Mastercam behavior"
    };
  }

  private discoverCapabilities(args: Record<string, unknown>) {
    const groups: Record<string, string[]> = {
      connection: ["mastercam_status", "mastercam_capabilities"],
      inspection: ["get_active_part", "list_operations", "get_operation", "get_operation_parameters", "get_stock", "get_wcs", "list_tools"],
      planning: ["mastercam_plan", "preview_operation_parameters", "apply_operation_parameter_preview"],
      safety: ["get_operation_risks", "run_simulation", "detect_collisions"],
      targeting: ["find_operations", "get_selection"],
      administration: ["mastercam_doctor", "get_version_report", "get_fixture_info"]
    };
    const category = typeof args.category === "string" ? args.category : "";
    if (category && groups[category]) return { category, tools: groups[category], nextAction: "Inspect the active part before planning a change" };
    return { groups, nextAction: "Inspect the active part before planning a change", safeDefaults: { liveWrites: false, posting: false } };
  }

  private programmingContext() {
    return {
      documentRevision: this.revision,
      activePart: { name: "fixture-part", units: "mm" },
      selection: this.selected,
      machineGroup: { id: "mill", name: "Mill machine group", type: "mill" },
      wcs: { name: "WCS 1" },
      stock: { dimensions: { x: 110, y: 90, z: 30, unit: "mm" } },
      toolSummary: { count: 1, numbers: [1] },
      operationSummary: this.operations.map(op => ({ id: op.id, name: op.name, type: op.type, toolpathDirty: op.toolpathDirty === true })),
      dirtyToolpaths: this.operations.filter(op => op.toolpathDirty === true).map(op => op.id),
      safety: { liveVerified: false, note: "Fixture context cannot prove live machine safety" }
    };
  }

  private applyReceipt(applied: { transactionId: string; operationId: number; before: unknown; after: unknown; requiresRegeneration: boolean }, duplicate: boolean) {
    return {
      applied: true,
      duplicate: duplicate || undefined,
      operationId: applied.operationId,
      before: applied.before,
      after: applied.after,
      requiresRegeneration: applied.requiresRegeneration,
      transactionId: applied.transactionId
    };
  }
}

export function request(tool: string, args: Record<string, unknown> = {}): Request { return { id: randomUUID(), tool, arguments: args }; }

// Re-export shared formatting for callers that want human summaries.
export { formatFeed, formatSpindle, feedToMmPerMinute, newApprovalToken };
