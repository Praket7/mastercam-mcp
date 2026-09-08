# ChatGPT web configuration

ChatGPT web requires an authenticated private MCP endpoint using Streamable HTTP. Run `npm run start:http` with `MASTERCAM_MCP_HTTP_TOKEN` set to a random secret. The listener binds to localhost by default. The application validates Host and Origin before the SDK transport handles a request. If a private development tunnel is used, configure `MASTERCAM_MCP_ALLOWED_ORIGINS` and keep the tunnel pointed only at this external listener. Never tunnel the named pipe or the add in.

The required live verification is to list operations in the active part, run a feed change dry run, apply a controlled change with confirmation, reread it, and restore the original value. It remains unverified in this checkout because no live Mastercam installation was present.
