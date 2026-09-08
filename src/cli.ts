#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const command = process.argv[2] ?? "serve";
if (command === "serve") {
  await import("./server.js");
} else if (command === "install") {
  if (process.platform !== "win32") throw new Error("The Mastercam add in installer requires Windows");
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "install.ps1");
  if (!existsSync(script)) throw new Error(`Installer script was not included in this package: ${script}`);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...process.argv.slice(3)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
} else {
  console.error("Usage: mastercam-mcp [serve|install]");
  process.exit(2);
}
