import { spawn } from "node:child_process";
const env = { ...process.env, MASTERCAM_MCP_BACKEND: "mock", MASTERCAM_MCP_PROFILE: "core", MASTERCAM_MCP_HARD_READ_ONLY: "0", MASTERCAM_MCP_FIXTURE: "work/fixture.json" };
const child = spawn(process.execPath, ["dist/cli.js", "serve"], { env, stdio: ["pipe", "pipe", "inherit"] });
let buffer = ""; const pending = new Map(); let progressCount = 0; child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => { buffer += chunk; while (buffer.includes("\n")) { const i = buffer.indexOf("\n"); const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line) continue; const message = JSON.parse(line); if (message.method === "notifications/progress") progressCount++; if (message.id) pending.get(message.id)?.(message); } });
function call(id, method, params) { return new Promise(resolve => { pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }); }
const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: { }, clientInfo: { name: "feature-smoke", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
const list = await call(2, "tools/list", {});
const names = ["mastercam_doctor", "mastercam_help", "list_tool_categories", "mastercam_plan", "get_active_part", "get_geometry_summary", "get_selection", "list_operations", "find_operations", "inspect", "measure", "assert", "preview_change", "capture_view", "regenerate_toolpath", "run_simulation", "detect_collisions", "get_version_report", "client_setup_check", "get_audit_history", "rollback_change"];
const responses = {}; for (const [index, name] of names.entries()) responses[name] = await call(10 + index, "tools/call", { name, arguments: name === "assert" ? { path: "operation.feed", equals: 35 } : name === "preview_change" ? { feed: 42 } : name === "rollback_change" ? { beforeFeed: 35, confirmed: true } : name === "regenerate_toolpath" ? { operationId: 4, confirmed: true } : name === "find_operations" ? { query: "Facing" } : { operationId: 4 }, _meta: { progressToken: "feature-smoke" } });
const visual = JSON.parse(responses.capture_view.result.content[0].text); if (!visual.data?.image?.startsWith("data:image/svg+xml")) throw new Error("capture_view did not return a visual payload");
const assertion = JSON.parse(responses.assert.result.content[0].text); if (!assertion.ok || !assertion.data.pass) throw new Error("assert tool did not pass the fixture assertion");
if (progressCount === 0) throw new Error("progress notifications were not emitted");
const resources = await call(50, "resources/list", {});
const resourceRead = await call(51, "resources/read", { uri: "mastercam://operations" });
if (!resources.result?.resources?.length || !resourceRead.result?.contents?.length) throw new Error("MCP resources were not available");
console.log(JSON.stringify({ initialized: Boolean(init.result), toolCount: list.result.tools.length, resourceCount: resources.result.resources.length, progressCount, features: Object.fromEntries(names.map(name => [name, Boolean(responses[name]?.result)])) }, null, 2)); child.kill();
