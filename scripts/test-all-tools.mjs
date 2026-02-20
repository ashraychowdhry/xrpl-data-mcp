import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const WORKDIR = process.cwd();
const DEFAULT_ACCOUNT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const FALLBACK_TOKEN = "5553440000000000000000000000000000000000.rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq";

function isObject(value) {
  return value !== null && typeof value === "object";
}

function walk(value, visitor) {
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visitor);
    }
    return;
  }
  if (isObject(value)) {
    for (const item of Object.values(value)) {
      walk(item, visitor);
    }
  }
}

function collectStrings(value) {
  const out = [];
  walk(value, (node) => {
    if (typeof node === "string") {
      out.push(node);
    }
  });
  return out;
}

function findFirst(value, predicate) {
  let found;
  walk(value, (node) => {
    if (found !== undefined) {
      return;
    }
    if (predicate(node)) {
      found = node;
    }
  });
  return found;
}

function findFirstString(value, re) {
  return collectStrings(value).find((s) => re.test(s));
}

function parseToolPayload(result) {
  const textPart = Array.isArray(result?.content)
    ? result.content.find((c) => c && c.type === "text" && typeof c.text === "string")
    : null;

  if (!textPart) {
    return result;
  }

  try {
    return JSON.parse(textPart.text);
  } catch {
    return textPart.text;
  }
}

function shortError(raw) {
  if (typeof raw !== "string") {
    return String(raw);
  }
  return raw.length > 280 ? `${raw.slice(0, 280)}...` : raw;
}

function extractNftFromLedgerTx(tx) {
  if (!tx || typeof tx !== "object") {
    return null;
  }
  const type = String(tx.TransactionType || "");
  if (!type.includes("NFToken")) {
    return null;
  }
  const candidate = [tx.NFTokenID, tx.NFTokenSellOffer, tx.NFTokenBuyOffer].find(
    (v) => typeof v === "string" && /^[A-F0-9]{64}$/.test(v)
  );
  if (candidate) {
    return { nftId: candidate, issuer: tx.Account };
  }
  return null;
}

async function main() {
  const client = new Client(
    { name: "xrpl-mcp-e2e-tester", version: "1.1.0" },
    { capabilities: {} }
  );

  const transport = new StdioClientTransport({
    command: "node",
    args: ["src/server.js"],
    cwd: WORKDIR,
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio"
    },
    stderr: "pipe"
  });

  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      const msg = String(chunk || "").trim();
      if (msg) {
        console.error(`[server-stderr] ${msg}`);
      }
    });
  }

  const byTool = new Map();

  function record(name, ok, detail) {
    byTool.set(name, { name, ok, detail });
  }

  async function call(name, args = {}) {
    try {
      const result = await client.callTool({ name, arguments: args });
      const payload = parseToolPayload(result);
      if (result?.isError) {
        return { ok: false, error: shortError(typeof payload === "string" ? payload : JSON.stringify(payload)), payload };
      }
      return { ok: true, payload };
    } catch (error) {
      return { ok: false, error: shortError(error instanceof Error ? error.message : String(error)) };
    }
  }

  try {
    await client.connect(transport);

    const list = await client.listTools();
    const toolNames = list.tools.map((t) => t.name);

    const ctx = {
      account: DEFAULT_ACCOUNT,
      txHash: null,
      network: "main",
      validatorPubkey: null,
      topologyPubkey: null,
      amendmentIdentifier: null,
      tokenID: null,
      nftId: null,
      nftIssuer: DEFAULT_ACCOUNT,
      ammAsset: null,
      ammAsset2: null,
      ammId: null
    };

    const accountTxPrime = await call("xrpl_account_tx", {
      account: ctx.account,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: 5
    });
    if (accountTxPrime.ok) {
      ctx.txHash = findFirstString(accountTxPrime.payload, /^[A-F0-9]{64}$/) ?? ctx.txHash;
    }

    const networksPrime = await call("vh_list_networks", {});
    if (networksPrime.ok) {
      const netObj = findFirst(networksPrime.payload, (node) => isObject(node) && typeof node.id === "string" && node.id === "main");
      if (netObj?.id) {
        ctx.network = netObj.id;
      }
    }

    const validatorsPrime = await call("vh_list_validators", {});
    if (validatorsPrime.ok) {
      ctx.validatorPubkey = findFirstString(validatorsPrime.payload, /^n[1-9A-HJ-NP-Za-km-z]{20,}$/) ?? ctx.validatorPubkey;
    }
    const topologyPrime = await call("vh_topology_nodes", { network: ctx.network });
    if (topologyPrime.ok) {
      ctx.topologyPubkey = findFirstString(topologyPrime.payload, /^n[1-9A-HJ-NP-Za-km-z]{20,}$/) ?? ctx.topologyPubkey;
    }

    const trustedPrime = await call("los_get_trusted_tokens", {});
    if (trustedPrime.ok) {
      const tokenObj = findFirst(
        trustedPrime.payload,
        (node) =>
          isObject(node)
          && typeof node.currency === "string"
          && typeof node.issuer_account === "string"
          && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(node.issuer_account)
      );
      if (tokenObj) {
        ctx.tokenID = `${String(tokenObj.currency).toUpperCase()}.${tokenObj.issuer_account}`;
      }
    }
    ctx.tokenID = ctx.tokenID ?? FALLBACK_TOKEN;

    const amendmentsPrime = await call("vh_get_amendments_vote", { network: ctx.network });
    if (amendmentsPrime.ok) {
      ctx.amendmentIdentifier = findFirstString(amendmentsPrime.payload, /^[A-F0-9]{64}$/) ?? ctx.amendmentIdentifier;
    }

    const nftPrime = await call("xrpl_ledger_data", { ledger_index: "validated", type: "nft_page", limit: 10 });
    if (nftPrime.ok) {
      const nftNode = findFirst(
        nftPrime.payload,
        (node) => isObject(node) && typeof node.NFTokenID === "string" && /^[A-F0-9]{64}$/.test(node.NFTokenID)
      );
      if (nftNode?.NFTokenID) {
        ctx.nftId = nftNode.NFTokenID;
      }
      if (nftNode?.Issuer && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(nftNode.Issuer)) {
        ctx.nftIssuer = nftNode.Issuer;
      }
    }

    if (!ctx.nftId) {
      const serverInfoPrime = await call("xrpl_server_info", {});
      const validated = Number(serverInfoPrime.payload?.result?.info?.validated_ledger?.seq);
      if (Number.isFinite(validated)) {
        for (let i = 0; i < 160 && !ctx.nftId; i += 1) {
          const ledgerIndex = validated - i;
          const ledgerTx = await call("xrpl_ledger", {
            ledger_index: ledgerIndex,
            transactions: true,
            expand: true
          });
          if (!ledgerTx.ok) {
            continue;
          }
          const txs = ledgerTx.payload?.result?.ledger?.transactions;
          if (!Array.isArray(txs)) {
            continue;
          }
          for (const tx of txs) {
            const found = extractNftFromLedgerTx(tx);
            if (!found) {
              continue;
            }
            ctx.nftId = found.nftId;
            if (found.issuer && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(found.issuer)) {
              ctx.nftIssuer = found.issuer;
            }
            break;
          }
        }
      }
    }

    const ammPrime = await call("xrpl_public_api_call", {
      method: "amm_info",
      params: [{
        asset: { currency: "XRP" },
        asset2: { currency: "USD", issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq" }
      }]
    });
    if (ammPrime.ok) {
      const ammObj = findFirst(ammPrime.payload, (node) => isObject(node) && node.amount && node.amount2);
      if (ammObj) {
        ctx.ammAsset = { currency: "XRP" };
        ctx.ammAsset2 = { currency: "USD", issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq" };
      }
    }

    const toolArgs = {
      los_get_token: () => ({ tokenID: ctx.tokenID }),
      los_batch_get_tokens: () => ({ tokenIds: [ctx.tokenID] }),
      los_get_trusted_tokens: () => ({}),
      los_get_transactions: () => ({ token: ctx.tokenID, size: 5, sort_field: "timestamp", sort_order: "desc" }),
      vh_list_networks: () => ({}),
      vh_topology_nodes: () => ({ network: ctx.network }),
      vh_topology_node: () => ({ pubkey: ctx.topologyPubkey ?? ctx.validatorPubkey }),
      vh_list_validators: () => ({}),
      vh_get_validator: () => ({ pubkey: ctx.validatorPubkey }),
      vh_get_validator_manifests: () => ({ pubkey: ctx.validatorPubkey }),
      vh_get_validator_reports: () => ({ pubkey: ctx.validatorPubkey }),
      vh_get_daily_validator_reports: () => ({}),
      vh_get_amendments_info: () => ({}),
      vh_get_amendment_info: () => ({ amendment: ctx.amendmentIdentifier ?? "Checks" }),
      vh_get_amendments_vote: () => ({ network: ctx.network }),
      vh_get_amendment_vote: () => ({ network: ctx.network, identifier: ctx.amendmentIdentifier ?? "Checks" }),
      vh_health: () => ({}),
      vh_metrics: () => ({}),
      validator_history_get: () => ({ path: "/v1/network/networks" }),
      xrpl_account_info: () => ({ account: ctx.account, ledger_index: "validated" }),
      xrpl_account_objects: () => ({ account: ctx.account, ledger_index: "validated", limit: 5 }),
      xrpl_account_lines: () => ({ account: ctx.account, ledger_index: "validated", limit: 5 }),
      xrpl_account_tx: () => ({ account: ctx.account, ledger_index_min: -1, ledger_index_max: -1, limit: 5 }),
      xrpl_ledger: () => ({ ledger_index: "validated" }),
      xrpl_ledger_data: () => ({ ledger_index: "validated", limit: 5 }),
      xrpl_ledger_entry: () => ({ ledger_index: "validated", account_root: { account: ctx.account } }),
      xrpl_tx: () => ({ transaction: ctx.txHash }),
      xrpl_book_offers: () => ({
        taker_gets: { currency: "XRP" },
        taker_pays: { currency: "USD", issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq" },
        limit: 5
      }),
      xrpl_amm_info: () => ({
        asset: ctx.ammAsset ?? { currency: "XRP" },
        asset2: ctx.ammAsset2 ?? { currency: "USD", issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq" }
      }),
      xrpl_nft_info: () => ({ nft_id: ctx.nftId }),
      xrpl_nft_history: () => ({ nft_id: ctx.nftId, limit: 5 }),
      xrpl_nfts_by_issuer: () => ({ issuer: ctx.nftIssuer, ledger_index: "validated", limit: 5 }),
      xrpl_server_info: () => ({}),
      xrpl_fee: () => ({}),
      xrpl_public_api_call: () => ({ method: "server_info", params: [{}] }),
      xrplmeta_get: () => ({ path: "/" }),
      network_overview: () => ({}),
      ledger_summary: () => ({ ledger_index: "validated" }),
      tx_explain: () => ({ tx_hash: ctx.txHash }),
      account_overview: () => ({ account: ctx.account }),
      token_overview: () => ({
        issuer: ctx.tokenID.split(".")[1],
        currency: ctx.tokenID.split(".")[0]
      }),
      market_snapshot: () => ({
        base: ctx.ammAsset ?? { currency: "XRP" },
        quote: ctx.ammAsset2 ?? { currency: "USD", issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq" }
      }),
      amm_overview: () => ({
        assetA: ctx.ammAsset ?? { currency: "XRP" },
        assetB: ctx.ammAsset2 ?? { currency: "USD", issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq" }
      }),
      validator_set_overview: () => ({ options: { group: ctx.network } }),
      validator_health: () => ({ pubkey_or_node: ctx.validatorPubkey }),
      amendment_status: () => ({ network: ctx.network }),
      search_transactions: () => ({
        filters: { token: ctx.tokenID, sort_order: "desc", sort_field: "timestamp" },
        size: 5
      }),
      resolve_entities: () => ({ input: ctx.txHash ?? ctx.account }),
      xrpl_list_recommended_methods: () => ({})
    };

    for (const toolName of toolNames) {
      const buildArgs = toolArgs[toolName];
      if (!buildArgs) {
        record(toolName, false, "No test args configured");
        continue;
      }

      const args = buildArgs();
      const missingPrereq =
        (toolName === "vh_topology_node" && !args.pubkey) ||
        (toolName === "vh_get_validator" && !args.pubkey) ||
        (toolName === "vh_get_validator_manifests" && !args.pubkey) ||
        (toolName === "vh_get_validator_reports" && !args.pubkey) ||
        (toolName === "validator_health" && !args.pubkey_or_node) ||
        (toolName === "xrpl_tx" && !args.transaction) ||
        (toolName === "tx_explain" && !args.tx_hash) ||
        (toolName === "xrpl_nft_info" && !args.nft_id) ||
        (toolName === "xrpl_nft_history" && !args.nft_id);

      if (missingPrereq) {
        record(toolName, false, "Missing discovered prerequisite data for this tool");
        continue;
      }

      const res = await call(toolName, args);
      record(toolName, res.ok, res.ok ? "ok" : res.error);
    }

    const results = [...byTool.values()].sort((a, b) => a.name.localeCompare(b.name));
    const pass = results.filter((r) => r.ok).length;
    const fail = results.filter((r) => !r.ok).length;

    console.log(JSON.stringify({
      summary: {
        totalTools: toolNames.length,
        pass,
        fail
      },
      context: ctx,
      failures: results.filter((r) => !r.ok),
      results
    }, null, 2));

    await client.close();
  } catch (error) {
    console.error("Fatal harness error:", error instanceof Error ? error.message : String(error));
    try {
      await client.close();
    } catch {
      // ignore
    }
    process.exitCode = 1;
  }
}

main();
