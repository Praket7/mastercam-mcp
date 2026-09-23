# API evidence

This project records implementation evidence without redistributing proprietary Mastercam SDK material.

## What public evidence establishes

Public Mastercam NET-Hook examples establish the `NetHook3App` entry model and the use of installed NET-Hook assemblies. A public setup-sheet example calls:

`Mastercam.Support.SearchManager.GetOperations().Any()`

That exact call is enough evidence to treat **operation enumeration** as a discovered API surface. It is not evidence for a stable cross-version serialization contract for every operation field, full tool-library access, stock, WCS/planes, tool motion, cycle time, regeneration state, or mutation methods.

The public example used as the primary operation-enumeration evidence is the SetupSheetXML NET-Hook project. Historical CNC Software staff examples and eMastercam discussions also show NET-Hook operation/toolpath automation and tool-database access, but those examples span older releases and are not treated as proof of the Mastercam 2027 shape.

## Mastercam 2027 Stage-B reader

The 2027 adapter now contains an **opt-in read-only Stage-B candidate**. It is disabled by default and enabled only when:

```text
MASTERCAM_MCP_ENABLE_STAGE_B_READS=1
```

is present in the Mastercam/add-in environment.

The reader:

1. probes the loaded AppDomain for the exact `Mastercam.Support.SearchManager` type
2. verifies a public static zero-argument `GetOperations()` method exists
3. invokes only that evidenced enumeration contract
4. maps returned operation objects through a bounded allowlist of candidate field names
5. serializes only primitives and small quantity-like `{ value, unit }` records
6. catches individual vendor getter failures instead of walking arbitrary object graphs
7. computes a deterministic revision for the resulting snapshot
8. refuses identity-dependent reads unless every operation has a unique numeric identifier
9. records the actual member names used as mapping evidence
10. preserves missing values as unknown instead of inventing defaults

A 250 ms native snapshot cache lets related MCP reads share coherent state and avoids repeatedly walking the Mastercam API.

The Stage-B snapshot currently supports these native read candidates:

- `get_programming_context`
- `list_operations`
- `get_operation`
- `get_operation_parameters`
- `find_operations`
- `get_dirty_toolpaths`
- `get_toolpath_status`
- `list_tools`
- `get_tool`

The tool reads are intentionally scoped to **tools referenced by active operations**. They do not claim that the complete Mastercam tool database or every `.TOOLDB` record has been extracted. Raw `.TOOLDB` parsing is deliberately not used as the production integration boundary because the format is release-sensitive and lacks a stable public vendor-write contract.

Active-part identity, stock, WCS/planes, full toolpath motion, and machine simulation are still explicit unknowns in this Stage-B snapshot until their 2027 API members are identified and accepted.

## Local API catalog

The local API catalog now discovers every installed `NETHook*.dll` rather than only the older `NETHook3_0.dll`. That includes the `NETHook10_0.dll` family used by the Mastercam 2027 add-in when present.

The catalog records assembly hashes, versions, public types/properties/methods, loader exceptions, and the presence of the Stage-B operation contract. Proprietary assemblies remain local. Catalog output is discovery evidence only and never promotes a capability to `LIVE_READ_VERIFIED`.

## Promotion rule

A native capability moves to a live-verified tier only when all of the following are true:

1. the matching Mastercam SDK/API member is identified for that release family
2. units and target identity are explicit
3. the adapter compiles against the intended Mastercam assemblies
4. a licensed live acceptance run proves the read or mutation behavior
5. the capability report and generated documentation are updated from the canonical manifest

Portable CI, reflection tests, fixture success, and a successful API probe establish implementation quality. They do **not** substitute for a licensed Mastercam 2027 acceptance run.

The acceptance report now exposes `stageBContextReady` separately from full `liveReadReady`. Stage-B context readiness can pass when the operation/tool snapshot works even while active part, stock, or WCS remain unmapped.

## Public references

- Mastercam third-party developer resources: https://www.mastercam.com/community/3rd-party-developers/
- Mastercam NET-Hook documentation portal: https://nethookdocs.mastercam.com/
- eMastercam NET-Hook development forum: https://www.emastercam.com/forums/forum/10-mastercam-c-hook-net-hook-and-vbscript-development/
- Public SetupSheetXML example using `SearchManager.GetOperations()`: https://github.com/Predatorie/SetupSheetXML
