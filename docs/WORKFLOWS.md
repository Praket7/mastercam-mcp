# Safe workflows

## Fixture verification

The fixture mode is intended for contributors who do not have Mastercam. It exercises the MCP contract and safety flow with synthetic data.

```text
$env:MASTERCAM_MCP_BACKEND = "mock"
pnpm run build
pnpm test
node work\feature-smoke.mjs
```

The fixture marks geometry, kinematics, workholding, simulation, and collision information as synthetic. A passing fixture check proves the bridge contract only.

## Inspection

Use `discover_capabilities` first. Call `mastercam_doctor`, `get_active_part`, `list_operations`, `get_machine_context`, and `get_operation_risks`. Use `find_operations` before passing an operation ID to another tool.

## Safe editing

Call `preview_change` with the intended feed. Review the returned before and after values. Call `set_feed_speed` only with explicit confirmation. Call `regenerate_toolpath` for affected operations. Finish with `verify_change` and retain the receipt from `get_audit_history`.

## Live boundary

The native add in returns `UNSUPPORTED_CAPABILITY` for operation mappings that have not been validated against the installed Mastercam API. This is intentional. Live acceptance requires a licensed Windows Mastercam workstation and a matching release adapter.

## Compatibility evidence

Mastercam developer examples show that operation iteration and NET Hook assembly references are tied to the installed release. The installer therefore detects the installation path and the compatibility report keeps the detected version visible.
