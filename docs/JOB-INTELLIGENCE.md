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

The implementation here is intentionally simpler than a full verifier. A straight segment is conservatively represented by an expanded axis-aligned swept box. Arc moves are marked unknown unless the caller pre-segments the arc. This prevents an endpoint-only check from being mislabeled as complete arc or multi-axis verification.

## Cycle-time and air-time analysis

`analyze_cycle_time` separates known time into cutting, air-feed, rapid, dwell, and tool-change buckets. It reports large non-cutting events as review opportunities and gives an upper bound on the listed non-cutting seconds.

It does **not** claim those seconds are safely removable. Research on machining airtime consistently treats retract/link optimization as a constrained path-planning problem rather than a simple speed-up. For example, work on minimizing machining airtime models non-productive positioning and retraction as an optimization problem, while machine-tool research emphasizes acceleration, jerk, positioning, collision, and setup constraints.

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

## Natural-language OD rough + finish planning

`plan_od_rough_finish` is a preview tool. An MCP client can translate a request such as “make me a rough + finish toolpath for this OD profile” into a structured call containing:

- OD profile points
- stock diameter
- material
- actual shop tooling
- machine limits
- finish allowance
- an explicit or tool-library-backed roughing depth

The engine selects compatible roughing and finishing candidates only from the supplied tool library, calculates radial stock removal and rough-pass count, and returns a finish profile plus verification gates.

It returns `executable: false`. The plan must still be mapped to the release-specific Mastercam API, regenerated against actual geometry, simulated for stock removal/collision, and post-regression reviewed before it can become production state.

This separation is consistent with recent manufacturing-agent research such as **Design-to-Plan: A Large Language Model-Based Multi-Agent Framework for Manufacturing Process Planning from 3D CAD Models and 2D Engineering Drawings** (alphaXiv 2608.24039) and **Physics-Grounded Multi-Agent Architecture for Traceable, Risk-Aware Human-AI Decision Support in Manufacturing** (alphaXiv 2605.04003): language-model reasoning is most defensible when coupled to deterministic extraction, physics/process constraints, traceable evidence, and human verification.

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
