# Shop floor workflows

## Setup sheets

Collect the active part, machine context, stock, WCS, operations, and tools. Pass those values to `generate_setup_sheet`. Treat the result as a draft until a responsible person approves the part revision and machine setup.

## Tool database comparison

Pass two parsed snapshots to `compare_tool_databases`. The operation is read only and returns hashes and changed line counts. Keep the original files untouched and require a checkout process before shared database edits.

## NC comparison

Pass the previous and new NC text to `compare_nc_files`. Review tool numbers, changed lines, added lines, removed lines, offsets, spindle commands, and rapid motion before releasing a program.

## Machine validation

Pass an operation and a machine profile to `validate_machine_profile`. A valid result means only that the declared values do not violate the declared limits. It does not certify a real machine, fixture, controller, tool, or material setup.

## Cross platform behavior

The setup sheet, comparison, validation, fixture, and protocol tests use portable Node APIs. Live Mastercam access remains Windows only because the NET Hook add in runs inside Mastercam. On macOS and Linux use the fixture backend, recorded responses, or exported text and JSON data.

## Path evidence

The standard Windows locations used by the installer are based on the Mastercam administrator guide and NET Hook examples. The project accepts a custom root so installations outside Program Files do not depend on guessed paths.
