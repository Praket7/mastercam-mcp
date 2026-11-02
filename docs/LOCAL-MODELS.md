# Using a smaller tool catalog with a local model

Mastercam MCP supplies tools. Your MCP client chooses the language model. Use a
client that can connect both to an MCP server and to your local model server.
The MCP server does not load a model or allocate its GPU memory.

A task-specific catalog gives a smaller local model fewer tool schemas to read.
An explicit allowlist selects the tools needed for the current task.

## Select the tools for a task

Set `MASTERCAM_MCP_TOOLS` to a comma-separated list of registered tool names in
the environment that starts the MCP server. Both stdio and HTTP use the setting.

For example, this PowerShell command selects a small catalog for file review and
thread calculations:

```powershell
$env:MASTERCAM_MCP_TOOLS = 'mastercam_help,discover_capabilities,analyze_nc_program,calculate_thread_tap'
node dist/cli.js serve
```

For a client that launches the server itself, add the variable to that server's
`env` configuration:

```json
{
  "MASTERCAM_MCP_TOOLS": "mastercam_help,discover_capabilities,analyze_nc_program,calculate_thread_tap"
}
```

Only selected tools appear in `tools/list` and receive tool-call handlers.
The help and discovery tools describe that same selected catalog. Include them
in the list if you want the model to use them. Selection preserves the canonical
tool order, and duplicate names do not register duplicate tools.

The setting is read at startup. Restart the server after changing it. With the
variable unset, the existing catalog is preserved. An explicitly empty value
selects zero tools. An unknown or unregistered name rejects server creation.
Wildcards are not supported.

Selection narrows the current backend's tools. It cannot expose an unavailable
native mapping, enable Stage-B reads, override the profile, or grant write
approval. Existing resources remain available; this setting controls tools, not
resource access. Internal dependencies of a selected tool still run as before.
Treat it as a context-size control, not a replacement for authorization.

## What to measure on an 8 GB GPU

An 8 GB GPU is the hardware target motivating this contribution. This patch
does not establish a minimum GPU requirement or a model compatibility claim.
Model weights, quantization, context length, runtime buffers, and display use
all affect fit.

Start with synthetic data and one supported deterministic task. Record:

- The model, quantization, inference runtime, context setting, and GPU.
- The selected tools and serialized `tools/list` size.
- Whether the model selects the right tool and supplies valid arguments.
- Time to the first useful result, failures, and peak memory.

Compare with the full catalog using the same prompt and inputs. A smaller
schema payload is a protocol-level result. Better latency, accuracy, and memory
use require measurements on the chosen model and hardware.

After building, run `node work/local-model-catalog.mjs` to compare the full
synthetic catalog with the four-tool example above over stdio. It prints tool
counts and UTF-8 bytes of the serialized tool arrays. This is not an inference
benchmark. The measurement uses the repository's development MCP client.

MCP transport tests use synthetic data. They do not prove local-model inference
or licensed live Mastercam behavior. Use the existing acceptance procedure for
the latter. For private work, also check your client's inference endpoint and
logging behavior; a local MCP server alone does not make the client offline.
