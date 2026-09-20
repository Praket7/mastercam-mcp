# Safe workflows

## Fixture verification

The fixture mode is intended for contributors who do not have Mastercam. It exercises the MCP contract and safety flow with synthetic data.

```text
$env:MASTERCAM_MCP_BACKEND = "mock"
pnpm run build
pnpm test
node work/smoke.mjs
node work/http-smoke.mjs
```

The fixture marks geometry, kinematics, workholding, simulation, and collision information as synthetic. A passing fixture check proves the bridge contract only.

## Inspection

Use `discover_capabilities` first. Call `mastercam_doctor`, `get_active_part`, `list_operations`, `get_machine_context`, and `get_operation_risks`. Use `find_operations` before passing an operation ID to another tool.

## Safe editing

Mutations follow a fixed, server-verified pipeline. There is no direct write path:

1. `preview_operation_parameters` with explicit quantities `{ "feedRate": { "value": 250, "unit": "mm/min" } }`. The server returns a single-use `approvalToken`, the current document revision, and before/after hashes.
2. Review the preview with a human. An assistant saying "confirmed" is not approval; only the server-issued token is.
3. `apply_operation_parameter_preview` with the token. The server re-checks the document revision and the operation fingerprint and refuses with `STALE_PREVIEW` if anything changed (compare-and-swap).
4. A successful apply returns a receipt (`transactionId`, before/after state and hashes). The receipt, never a caller-supplied value, is what `rollback_change` consumes.
5. `verify_change` rereads the operation and compares it to the expected state.
6. `regenerate_toolpath` for the affected operation only.
7. `rollback_change` with the transaction ID restores the prior state and records a rollback receipt in the hash-chained audit log.

Every mutation requires an exact `operationId`; `OPERATION_NOT_FOUND` and `TARGET_REQUIRED` replace any fallback to the first operation.

## Live boundary

The native add in returns `UNSUPPORTED_CAPABILITY` for operation mappings that have not been validated against the installed Mastercam API. This is intentional. Live acceptance requires a licensed Windows Mastercam workstation and a matching release adapter.

## Compatibility evidence

Mastercam developer examples show that operation iteration and NET Hook assembly references are tied to the installed release. The installer therefore detects the installation path and the compatibility report keeps the detected version visible.
