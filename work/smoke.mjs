import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const timeout = (ms, label) => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  timer.unref?.();
});

const client = new Client(
  { name: 'smoke', version: '1.0.0' },
  {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
    capabilities: { elicitation: { form: {} } }
  }
);
client.setRequestHandler('elicitation/create', async request => {
  if (!request.params.message.includes('Before:') || !request.params.message.includes('After:')) {
    throw new Error('operator approval prompt did not show the exact preview');
  }
  return { action: 'accept', content: { confirm: true } };
});
const sdkTransport = new StdioClientTransport({
  command: process.execPath,
  args: ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'],
  env: {
    ...process.env,
    MASTERCAM_MCP_BACKEND: 'mock',
    MASTERCAM_MCP_AUDIT: '0',
    MASTERCAM_MCP_PROFILE: 'all',
    MASTERCAM_MCP_HARD_READ_ONLY: '0'
  }
});

await Promise.race([client.connect(sdkTransport), timeout(15000, 'connect')]);

const result = { initialized: true, protocolEra: client.getProtocolEra() };
try {
  if (result.protocolEra !== 'modern') throw new Error(`Expected modern MCP era, got ${result.protocolEra}`);

  const tools = await Promise.race([client.listTools(), timeout(10000, 'tools/list')]);
  result.toolCount = tools.tools.length;
  result.hasStatus = tools.tools.some(t => t.name === 'mastercam_status');
  result.hasPreview = tools.tools.some(t => t.name === 'preview_operation_parameters');

  const status = await Promise.race([
    client.callTool({ name: 'mastercam_status', arguments: {} }),
    timeout(10000, 'status')
  ]);
  result.status = status.structuredContent;

  const preview = await Promise.race([
    client.callTool({
      name: 'preview_operation_parameters',
      arguments: { operationId: 4, changes: { feedRate: { value: 42, unit: 'mm/min' } } }
    }),
    timeout(10000, 'preview')
  ]);
  const previewData = preview.structuredContent?.data;
  if (!previewData?.approvalToken) throw new Error('preview did not return approvalToken');
  result.preview = { hasToken: true };

  const apply = await Promise.race([
    client.callTool({
      name: 'apply_operation_parameter_preview',
      arguments: { approvalToken: previewData.approvalToken }
    }),
    timeout(10000, 'apply')
  ]);
  const applyData = apply.structuredContent?.data;
  if (!applyData?.applied || !applyData?.rollback?.transactionId) {
    throw new Error('apply did not return an applied result and rollback transaction');
  }
  result.apply = { applied: true, hasTransaction: true };

  const verify = await Promise.race([
    client.callTool({
      name: 'verify_change',
      arguments: { operationId: 4, expected: { feedRate: { value: 42, unit: 'mm/min' } } }
    }),
    timeout(10000, 'verify')
  ]);
  result.verify = { pass: verify.structuredContent?.data?.pass === true };
  if (!result.verify.pass) throw new Error('verify_change did not pass');

  const rollback = await Promise.race([
    client.callTool({
      name: 'rollback_change',
      arguments: { transactionId: applyData.rollback.transactionId }
    }),
    timeout(10000, 'rollback')
  ]);
  const rollbackData = rollback.structuredContent?.data;
  result.rollback = { restored: rollbackData?.restored?.feedRate?.value === 35 };
  if (!result.rollback.restored) throw new Error('rollback did not restore the original feed');

  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
