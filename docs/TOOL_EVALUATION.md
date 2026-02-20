# Tool Evaluation (Community Utility)

## Recommended high-level tools (implemented)

1. `network_overview`: single health + freshness check before any reasoning chain.
2. `ledger_summary`: canonical ledger facts with optional LOS artifact lookup.
3. `tx_explain`: normalized tx/meta + classification + plain-language summary.
4. `account_overview`: account state + trustline + behavior profile.
5. `token_overview`: issuer/currency consolidated token profile.
6. `market_snapshot`: orderbook + AMM + recent DEX trades in one call.
7. `amm_overview`: pool state and swap activity.
8. `validator_set_overview`: validator set composition and concentration.
9. `validator_health`: reliability summary for one validator.
10. `amendment_status`: governance and enablement state.
11. `search_transactions`: open-ended LOS transaction retrieval + aggregates.
12. `resolve_entities`: canonical identifier resolution and next-step tool hints.

## Why this set

- Minimizes tool-chaining for the most common XRPL agent questions.
- Separates high-value analytical tools from low-level passthrough methods.
- Adds source/freshness metadata so agents can reason about confidence.
- Retains generic passthrough tools for future LOS/VHS/XRPL API expansion.

## Integrated systems

- LOS (`los.prod.ripplex.io`)
- VHS (`data.xrpl.org`)
- rippled/Clio public RPC
- XRPLMeta public server (generic passthrough)

