# Job Intelligence Design

This document explains the design boundary behind the server-local manufacturing intelligence tools. The goal is to make the MCP useful for real CAM reasoning without pretending that a generic language model, a fixture backend, or an unverified native mapping can prove that a machine move is safe.

## Architecture

The workflow is intentionally split into four layers.

1. **Grounding**: consume actual shop evidence supplied by the caller: tool-library records, machine limits, material, operation tree, geometry/profile data, workholding bounds, NC/toolpath motion, and provenance.
2. **Deterministic analysis**: run hard compatibility filters, geometry/kinematics checks, cycle-time accounting, and engineering formulas before any generative planning.
3. **Proposal**: create recommendations, operator packets, or a non-executable process-plan preview with explicit assumptions and unknowns.
4. **Verification**: require release-specific regeneration, stock removal/collision simulation, machine-limit checks, and semantic NC/post regression before release.

No tool in this layer posts NC, transfers programs, starts a machine, or bypasses the existing preview/approval boundary.

## Tooling recommendations

`recommend_job_tooling` never invents a catalog entry. It ranks only the tools supplied to the call.

Hard filters are applied before scoring, including declared material compatibility, operation/feature compatibility, internal-feature diameter, depth/flute reach, minimum feature diameter, and supplied machine tool-size limits. Provenance and supplier/shop cutting recommendations improve evidence quality but do not override a hard incompatibility.

This follows the architecture direction in **Knowledge Graph Fusion with Large Language Models for Accurate, Explainable Manufacturing Process Planning** (arXiv/alphaXiv 2506.13026), which grounds tool and process decisions in structured manufacturing knowledge rather than allowing an LLM to free-associate feeds, speeds, or tooling.

Set `MASTERCAM_MCP_TOOL_LIBRARY` to a JSON inventory to supply actual tool records. The loader accepts the existing `mastercam-mcp/tool-library/v1` format and RobbJack's publisher/schema-versioned ISO 13399 bulk JSON envelope (`toolNbr`/`specs` records), including the [machine-readable v1.1 catalog](https://robbjack.com/downloads/master-catalog). That adapter is validated against RobbJack's published shape, not every possible vendor extension of ISO 13399. For example:

```json
{
  "schema": "mastercam-mcp/tool-library/v1",
  "units": "mm",
  "tools": [{
    "number": 12, "name": "CNMG rougher", "type": "turning insert",
    "insert": "CNMG 432", "grade": "P25", "diameter": 25,
    "materials": ["4140"], "operations": ["turning rough"],
    "holderStyle": "PCLNR", "machineLocation": "Turret station 4",
    "lengthOutOfHolder": { "value": 32, "unit": "mm" },
    "provenance": [{ "source": "shop export", "verified": true }]
  }]
}
```

The file is validated, limited to 10 MB and 20,000 tools, and merged with tool records referenced by active Mastercam operations. Referenced live values override matching catalog identity fields; catalog material/operation compatibility remains intact. ISO 13399 geometry/coatings are mapped only where present. Material compatibility, operations, and cutting parameters are not inferred when the source omits them. The public RobbJack v1.1 feed's manifest publishes a SHA-256 checksum and permits import into CAM/CAD/tool-management systems with attribution; it is not bundled here. Without a catalog or referenced live tools, the result explicitly says `NO_TOOL_DATA`. The adapter still does not read proprietary `.TOOLDB` files; native vendor catalog integrations remain the supported source for broader, continuously updated tooling. Live Mastercam mapping remains an unverified candidate until licensed acceptance.

Setup packets include holder style, tool location, stickout, flute/cutting length, workholding/setup references, provenance, and missing-data flags when those values are supplied. These fields reflect machinist requests in a [Reddit discussion about setup-sheet contents](https://www.reddit.com/r/Machinists/comments/1kmjxgm/what_do_your_set_up_sheets_look_like/); they are practical user feedback, not an industry standard.

## Toolpath risk review

`analyze_toolpath_risk` performs conservative checks over the supplied motion model:

- machine travel envelope violations
- declared feed and spindle limit violations
- rapid moves below a supplied safe-Z plane
- lateral/downward diagonal rapids near the machining region
- conservative swept envelopes expanded by tool/holder radius and safety margin
- supplied fixture and stock bounding-volume intersections
- optional tool-axis versus surface-normal approach-angle thresholds

The swept-volume idea is aligned with **Separation Logic for Verifying Physical Collisions of CNC Programs** (arXiv/alphaXiv 2605.10437), which models physical occupancy as a deterministic spatial resource and uses geometric expansion/safety margins before logical verification.

The implementation here is intentionally simpler than a full verifier. A straight segment is conservatively represented by an expanded axis-aligned swept box. Common G2/G3 arcs in G17/G18/G19 are chorded within a configured tolerance and checked as expanded segments; their analytical length is used for the movement-time estimate. Absolute/incremental center modes and G18 XZ/I-K ordering are modeled. P-word turn counts, conflicting radius/center formats, and inconsistent or unsupported arc definitions remain unknown. Chording and axis-aligned bounds are conservative approximations, not a swept-solid machine simulation. Plane/offset semantics follow the [LinuxCNC RS274/NGC documentation](https://linuxcnc.org/docs/2.8/html/gcode/g-code.html#sec:G2-G3-Arc).

`analyze_nc_program` is a bounded parser for common linear and planar arc G-code (`G0`–`G3`) with modal units, absolute/incremental positioning, feed, spindle, and common safety-state reporting. It can apply caller-supplied translation-only origins for G54–G59 before machine travel and fixture checks. If a transform is missing, machine-travel, stock, fixture, and safe-Z checks are skipped rather than run against untransformed coordinates. Rotated workplanes, missing offsets, canned cycles, macros, subprogram flow, rotary motion, and controller-specific behavior remain unknown or skipped. It cannot infer stock engagement, actual cutting versus air motion, approach angle, collisions hidden between samples, or machine acceleration. Treat its output as a review aid; retain release-specific post simulation and prove-out.

## Cycle-time and air-time analysis

`analyze_cycle_time` separates known time into cutting, air-feed, rapid, dwell, and tool-change buckets. It also reports commanded feed-motion time with unknown engagement separately as `unknownEngagementSeconds`; this time is not added to category-known time until cutting versus air motion is verified. It reports large non-cutting events as review opportunities and gives an upper bound on the listed non-cutting seconds.

It does **not** claim those seconds are safely removable. Research on machining airtime consistently treats retract/link optimization as a constrained path-planning problem rather than a simple speed-up. For example, work on minimizing machining airtime models non-productive positioning and retraction as an optimization problem, while machine-tool research emphasizes acceleration, jerk, positioning, collision, and setup constraints.

The NC parser cannot identify cutting engagement from G-code alone and therefore does not classify every feed move as cutting or air. This ceiling is consistent with published evidence that commanded-feed-only estimates can materially under-predict time when machine-axis acceleration and toolpath geometry are omitted ([Leal, 2022](https://doi.org/10.1016/j.rcim.2021.102293)). A [Reddit Mastercam timing request](https://www.reddit.com/r/CNC/comments/195hmjf/mastercam_toolpath_lenghttime/) also asked to expose toolpath length and estimated time; both are useful future operation-tree outputs once verified live fields exist.

## Setup and operation packets

`generate_operation_packet` creates a revision-ready Markdown packet from the supplied operation tree and tool records. It includes operation sequence, tool numbers, WCS/plane, feed, spindle, estimated cycle time, shop notes, tool provenance, dirty-toolpath IDs, and unresolved tool references.

This is documentation generation from known CAM state. It is not an inferred source of truth; missing values remain missing instead of being fabricated.

## Thread and tap calculations

`calculate_thread_tap` supports metric and Unified 60-degree thread geometry supplied directly or through callouts such as `M10x1.5` and `1/4-20 UNC`.

For cut taps it uses published tapping relationships for tap-drill sizing and synchronized feed. RPM/feed calculations follow standard relationships:

- metric RPM from cutting speed: `n = vc * 1000 / (pi * D)`
- metric tapping feed: `vf = pitch * n`
- inch RPM from surface speed: `n = SFM * 12 / (pi * D)`
- inch tapping feed: `IPM = RPM / TPI`

References used during implementation:

- Sandvik Coromant, *Threading formulas and definitions*: https://www.sandvik.coromant.com/en-gb/knowledge/machining-formulas-definitions/threading-formulas-definitions
- Guhring, *Tapping Formulas and Calculations*: https://guhring.com/media/support/Common-Formulas-For-Tapping.pdf
- Haas, *Machinist's CNC Reference Guide*: https://www.haascnc.com/content/dam/haascnc/en/service/reference/programming-workbooks/shop-notes---machinist's-cnc-reference-guide.pdf

Form taps are deliberately different: the tool refuses to invent a generic form-tap drill diameter because manufacturer, material, lubrication, and desired thread percentage materially change that recommendation.

Thread dimensions are calculated from a supplied callout or supplied dimensions. Automatic extraction of threads from native Mastercam part geometry is not implemented: the current live adapter does not expose mapped CAD feature geometry. A caller must provide a confirmed callout/dimension; do not treat a text prompt alone as measured geometry. Recent research on B-rep machining-feature recognition depends on analytic face-adjacency data and labeled training/validation evidence; a triangulated mesh reader alone cannot establish thread pitch, class, or tolerance. Mastercam's current public developer entry point requires access to its developer program and release-specific SDK; geometry extraction therefore needs licensed Windows acceptance against the target release and representative part files.

## Natural-language OD rough + finish planning

`plan_od_rough_finish` is a preview tool. It can use a supplied tool list, the configured shop/ISO 13399 catalog, and tools referenced by active operations. An MCP client can translate a request such as “make me a rough + finish toolpath for this OD profile” into a structured call containing:

- OD profile points
- stock diameter
- material
- actual shop tooling
- machine limits
- finish allowance
- an explicit or tool-library-backed roughing depth

The engine selects compatible roughing and finishing candidates only from the supplied tool library, calculates radial stock removal and rough-pass count, and returns a finish profile plus verification gates.

The result includes rough-pass profile offsets and a finish profile, but returns `executable: false`. The plan must still be mapped to the release-specific Mastercam API, regenerated against actual geometry, simulated for stock removal/collision, and post-regression reviewed before it can become production state. Generic G-code generation would not meet that bar: a controller/post, machine kinematics, stock, workholding, insert orientation, and licensed Mastercam mutation/posting APIs are not present in this environment.

Natural-language support is the MCP client's job: it should translate a request into the structured profile, stock, material, machine, and tool-library inputs above. The server does not interpret arbitrary prose into CAD geometry, and no post-ready toolpath is generated. Current research likewise places collision checking and machine constraints inside the actual planning loop; a language-model process-plan preview does not substitute for that work ([Zaragoza Chichell et al., 2024](https://doi.org/10.1016/j.cad.2024.103725); [alphaXiv CNC feedrate planning search](https://www.alphaxiv.org/abs/2606.12151)).

This separation is consistent with recent manufacturing-agent research such as **Design-to-Plan: A Large Language Model-Based Multi-Agent Framework for Manufacturing Process Planning from 3D CAD Models and 2D Engineering Drawings** (alphaXiv 2608.24039) and **Physics-Grounded Multi-Agent Architecture for Traceable, Risk-Aware Human-AI Decision Support in Manufacturing** (alphaXiv 2605.04003): language-model reasoning is most defensible when coupled to deterministic extraction, physics/process constraints, traceable evidence, and human verification.

## Native `.TOOLDB` loading boundary

Mastercam tool libraries are commonly distributed in `.TOOLDB` format. Historical Mastercam community material identifies SQLite internals and a `TlToolMill` table, but the current vendor documentation/API contract does not publish a stable schema. The repository has no representative licensed `.TOOLDB` fixture, and the schema can vary by release/library. The importer therefore remains operator-exported JSON plus tools proven referenced by active operations; parsing guessed column names would silently mis-map grades, inserts, units, or tool geometry. A production importer needs a versioned vendor schema/API or representative databases for each supported Mastercam release, read-only access, explicit field mapping, and acceptance against known tool records.

References: [Mastercam Third-Party Developers](https://www.mastercam.com/community/3rd-party-developers/), [NET-Hook documentation](https://nethookdocs.mastercam.com/), [historical TOOLDB format note](https://www.emastercam.com/forums/topic/82303-reading-tooldb-in-mastercam-x6-using-chooks). The community note is historical evidence only, not a current schema guarantee.

## Current live boundary

The manufacturing-intelligence tools remain server-local, but Mastercam 2027 now has an opt-in **Stage-B read candidate** that can populate part of their grounding context directly from the active operation graph.

With `MASTERCAM_MCP_ENABLE_STAGE_B_READS=1`, the native adapter runtime-probes the public `Mastercam.Support.SearchManager.GetOperations()` contract and builds one bounded, revisioned snapshot. The following live-read candidates are derived from that snapshot:

- `get_programming_context`
- `list_operations`
- `get_operation`
- `get_operation_parameters`
- `find_operations`
- `get_dirty_toolpaths`
- `get_toolpath_status`
- `list_tools`
- `get_tool`

The snapshot carries per-field mapping evidence and explicit unknowns. Exact operation tools fail closed unless unique numeric operation IDs are proven. Tool records are limited to tooling referenced by active operations, so `list_tools` is **not** a claim of complete `.TOOLDB` coverage.

Therefore:

- tooling recommendations can be grounded in referenced live-operation tools when those fields are present, but a complete shop library still requires a separately verified library mapping
- operation-tree data can now come from the opt-in 2027 Stage-B snapshot
- toolpath risk analysis still requires actual motion segments; operation metadata or dirty state is not motion verification
- cycle-time analysis still requires motion/event timing evidence
- stock, WCS/planes, active-part identity, and full toolpath motion remain explicit Stage-B unknowns today
- `plan_od_rough_finish` remains a non-executable process-plan preview and does not create Mastercam operations

Portable CI compiles and exercises the Stage-B reflection/derivation layer using synthetic Mastercam-shaped objects. That proves software behavior, not a licensed 2027 mapping. A real workstation must pass `acceptance --live`; its `stageBContextReady` result is tracked separately from full `liveReadReady`. Only after that evidence should any candidate move to `LIVE_READ_VERIFIED`.
