import { spawn } from 'node:child_process';
const node = process.execPath;
const env = { ...process.env, MASTERCAM_MCP_BACKEND: 'mock', MASTERCAM_MCP_HARD_READ_ONLY: '0', MASTERCAM_MCP_PROFILE: 'core' };
const child = spawn(node, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => { buffer += chunk; while (buffer.includes('\n')) { const i = buffer.indexOf('\n'); const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line) continue; const message = JSON.parse(line); if (message.id) pending.get(message.id)?.(message); } });
function call(id, method, params) { return new Promise(resolve => { pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); }
const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
const tools = await call(2, 'tools/list', {});
const status = await call(3, 'tools/call', { name: 'mastercam_status', arguments: {} });
const dry = await call(4, 'tools/call', { name: 'set_feed_speed', arguments: { operationId: 4, feed: 42, dryRun: true } });
const apply = await call(5, 'tools/call', { name: 'set_feed_speed', arguments: { operationId: 4, feed: 42, dryRun: false, confirmed: true } });
const reread = await call(6, 'tools/call', { name: 'get_operation', arguments: { operationId: 4 } });
const restore = await call(7, 'tools/call', { name: 'set_feed_speed', arguments: { operationId: 4, feed: 35, dryRun: false, confirmed: true } });
console.log(JSON.stringify({ initialized: Boolean(init.result), toolCount: tools.result.tools.length, hasStatus: tools.result.tools.some(t => t.name === 'mastercam_status'), status, dry, apply, reread, restore }, null, 2));
child.kill();
