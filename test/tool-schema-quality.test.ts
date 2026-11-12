import test from "node:test";
import assert from "node:assert/strict";
import * as z from "zod/v4";
import { TOOL_DEFINITIONS, ToolEnvelopeSchema } from "../src/mcp/registry.js";

function undocumentedProperties(schema: unknown, toolName: string): string[] {
  const missing: string[] = [];
  const visited = new Set<object>();

  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    const node = value as Record<string, unknown>;

    if (node.properties && typeof node.properties === "object") {
      for (const [name, propertySchema] of Object.entries(node.properties)) {
        const property = propertySchema as Record<string, unknown>;
        if (typeof property.description !== "string" || property.description.trim().length === 0) {
          missing.push(`${toolName}.${path}${name}`);
        }
        visit(propertySchema, `${path}${name}.`);
      }
    }
    if (node.items) visit(node.items, `${path}[].`);
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      visit(node.additionalProperties, `${path}{value}.`);
    }
    for (const key of ["anyOf", "oneOf", "allOf", "$defs"]) {
      const children = node[key];
      if (Array.isArray(children)) children.forEach((child, index) => visit(child, `${path}${key}[${index}].`));
      else if (children && typeof children === "object") {
        for (const [name, child] of Object.entries(children)) visit(child, `${path}${key}.${name}.`);
      }
    }
  };

  visit(schema, "");
  return missing;
}

test("every registered tool input field has a useful schema description", () => {
  const missing = TOOL_DEFINITIONS.flatMap(definition =>
    undocumentedProperties(z.toJSONSchema(definition.inputSchema, { unrepresentable: "any" }), definition.name)
  );
  assert.deepEqual(missing, [], `Undocumented MCP input fields:\n${missing.join("\n")}`);
});

test("shared response fields explain their meaning to MCP clients", () => {
  const missing = undocumentedProperties(z.toJSONSchema(ToolEnvelopeSchema), "response");
  assert.deepEqual(missing, [], `Undocumented response fields: ${missing.join(", ")}`);
});

test("tool purposes describe when to use the tool and meaningful limits", () => {
  const tooBrief = TOOL_DEFINITIONS
    .filter(definition => definition.description.trim().split(/\s+/).length < 12)
    .map(definition => definition.name);
  assert.deepEqual(tooBrief, [], `Tool descriptions need clearer use guidance: ${tooBrief.join(", ")}`);
});

test("registered tool names use one unique snake_case verb_noun pattern", () => {
  const names = TOOL_DEFINITIONS.map(definition => definition.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  const inconsistent = names.filter(name => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name));
  assert.ok(names.length <= 40, `Tool catalog grew beyond its reviewed limit: ${names.length}`);
  assert.deepEqual(duplicates, [], "The MCP catalog must not advertise aliases or duplicate names.");
  assert.deepEqual(inconsistent, [], `Tool names must use snake_case verb_noun names: ${inconsistent.join(", ")}`);
});
