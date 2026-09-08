# API evidence

This project records implementation evidence without redistributing protected Mastercam material.

Public evidence reviewed on 2026 09 08 indicates that NET Hook add ins use a `NetHook3App` entry point and return `MCamReturn.NoErrors` from `Run`. Public Mastercam material also documents local NET Script references to the installed `NETHook3_0.dll` for Mastercam 2026.

The live machine preflight for this checkout found no installed Mastercam executable or SDK assemblies. Therefore the adapter intentionally uses a local reflection catalog and a capability registry rather than inventing undocumented operation methods. A capability becomes supported only after local assembly inspection and a live acceptance test.

Sources

https://www.mastercam.com/community/3rd-party-developers/

https://nethookdocs.mastercam.com/

https://www.emastercam.com/forums/topic/79735-nethook-api-project-examples/
