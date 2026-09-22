import { writeFileSync } from "node:fs";
import { renderCapabilitiesDoc } from "../src/capabilities.js";

writeFileSync(new URL("../docs/CAPABILITIES.md", import.meta.url), renderCapabilitiesDoc());
console.log("docs/CAPABILITIES.md regenerated from src/capabilities.ts");
