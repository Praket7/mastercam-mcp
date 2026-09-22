import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockBackend } from "../src/backend.js";
import { AuditLog, verifyAuditChain } from "../src/audit/audit-log.js";

test("mutation audit remains unverified until a linked reread succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcam-verify-audit-"));
  const audit = new AuditLog({ path: join(dir, "audit.jsonl"), enabled: true });
  const backend = new MockBackend(
    { operations: [{ id: 4, name: "Facing", feed: 35 }] },
    audit
  );

  const preview = await backend.call({
    id: "verify-preview",
    tool: "preview_operation_parameters",
    arguments: {
      operationId: 4,
      changes: { feedRate: { value: 50, unit: "mm/min" } }
    }
  });
  assert.equal(preview.ok, true);

  const approvalToken = (preview.data as { approvalToken: string }).approvalToken;
  const apply = await backend.call({
    id: "verify-apply",
    tool: "apply_operation_parameter_preview",
    arguments: { approvalToken }
  });
  assert.equal(apply.ok, true);

  const applied = apply.data as { transactionId: string; documentRevision: string };
  const verification = await backend.call({
    id: "verify-reread",
    tool: "verify_change",
    arguments: {
      operationId: 4,
      expected: { feedRate: { value: 50, unit: "mm/min" } },
      documentRevision: applied.documentRevision,
      transactionId: applied.transactionId
    }
  });
  assert.equal(verification.ok, true);
  assert.equal((verification.data as { transactionId?: string }).transactionId, applied.transactionId);

  await audit.flush();
  const chain = await verifyAuditChain(audit.location);
  assert.equal(chain.ok, true);

  const entries = (await readFile(audit.location, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);

  const applyEntry = entries.find(entry => entry.tool === "apply_operation_parameter_preview");
  assert.ok(applyEntry);
  assert.equal(applyEntry.transactionId, applied.transactionId);
  assert.equal(applyEntry.verified, false);

  const verifyEntry = entries.find(entry => entry.tool === "verify_change" && entry.transactionId === applied.transactionId);
  assert.ok(verifyEntry);
  assert.equal(verifyEntry.verified, true);
  assert.ok(Number(verifyEntry.sequence) > Number(applyEntry.sequence));
});

test("failed reread records verified false for the linked transaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcam-verify-mismatch-"));
  const audit = new AuditLog({ path: join(dir, "audit.jsonl"), enabled: true });
  const backend = new MockBackend(
    { operations: [{ id: 4, name: "Facing", feed: 35 }] },
    audit
  );

  const preview = await backend.call({
    id: "mismatch-preview",
    tool: "preview_operation_parameters",
    arguments: {
      operationId: 4,
      changes: { feedRate: { value: 50, unit: "mm/min" } }
    }
  });
  const approvalToken = (preview.data as { approvalToken: string }).approvalToken;
  const apply = await backend.call({
    id: "mismatch-apply",
    tool: "apply_operation_parameter_preview",
    arguments: { approvalToken }
  });
  const transactionId = (apply.data as { transactionId: string }).transactionId;

  const verification = await backend.call({
    id: "mismatch-reread",
    tool: "verify_change",
    arguments: {
      operationId: 4,
      expected: { feedRate: { value: 60, unit: "mm/min" } },
      transactionId
    }
  });
  assert.equal(verification.ok, false);

  await audit.flush();
  const entries = (await readFile(audit.location, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
  const verifyEntry = entries.find(entry => entry.tool === "verify_change" && entry.transactionId === transactionId);
  assert.ok(verifyEntry);
  assert.equal(verifyEntry.verified, false);
});
