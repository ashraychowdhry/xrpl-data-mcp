# Test Results

Date: 2026-02-20

## Summary

- Total tools: 49
- Passed: 49
- Failed: 0

## Command

```bash
node scripts/test-all-tools.mjs > /tmp/xrpl-mcp-test-results.json
```

## Notes

- Test uses live endpoint calls across LOS, VHS, XRPL RPC, and XRPLMeta.
- Dynamic identifiers are discovered before tool calls (tx hash, topology pubkey, token ID, NFT ID).
- Full raw JSON result artifact is at `/tmp/xrpl-mcp-test-results.json`.

## Tools

- account_overview: PASS
- amendment_status: PASS
- amm_overview: PASS
- ledger_summary: PASS
- los_batch_get_tokens: PASS
- los_get_token: PASS
- los_get_transactions: PASS
- los_get_trusted_tokens: PASS
- market_snapshot: PASS
- network_overview: PASS
- resolve_entities: PASS
- search_transactions: PASS
- token_overview: PASS
- tx_explain: PASS
- validator_health: PASS
- validator_history_get: PASS
- validator_set_overview: PASS
- vh_get_amendment_info: PASS
- vh_get_amendment_vote: PASS
- vh_get_amendments_info: PASS
- vh_get_amendments_vote: PASS
- vh_get_daily_validator_reports: PASS
- vh_get_validator: PASS
- vh_get_validator_manifests: PASS
- vh_get_validator_reports: PASS
- vh_health: PASS
- vh_list_networks: PASS
- vh_list_validators: PASS
- vh_metrics: PASS
- vh_topology_node: PASS
- vh_topology_nodes: PASS
- xrpl_account_info: PASS
- xrpl_account_lines: PASS
- xrpl_account_objects: PASS
- xrpl_account_tx: PASS
- xrpl_amm_info: PASS
- xrpl_book_offers: PASS
- xrpl_fee: PASS
- xrpl_ledger: PASS
- xrpl_ledger_data: PASS
- xrpl_ledger_entry: PASS
- xrpl_list_recommended_methods: PASS
- xrpl_nft_history: PASS
- xrpl_nft_info: PASS
- xrpl_nfts_by_issuer: PASS
- xrpl_public_api_call: PASS
- xrpl_server_info: PASS
- xrpl_tx: PASS
- xrplmeta_get: PASS
