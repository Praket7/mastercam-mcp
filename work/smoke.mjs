import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const timeout = (ms, label) => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  timer.unref?.();
});

const client = new Client({ name: 'smoke', version: '1.0.0' });
const sdkTransport = new StdioClientTransport({
  command: process.execPath,
  args: ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'],
  env: { ...process.env, MASTERCAM_MCP_BACKEND: 'mock', MASTERCAM_MCP_AUDIT: '0', MASTERCAM_MCP_PROFILE: 'all', MASTERCAM_MCP_HARD_READ_ONLY: '0' }
});
await Promise.race([client.connect(sdkTransport), timeout(15000, 'connect')]);

const result = { initialized: true };
try {
  const tools = await Promise.race([client.listTools(), timeout(10000, 'tools/list')]);
  result.toolCount = tools.tools.length;
  result.hasStatus = tools.tools.some(t => t.name === 'mastercam_status');
  result.hasPreview = tools.tools.some(t => t.name === 'preview_operation_parameters');

  const status = await Promise.race([client.callTool({ name: 'mastercam_status', arguments: {} }), timeout(10000, 'status')]);
  result.status = status.structuredContent;

  const preview = await Promise.race([client.callTool({
    name: 'preview_operation_parameters',
    arguments: { operationId: 4, changes: { feedRate: { value: 42, unit: 'mm/min' } } }
  }), timeout(10000, 'preview')]);
  const previewData = preview.structuredContent?.data;
  result.preview = { ok: previewData?.ok !== false, hasToken: Boolean(previewData?.approvalToken) };

  const apply = await Promise.race([client.callTool({
    name: 'apply_operation_parameter_preview',
    arguments: { approvalToken: previewData.approvalToken }
  }), timeout(10000, 'apply')]);
  const applyData = apply.structuredContent?.data;
  result.apply = { applied: applyData?.applied === true, hasTransaction: Boolean(applyData?.transactionId) };

  const verify = await Promise.race([client.callTool({
    name: 'verify_change',
    arguments: { operationId: 4, expectedFeed: 42 }
  }), timeout(10000, 'verify')]);
  result.verify = { pass: verify.structuredContent?.data?.pass === true };

  const rollback = await Promise.race([client.callTool({
    name: 'rollback_change',
    arguments: { transactionId: applyData.rollback.transactionId }
  }), timeout(10000, 'rollback')]);
  const rollbackData = rollback.structuredContent?.data;
  result.rollback = { restored: rollbackData?.restored?.feedRate?.value === 35 };

  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error), stderr: stderr.slice(-400) }, null, 2));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
