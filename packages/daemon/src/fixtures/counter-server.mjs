// A small stdio MCP server for the tests of the gateway. Its one tool counts the calls and gives its process ID,
// so a test can see that two sessions share one process. With `steps`, it sends that many progress notifications.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

let count = 0;
const server = new McpServer({ name: "counter", version: "1.0.0" }, { instructions: "Counts the calls." });
server.registerTool(
  "count",
  { description: "Count one call", inputSchema: { steps: z.number().int().min(0).max(5).optional() } },
  async ({ steps }, extra) => {
    const token = extra._meta?.progressToken;
    // A pause after each step: the SDK client drops a progress notification that comes in one read with the result.
    for (let step = 1; step <= (steps ?? 0); step++) {
      if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, total: steps } });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    count += 1;
    return { content: [{ type: "text", text: JSON.stringify({ count, pid: process.pid, title: process.title, server: process.env.HEADROOM_MCP_SERVER }) }] };
  },
);
server.registerTool("confirm", { description: "Ask the person a question" }, async () => {
  const answer = await server.server.elicitInput({
    message: "Release the page?",
    requestedSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  });
  return { content: [{ type: "text", text: JSON.stringify(answer) }] };
});
await server.connect(new StdioServerTransport());
