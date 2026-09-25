# Safe workflows

## Fixture verification

Fixture mode is for contributors who do not have Mastercam. It exercises the MCP contract and safety flow with synthetic data.

```text
$env:MASTERCAM_MCP_BACKEND = "mock"
pnpm run build
pnpm test
pnpm run smoke
pnpm run smoke:http
```

The fixture marks geometry, kinematics, workholding, simulation, and collision information as synthetic. A passing fixture check proves the portable contract only. It does not establish live Mastercam readiness.

## Inspection

Use `discover_capabilities` first. Call `mastercam_doctor`, then inspect the active part and the capabilities actually advertised by the connected backend. In fixture mode, useful reads include `get_active_part`, `list_operations`, `get_machine_context`, `get_operation_risks`, and `find_operations` before passing an exact operation ID to another tool.

On a live Stage-A adapter, only `mastercam_status` and `mastercam_capabilities` are currently mapped. Other live inspection calls remain unavailable until release-specific SDK mappings pass licensed acceptance.

## Safe parameter editing

The public parameter mutation path is deliberately narrow:

1. Inspect the exact operation and current values.
2. Call `preview_operation_parameters` with an explicit `operationId` and unit-bearing feed and/or spindle quantity.
3. Review the returned before/after values, risks, document revision, operation fingerprint, expiration, and server-minted `approvalToken`.
4. Call `apply_operation_parameter_preview` with that `approvalToken`. The server asks the MCP client to present the exact proposed change to its operator. The operator must approve through the client's elicitation flow. A token by itself is not approval. Clients without that flow fail closed.
5. The server rejects stale, expired, reused, or mismatched approvals when it checks the current document.
6. Call `verify_change` to reread the operation and compare the expected unit-bearing values.
7. Keep the returned transaction/rollback receipt. If the change must be reversed and the state has not diverged, call `rollback_change` with the server-issued transaction identifier.

There is no direct `set_feed_speed` tool. `change_tool` and `update_stock` are also withheld until they have equivalent preview/approval workflows and verified backends.

## Regeneration boundary

`regenerate_toolpath` is currently not registered as an MCP tool. Regeneration mutates CAM state and previously accepted operation IDs without being bound to the exact approved parameter transaction. Until transaction-bound regeneration is implemented and verified, regenerate manually in Mastercam when a parameter change requires it.

## Live acceptance

Run the live acceptance harness only on a licensed Windows Mastercam workstation with the matching release adapter loaded:

```text
node dist/cli.js acceptance --live
```

The command exits nonzero until the required live inspection mappings pass. Write readiness is evaluated separately on a disposable test part with `--allow-writes`; fixture success never promotes a live capability.

## Live boundary

The native add in returns `UNSUPPORTED_CAPABILITY` for operation mappings that have not been validated against the installed Mastercam API. This is intentional. The current Legacy and 2027 adapters are Stage A environment bridges, not proof that the broader fixture workflow works live.

## Compatibility evidence

Public Mastercam developer examples establish NET-Hook entry points and at least basic operation enumeration, but many operation properties and mutation APIs are release-specific and documented through the installed/licensed SDK. The installer therefore detects the installation path and release, while the compatibility and acceptance reports keep unsupported mappings explicit rather than guessing.
