import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadShopToolLibrary, mergeActiveJobTools } from "../src/shop-tool-library.js";

test("loads an explicit shop tool inventory and overlays real active-job references without inventing specs", () => {
  const directory = mkdtempSync(join(tmpdir(), "mastercam-tool-library-"));
  try {
    const path = join(directory, "tools.json");
    writeFileSync(path, JSON.stringify({
      schema: "mastercam-mcp/tool-library/v1",
      units: "mm",
      tools: [{ number: 12, name: "CNMG rougher", insert: "CNMG 432", grade: "P25", materials: ["4140"], operations: ["turning rough"] }]
    }));
    const library = loadShopToolLibrary(path);
    assert.equal(library?.units, "mm");
    const merged = mergeActiveJobTools(library, [
      { number: 12, name: "Active job rougher", diameter: 25, insert: "CNMG 432" },
      { number: 18, name: "Unknown live tool", diameter: 12 }
    ]);
    assert.equal(merged?.tools.length, 2);
    assert.equal(merged?.tools[0]?.materials[0], "4140");
    assert.equal(merged?.tools[0]?.diameter, 25);
    assert.equal(merged?.tools[1]?.materials.length, 0);
    assert.equal(merged?.tools[1]?.provenance[0]?.verified, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
