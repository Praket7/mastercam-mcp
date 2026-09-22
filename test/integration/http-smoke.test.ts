import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const tsx = "node_modules/tsx/dist/cli.mjs";
const PORT = 18987;
const SERVER_URL = `http://127.0.0.1:${PORT}/mcp`;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    })
  ]);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await Promise.race([
      new Promise<void>(resolve => child.once("exit", () => resolve())),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 3000);
        timer.unref?.();
      })
    ]);
  }

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  child.stderr?.removeAllListeners();
  child.stderr?.destroy();
  child.unref();
}

test("streamable http serves 2026-07-28 and keeps stateless legacy fallback", async () => {
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
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;
  try {
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 15_000) {
      try {
        const response = await withTimeout(
          fetch(`http://127.0.0.1:${PORT}/health`),
          2000,
          "health probe"
        );
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // not listening yet
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`HTTP server never became ready: ${stderr}`);

    transport = new StreamableHTTPClientTransport(new URL(SERVER_URL));
    client = new Client(
      { name: "http-smoke", version: "1.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await withTimeout(client.connect(transport), 15_000, "HTTP MCP connect");
    assert.equal(client.getProtocolEra(), "modern");

    const tools = await withTimeout(client.listTools(), 10_000, "HTTP tools/list");
    assert.ok(tools.tools.length >= 40, `expected full tool registry, got ${tools.tools.length}`);
    const status = await withTimeout(
      client.callTool({ name: "mastercam_status", arguments: {} }),
      10_000,
      "HTTP mastercam_status"
    );
    assert.equal((status.structuredContent as { ok?: boolean } | undefined)?.ok, true);

    const originResponse = await withTimeout(fetch(SERVER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "evil", version: "1" }
        }
      })
    }), 10_000, "invalid-origin request");
    assert.equal(originResponse.status, 403);

    const health = await withTimeout(
      fetch(`http://127.0.0.1:${PORT}/health`),
      10_000,
      "health request"
    );
    assert.equal(health.status, 200);
    const healthBody = await health.json() as { protocol?: string };
    assert.equal(healthBody.protocol, "2026-07-28");

    const legacy = await withTimeout(fetch(SERVER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-smoke", version: "1" }
        }
      })
    }), 10_000, "legacy fallback request");
    assert.equal(legacy.status, 200);
  } finally {
    if (client) {
      await withTimeout(client.close(), 5000, "HTTP MCP client close").catch(() => undefined);
    }
    if (transport) {
      await withTimeout(transport.close(), 5000, "HTTP transport close").catch(() => undefined);
    }
    await stopChild(child);
  }
});
