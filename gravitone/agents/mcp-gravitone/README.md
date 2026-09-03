# mcp-gravitone

A stdio MCP server that exposes **exactly** the tools one Gravitone API key's
capability manifest declares. Zero dependencies, one `node` process.

The toolbox is not written here. On start the bridge fetches
`GET /api/keys/{id}/manifest` from a Gravitone studio, and every tool it offers
comes from that document: a scope the key does not hold has no tool, so the
key's scopes are the agent's real boundary rather than a policy the agent is
asked to respect. A revoked key exposes nothing and says so at handshake.

## Configure

| Variable | Required | What it is |
|---|---|---|
| `GRAVITONE_API_KEY` | yes | The key's secret. Presented as `xi-api-key` on every call. |
| `GRAVITONE_KEY_ID` | yes | Which key's manifest to read. |
| `GRAVITONE_STUDIO_URL` | no | Where the manifest lives (the studio). Default `http://127.0.0.1:3000`. |
| `GRAVITONE_URL` | no | Overrides the service base URL the manifest names — for when the studio reports a loopback address only it can reach. |

The studio's keys page generates a filled-in config block: mint or open a key,
then **agent config** (ledger row) or the **agents** tab in the reveal.

```json
{
  "mcpServers": {
    "gravitone": {
      "command": "node",
      "args": ["agents/mcp-gravitone/server.mjs"],
      "env": {
        "GRAVITONE_STUDIO_URL": "http://127.0.0.1:3000",
        "GRAVITONE_KEY_ID": "abc123",
        "GRAVITONE_URL": "https://voice.example.com",
        "GRAVITONE_API_KEY": "${GRAVITONE_API_KEY}"
      }
    }
  }
}
```

`GRAVITONE_API_KEY` is a **reference** on purpose — an agent config is a file,
and files get committed. Export the secret in the shell that launches the
client. The bridge refuses to start if it is handed the literal placeholder,
because a placeholder produces 401s that look like a broken deployment.

## Test

```
cd agents/mcp-gravitone && node --test
```

No live service and no network: the manifest fetch and every tool call take an
injected `fetchImpl`.

## What it deliberately does not do

* **No built-in tool list.** A capability added to the studio's table is
  callable here without a code change; one removed disappears.
* **No silent success.** An upstream 401/403/429 comes back as an MCP error
  result carrying the service's own detail, never an empty result.
* **Nothing on stdout but protocol.** Diagnostics go to stderr — one stray
  `console.log` would corrupt the JSON-RPC stream.
