import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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

async function main() {
  const endpoint = process.argv[2] ?? process.env.MCP_SERVER_URL ?? "http://127.0.0.1:3000/mcp";
  const toolName = process.argv[3] ?? "xrpl_server_info";
  const rawArgs = process.argv[4] ?? "{}";

  let args = {};
  try {
    args = JSON.parse(rawArgs);
  } catch (error) {
    console.error("Invalid JSON for tool args:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const client = new Client({ name: "xrpl-mcp-http-tester", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const result = await client.callTool({ name: toolName, arguments: args });
    const payload = parseToolPayload(result);

    console.log(
      JSON.stringify(
        {
          endpoint,
          toolCount: Array.isArray(tools?.tools) ? tools.tools.length : null,
          toolName,
          args,
          isError: Boolean(result?.isError),
          payload
        },
        null,
        2
      )
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("HTTP tool test failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
