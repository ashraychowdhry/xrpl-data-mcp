# XRPL MCP Server

MCP server for LOS, VHS (`data.xrpl.org`), XRPL public JSON-RPC, and XRPLMeta.

## New agent-first composite tools

- `network_overview`
- `ledger_summary`
- `tx_explain`
- `account_overview`
- `token_overview`
- `market_snapshot`
- `amm_overview`
- `validator_set_overview`
- `validator_health`
- `amendment_status`
- `search_transactions`
- `resolve_entities`

All of these return a consistent envelope:

```json
{
  "data": {},
  "sources": [{ "system": "LOS|VHS|rippled|XRPLMeta", "method": "...", "at": "..." }],
  "freshness": { "asOfLedger": 0, "asOfTime": "..." },
  "warnings": []
}
```

## Existing low-level tools still included

- LOS: `los_get_token`, `los_batch_get_tokens`, `los_get_trusted_tokens`, `los_get_transactions`
  - `los_batch_get_tokens` input: `{ "tokenIds": ["<currencyHex.issuer>", "..."] }`
- VHS: `vh_*` tools + `validator_history_get`
- XRPL RPC: `xrpl_*` tools + `xrpl_public_api_call`
- XRPLMeta passthrough: `xrplmeta_get`

## Setup

```bash
npm install
npm start
```

## Environment variables

- `LOS_BASE_URL` (default: `https://los.prod.ripplex.io`)
- `DATA_XRPL_BASE_URL` (default: `https://data.xrpl.org`)
- `XRPL_RPC_URL` (default: `https://s1.ripple.com:51234`)
- `XRPLMETA_BASE_URL` (default: `https://api.xrplmeta.org`)

## MCP client config (`stdio`)

```json
{
  "mcpServers": {
    "xrpl-data": {
      "command": "node",
      "args": ["/Users/ashraychowdhry/Documents/New project/src/server.js"],
      "env": {
        "LOS_BASE_URL": "https://los.prod.ripplex.io",
        "DATA_XRPL_BASE_URL": "https://data.xrpl.org",
        "XRPL_RPC_URL": "https://s1.ripple.com:51234",
        "XRPLMETA_BASE_URL": "https://api.xrplmeta.org"
      }
    }
  }
}
```
