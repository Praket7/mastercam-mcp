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

test("maps publisher ISO 13399 tool records without inventing cutting data", () => {
  const directory = mkdtempSync(join(tmpdir(), "mastercam-iso-catalog-"));
  try {
    const path = join(directory, "catalog.json");
    const catalog = {
      schemaVersion: "1.1",
      publisher: "Test Toolmaker",
      generated: "2026-09-23",
      toolCount: 1,
      tools: [{
        toolNbr: "EM-10",
        name: "10 mm end mill",
        url: "https://example.com/tools/EM-10",
        toolTypes: ["End Mill"],
        coatings: ["TiAlN"],
        specs: { DC: { in: 0.3937, mm: 10 }, APMX: { in: 0.7874, mm: 20 }, OAL: { in: 2.95, mm: 75 }, NOF: 4 }
      }]
    };
    writeFileSync(path, JSON.stringify(catalog));
    const library = loadShopToolLibrary(path);
    const tool = library?.tools[0];
    assert.equal(library?.units, "mm");
    assert.equal(tool?.diameter, 10);
    assert.equal(tool?.fluteLength, 20);
    assert.equal(tool?.overallLength, 75);
    assert.equal(tool?.coating, "TiAlN");
    assert.equal(tool?.recommended, undefined, "publisher feed has no cutting parameters, so none are fabricated");
    assert.equal(tool?.materials.length, 0, "material compatibility is not inferred from tool geometry");
    assert.match(tool?.provenance[0]?.source ?? "", /ISO 13399 catalog v1.1/);
    writeFileSync(path, JSON.stringify({ ...catalog, toolCount: 2 }));
    assert.throws(() => loadShopToolLibrary(path), /toolCount/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
