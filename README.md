# XRPL MCP Server

MCP server for:
- LOS (`https://los.prod.ripplex.io`)
- Validator History Service (`https://data.xrpl.org`)
- XRPL JSON-RPC (`https://s1.ripple.com:51234`)
- XRPLMeta (`https://s1.xrplmeta.org`)

## Setup

```bash
npm install
npm start
```

`npm start` runs the server over Streamable HTTP at `http://127.0.0.1:3000/mcp` by default.
For stdio mode (used by some local MCP clients and the all-tools harness), run:

```bash
npm run start:stdio
```

## Environment Variables

- `LOS_BASE_URL` (default: `https://los.prod.ripplex.io`)
- `DATA_XRPL_BASE_URL` (default: `https://data.xrpl.org`)
- `XRPL_RPC_URL` (default: `https://s1.ripple.com:51234`)
- `XRPLMETA_BASE_URL` (default: `https://s1.xrplmeta.org`)
- `MCP_TRANSPORT` (default: `http`, options: `http` or `stdio`)
- `MCP_HTTP_HOST` (default: `0.0.0.0`)
- `MCP_HTTP_PORT` (default: `3000`)
- `MCP_HTTP_PATH` (default: `/mcp`)

## MCP Client Config (`http`, default)

```json
{
  "mcpServers": {
    "xrpl-data": {
      "transport": {
        "type": "http",
        "url": "http://127.0.0.1:3000/mcp"
      }
    }
  }
}
```

## MCP Client Config (`stdio`, optional)

```json
{
  "mcpServers": {
    "xrpl-data": {
      "command": "node",
      "args": ["/Users/ashraychowdhry/Documents/xrpl-data-mcp/src/server.js"],
      "env": {
        "LOS_BASE_URL": "https://los.prod.ripplex.io",
        "DATA_XRPL_BASE_URL": "https://data.xrpl.org",
        "XRPL_RPC_URL": "https://s1.ripple.com:51234",
        "XRPLMETA_BASE_URL": "https://s1.xrplmeta.org"
      }
    }
  }
}
```

## Response Formats

### 1) Low-level passthrough tools
Most low-level tools (`los_*`, `vh_*`, `xrpl_*`, `validator_history_get`, `xrpl_public_api_call`) return the upstream JSON payload in MCP text content.

Typical shapes:
- XRPL RPC tools: `{ "result": { ... }, "status": "success", "warnings"?: [...] }`
- VHS/LOS GET tools: service-native object/array response

### 2) Agent-first composite tools
These return a normalized envelope:

```json
{
  "data": {},
  "sources": [{ "system": "LOS|VHS|rippled|XRPLMeta", "method": "...", "at": "..." }],
  "freshness": { "asOfLedger": 0, "asOfTime": "..." },
  "warnings": []
}
```

### 3) Error format
On upstream/API/runtime failure, tools return MCP error content with `isError: true` and human-readable text (often including upstream HTTP status/body).

## How To Use Tools

Call MCP tools with:
- `name`: tool id
- `arguments`: JSON object matching the tool input schema below

Example:

```json
{
  "name": "xrpl_account_info",
  "arguments": {
    "account": "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    "ledger_index": "validated"
  }
}
```

## How To Use This Server (Step-by-step)

1. Install dependencies.
   ```bash
   npm install
   ```
2. Start the server locally.
   ```bash
   npm start
   ```
3. Add the MCP server config to your MCP client (use the `http` config above by default).
4. In your MCP client, run `tools/list` to discover all available tools.
5. Start with a simple connectivity check:
   - `xrpl_server_info`
   - `network_overview`
6. For entity-specific lookups, use `resolve_entities` first, then call suggested tools.
7. For topology-specific calls:
   - call `vh_topology_nodes` first
   - take a `pubkey` from that response
   - call `vh_topology_node` with that `pubkey`
8. For token/NFT-specific calls, discover live IDs first:
   - token: `los_get_trusted_tokens`
   - nft: `xrpl_nft_info` / `xrpl_nft_history` after discovering an `nft_id`
9. Run the full validation suite to verify end-to-end health:
   ```bash
   node scripts/test-all-tools.mjs > /tmp/xrpl-mcp-test-results.json
   ```
10. Manually call a single tool over HTTP:
    ```bash
    node scripts/test-http-tool.mjs http://127.0.0.1:3000/mcp xrpl_server_info '{}'
    ```

## Full Tool Catalog (49)

### Agent-first composite tools (12)

| Tool | Description | Required arguments | Expected response format |
|---|---|---|---|
| `network_overview` | Network identity, health summary, LOS freshness | none | Envelope: `data` includes server/network/health metrics |
| `ledger_summary` | Canonical ledger facts + LOS hints | none (`ledger_index`/`ledger_hash` optional) | Envelope: `data.ledger`, ledger metadata, optional LOS artifacts |
| `tx_explain` | Normalized transaction explanation/classification | `tx_hash` | Envelope: tx details, classification, token/entity hints |
| `account_overview` | Account state/activity summary | `account` | Envelope: balances, trustlines, activity histogram, risk indicators |
| `token_overview` | Consolidated issued-token view | `issuer`, `currency` | Envelope: token metadata, holders/trustlines, liquidity/activity |
| `market_snapshot` | Orderbook + AMM + recent LOS trades | `base`, `quote` | Envelope: orderbook summary, AMM state, trade sample/VWAP |
| `amm_overview` | AMM state and swap activity | none (`amm_id` or `assetA`+`assetB` recommended) | Envelope: AMM state, swap sample, aggregate volume |
| `validator_set_overview` | Validator set composition summary | none (`options.group` optional) | Envelope: validator count, operator concentration, set sample |
| `validator_health` | Validator reliability metrics | `pubkey_or_node` | Envelope: validator profile + signed/missed/uptime-like metrics |
| `amendment_status` | Amendment enablement + context | none (`network` optional) | Envelope: enabled amendments, vote context, network context |
| `search_transactions` | Filtered LOS transaction search + aggregates | `filters` | Envelope: `results`, `cursor`, aggregate stats |
| `resolve_entities` | Pattern-based XRPL entity resolver | `input` | Envelope: resolved entity type + suggested next tools |

### LOS tools (4)

| Tool | Description | Required arguments | Expected response format |
|---|---|---|---|
| `los_get_token` | Fetch one LOS token by tokenID (`currencyHex.issuer`) | `tokenID` | LOS token object |
| `los_batch_get_tokens` | Batch fetch LOS tokens | `tokenIds` (array) | LOS batch token response |
| `los_get_trusted_tokens` | List trusted/KYC tokens | none | LOS trusted token list (`count`, `tokens`) |
| `los_get_transactions` | Query LOS transactions with paging/sort | none (`token` strongly recommended) | LOS transaction query response (`results`/cursor fields) |

### Validator history tools (15)

| Tool | Description | Required arguments | Expected response format |
|---|---|---|---|
| `vh_list_networks` | List tracked networks | none | VHS networks payload (`result`, `networks`) |
| `vh_topology_nodes` | Topology nodes for all/specific network | none (`network` optional) | VHS topology nodes payload |
| `vh_topology_node` | Topology for a specific node pubkey | `pubkey` | VHS topology node payload |
| `vh_list_validators` | List validators (optionally by group) | none (`group` optional) | VHS validators payload |
| `vh_get_validator` | Validator detail | `pubkey` | VHS validator profile |
| `vh_get_validator_manifests` | Validator manifest history | `pubkey` | VHS manifest history payload |
| `vh_get_validator_reports` | Validator reports | `pubkey` | VHS validator reports payload |
| `vh_get_daily_validator_reports` | Daily validator reports collection | none | VHS daily report payload |
| `vh_get_amendments_info` | Amendment metadata | none | VHS amendments info payload |
| `vh_get_amendment_info` | Amendment info by name/id | `amendment` | VHS amendment detail payload |
| `vh_get_amendments_vote` | Amendment votes for a network | `network` | VHS amendment votes payload |
| `vh_get_amendment_vote` | Single amendment vote status | `network`, `identifier` | VHS amendment vote detail payload |
| `vh_health` | VHS health summary | none | VHS health payload |
| `vh_metrics` | VHS Prometheus metrics | none | Metrics text/structured payload returned as text |
| `validator_history_get` | Generic VHS GET passthrough | `path` | Raw VHS response for requested path |

### XRPL JSON-RPC tools (17)

| Tool | Description | Required arguments | Expected response format |
|---|---|---|---|
| `xrpl_account_info` | Account root info | `account` | XRPL RPC result object |
| `xrpl_account_objects` | Objects owned by account | `account` | XRPL RPC result object |
| `xrpl_account_lines` | Trust lines | `account` | XRPL RPC result object |
| `xrpl_account_tx` | Account tx history | `account` | XRPL RPC result object |
| `xrpl_ledger` | Ledger by hash/index | none | XRPL RPC result object |
| `xrpl_ledger_data` | Raw ledger state pages | none | XRPL RPC result object |
| `xrpl_ledger_entry` | Single ledger entry | none (one locator required by XRPL) | XRPL RPC result object |
| `xrpl_tx` | Transaction by hash | `transaction` | XRPL RPC result object |
| `xrpl_book_offers` | Orderbook offers | `taker_gets`, `taker_pays` | XRPL RPC result object |
| `xrpl_amm_info` | AMM pool info | `asset`, `asset2` | XRPL RPC result object |
| `xrpl_nft_info` | NFToken state/metadata | `nft_id` | XRPL RPC result object |
| `xrpl_nft_history` | NFToken ownership/transfer history | `nft_id` | XRPL RPC result object |
| `xrpl_nfts_by_issuer` | NFTs by issuer | `issuer` | XRPL RPC result object |
| `xrpl_server_info` | Server status/validated range | none | XRPL RPC result object |
| `xrpl_fee` | Fee metrics | none | XRPL RPC result object |
| `xrpl_public_api_call` | Generic JSON-RPC method call | `method` | XRPL RPC result object |
| `xrpl_list_recommended_methods` | Curated method list exposed by dedicated tools | none | `{ "methods": [...] }` |

### XRPLMeta tools (1)

| Tool | Description | Required arguments | Expected response format |
|---|---|---|---|
| `xrplmeta_get` | Generic XRPLMeta GET passthrough | `path` | Envelope: `data` contains XRPLMeta response |

## Input Discovery Notes (for reliable testing)

Some tools need live identifiers. The test harness discovers them first:
- `vh_topology_node.pubkey`: taken from `vh_topology_nodes` output
- `vh_get_validator*` / `validator_health`: taken from `vh_list_validators`
- `tx_explain` / `xrpl_tx`: tx hash from `xrpl_account_tx`
- `xrpl_nft_info` / `xrpl_nft_history`: NFT id from recent NFT transactions
- `los_get_token` / token-dependent tools: token from `los_get_trusted_tokens`

## Test Results

Latest end-to-end live run (2026-02-20):
- Tools tested: `49`
- Passed: `49`
- Failed: `0`

Run command:

```bash
node scripts/test-all-tools.mjs > /tmp/xrpl-mcp-test-results.json
```

Detailed output:
- `/tmp/xrpl-mcp-test-results.json`
- `/Users/ashraychowdhry/Documents/xrpl-data-mcp/docs/TEST_RESULTS.md`
