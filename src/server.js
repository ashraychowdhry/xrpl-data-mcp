import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LOS_BASE_URL = process.env.LOS_BASE_URL ?? "https://los.prod.ripplex.io";
const DATA_XRPL_BASE_URL = process.env.DATA_XRPL_BASE_URL ?? "https://data.xrpl.org";
const XRPL_RPC_URL = process.env.XRPL_RPC_URL ?? "https://s1.ripple.com:51234";
const XRPLMETA_BASE_URL = process.env.XRPLMETA_BASE_URL ?? "https://s1.xrplmeta.org";
const MCP_TRANSPORT = String(process.env.MCP_TRANSPORT ?? "http").toLowerCase();
const MCP_HTTP_HOST = process.env.MCP_HTTP_HOST ?? process.env.HOST ?? "0.0.0.0";
const MCP_HTTP_PORT = Number.parseInt(process.env.MCP_HTTP_PORT ?? process.env.PORT ?? "3000", 10);
const MCP_HTTP_PATH = process.env.MCP_HTTP_PATH ?? "/mcp";

const server = new McpServer({
  name: "xrpl-data-mcp",
  version: "0.2.0"
});

const passthroughObject = z.object({}).passthrough();

// Normalize base URLs once so path joins don't produce double slashes.
function normalizeBaseUrl(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function urlWithPathAndQuery(baseUrl, path, query) {
  const base = normalizeBaseUrl(baseUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}${normalizedPath}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }
      } else if (typeof value === "object") {
        url.searchParams.set(key, JSON.stringify(value));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url;
}

async function fetchWithParse(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });

  const bodyText = await response.text();
  const contentType = response.headers.get("content-type") || "";
  let body = bodyText;

  if (contentType.includes("application/json") || bodyText.startsWith("{") || bodyText.startsWith("[")) {
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = bodyText;
    }
  }

  if (!response.ok) {
    const detail = {
      status: response.status,
      statusText: response.statusText,
      body
    };
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${JSON.stringify(detail)}`);
  }

  return body;
}

// MCP returns textual payloads; keep one JSON rendering path for all tools.
function toolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message
      }
    ]
  };
}

function nowIso() {
  return new Date().toISOString();
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickFirstNumber(value, keys) {
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const key of keys) {
    if (key in value) {
      const n = toNum(value[key]);
      if (n !== null) {
        return n;
      }
    }
  }
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") {
      const n = pickFirstNumber(nested, keys);
      if (n !== null) {
        return n;
      }
    }
  }
  return null;
}

// Shared response envelope for agent-oriented tools to report provenance/freshness.
function envelope({ data, sources = [], freshness = {}, warnings = [] }) {
  return {
    data,
    sources,
    freshness: {
      asOfLedger: freshness.asOfLedger ?? null,
      asOfTime: freshness.asOfTime ?? nowIso()
    },
    warnings
  };
}

function toToolEnvelope(args) {
  return toolResult(envelope(args));
}

function currencyTo160Hex(currency) {
  const raw = String(currency || "").trim();
  if (/^[A-Fa-f0-9]{40}$/.test(raw)) {
    return raw.toUpperCase();
  }
  if (/^[A-Za-z0-9]{3}$/.test(raw)) {
    const hex = Buffer.from(raw.toUpperCase(), "ascii").toString("hex").toUpperCase();
    return `${hex}${"0".repeat(34)}`;
  }
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.length > 20) {
    return null;
  }
  return Buffer.concat([bytes, Buffer.alloc(20 - bytes.length)]).toString("hex").toUpperCase();
}

// Canonical LOS token key format: <160-bit-currency-hex>.<issuer>.
function tokenIdFromIssuerCurrency(issuer, currency) {
  const currencyHex = currencyTo160Hex(currency);
  if (!currencyHex) {
    return null;
  }
  return `${currencyHex}.${issuer}`;
}

function xrplResultEnvelope(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  if ("result" in payload && payload.result && typeof payload.result === "object") {
    return payload.result;
  }
  return payload;
}

function parseXrpDrops(value) {
  const drops = toNum(value);
  if (drops === null) {
    return null;
  }
  return drops / 1_000_000;
}

function extractTokensFromTx(tx, meta) {
  const tokens = new Set();
  const addCurrency = (amount) => {
    if (!amount) {
      return;
    }
    if (typeof amount === "string") {
      tokens.add("XRP");
      return;
    }
    if (amount.currency && amount.issuer) {
      tokens.add(`${amount.currency}.${amount.issuer}`);
    }
  };

  addCurrency(tx?.Amount);
  addCurrency(tx?.TakerGets);
  addCurrency(tx?.TakerPays);
  addCurrency(meta?.delivered_amount);

  const nodes = Array.isArray(meta?.AffectedNodes) ? meta.AffectedNodes : [];
  for (const node of nodes) {
    const body = node.ModifiedNode || node.CreatedNode || node.DeletedNode;
    const finalFields = body?.FinalFields || {};
    const newFields = body?.NewFields || {};
    addCurrency(finalFields.Balance);
    addCurrency(newFields.Balance);
  }
  return [...tokens];
}

async function callLos(path, query) {
  const url = urlWithPathAndQuery(LOS_BASE_URL, path, query);
  return fetchWithParse(url);
}

// Soft LOS call for optional enrichments/fallbacks without failing the entire tool.
async function tryLos(path, query) {
  try {
    return await callLos(path, query);
  } catch {
    return null;
  }
}

// LOS ingestion freshness is probed across a few likely status endpoints.
async function losFreshnessProbe() {
  const candidates = [
    "/ingestion-watermark",
    "/ingestion/status",
    "/status",
    "/health",
    "/meta"
  ];

  for (const path of candidates) {
    const payload = await tryLos(path);
    if (!payload) {
      continue;
    }
    const latestIndexedLedger = pickFirstNumber(payload, [
      "latestIndexedLedger",
      "latest_indexed_ledger",
      "indexed_ledger",
      "ledger_index",
      "ledger"
    ]);
    if (latestIndexedLedger !== null) {
      return {
        latestIndexedLedger,
        sourcePath: path,
        raw: payload
      };
    }
  }

  return {
    latestIndexedLedger: null,
    sourcePath: null,
    raw: null
  };
}

async function xrplRpc(method, params = [], id = "xrpl-mcp") {
  return fetchWithParse(XRPL_RPC_URL, {
    method: "POST",
    body: JSON.stringify({ method, params, id })
  });
}

// Wrapper for plain HTTP GET tools where path/query are derived from validated args.
function registerGetTool(name, description, schema, baseUrl, pathAndQueryBuilder) {
  server.tool(name, description, schema, async (args) => {
    try {
      const { path, query } = pathAndQueryBuilder(args);
      const url = urlWithPathAndQuery(baseUrl, path, query);
      const data = await fetchWithParse(url);
      return toolResult(data);
    } catch (error) {
      return toolError(error);
    }
  });
}

// Wrapper for single-method XRPL JSON-RPC tools.
function registerRpcTool(name, description, schema, method, paramsBuilder) {
  server.tool(name, description, schema, async (args) => {
    try {
      const data = await xrplRpc(method, [paramsBuilder(args)]);
      return toolResult(data);
    } catch (error) {
      return toolError(error);
    }
  });
}

server.tool(
  "los_get_token",
  "Get a single LOS token by tokenID (format: currencyHex.issuer).",
  {
    tokenID: z.string().min(3)
  },
  async ({ tokenID }) => {
    try {
      const url = urlWithPathAndQuery(LOS_BASE_URL, `/tokens/${encodeURIComponent(tokenID)}`);
      const data = await fetchWithParse(url);
      return toolResult(data);
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "los_batch_get_tokens",
  "Batch fetch LOS token objects. Requires tokenIds as an array of tokenID strings.",
  {
    tokenIds: z.array(z.string().min(3)).min(1)
  },
  async ({ tokenIds }) => {
    try {
      const url = urlWithPathAndQuery(LOS_BASE_URL, "/tokens/batch-get");
      const data = await fetchWithParse(url, {
        method: "POST",
        body: JSON.stringify({ tokenIds })
      });
      return toolResult(data);
    } catch (error) {
      return toolError(error);
    }
  }
);

registerGetTool(
  "los_get_trusted_tokens",
  "Get trusted/KYCed tokens from LOS.",
  {},
  LOS_BASE_URL,
  () => ({ path: "/trusted-tokens" })
);

registerGetTool(
  "los_get_transactions",
  "Query LOS token transactions with pagination and sorting.",
  {
    token: z.string().optional(),
    transactionType: z.string().optional(),
    size: z.number().int().positive().max(1000).optional(),
    direction: z.enum(["next", "prev"]).optional(),
    sort_field: z.string().optional(),
    sort_order: z.enum(["asc", "desc"]).optional(),
    marker: z.string().optional(),
    ledger_index_min: z.number().int().nonnegative().optional(),
    ledger_index_max: z.number().int().nonnegative().optional()
  },
  LOS_BASE_URL,
  (args) => ({ path: "/transactions", query: args })
);

registerGetTool(
  "vh_list_networks",
  "Get all tracked networks from validator history service.",
  {},
  DATA_XRPL_BASE_URL,
  () => ({ path: "/v1/network/networks" })
);

registerGetTool(
  "vh_topology_nodes",
  "Get topology nodes for all networks or a specific network.",
  {
    network: z.string().optional()
  },
  DATA_XRPL_BASE_URL,
  ({ network }) => ({
    path: network ? `/v1/network/topology/nodes/${encodeURIComponent(network)}` : "/v1/network/topology/nodes"
  })
);

registerGetTool(
  "vh_topology_node",
  "Get topology information for a specific validator pubkey.",
  {
    pubkey: z.string().min(1)
  },
  DATA_XRPL_BASE_URL,
  ({ pubkey }) => ({ path: `/v1/network/topology/node/${encodeURIComponent(pubkey)}` })
);

registerGetTool(
  "vh_list_validators",
  "Get validators or validators filtered by group (UNL/network identifier).",
  {
    group: z.string().optional()
  },
  DATA_XRPL_BASE_URL,
  ({ group }) => ({
    path: group ? `/v1/network/validators/${encodeURIComponent(group)}` : "/v1/network/validators"
  })
);

registerGetTool(
  "vh_get_validator",
  "Get details for a specific validator pubkey.",
  {
    pubkey: z.string().min(1)
  },
  DATA_XRPL_BASE_URL,
  ({ pubkey }) => ({ path: `/v1/network/validator/${encodeURIComponent(pubkey)}` })
);

registerGetTool(
  "vh_get_validator_manifests",
  "Get manifest history for a specific validator pubkey.",
  {
    pubkey: z.string().min(1)
  },
  DATA_XRPL_BASE_URL,
  ({ pubkey }) => ({ path: `/v1/network/validator/${encodeURIComponent(pubkey)}/manifests` })
);

registerGetTool(
  "vh_get_validator_reports",
  "Get report history for a specific validator pubkey.",
  {
    pubkey: z.string().min(1)
  },
  DATA_XRPL_BASE_URL,
  ({ pubkey }) => ({ path: `/v1/network/validator/${encodeURIComponent(pubkey)}/reports` })
);

registerGetTool(
  "vh_get_daily_validator_reports",
  "Get daily validator reports collection.",
  {},
  DATA_XRPL_BASE_URL,
  () => ({ path: "/v1/network/validator_reports" })
);

registerGetTool(
  "vh_get_amendments_info",
  "Get general amendment information.",
  {},
  DATA_XRPL_BASE_URL,
  () => ({ path: "/v1/network/amendments/info" })
);

registerGetTool(
  "vh_get_amendment_info",
  "Get amendment information by amendment name or id.",
  {
    amendment: z.string().min(1)
  },
  DATA_XRPL_BASE_URL,
  ({ amendment }) => ({ path: `/v1/network/amendment/info/${encodeURIComponent(amendment)}` })
);

registerGetTool(
  "vh_get_amendments_vote",
  "Get all amendment votes for a network.",
  {
    network: z.string().min(1)
  },
  DATA_XRPL_BASE_URL,
  ({ network }) => ({ path: `/v1/network/amendments/vote/${encodeURIComponent(network)}` })
);

registerGetTool(
  "vh_get_amendment_vote",
  "Get amendment vote details for network and amendment identifier.",
  {
    network: z.string().min(1),
    identifier: z.string().min(1)
  },
  DATA_XRPL_BASE_URL,
  ({ network, identifier }) => ({
    path: `/v1/network/amendment/vote/${encodeURIComponent(network)}/${encodeURIComponent(identifier)}`
  })
);

registerGetTool(
  "vh_health",
  "Get validator history service health summary.",
  {},
  DATA_XRPL_BASE_URL,
  () => ({ path: "/v1/health" })
);

registerGetTool(
  "vh_metrics",
  "Get validator history service Prometheus metrics exposition.",
  {},
  DATA_XRPL_BASE_URL,
  () => ({ path: "/v1/metrics" })
);

registerGetTool(
  "validator_history_get",
  "GET any validator history endpoint by path and optional query params.",
  {
    path: z.string().min(1),
    query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
  },
  DATA_XRPL_BASE_URL,
  ({ path, query }) => ({ path, query })
);

registerRpcTool(
  "xrpl_account_info",
  "Get basic account data.",
  {
    account: z.string().min(1),
    ledger_index: z.union([z.string(), z.number()]).optional(),
    queue: z.boolean().optional(),
    signer_lists: z.boolean().optional()
  },
  "account_info",
  (args) => args
);

registerRpcTool(
  "xrpl_account_objects",
  "Get ledger objects owned by an account.",
  {
    account: z.string().min(1),
    ledger_index: z.union([z.string(), z.number()]).optional(),
    type: z.string().optional(),
    deletion_blockers_only: z.boolean().optional(),
    limit: z.number().int().positive().max(1000).optional(),
    marker: passthroughObject.optional()
  },
  "account_objects",
  (args) => args
);

registerRpcTool(
  "xrpl_account_lines",
  "Get trust lines for an account.",
  {
    account: z.string().min(1),
    ledger_index: z.union([z.string(), z.number()]).optional(),
    peer: z.string().optional(),
    limit: z.number().int().positive().max(1000).optional(),
    marker: passthroughObject.optional()
  },
  "account_lines",
  (args) => args
);

registerRpcTool(
  "xrpl_account_tx",
  "Get account transaction history.",
  {
    account: z.string().min(1),
    ledger_index_min: z.number().int().optional(),
    ledger_index_max: z.number().int().optional(),
    binary: z.boolean().optional(),
    forward: z.boolean().optional(),
    limit: z.number().int().positive().max(1000).optional(),
    marker: passthroughObject.optional()
  },
  "account_tx",
  (args) => args
);

registerRpcTool(
  "xrpl_ledger",
  "Get one ledger version and optional transaction/state expansion.",
  {
    ledger_hash: z.string().optional(),
    ledger_index: z.union([z.string(), z.number()]).optional(),
    transactions: z.boolean().optional(),
    expand: z.boolean().optional(),
    owner_funds: z.boolean().optional(),
    binary: z.boolean().optional(),
    queue: z.boolean().optional()
  },
  "ledger",
  (args) => args
);

registerRpcTool(
  "xrpl_ledger_data",
  "Get raw ledger state data.",
  {
    ledger_hash: z.string().optional(),
    ledger_index: z.union([z.string(), z.number()]).optional(),
    binary: z.boolean().optional(),
    limit: z.number().int().positive().max(2048).optional(),
    marker: passthroughObject.optional(),
    type: z.string().optional()
  },
  "ledger_data",
  (args) => args
);

registerRpcTool(
  "xrpl_ledger_entry",
  "Get a specific ledger entry by index or typed locator fields.",
  {
    ledger_hash: z.string().optional(),
    ledger_index: z.union([z.string(), z.number()]).optional(),
    index: z.string().optional(),
    account_root: passthroughObject.optional(),
    check: passthroughObject.optional(),
    deposit_preauth: passthroughObject.optional(),
    directory: passthroughObject.optional(),
    escrow: passthroughObject.optional(),
    offer: passthroughObject.optional(),
    payment_channel: passthroughObject.optional(),
    ripple_state: passthroughObject.optional(),
    ticket: passthroughObject.optional()
  },
  "ledger_entry",
  (args) => args
);

registerRpcTool(
  "xrpl_tx",
  "Get a transaction by hash.",
  {
    transaction: z.string().min(1),
    binary: z.boolean().optional(),
    min_ledger: z.number().int().optional(),
    max_ledger: z.number().int().optional()
  },
  "tx",
  (args) => args
);

registerRpcTool(
  "xrpl_book_offers",
  "Get offers in one order book.",
  {
    taker_gets: passthroughObject,
    taker_pays: passthroughObject,
    taker: z.string().optional(),
    ledger_index: z.union([z.string(), z.number()]).optional(),
    limit: z.number().int().positive().max(1000).optional(),
    marker: passthroughObject.optional()
  },
  "book_offers",
  (args) => args
);

registerRpcTool(
  "xrpl_amm_info",
  "Get Automated Market Maker pool info.",
  {
    asset: passthroughObject,
    asset2: passthroughObject,
    ledger_hash: z.string().optional(),
    ledger_index: z.union([z.string(), z.number()]).optional()
  },
  "amm_info",
  (args) => args
);

registerRpcTool(
  "xrpl_nft_info",
  "Get metadata and state for one NFToken (Clio method).",
  {
    nft_id: z.string().min(1),
    ledger_hash: z.string().optional(),
    ledger_index: z.union([z.string(), z.number()]).optional()
  },
  "nft_info",
  (args) => args
);

registerRpcTool(
  "xrpl_nft_history",
  "Get ownership and transfer history for one NFToken (Clio method).",
  {
    nft_id: z.string().min(1),
    ledger_index_min: z.number().int().optional(),
    ledger_index_max: z.number().int().optional(),
    limit: z.number().int().positive().max(1000).optional(),
    marker: passthroughObject.optional()
  },
  "nft_history",
  (args) => args
);

registerRpcTool(
  "xrpl_nfts_by_issuer",
  "List NFTs issued by an account (Clio method).",
  {
    issuer: z.string().min(1),
    ledger_index: z.union([z.string(), z.number()]).optional(),
    limit: z.number().int().positive().max(1000).optional(),
    marker: passthroughObject.optional()
  },
  "nfts_by_issuer",
  (args) => args
);

registerRpcTool(
  "xrpl_server_info",
  "Get server status and validated range.",
  {},
  "server_info",
  () => ({})
);

registerRpcTool(
  "xrpl_fee",
  "Get current transaction cost metrics.",
  {},
  "fee",
  () => ({})
);

server.tool(
  "xrpl_public_api_call",
  "Call any XRPL JSON-RPC public API method against rippled/Clio endpoint.",
  {
    method: z.string().min(1),
    params: z.array(passthroughObject).optional(),
    id: z.union([z.string(), z.number()]).optional()
  },
  async ({ method, params, id }) => {
    try {
      const data = await xrplRpc(method, params ?? [], id ?? "xrpl-mcp");
      return toolResult(data);
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "xrplmeta_get",
  "GET XRPLMeta public API path with optional query params.",
  {
    path: z.string().min(1),
    query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
  },
  async ({ path, query }) => {
    try {
      const url = urlWithPathAndQuery(XRPLMETA_BASE_URL, path, query);
      const data = await fetchWithParse(url);
      return toToolEnvelope({
        data,
        sources: [{ system: "XRPLMeta", method: `GET ${path}`, at: nowIso() }]
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "network_overview",
  "Get network identity, health summary, key rates, and LOS freshness in one call.",
  {},
  async () => {
    try {
      // Combine rippled health and LOS indexing lag so agents can reason about freshness.
      const warnings = [];
      const serverInfoRaw = await xrplRpc("server_info", [{}]);
      const serverInfo = xrplResultEnvelope(serverInfoRaw)?.info ?? xrplResultEnvelope(serverInfoRaw);
      const validatedLedger = serverInfo?.validated_ledger ?? {};
      const validatedLedgerIndex =
        toNum(validatedLedger.seq) ??
        toNum(validatedLedger.ledger_index) ??
        toNum(validatedLedger.index) ??
        null;
      const losFreshness = await losFreshnessProbe();
      const lag = validatedLedgerIndex && losFreshness.latestIndexedLedger !== null
        ? validatedLedgerIndex - losFreshness.latestIndexedLedger
        : null;
      if (losFreshness.latestIndexedLedger === null) {
        warnings.push("LOS ingestion watermark endpoint was not detected from known paths.");
      }

      return toToolEnvelope({
        data: {
          network: serverInfo?.network_id ?? serverInfo?.network ?? "mainnet",
          validatedLedgerIndex,
          validatedLedgerCloseTime: validatedLedger.close_time_human ?? validatedLedger.close_time_iso ?? null,
          serverHealthSummary: {
            serverState: serverInfo?.server_state ?? null,
            completeLedgers: serverInfo?.complete_ledgers ?? null,
            loadFactor: toNum(serverInfo?.load_factor),
            peers: toNum(serverInfo?.peers),
            warnings: serverInfo?.warnings ?? []
          },
          keyRates: {
            ledgerLagVsLos: lag,
            loadFactor: toNum(serverInfo?.load_factor),
            peers: toNum(serverInfo?.peers)
          },
          dataFreshness: {
            losLatestIndexedLedger: losFreshness.latestIndexedLedger,
            losSourcePath: losFreshness.sourcePath
          }
        },
        sources: [
          { system: "rippled", method: "server_info", at: nowIso() },
          { system: "LOS", method: "ingestion watermark probe", at: nowIso() }
        ],
        freshness: {
          asOfLedger: validatedLedgerIndex,
          asOfTime: nowIso()
        },
        warnings
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "ledger_summary",
  "Get canonical ledger facts plus optional LOS artifact hints.",
  {
    ledger_index: z.union([z.string(), z.number()]).optional(),
    ledger_hash: z.string().optional()
  },
  async ({ ledger_index, ledger_hash }) => {
    try {
      // Canonical ledger facts come from rippled; LOS artifacts are attached opportunistically.
      const warnings = [];
      const params = {
        transactions: false,
        expand: false
      };
      if (ledger_index !== undefined) {
        params.ledger_index = ledger_index;
      }
      if (ledger_hash) {
        params.ledger_hash = ledger_hash;
      }

      const ledgerRaw = await xrplRpc("ledger", [params]);
      const ledgerResult = xrplResultEnvelope(ledgerRaw);
      const ledger = ledgerResult?.ledger ?? {};
      const canonicalIndex =
        toNum(ledger.ledger_index) ??
        toNum(ledger.ledger_index_min) ??
        toNum(ledgerResult?.ledger_index) ??
        null;

      let losArtifacts = null;
      if (canonicalIndex !== null) {
        losArtifacts = await tryLos(`/ledger/${canonicalIndex}`);
      } else if (ledger_hash) {
        losArtifacts = await tryLos(`/ledger/${ledger_hash}`);
      }
      if (!losArtifacts) {
        warnings.push("No LOS artifact endpoint matched /ledger/{index|hash}.");
      }

      return toToolEnvelope({
        data: {
          ledgerIndex: canonicalIndex,
          ledgerHash: ledger?.ledger_hash ?? ledger?.hash ?? ledger_hash ?? null,
          closeTime:
            ledger?.close_time_human ??
            ledger?.close_time_iso ??
            ledgerResult?.close_time_human ??
            null,
          txCount: toNum(ledger?.txn_count) ?? toNum(ledgerResult?.txn_count),
          feeMetrics: {
            baseFeeXrp: parseXrpDrops(ledger?.base_fee),
            reserveBaseXrp: parseXrpDrops(ledger?.reserve_base),
            reserveIncrementXrp: parseXrpDrops(ledger?.reserve_inc)
          },
          representativeTxHashes: Array.isArray(ledger?.transactions) ? ledger.transactions.slice(0, 5) : [],
          losArtifacts
        },
        sources: [
          { system: "rippled", method: "ledger", at: nowIso() },
          { system: "LOS", method: "GET /ledger/{index|hash} probe", at: nowIso() }
        ],
        freshness: {
          asOfLedger: canonicalIndex,
          asOfTime: nowIso()
        },
        warnings
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "tx_explain",
  "Get a normalized transaction explanation with classifications and related objects.",
  {
    tx_hash: z.string().min(32)
  },
  async ({ tx_hash }) => {
    try {
      // LOS is used first for enriched parse/flags, then rippled tx+meta as canonical fallback.
      const warnings = [];
      let losTx = await tryLos("/transactions", { tx_hash, hash: tx_hash, size: 1 });
      if (Array.isArray(losTx?.transactions) && losTx.transactions.length > 0) {
        losTx = losTx.transactions[0];
      }
      const txRaw = await xrplRpc("tx", [{ transaction: tx_hash }]);
      const txResult = xrplResultEnvelope(txRaw);
      const tx = txResult?.tx_json ?? txResult;
      const meta = txResult?.meta ?? txResult?.metaData ?? null;

      const transactionType = tx?.TransactionType ?? null;
      const classification = {
        isDexTrade:
          transactionType === "OfferCreate" ||
          transactionType === "AMMSwap" ||
          transactionType === "OfferCancel",
        isTransfer: transactionType === "Payment",
        isAmmRelated: String(transactionType || "").startsWith("AMM"),
        tokensInvolved: extractTokensFromTx(tx, meta)
      };

      const parties = {
        sender: tx?.Account ?? null,
        destination: tx?.Destination ?? null
      };

      const amountIn = tx?.SendMax ?? tx?.Amount ?? null;
      const amountOut = meta?.delivered_amount ?? tx?.DeliverMax ?? tx?.Amount ?? null;
      const explanation = `${transactionType ?? "Transaction"} by ${parties.sender ?? "unknown"} ${
        parties.destination ? `to ${parties.destination}` : ""
      }`.trim();

      const affectedAccounts = new Set();
      const nodes = Array.isArray(meta?.AffectedNodes) ? meta.AffectedNodes : [];
      for (const node of nodes) {
        const n = node.ModifiedNode || node.CreatedNode || node.DeletedNode;
        const ff = n?.FinalFields || {};
        const nf = n?.NewFields || {};
        if (ff.Account) {
          affectedAccounts.add(ff.Account);
        }
        if (nf.Account) {
          affectedAccounts.add(nf.Account);
        }
      }
      if (parties.sender) {
        affectedAccounts.add(parties.sender);
      }
      if (parties.destination) {
        affectedAccounts.add(parties.destination);
      }

      if (!losTx) {
        warnings.push("LOS enriched transaction record not found; classification is rippled-derived.");
      }

      return toToolEnvelope({
        data: {
          txHash: tx_hash,
          canonical: {
            tx,
            meta
          },
          classification: {
            ...classification,
            losFlags: losTx?.flags ?? null
          },
          humanExplanation: {
            summary: explanation,
            amounts: {
              in: amountIn,
              out: amountOut
            },
            parties
          },
          relatedObjects: {
            affectedAccounts: [...affectedAccounts],
            tokens: classification.tokensInvolved,
            amm: losTx?.amm ?? null,
            offers: losTx?.offers ?? null
          },
          losEnrichment: losTx
        },
        sources: [
          { system: "LOS", method: "GET /transactions", at: nowIso() },
          { system: "rippled", method: "tx", at: nowIso() }
        ],
        freshness: {
          asOfLedger: toNum(txResult?.ledger_index) ?? null,
          asOfTime: nowIso()
        },
        warnings
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "account_overview",
  "Get an account activity and state summary.",
  {
    account: z.string().min(10),
    options: passthroughObject.optional()
  },
  async ({ account, options }) => {
    try {
      // Build an agent-friendly account profile from account_info + lines + recent txs.
      const warnings = [];
      const txLimit = toNum(options?.tx_limit) ?? 100;
      const linesLimit = toNum(options?.lines_limit) ?? 400;

      const infoRaw = await xrplRpc("account_info", [{ account, ledger_index: "validated" }]);
      const linesRaw = await xrplRpc("account_lines", [{ account, ledger_index: "validated", limit: linesLimit }]);
      const txRaw = await xrplRpc("account_tx", [{ account, ledger_index_min: -1, ledger_index_max: -1, limit: txLimit }]);

      const accountData = xrplResultEnvelope(infoRaw)?.account_data ?? {};
      const lines = xrplResultEnvelope(linesRaw)?.lines ?? [];
      const txs = xrplResultEnvelope(txRaw)?.transactions ?? [];

      const trustlineCount = Array.isArray(lines) ? lines.length : 0;
      const topTokensByAbsBalance = (Array.isArray(lines) ? lines : [])
        .map((line) => ({
          currency: line.currency,
          issuer: line.account,
          balance: Number(line.balance),
          absBalance: Math.abs(Number(line.balance))
        }))
        .sort((a, b) => b.absBalance - a.absBalance)
        .slice(0, 5);

      const txTypeHistogram = {};
      const counterparties = new Map();
      for (const row of txs) {
        const tx = row.tx_json || row.tx || {};
        const type = tx.TransactionType || "Unknown";
        txTypeHistogram[type] = (txTypeHistogram[type] || 0) + 1;
        const cp = tx.Destination || tx.Account;
        if (cp && cp !== account) {
          counterparties.set(cp, (counterparties.get(cp) || 0) + 1);
        }
      }
      const recentCounterparties = [...counterparties.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([address, count]) => ({ address, interactions: count }));

      const riskIndicators = [];
      if (trustlineCount > 250) {
        riskIndicators.push("High trustline count may indicate hub/exchange behavior.");
      }
      if (Number(accountData.OwnerCount || 0) > 1000) {
        riskIndicators.push("High owner count; reserve pressure likely high.");
      }
      if (Number(accountData.Flags || 0) !== 0) {
        riskIndicators.push("Account has non-zero flags; inspect issuer permissions.");
      }

      const ownerCount = Number(accountData.OwnerCount || 0);
      const reserveEstimateXrp = 1 + ownerCount * 0.2;

      return toToolEnvelope({
        data: {
          account,
          xrpBalance: parseXrpDrops(accountData.Balance),
          ownerCount,
          reserveEstimateXrp,
          flags: accountData.Flags ?? 0,
          trustlines: {
            count: trustlineCount,
            topTokensByBalance: topTokensByAbsBalance
          },
          recentActivity: {
            txTypeHistogram,
            recentCounterparties
          },
          riskIndicators
        },
        sources: [
          { system: "rippled", method: "account_info", at: nowIso() },
          { system: "rippled", method: "account_lines", at: nowIso() },
          { system: "rippled", method: "account_tx", at: nowIso() }
        ],
        freshness: {
          asOfLedger: toNum(xrplResultEnvelope(infoRaw)?.ledger_current_index) ?? null,
          asOfTime: nowIso()
        },
        warnings
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "token_overview",
  "Get one consolidated issued-token overview.",
  {
    issuer: z.string().min(10),
    currency: z.string().min(1),
    options: passthroughObject.optional()
  },
  async ({ issuer, currency, options }) => {
    try {
      // Merge LOS token analytics with live book/AMM checks from rippled.
      const warnings = [];
      const tokenID = tokenIdFromIssuerCurrency(issuer, currency);
      if (!tokenID) {
        return toolError("Unable to normalize currency to XRPL 160-bit code.");
      }

      const tokenMeta = await tryLos(`/tokens/${encodeURIComponent(tokenID)}`);
      const txWindowSize = toNum(options?.tx_window_size) ?? 200;
      const tokenTx = await tryLos("/transactions", {
        token: tokenID,
        transactionType: "transfer",
        size: txWindowSize,
        sort_field: "timestamp",
        sort_order: "desc"
      });

      const book = await xrplRpc("book_offers", [
        {
          taker_gets: { currency, issuer },
          taker_pays: { currency: "XRP" }
        }
      ]);
      let amm = null;
      try {
        amm = await xrplRpc("amm_info", [{ asset: { currency, issuer }, asset2: { currency: "XRP" } }]);
      } catch {
        amm = null;
      }

      const offers = xrplResultEnvelope(book)?.offers ?? [];
      const bestAsk = Array.isArray(offers) && offers.length > 0 ? offers[0] : null;

      if (!tokenMeta) {
        warnings.push("LOS token metadata not found for normalized tokenID.");
      }

      return toToolEnvelope({
        data: {
          token: {
            issuer,
            currency,
            tokenID
          },
          metadata: tokenMeta?.metadata ?? tokenMeta ?? null,
          trustlineAndHolderStats: tokenMeta?.holderStats ?? tokenMeta?.holders ?? null,
          liquiditySummary: {
            orderbookBestAsk: bestAsk,
            amm: xrplResultEnvelope(amm)?.amm ?? xrplResultEnvelope(amm) ?? null
          },
          recentActivity: {
            transferSampleSize: Array.isArray(tokenTx?.transactions) ? tokenTx.transactions.length : null,
            sample: Array.isArray(tokenTx?.transactions) ? tokenTx.transactions.slice(0, 10) : tokenTx
          }
        },
        sources: [
          { system: "LOS", method: "GET /tokens/{tokenID}", at: nowIso() },
          { system: "LOS", method: "GET /transactions", at: nowIso() },
          { system: "rippled", method: "book_offers", at: nowIso() },
          { system: "rippled", method: "amm_info", at: nowIso() }
        ],
        freshness: {
          asOfLedger: toNum(xrplResultEnvelope(book)?.ledger_index) ?? null,
          asOfTime: nowIso()
        },
        warnings
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "market_snapshot",
  "Get a live market snapshot for base/quote including orderbook, AMM, and recent LOS trades.",
  {
    base: passthroughObject,
    quote: passthroughObject,
    options: passthroughObject.optional()
  },
  async ({ base, quote, options }) => {
    try {
      // Unified market view: orderbook + AMM state + recent LOS DEX trades.
      const warnings = [];
      const window = String(options?.window || "1h");
      const txSize = toNum(options?.size) ?? 200;
      const bookRaw = await xrplRpc("book_offers", [{ taker_gets: base, taker_pays: quote, limit: 50 }]);
      const bookResult = xrplResultEnvelope(bookRaw);
      const offers = bookResult?.offers ?? [];
      const best = Array.isArray(offers) && offers.length ? offers[0] : null;
      let ammRaw = null;
      try {
        ammRaw = await xrplRpc("amm_info", [{ asset: base, asset2: quote }]);
      } catch {
        ammRaw = null;
      }

      const losTrades = await tryLos("/transactions", {
        transactionType: "dex-trade",
        size: txSize,
        sort_field: "timestamp",
        sort_order: "desc"
      });

      const recentTrades = Array.isArray(losTrades?.transactions) ? losTrades.transactions : [];
      const vwapNumerator = recentTrades.reduce((sum, t) => sum + Number(t.price || 0) * Number(t.amount || 0), 0);
      const vwapDenominator = recentTrades.reduce((sum, t) => sum + Number(t.amount || 0), 0);
      const vwap = vwapDenominator > 0 ? vwapNumerator / vwapDenominator : null;

      if (!recentTrades.length) {
        warnings.push("No LOS trade samples returned for VWAP estimate.");
      }

      return toToolEnvelope({
        data: {
          orderbook: {
            bestBidAskProxy: best,
            spread: best?.quality ? Number(best.quality) : null,
            mid: best?.quality ? Number(best.quality) : null,
            offerCount: Array.isArray(offers) ? offers.length : 0
          },
          amm: xrplResultEnvelope(ammRaw)?.amm ?? xrplResultEnvelope(ammRaw) ?? null,
          recentTrades: {
            window,
            count: recentTrades.length,
            vwap,
            sample: recentTrades.slice(0, 20)
          }
        },
        sources: [
          { system: "rippled", method: "book_offers", at: nowIso() },
          { system: "rippled", method: "amm_info", at: nowIso() },
          { system: "LOS", method: "GET /transactions?transactionType=dex-trade", at: nowIso() }
        ],
        freshness: {
          asOfLedger: toNum(bookResult?.ledger_index) ?? null,
          asOfTime: nowIso()
        },
        warnings
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "amm_overview",
  "Get AMM state and recent swap activity.",
  {
    amm_id: z.string().optional(),
    assetA: passthroughObject.optional(),
    assetB: passthroughObject.optional(),
    options: passthroughObject.optional()
  },
  async ({ amm_id, assetA, assetB, options }) => {
    try {
      // AMM state is canonical from rippled; swap activity is sampled from LOS trades.
      const warnings = [];
      const params = {};
      if (amm_id) {
        params.amm_account = amm_id;
      } else {
        params.asset = assetA;
        params.asset2 = assetB;
      }
      const ammRaw = await xrplRpc("amm_info", [params]);
      const amm = xrplResultEnvelope(ammRaw)?.amm ?? xrplResultEnvelope(ammRaw);

      const txSize = toNum(options?.size) ?? 200;
      const losSwaps = await tryLos("/transactions", {
        transactionType: "dex-trade",
        size: txSize,
        sort_field: "timestamp",
        sort_order: "desc"
      });

      const swaps = Array.isArray(losSwaps?.transactions) ? losSwaps.transactions : [];
      const volume = swaps.reduce((sum, row) => sum + Math.abs(Number(row.amount || 0)), 0);

      return toToolEnvelope({
        data: {
          amm,
          recentSwaps: {
            count: swaps.length,
            volume,
            sample: swaps.slice(0, 20)
          },
          priceImpactHooks: {
            note: "Use reserves plus candidate trade size to estimate slippage."
          }
        },
        sources: [
          { system: "rippled", method: "amm_info", at: nowIso() },
          { system: "LOS", method: "GET /transactions?transactionType=dex-trade", at: nowIso() }
        ],
        freshness: {
          asOfLedger: toNum(xrplResultEnvelope(ammRaw)?.ledger_index) ?? null,
          asOfTime: nowIso()
        },
        warnings
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "validator_set_overview",
  "Get validator set composition and recent change-oriented summary.",
  {
    options: passthroughObject.optional()
  },
  async ({ options }) => {
    try {
      // VHS snapshot used for basic set composition and concentration summary.
      const warnings = [];
      const group = options?.group ? `/${encodeURIComponent(String(options.group))}` : "";
      const validatorsRaw = await fetchWithParse(urlWithPathAndQuery(DATA_XRPL_BASE_URL, `/v1/network/validators${group}`));
      const list = Array.isArray(validatorsRaw?.validators)
        ? validatorsRaw.validators
        : Array.isArray(validatorsRaw)
          ? validatorsRaw
          : [];
      const byOperator = {};
      for (const v of list) {
        const org = v.domain || v.operator || v.owner || "unknown";
        byOperator[org] = (byOperator[org] || 0) + 1;
      }

      return toToolEnvelope({
        data: {
          validatorCount: list.length,
          byOperator,
          currentSet: list.slice(0, 200),
          notableEvents: {
            note: "Use repeated snapshots of this tool for 7/30/90 day diffing."
          }
        },
        sources: [{ system: "VHS", method: "GET /v1/network/validators", at: nowIso() }],
        freshness: {
          asOfTime: nowIso()
        },
        warnings
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "validator_health",
  "Get validator performance summary over a report window.",
  {
    pubkey_or_node: z.string().min(8),
    window: z.string().optional()
  },
  async ({ pubkey_or_node, window }) => {
    try {
      // Health summary is derived from VHS validator profile + report history.
      const warnings = [];
      const validator = await fetchWithParse(
        urlWithPathAndQuery(DATA_XRPL_BASE_URL, `/v1/network/validator/${encodeURIComponent(pubkey_or_node)}`)
      );
      const reports = await fetchWithParse(
        urlWithPathAndQuery(DATA_XRPL_BASE_URL, `/v1/network/validator/${encodeURIComponent(pubkey_or_node)}/reports`)
      );
      const reportList = Array.isArray(reports?.reports) ? reports.reports : Array.isArray(reports) ? reports : [];
      const recent = reportList.slice(-30);
      const signed = recent.reduce((sum, r) => sum + Number(r.signed || r.validations_signed || 0), 0);
      const missed = recent.reduce((sum, r) => sum + Number(r.missed || r.validations_missed || 0), 0);
      const uptimeish = signed + missed > 0 ? signed / (signed + missed) : null;

      if (!reportList.length) {
        warnings.push("Validator report history is empty for this key.");
      }

      return toToolEnvelope({
        data: {
          validator,
          window: window || "last-30-reports",
          metrics: {
            validationsSigned: signed,
            validationsMissed: missed,
            uptimeScore: uptimeish
          },
          recentReports: recent
        },
        sources: [
          { system: "VHS", method: "GET /v1/network/validator/{pubkey}", at: nowIso() },
          { system: "VHS", method: "GET /v1/network/validator/{pubkey}/reports", at: nowIso() }
        ],
        freshness: {
          asOfTime: nowIso()
        },
        warnings
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "amendment_status",
  "Get enabled amendments and governance context.",
  {
    network: z.string().optional()
  },
  async ({ network }) => {
    try {
      // Governance context joins VHS amendment history with current rippled network context.
      const warnings = [];
      const vhInfo = await fetchWithParse(urlWithPathAndQuery(DATA_XRPL_BASE_URL, "/v1/network/amendments/info"));
      const votes = network
        ? await fetchWithParse(
          urlWithPathAndQuery(DATA_XRPL_BASE_URL, `/v1/network/amendments/vote/${encodeURIComponent(network)}`)
        )
        : null;
      const serverInfo = await xrplRpc("server_info", [{}]);

      return toToolEnvelope({
        data: {
          enabledAmendments: vhInfo?.enabled ?? vhInfo?.amendments ?? vhInfo,
          votingStatus: votes,
          networkContext: {
            requested: network ?? null,
            rippledNetwork: xrplResultEnvelope(serverInfo)?.info?.network_id ?? null
          }
        },
        sources: [
          { system: "VHS", method: "GET /v1/network/amendments/info", at: nowIso() },
          { system: "rippled", method: "server_info", at: nowIso() }
        ],
        freshness: { asOfTime: nowIso() },
        warnings
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "search_transactions",
  "Search LOS transactions with open-ended filters and return aggregate summary.",
  {
    filters: passthroughObject,
    cursor: z.string().optional(),
    size: z.number().int().positive().max(1000).optional()
  },
  async ({ filters, cursor, size }) => {
    try {
      // Open-ended LOS query endpoint with aggregate block for agent convenience.
      const query = {
        ...filters,
        marker: cursor || filters.marker,
        size: size ?? filters.size ?? 200
      };
      const payload = await callLos("/transactions", query);
      const rows = Array.isArray(payload?.transactions) ? payload.transactions : Array.isArray(payload) ? payload : [];
      const txTypes = {};
      for (const row of rows) {
        const t = row.transactionType || row.type || row.tx_type || "unknown";
        txTypes[t] = (txTypes[t] || 0) + 1;
      }

      return toToolEnvelope({
        data: {
          results: rows,
          cursor: payload?.marker ?? payload?.next ?? null,
          aggregates: {
            count: rows.length,
            txTypeHistogram: txTypes,
            totalAmount: rows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
          }
        },
        sources: [{ system: "LOS", method: "GET /transactions", at: nowIso() }],
        freshness: { asOfTime: nowIso() },
        warnings: []
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "resolve_entities",
  "Resolve user input into canonical XRPL/LOS entity identifiers and suggested next tools.",
  {
    input: z.string().min(1)
  },
  async ({ input }) => {
    try {
      // Lightweight identifier resolver to reduce guessing in multi-step tool chains.
      const value = input.trim();
      const suggestions = [];
      let entity = {
        type: "unknown",
        normalized: value
      };

      if (/^[A-Fa-f0-9]{64}$/.test(value)) {
        entity = { type: "tx_hash", normalized: value.toUpperCase() };
        suggestions.push("tx_explain", "xrpl_tx");
      } else if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) {
        entity = { type: "account", normalized: value };
        suggestions.push("account_overview", "xrpl_account_info");
      } else if (/^[A-Fa-f0-9]{40}\.r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) {
        entity = { type: "token_id", normalized: value.toUpperCase() };
        suggestions.push("token_overview", "los_get_token");
      } else if (/^[0-9]+$/.test(value)) {
        entity = { type: "ledger_index", normalized: Number(value) };
        suggestions.push("ledger_summary", "xrpl_ledger");
      } else if (value.includes(".")) {
        entity = { type: "domain_or_host", normalized: value.toLowerCase() };
        suggestions.push("xrplmeta_get", "validator_set_overview");
      }

      return toToolEnvelope({
        data: {
          entity,
          nextTools: suggestions
        },
        sources: [{ system: "local-resolver", method: "pattern-match", at: nowIso() }],
        freshness: { asOfTime: nowIso() },
        warnings: entity.type === "unknown" ? ["Input did not match known XRPL identifier patterns."] : []
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  "xrpl_list_recommended_methods",
  "List the curated high-utility XRPL methods this MCP server exposes as dedicated tools.",
  {},
  async () => {
    const methods = [
      "account_info",
      "account_objects",
      "account_lines",
      "account_tx",
      "ledger",
      "ledger_data",
      "ledger_entry",
      "tx",
      "book_offers",
      "amm_info",
      "nft_info",
      "nft_history",
      "nfts_by_issuer",
      "server_info",
      "fee"
    ];
    return toolResult({ methods });
  }
);

async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function getPathname(url, fallback = "/") {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return fallback;
  }
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

async function startHttp() {
  if (!Number.isFinite(MCP_HTTP_PORT) || MCP_HTTP_PORT < 1 || MCP_HTTP_PORT > 65535) {
    throw new Error(`Invalid MCP_HTTP_PORT/PORT value: ${String(process.env.MCP_HTTP_PORT ?? process.env.PORT)}`);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  });
  await server.connect(transport);

  const httpServer = createServer(async (req, res) => {
    try {
      const pathname = getPathname(req.url || "/");

      if (pathname === "/health") {
        return writeJson(res, 200, {
          ok: true,
          name: "xrpl-data-mcp",
          transport: "streamable-http",
          endpoint: MCP_HTTP_PATH
        });
      }

      if (pathname !== MCP_HTTP_PATH) {
        return writeJson(res, 404, {
          error: "Not Found",
          message: `Use ${MCP_HTTP_PATH} for MCP requests.`
        });
      }

      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        writeJson(res, 500, {
          error: "Internal Server Error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(MCP_HTTP_PORT, MCP_HTTP_HOST, resolve);
  });

  console.error(`MCP HTTP server listening on http://${MCP_HTTP_HOST}:${MCP_HTTP_PORT}${MCP_HTTP_PATH}`);

  const shutdown = async () => {
    try {
      await transport.close();
    } finally {
      httpServer.close(() => process.exit(0));
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function main() {
  if (MCP_TRANSPORT === "stdio") {
    await startStdio();
    return;
  }
  await startHttp();
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
