import net from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Request, Response, ToolResult } from "./contracts.js";
import { OperationIdSchema, FeedRateSchema, SpindleSpeedSchema, ApprovalTokenSchema, TransactionIdSchema } from "./schemas/common.js";

export interface Backend { call(request: Request): Promise<ToolResult>; close?(): Promise<void> }

interface Operation {
  id: number;
  name: string;
  type: string;
  feedRate?: { value: number; unit: string };
  spindleSpeed?: { value: number; unit: string };
  tool?: { number: number; name: string };
  [key: string]: unknown;
}

interface AuditEntry {
  sequence: number;
  timestamp: string;
  requestId: string;
  transactionId?: string;
  tool: string;
  target: Record<string, unknown>;
  policy: Record<string, unknown>;
  beforeHash?: string;
  afterHash?: string;
  verified: boolean;
  previousEntryHash?: string;
  entryHash: string;
}

interface TransactionReceipt {
  transactionId: string;
  partFingerprint: string;
  operationId: number;
  beforeHash: string;
  afterHash: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

interface ApprovalRecord {
  approvalToken: string;
  transactionId: string;
  operationId: number;
  operationFingerprint: string;
  documentRevision: string;
  beforeHash: string;
  proposedHash: string;
  proposed: { feedRate?: { value: number; unit: string }; spindleSpeed?: { value: number; unit: string } };
  expiresAt: string;
  used: boolean;
}

const MAX_AUDIT_ENTRIES = 500;
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const TX_TTL_MS = 10 * 60 * 1000;

function hashObject(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj, Object.keys(obj as object).sort())).digest("hex");
}

function computeFingerprint(operation: Operation): string {
  const { id, name, type, feedRate, spindleSpeed, tool } = operation;
  return hashObject({ id, name, type, feedRate, spindleSpeed, tool });
}

export class PipeBackend implements Backend {
  constructor(private readonly pipeName: string) {}
  call(request: Request): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipeName);
      let buffer = "";
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (error?: Error, result?: ToolResult) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result!); };
      timer = setTimeout(() => finish(new Error("Mastercam named pipe timeout")), 15000);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
      socket.on("data", (chunk: string) => { buffer += chunk; if (buffer.length > 4 * 1024 * 1024) return finish(new Error("Mastercam named pipe response exceeded 4 MiB")); const line = buffer.split("\n")[0]; if (!line) return; try { const response = JSON.parse(line) as Response; if (response.id !== request.id) return finish(new Error("Mastercam named pipe response id mismatch")); finish(undefined, response.result); } catch (e) { finish(e instanceof Error ? e : new Error(String(e))); } });
      socket.on("error", (e: Error) => finish(e));
      socket.on("close", () => { if (!settled) finish(new Error("Mastercam named pipe closed before a response")); });
    });
  }
}

export class MockBackend implements Backend {
  private operations: Operation[];
  private history: AuditEntry[] = [];
  private transactions: Map<string, TransactionReceipt> = new Map();
  private approvals: Map<string, ApprovalRecord> = new Map();
  private selected: number[] = [4];
  private readonly auditPath: string;
  private auditSequence = 0;
  private documentRevision = "rev-1";

  constructor(fixture?: { feed?: number; operations?: Array<Record<string, unknown>> }) {
    this.auditPath = process.env["MASTERCAM_MCP_AUDIT_PATH"] ?? join(process.env["LOCALAPPDATA"] ?? ".", "mastercam-mcp", "audit.jsonl");
    this.loadAudit();
    const initialFeed = fixture?.feed !== undefined && Number.isFinite(fixture.feed) && fixture.feed > 0 ? fixture.feed : 35;
    this.operations = fixture?.operations?.length
      ? fixture.operations.map((operation, index) => ({ id: Number(operation.id ?? index + 1), name: String(operation.name ?? `Op${index + 1}`), type: String(operation.type ?? "mill"), feedRate: { value: Number(operation.feed ?? initialFeed), unit: "mm/min" }, spindleSpeed: { value: Number(operation.speed ?? 12000), unit: "rpm" } }))
      : [{ id: 4, name: "Facing", type: "mill", feedRate: { value: initialFeed, unit: "mm/min" }, spindleSpeed: { value: 12000, unit: "rpm" } }];
    this.cleanupExpired();
  }

  private loadAudit() {
    if (existsSync(this.auditPath)) {
      try {
        const content = readFileSync(this.auditPath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        for (const line of lines.slice(-MAX_AUDIT_ENTRIES)) {
          const entry = JSON.parse(line) as AuditEntry;
          this.history.push(entry);
          this.auditSequence = Math.max(this.auditSequence, entry.sequence);
        }
      } catch { this.history = []; }
    }
  }

  private cleanupExpired() {
    const now = new Date().toISOString();
    for (const [token, approval] of this.approvals) {
      if (approval.expiresAt < now) this.approvals.delete(token);
    }
    for (const [txId, tx] of this.transactions) {
      if (tx.expiresAt < now) this.transactions.delete(txId);
    }
  }

  async call(request: Request): Promise<ToolResult> {
    this.cleanupExpired();
    const a = request.arguments ?? {};
    const tool = request.tool;

    if (tool === "mastercam_status") return { ok: true, tool, data: { connected: true, backend: "mock", version: "fixture" } };
    if (tool === "mastercam_capabilities") return { ok: true, tool, data: { profile: "mock", live: false, fixture: true, supported: ["inspection", "targeting", "feedSpeed", "preview", "rollback", "regeneration", "simulation", "visualContext"] } };

    if (tool === "discover_capabilities") {
      const groups = { connection: ["mastercam_status", "mastercam_capabilities"], inspection: ["get_active_part", "list_operations", "get_operation", "get_operation_parameters", "get_stock", "get_wcs", "list_tools"], planning: ["mastercam_plan", "preview_operation_parameters", "verify_change"], safety: ["get_operation_risks", "run_simulation", "detect_collisions"], targeting: ["find_operations", "get_selection"], administration: ["mastercam_doctor", "get_version_report", "get_fixture_info"] };
      const category = String(a["category"] ?? "");
      return this.result(request, category && groups[category as keyof typeof groups] ? { category, tools: groups[category as keyof typeof groups], nextAction: "Inspect the active part before planning a change" } : { groups, nextAction: "Inspect the active part before planning a change", safeDefaults: { liveWrites: false, posting: false } });
    }

    if (tool === "get_active_part") return this.result(request, { name: "fixture-part", path: "fixture://active-part", units: "mm", modified: false, revision: this.documentRevision, fingerprint: hashObject({ name: "fixture-part", units: "mm" }) });
    if (tool === "get_geometry_summary") return this.result(request, { solids: 1, surfaces: 6, curves: 12, boundingBox: { x: 100, y: 80, z: 25 }, units: "mm" });
    if (tool === "get_selection") return this.result(request, { operationIds: this.selected, count: this.selected.length });
    if (tool === "list_machine_groups") return this.result(request, [{ id: "mill", name: "Mill machine group", type: "mill" }]);
    if (tool === "list_operations") return { ok: true, tool, data: this.operations.map(item => ({ ...item })) };
    if (tool === "find_operations") {
      const query = String(a["query"] ?? "").toLowerCase();
      return this.result(request, this.operations.filter(item => !query || Object.values(item).some(value => String(value).toLowerCase().includes(query))));
    }

    const operation = this.resolveOperation(a["operationId"]);
    if (!operation) return { ok: false, tool, error: { code: "OPERATION_NOT_FOUND", message: `Operation ${a["operationId"] ?? "not specified"} not found` } };

    const opFingerprint = computeFingerprint(operation);
    const feedRate = operation.feedRate ?? { value: 35, unit: "mm/min" };
    const spindleSpeed = operation.spindleSpeed ?? { value: 12000, unit: "rpm" };

    if (["get_operation", "inspect"].includes(tool)) return { ok: true, tool, data: { ...operation, documentRevision: this.documentRevision, operationFingerprint: opFingerprint } };

    if (tool === "explain_operation") return this.result(request, { operationId: operation.id, summary: `${operation.name ?? "Unnamed operation"} uses a ${operation.type ?? "machine"} strategy`, inputs: { name: operation.name, type: operation.type, feedRate, spindleSpeed, tool: operation.tool ?? { number: 1 } }, verification: { toolpath: "generated", collisions: "not_checked", live: false }, nextActions: ["Review operation parameters", "Preview any feed or speed change", "Confirm only after rereading the target"], unknownFields: [] });

    if (tool === "get_operation_risks") return this.result(request, { operationId: operation.id, riskLevel: "review_required", checks: [{ name: "toolpath", state: "generated" }, { name: "collision", state: "not_checked" }, { name: "holder clearance", state: "not_verified" }, { name: "machine kinematics", state: "not_verified" }], warnings: ["Fixture data cannot prove live Mastercam or machine safety"], requiresConfirmation: true });

    if (tool === "get_operation_parameters") return this.result(request, { operationId: operation.id, parameters: { feedRate, spindleSpeed, stepdown: { value: 2, unit: "mm" } } });

    if (tool === "get_stock") return this.result(request, { dimensions: { x: 110, y: 90, z: 30 }, units: "mm" });
    if (tool === "get_wcs") return this.result(request, { name: "WCS 1", origin: [0, 0, 0], axes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } });
    if (tool === "list_tools") return this.result(request, [{ number: 1, name: "6mm flat end mill", diameter: 6, units: "mm" }]);
    if (tool === "get_toolpath_status") return this.result(request, { operationId: operation.id, generated: true, valid: true, dirty: false, collisionState: "not_checked" });
    if (tool === "get_post_processor") return this.result(request, { name: "fixture-post", extension: ".nc", machine: "mock-mill" });
    if (tool === "estimate_cycle_time") return this.result(request, { operationId: operation.id, seconds: 42, confidence: "fixture" });
    if (tool === "compare_toolpaths") return this.result(request, { changed: false, added: 0, removed: 0, modified: 0 });
    if (tool === "measure") return { ok: true, tool, data: { path: a["path"] ?? "operation.feedRate", value: feedRate.value, unit: feedRate.unit, operationId: operation.id } };
    if (tool === "assert") { const expected = a["equals"]; const pass = Number(expected) === feedRate.value; return { ok: pass, tool, data: { pass, path: a["path"] ?? "operation.feedRate", actual: feedRate.value, expected, operationId: operation.id } }; }
    if (tool === "capture_view") return { ok: true, tool, data: { format: "svg", placeholder: true, image: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='100%' height='100%' fill='#222'/><text x='16' y='95' fill='white'>Mock Mastercam view</text></svg>" } };

    if (tool === "preview_operation_parameters") {
      const feedRateInput = a["feedRate"] ? FeedRateSchema.parse(a["feedRate"]) : undefined;
      const spindleSpeedInput = a["spindleSpeed"] ? SpindleSpeedSchema.parse(a["spindleSpeed"]) : undefined;
      if (!feedRateInput && !spindleSpeedInput) return { ok: false, tool, error: { code: "VALIDATION_FAILED", message: "At least one of feedRate or spindleSpeed must be provided" } };

      const before = { feedRate, spindleSpeed };
      const after = {
        feedRate: feedRateInput ?? feedRate,
        spindleSpeed: spindleSpeedInput ?? spindleSpeed
      };
      const proposedHash = hashObject(after);
      const beforeHash = hashObject(before);

      const approvalToken = randomUUID();
      const transactionId = randomUUID();
      const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();

      const approval: ApprovalRecord = {
        approvalToken,
        transactionId,
        operationId: operation.id,
        operationFingerprint: opFingerprint,
        documentRevision: this.documentRevision,
        beforeHash,
        proposedHash,
        proposed: after,
        expiresAt,
        used: false
      };
      this.approvals.set(approvalToken, approval);

      return { ok: true, tool, data: { before, after, requiresRegeneration: true, rollbackAvailable: true, approvalToken, expiresAt, documentRevision: this.documentRevision, operationFingerprint: opFingerprint, risks: [] } };
    }

    if (tool === "apply_operation_parameter_preview") {
      const approvalToken = ApprovalTokenSchema.parse(a["approvalToken"]);
      const approval = this.approvals.get(approvalToken);
      if (!approval) return { ok: false, tool, error: { code: "INVALID_APPROVAL_TOKEN", message: "Approval token not found or expired" } };
      if (approval.used) return { ok: false, tool, error: { code: "APPROVAL_TOKEN_USED", message: "Approval token has already been used" } };
      if (approval.expiresAt < new Date().toISOString()) { this.approvals.delete(approvalToken); return { ok: false, tool, error: { code: "APPROVAL_TOKEN_EXPIRED", message: "Approval token has expired" } }; }

      const currentOp = this.operations.find(op => op.id === approval.operationId);
      if (!currentOp) return { ok: false, tool, error: { code: "OPERATION_NOT_FOUND", message: "Target operation no longer exists" } };
      const currentFingerprint = computeFingerprint(currentOp);
      if (currentFingerprint !== approval.operationFingerprint) return { ok: false, tool, error: { code: "STALE_PREVIEW", message: "Operation has been modified since preview" } };
      if (this.documentRevision !== approval.documentRevision) return { ok: false, tool, error: { code: "STALE_PREVIEW", message: "Document has been modified since preview" } };

      const before = { feedRate: currentOp.feedRate, spindleSpeed: currentOp.spindleSpeed };
      const beforeHash = hashObject(before);

      currentOp.feedRate = approval.proposed.feedRate;
      currentOp.spindleSpeed = approval.proposed.spindleSpeed;

      this.documentRevision = `rev-${Date.now()}`;
      const after = { feedRate: currentOp.feedRate, spindleSpeed: currentOp.spindleSpeed };
      const afterHash = hashObject(after);

      const txReceipt: TransactionReceipt = {
        transactionId: approval.transactionId,
        partFingerprint: hashObject({ operations: this.operations.map(computeFingerprint) }),
        operationId: operation.id,
        beforeHash,
        afterHash,
        before,
        after,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + TX_TTL_MS).toISOString()
      };
      this.transactions.set(approval.transactionId, txReceipt);

      approval.used = true;
      this.recordAudit({ requestId: request.id, transactionId: approval.transactionId, tool, target: { operationId: operation.id }, policy: {}, beforeHash, afterHash, verified: true });

      return { ok: true, tool, data: { applied: true, transactionId: approval.transactionId, documentRevision: this.documentRevision, operationFingerprint: computeFingerprint(currentOp), before, after, regenerated: true, verification: { pass: true, reread: true, actualFeedRate: currentOp.feedRate, actualSpindleSpeed: currentOp.spindleSpeed } } };
    }

    if (tool === "verify_change") {
      const expected = a["expected"] as Record<string, unknown> | undefined;
      const expectedFeedRate = expected?.feedRate ? FeedRateSchema.parse(expected.feedRate) : undefined;
      const expectedSpindleSpeed = expected?.spindleSpeed ? SpindleSpeedSchema.parse(expected.spindleSpeed) : undefined;
      if (!expectedFeedRate && !expectedSpindleSpeed) return { ok: false, tool, error: { code: "VALIDATION_FAILED", message: "At least one expected value (feedRate or spindleSpeed) must be provided" } };

      const actualFeedRate = operation.feedRate;
      const actualSpindleSpeed = operation.spindleSpeed;

      const feedMatch = (!expectedFeedRate || (actualFeedRate && expectedFeedRate.value === actualFeedRate.value && expectedFeedRate.unit === actualFeedRate.unit)) as boolean;
      const speedMatch = (!expectedSpindleSpeed || (actualSpindleSpeed && expectedSpindleSpeed.value === actualSpindleSpeed.value && expectedSpindleSpeed.unit === actualSpindleSpeed.unit)) as boolean;

      const pass = feedMatch && speedMatch;
      return { ok: pass, tool, data: { pass, operationId: operation.id, expectedFeedRate, actualFeedRate, expectedSpindleSpeed, actualSpindleSpeed, reread: true, verification: pass ? "verified" : "mismatch" } };
    }

    if (tool === "rollback_change") {
      const transactionId = TransactionIdSchema.parse(a["transactionId"]);
      const tx = this.transactions.get(transactionId);
      if (!tx) return { ok: false, tool, error: { code: "TRANSACTION_NOT_FOUND", message: "Rollback transaction not found or expired" } };

      const currentOp = this.operations.find(op => op.id === tx.operationId);
      if (!currentOp) return { ok: false, tool, error: { code: "OPERATION_NOT_FOUND", message: "Target operation no longer exists" } };
      const currentFingerprint = computeFingerprint(currentOp);
      if (currentFingerprint !== tx.afterHash) return { ok: false, tool, error: { code: "STALE_STATE", message: "Operation has been modified since the transaction; rollback refused" } };
      if (this.documentRevision !== tx.partFingerprint) return { ok: false, tool, error: { code: "STALE_STATE", message: "Document has been modified since the transaction; rollback refused" } };

      const beforeRollback = { feedRate: currentOp.feedRate, spindleSpeed: currentOp.spindleSpeed };
      currentOp.feedRate = tx.before.feedRate as { value: number; unit: string } | undefined;
      currentOp.spindleSpeed = tx.before.spindleSpeed as { value: number; unit: string } | undefined;

      this.documentRevision = `rev-${Date.now()}`;
      const afterRollback = { feedRate: currentOp.feedRate, spindleSpeed: currentOp.spindleSpeed };
      const rollbackTxId = randomUUID();
      const rollbackReceipt: TransactionReceipt = {
        transactionId: rollbackTxId,
        partFingerprint: hashObject({ operations: this.operations.map(computeFingerprint) }),
        operationId: operation.id,
        beforeHash: tx.afterHash,
        afterHash: hashObject(afterRollback),
        before: beforeRollback,
        after: afterRollback,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + TX_TTL_MS).toISOString()
      };
      this.transactions.set(rollbackTxId, rollbackReceipt);

      this.recordAudit({ requestId: request.id, transactionId: rollbackTxId, tool, target: { operationId: operation.id, rollbackOf: transactionId }, policy: {}, beforeHash: tx.afterHash, afterHash: rollbackReceipt.afterHash, verified: true });

      return { ok: true, tool, data: { applied: true, rollbackTransactionId: rollbackTxId, documentRevision: this.documentRevision, operationFingerprint: computeFingerprint(currentOp), before: beforeRollback, after: afterRollback, regenerated: true, verification: { pass: true, reread: true } } };
    }

    if (tool === "regenerate_toolpath") {
      const operationIds = a["operationIds"] as unknown[] | undefined;
      return this.result(request, { operationIds: operationIds?.map((id: unknown) => OperationIdSchema.parse(id)) ?? [operation.id], regenerated: true, progress: ["queued", "generating", "complete"], durationMs: 100 });
    }
    if (tool === "run_simulation") return this.result(request, { state: "complete", durationSeconds: 3, collisions: [], warnings: [], cycleTimeEstimate: 42, operationsSimulated: 1 });
    if (tool === "detect_collisions") {
      const operationIds = a["operationIds"] as unknown[] | undefined;
      return this.result(request, { collisions: [], checkedOperations: operationIds?.map((id: unknown) => OperationIdSchema.parse(id)) ?? [operation.id], durationMs: 50 });
    }
    if (tool === "get_version_report") return this.result(request, { mastercam: "fixture", netHook: "fixture", supported: ["mock"], liveMappingsVerified: false, adapterVersion: "0.1.6", protocolVersion: 2 });
    if (tool === "get_machine_context") return this.result(request, { machine: { name: "fixture mill", type: "mill", axes: 3 }, stock: { x: 110, y: 90, z: 30, units: "mm" }, workholding: { state: "fixture_placeholder", verified: false }, wcs: "WCS 1", safety: "not_verified" });
    if (tool === "get_fixture_info") return this.result(request, { backend: "mock", fixture: true, replayable: true, liveMastercamRequired: false, limitations: ["Geometry and kinematics are synthetic", "Collision results are not evidence of machine safety"] });
    if (tool === "client_setup_check") return this.result(request, { codex: "not_checked", claude: "not_checked", http: "available", guidance: "Run the installer with ConfigureClients on Windows" });
    if (tool === "get_audit_history") {
      const limit = Math.min(Number(a["limit"] ?? 100), 1000);
      let entries = this.history;
      if (a["tool"]) entries = entries.filter(e => e.tool === a["tool"]);
      if (a["operationId"]) entries = entries.filter(e => e.target.operationId === Number(a["operationId"]));
      return this.result(request, { entries: entries.slice(-limit), total: entries.length });
    }

    return { ok: false, tool, error: { code: "UNSUPPORTED_TOOL", message: `Tool ${tool} is not implemented` } };
  }

  private resolveOperation(id: unknown): Operation | null {
    if (id === undefined || id === null) {
      if (this.selected.length === 1) return this.operations.find(op => op.id === this.selected[0]) ?? null;
      return null;
    }
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) return null;
    return this.operations.find(op => op.id === numId) ?? null;
  }

  private result(request: Request, data: unknown): ToolResult { return { ok: true, tool: request.tool, data }; }

  private recordAudit(entry: Omit<AuditEntry, "sequence" | "timestamp" | "previousEntryHash" | "entryHash">) {
    this.auditSequence++;
    const timestamp = new Date().toISOString();
    const previousEntryHash = this.history.length > 0 ? (this.history[this.history.length - 1]?.entryHash ?? "0".repeat(64)) : "0".repeat(64);
    const entryHash = hashObject({ ...entry, sequence: this.auditSequence, timestamp, previousEntryHash });
    const fullEntry: AuditEntry = { ...entry, sequence: this.auditSequence, timestamp, previousEntryHash, entryHash };
    this.history.push(fullEntry);
    try { mkdirSync(dirname(this.auditPath), { recursive: true }); appendFileSync(this.auditPath, JSON.stringify(fullEntry) + "\n"); } catch { }
  }
}

export function request(tool: string, args: Record<string, unknown> = {}): Request { return { id: randomUUID(), tool, arguments: args }; }