import fs from "node:fs";
import path from "node:path";
const roots = process.argv.slice(2);
if (!roots.length) { console.error("Usage: npm run catalog -- <Mastercam install root>"); process.exit(2); }
const wanted = ["NETHook3_0.dll", "ToolNetApi.dll", "SimAccessManaged.dll"];
const files: string[] = [];
for (const root of roots) for (const file of wanted) { const full = path.join(root, file); if (fs.existsSync(full)) files.push(full); }
const output = { generatedAt: new Date().toISOString(), proprietaryFilesRemainLocal: true, assemblies: files.map(file => ({ file: path.basename(file), path: file })) };
const out = process.env.MASTERCAM_API_INDEX_DIR ?? path.join(process.env.LOCALAPPDATA ?? ".", "mastercam-mcp", "api-indexes");
fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(output, null, 2)); console.log(`Wrote local catalog to ${out}`);
