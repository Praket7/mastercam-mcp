# Mastercam MCP full automation research and readiness

Date: 2026-09-23
Repository: `Praket7/mastercam-mcp`

## Result

**Not ready to claim all requested manufacturing automation.** This branch improves bounded NC review, makes write defaults fail closed, and adds a client-mediated operator approval step. It does not resolve four hard product gaps: supported `.TOOLDB` access, CAD-derived thread feature extraction, native Mastercam operation generation, or posting. No real Mastercam installation, current SDK, representative `.TOOLDB`, target part, machine/controller definition, or approved post was available for acceptance. A release claiming these features would be misleading and unsafe.

## Research findings

- Mastercam's [Third-Party Developers program](https://www.mastercam.com/community/3rd-party-developers/) is the supported developer entry point; current [NET-Hook docs](https://nethookdocs.mastercam.com/) are login-gated. The checked-out project only has an opt-in reflection-based Stage-B reader over operation state, not a proven CAD feature or tool-database API.
- Historical Mastercam community reports describe `.TOOLDB` as SQLite and identify a `TlToolMill` table, but this is old, release-specific community evidence, not a supported stable schema contract ([historical discussion](https://www.emastercam.com/forums/topic/82303-reading-tooldb-in-mastercam-x6-using-chooks)). Guessing field names without licensed sample files risks silently corrupting dimensions, units, insert, and grade mappings.
- A tool vendor describes `.TOOLDB` as closed/no published third-party specification, and recommends supported catalog integrations instead ([RobbJack Mastercam notes](https://robbjack.com/downloads/mastercam)). Mastercam-facing catalog paths exist: [MachiningCloud offers GTC Light or its importer](https://www.machiningcloud.com/mastercam/), while [ToolsUnited documents a native Mastercam import plugin](https://info.toolsunited.com/mastercam). Broad programmatic catalog retrieval is commercially licensed; [MachiningCloud API documentation is provided during licensing](https://www.machiningcloud.com/enterprise/).
- NIST's [PMI model verification guide](https://nvlpubs.nist.gov/nistpubs/ams/NIST.AMS.100-10.pdf) documents variation and representation limitations in CAD PMI. alphaXiv research on B-rep feature recognition (FeatureFox, [2604.26770](https://www.alphaxiv.org/abs/2604.26770)) relies on face-adjacency graphs and training/evaluation data. Mesh triangulation alone cannot establish thread pitch/class/tolerance or a validated machinable feature.
- Mastercam-specific output generation is release/post dependent. A historical [STEP-NC C-Hook example](https://github.com/steptools/mastercam-stepnc) explicitly requires a Mastercam SDK installation. Mastercam lists third-party verification products including [NC machine simulation](https://www.mastercam.com/solutions/third-party-add-ons/verification). These support the boundary that a generic G-code string generator is not a safe substitute for native toolpath generation, post regression, and simulation.
- Mastercam's current [CoroPlus Tool Library add-in](https://www.mastercam.com/community/blog/page/2/) is a supported route to vendor tooling inside the programmer's workflow. Current search results did not reveal a public `.TOOLDB` parser contract or an unrestricted vendor catalog API. The implemented ISO 13399 JSON adapter is the safe portable input path until a licensed source contract is available.
- Reddit machinists describe checking programs with Mastercam Verify, then carefully proving out code at the control. Another recent discussion is openly skeptical of machine code written by a language model. These are anecdotal reports. They reinforce that static text review must never be presented as simulation or authorization ([program testing discussion](https://www.reddit.com/r/Machinists/comments/y853jd/how_do_you_test_a_cnc_program/), [AI-generated G-code discussion](https://www.reddit.com/r/Machinists/comments/1p5o7fy/g_codes_from_ai/)).
- alphaXiv search also surfaced research on CNC physical collision verification ([2605.10437](https://www.alphaxiv.org/abs/2605.10437)) and orientation-aware feedrate planning ([2606.12151](https://www.alphaxiv.org/abs/2606.12151)). These are research directions, not production validations or a replacement for controller-specific machine simulation.

## Implemented in this change

- Common G2/G3 arcs in G17/G18/G19 are approximated to a configurable chord error, bounded per arc and for the total parsed path, with modal arc direction, G90.1/G91.1 center mode, center offsets, and signed radius handling. G18 axis order follows XZ/I-K. P-word multi-turn arcs fail closed as unknown.
- Chorded arc segments feed existing swept-bound, travel, fixture, spindle/feed checks. The analytical arc length feeds cycle-time movement length. Arc approximation tolerance is included in the global safety margin.
- Caller-supplied translation-only G54-G59 origins are applied before machine travel checks. Unknown/missing offsets and unsupported fractional WCS codes remain fail-closed; rotated coordinates, canned cycles, subprograms/macros, rotary motion, controller behavior, and actual stock-removal engagement stay unknown. This remains static review, not machine simulation or machining authorization.
- `MASTERCAM_MCP_HARD_READ_ONLY` now defaults to enabled in the schema, environment loader, shared policy helper, and diagnostics. Only the exact value `0` disables it. The write profile alone cannot enable writes.
- The MCP apply tool asks the client to collect operator approval for the exact preview. The prompt shows the before/after values, document revision, operation fingerprint, and expiry. A signed request state binds the response to that preview, expiry, and authenticated client or transport session. The backend checks the live document again. A token alone does not prove operator identity. The configured MCP client remains the trust boundary and must show the request to a human.
- Full suite (149 tests), ESLint, TypeScript typecheck, build, package dry-run, and a live-source ISO 13399 loading check passed locally. Integration tests cover catalog-backed OD tool selection, translated work-offset checks, default read-only behavior, refusal without client approval, and an accepted approval round trip. GitHub CI for the branch is green as of this update.

## Current distribution check

A fresh npm query on 23 September 2026 returned `mastercam-mcp@latest = 0.2.0`; `mastercam-mcp@0.3.0` returned E404. Do not use the npm quick start for this source revision. The authenticated publishing workflow still needs repair, then a clean install from the registry must be verified. A GitHub push or release cannot substitute for npm publication.

The current source branch has an open review at [PR 22](https://github.com/Praket7/mastercam-mcp/pull/22). It is not merged or a final release.

## Remaining hard blockers and evidence needed

1. **`.TOOLDB` catalog loading:** direct `.TOOLDB` parsing remains unimplemented because the current schema/API contract is not published. A read-only ISO 13399 bulk-catalog adapter now loads manufacturer-published JSON and merges active-job tool references; it was exercised against RobbJack's 7,110-record v1.1 feed (published SHA-256 `cd77d7a15f9f739e4cdb1cc2de2438009d431f8db93e3e8da9b3d715ee7d3a44`). That source is end mills/saws, not lathe inserts, and omits material-specific cutting conditions. Full turning-tool data still needs a licensed provider API or supported vendor feed plus current Mastercam records. Direct native import still needs official API/schema access and acceptance.
2. **CAD-derived threads:** provide licensed Windows Mastercam release/API and representative native part files with verified thread callouts/features; prove CAD feature extraction and thread-class/tolerance handling against known geometry. Otherwise callers must continue supplying dimensions/callouts.
3. **Executable rough/finish path:** provide target machine, control, kinematics, stock/chuck/jaw/work offsets, approved release-specific post, insert/holder data, sample OD parts, and licensed Mastercam SDK/runtime. Then generate native operations, regenerate, simulate stock/collision, post, and compare semantic NC output on a known acceptance suite. Current OD output is a non-executable plan preview.
4. **Comprehensive NC review:** translation-only G54-G59 is implemented when explicitly supplied, but define supported controller/post families and provide machine models, rotated WCS/rotary kinematics, canned-cycle/macro/subprogram semantics, compensation settings, and trusted simulation/prove-out references. Parser support must be controller-specific and tested against posted samples.

## Release decision

The branch is a reviewable security and analysis improvement. It is not a completed full-automation release. Do not publish a version claiming the requested features until the acceptance inputs above exist and corresponding licensed live tests pass. GitHub source can be pushed for review after local verification. Merging or publishing a final automation release would misrepresent readiness.

## Evidence that remains unavailable

No licensed Windows Mastercam workstation, current release SDK, representative native threaded part, operator-approved post, target machine model, or production tool database was supplied. Therefore this work cannot verify CAD feature extraction, native toolpath creation, posted program behavior, or collision-free machine simulation. These are external acceptance gates, not defects that can be closed with fixture tests or a generated demo.
