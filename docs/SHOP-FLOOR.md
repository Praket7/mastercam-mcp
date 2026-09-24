# Shop floor workflows

These tools help gather job information before a programmer reviews a change. Their output is evidence for a person to check. It is not a machine approval.

## Prepare a setup note

Gather the part name, stock, machine, work offset, operations, and tools. Send that information to `generate_setup_sheet`. The result is a draft. Check the part revision and setup at the machine before using it.

## Check tool lists

Send two tool list files to `compare_tool_databases`. The result shows tools that changed or moved. The tool does not edit either file. Follow your shop's normal approval process before changing a shared tool list.

## Review two NC programs

Send the old and new program text to `compare_nc_files`. Read the changed lines. Pay close attention to tool numbers, offsets, spindle commands, feeds, and rapid moves.

`analyze_nc_program` can review a limited set of common straight moves and arcs. It cannot understand every controller command. It cannot replace Mastercam Verify or a machine simulation. Unknown motion must be checked in the correct CAM and machine tools.

## Check a machine profile

Send the operation data and declared machine limits to `validate_machine_profile`. The result checks the values you supplied. It cannot confirm that those values match the real machine, fixture, tool, or material.

## Build a tool or thread recommendation

Tool suggestions use the catalog supplied to the server. Confirm the tool, holder, insert, material, and cutting data with the source. Thread calculations need a confirmed callout or dimensions. They do not discover features inside a CAD model.

## Draft a turning plan

`plan_od_rough_finish` can organize a supplied outside diameter profile into a roughing and finishing proposal. The result is a review document. It does not create Mastercam operations or machine code.

## What a passing check means

Portable tests show that the software handled the supplied data as expected. They do not show that a licensed Mastercam session, post, controller, or physical machine will behave the same way. Use your established simulation and prove out process before cutting a part.
