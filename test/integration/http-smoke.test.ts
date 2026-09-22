import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const tsx = "node_modules/tsx/dist/cli.mjs";
const PORT = 18987;
const SERVER_URL = `http://127.0.0.1:${PORT}/mcp`;

test("streamable http end to end: init, tools, 403 origin, health", async () => {
  const child = spawn(process.execPath, [tsx, "src/http.ts"], {
    env: {
      ...process.env,
      MASTERCAM_MCP_BACKEND: "mock",
      MASTERCAM_MCP_AUDIT: "0",
      MASTERCAM_MCP_PROFILE: "all",
      MASTERCAM_MCP_HARD_READ_ONLY: "0",
      MASTERCAM_MCP_HTTP_PORT: String(PORT)
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    // Poll readiness instead of a fixed sleep (audit section 46).
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 15_000) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/health`);
        if (response.ok) { ready = true; break; }
      } catch { /* not listening yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`HTTP server never became ready: ${stderr}`);

    const transport = new StreamableHTTPClientTransport(new globalThis.URL(SERVER_URL));
    const client = new Client(\n      { name: "http-smoke", version: "1.0" },\n      { versionNegotiation: { mode: { pin: "2026-07-28" } } }\n    );
    await client.connect(transport);\n    assert.equal(client.getProtocolEra(), "modern");\n    const tools = await client.listTools();
    assert.ok(tools.tools.length >= 40, `expected full tool registry, got ${tools.tools.length}`);
    const status = await client.callTool({ name: "mastercam_status", arguments: {} }) as any;
    assert.equal(status.structuredContent.ok, true);
    await client.close();

    // Invalid Origin must be rejected with 403 over the wire (HTTP-01).
    const originResponse = await fetch(SERVER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "evil", version: "1" } } })
    });
    assert.equal(originResponse.status, 403);

    // Health endpoint stays open for readiness probes.
    const health = await fetch(`http://127.0.0.1:${PORT}/health`);\n    assert.equal(health.status, 200);\n    const healthBody = await health.json() as { protocol?: string };\n    assert.equal(healthBody.protocol, "2026-07-28");\n\n    // The v2 server keeps an intentional stateless legacy fallback for older clients.\n    const legacy = await fetch(SERVER_URL, {\n      method: "POST",\n      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },\n      body: JSON.stringify({\n        jsonrpc: "2.0",\n        id: 2,\n        method: "initialize",\n        params: {\n          protocolVersion: "2025-06-18",\n          capabilities: {},\n          clientInfo: { name: "legacy-smoke", version: "1" }\n        }\n      })\n    });\n    assert.equal(legacy.status, 200);
  } finally {
    child.kill();
  }
});
