import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = process.env.SMOKE_HTTP_PORT || '18990';
const URL = `http://127.0.0.1:${PORT}/mcp`;
const env = {
  ...process.env,
  MASTERCAM_MCP_BACKEND: 'mock',
  MASTERCAM_MCP_AUDIT: '0',
  MASTERCAM_MCP_PROFILE: 'all',
  MASTERCAM_MCP_HARD_READ_ONLY: '0',
  MASTERCAM_MCP_HTTP_PORT: String(PORT)
};

const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/http.ts'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });

const timeout = (ms, label) => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  timer.unref?.();
});

try {
  // Poll readiness with a deadline instead of a fixed sleep (audit section 46).
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < 20000) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) { ready = true; break; }
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`HTTP server never became ready: ${stderr.slice(-300)}`);

  const client = new Client({ name: 'http-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new globalThis.URL(URL));
  await Promise.race([client.connect(transport), timeout(15000, 'connect')]);

  const tools = await Promise.race([client.listTools(), timeout(10000, 'tools/list')]);
  const status = await Promise.race([client.callTool({ name: 'mastercam_status', arguments: {} }), timeout(10000, 'status')]);
  const capabilities = await Promise.race([client.callTool({ name: 'mastercam_capabilities', arguments: {} }), timeout(10000, 'capabilities')]);

  const result = {
    ok: true,
    ready: true,
    toolCount: tools.tools.length,
    hasStatus: tools.tools.some(tool => tool.name === 'mastercam_status'),
    statusOk: status.structuredContent?.ok === true,
    capabilitiesOk: capabilities.structuredContent?.ok === true
  };
  console.log(JSON.stringify(result, null, 2));
  const failures = [result.hasStatus, result.statusOk, result.capabilitiesOk, result.toolCount > 30].filter(value => !value).length;
  if (failures > 0) { process.exitCode = 1; }
  await client.close().catch(() => undefined);
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error), stderr: stderr.slice(-400) }, null, 2));
  process.exitCode = 1;
} finally {
  child.kill();
}
