import net from "node:net";
import { MockBackend } from "./backend.js";
const pipe = process.env.MASTERCAM_MCP_PIPE ?? "\\\\.\\pipe\\mastercam-mcp-default";
const backend = new MockBackend();
const server = net.createServer(socket => { socket.setEncoding("utf8"); let buffer = ""; socket.on("data", async chunk => { buffer += chunk; const line = buffer.split("\n")[0]; if (!line) return; buffer = buffer.slice(line.length + 1); try { const req = JSON.parse(line); socket.write(JSON.stringify({ id: req.id, result: await backend.call(req) }) + "\n"); } catch (e) { socket.write(JSON.stringify({ id: "unknown", result: { ok: false, error: { code: "BAD_REQUEST", message: String(e) } } }) + "\n"); } }); });
server.listen(pipe, () => console.error(`Mock Mastercam backend listening on ${pipe}`));
