# Using a smaller tool catalog with a local model

Mastercam MCP supplies tools. Your MCP client chooses the language model. Use a
client that can connect both to an MCP server and to your local model server.
The MCP server does not load a model or allocate its GPU memory.

A compact catalog is the default and gives local models fewer schemas to read.
Set a tool preset or an explicit allowlist for a smaller task-specific set.

## Select the tools for a task

The default is `MASTERCAM_MCP_TOOLSET=compact`. Set it to `full` to expose
specialist workflows. Both stdio and HTTP use this setting.

For example, this PowerShell command selects a small catalog for file review and
thread calculations:

```powershell
$env:MASTERCAM_MCP_TOOLSET = 'compact'
$env:MASTERCAM_MCP_TOOLS = 'get_server_readiness,get_job_context,analyze_nc_program,calculate_thread_tap'
node dist/cli.js serve
```

For a client that launches the server itself, add the variable to that server's
`env` configuration:

```json
{
  "MASTERCAM_MCP_TOOLSET": "compact",
  "MASTERCAM_MCP_TOOLS": "get_server_readiness,get_job_context,analyze_nc_program,calculate_thread_tap"
}
```

Only selected tools appear in `tools/list` and receive tool-call handlers.
The allowlist takes precedence over the preset, preserves canonical order, and
ignores duplicate names.

Settings are read at startup. Restart the server after changing them. An
explicitly empty allowlist selects zero tools. Unknown or unregistered names
reject server creation. Wildcards are not supported.

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

Compare compact, full, and selected catalogs with the same prompt and inputs. A
smaller schema payload is a protocol-level result. Better latency, accuracy,
and memory use require measurements on the chosen model and hardware.

After building, run `node work/local-model-catalog.mjs` to compare the compact,
full, and four-tool catalogs over stdio. It prints tool counts and UTF-8 bytes
of the serialized tool arrays. This is not an inference benchmark. The
measurement uses the repository's development MCP client.

MCP transport tests use synthetic data. They do not prove local-model inference
or licensed live Mastercam behavior. Use the existing acceptance procedure for
the latter. For private work, also check your client's inference endpoint and
logging behavior; a local MCP server alone does not make the client offline.
