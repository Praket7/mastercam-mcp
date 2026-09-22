# API evidence

This project records implementation evidence without redistributing proprietary Mastercam SDK material.

## What public evidence establishes

Public Mastercam NET-Hook examples establish the `NetHook3App` entry model and the use of installed NET-Hook assemblies. A public setup-sheet example also calls:

`Mastercam.Support.SearchManager.GetOperations().Any()`

That is enough evidence to treat operation enumeration as a discovered API surface. It is **not** enough evidence to safely define a cross-version serialization contract for operation ids, names, feed/spindle quantities, tools, stock, planes, regeneration state, or mutation methods across Mastercam 2024 through 2027.

For that reason the native adapters currently expose only `mastercam_status` and `mastercam_capabilities`. The richer operation workflow remains fixture/portable until a release-specific adapter is built from the licensed SDK and passes live acceptance.

## Promotion rule

A native capability moves from unavailable to implemented only when all of the following are true:

1. the matching Mastercam SDK/API member is identified for that release family
2. units and target identity are explicit
3. the adapter compiles against the intended Mastercam assemblies
4. a licensed live acceptance run proves the read or mutation behavior
5. the capability report and generated documentation are updated from the canonical manifest

Mock or fixture success alone never promotes a live capability.

## Public references

- Mastercam third-party developer resources: https://www.mastercam.com/community/3rd-party-developers/
- Mastercam NET-Hook documentation portal: https://nethookdocs.mastercam.com/
- eMastercam NET-Hook development forum: https://www.emastercam.com/forums/forum/10-mastercam-c-hook-net-hook-and-vbscript-development/
- Public SetupSheetXML example using `SearchManager.GetOperations()`: https://github.com/Predatorie/SetupSheetXML
