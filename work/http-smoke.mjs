import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const PORT = process.env.SMOKE_HTTP_PORT || '18990';
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
const MAX_BODY_BYTES = 1024;
const env = {
  ...process.env,
  MASTERCAM_MCP_BACKEND: 'mock',
  MASTERCAM_MCP_AUDIT: '0',
  MASTERCAM_MCP_PROFILE: 'all',
  MASTERCAM_MCP_HARD_READ_ONLY: '0',
  MASTERCAM_MCP_HTTP_PORT: String(PORT),
  MASTERCAM_MCP_HTTP_MAX_BODY_BYTES: String(MAX_BODY_BYTES)
};

const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/http.ts'], {
  env,
  stdio: ['ignore', 'ignore', 'pipe']
});
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });

const timeout = (ms, label) => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  timer.unref?.();
});

function chunkedOverflowStatus() {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: Number(PORT),
      path: '/mcp',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      }
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.write('x'.repeat(700));
    req.write('y'.repeat(700));
    req.end();
  });
}

async function stopChild() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try {
    await Promise.race([once(child, 'exit'), timeout(3000, 'HTTP smoke child shutdown')]);
  } catch {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), timeout(3000, 'HTTP smoke child kill')]).catch(() => undefined);
  }
}

try {
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < 20000) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`HTTP server never became ready: ${stderr.slice(-300)}`);

  const client = new Client(
    { name: 'http-smoke', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  const transport = new StreamableHTTPClientTransport(new globalThis.URL(MCP_URL));
  await Promise.race([client.connect(transport), timeout(15000, 'connect')]);
  if (client.getProtocolEra() !== 'modern') {
    throw new Error(`Expected modern MCP era, got ${client.getProtocolEra()}`);
  }

  const tools = await Promise.race([client.listTools(), timeout(10000, 'tools/list')]);
  const status = await Promise.race([
    client.callTool({ name: 'mastercam_status', arguments: {} }),
    timeout(10000, 'status')
  ]);
  const capabilities = await Promise.race([
    client.callTool({ name: 'mastercam_capabilities', arguments: {} }),
    timeout(10000, 'capabilities')
  ]);
  await client.close().catch(() => undefined);

  const overflowStatus = await Promise.race([
    chunkedOverflowStatus(),
    timeout(10000, 'chunked body overflow')
  ]);

  const result = {
    ok: true,
    ready: true,
    protocolEra: client.getProtocolEra(),
    toolCount: tools.tools.length,
    hasStatus: tools.tools.some(tool => tool.name === 'mastercam_status'),
    statusOk: status.structuredContent?.ok === true,
    capabilitiesOk: capabilities.structuredContent?.ok === true,
    chunkedBodyLimitStatus: overflowStatus
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    !result.hasStatus ||
    !result.statusOk ||
    !result.capabilitiesOk ||
    result.toolCount <= 30 ||
    result.chunkedBodyLimitStatus !== 413
  ) {
    process.exitCode = 1;
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error), stderr: stderr.slice(-400) }, null, 2));
  process.exitCode = 1;
} finally {
  await stopChild();
}
