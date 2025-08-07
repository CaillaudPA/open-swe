import { Hono } from "hono";
import { issueWebhookHandler } from "./github/issue-webhook.js";
import { mcpServerApp } from "./mcp-server.js";

export const app = new Hono();

// GitHub webhook handler
app.post("/webhooks/github", issueWebhookHandler);

// Mount MCP server routes
app.route("/mcp", mcpServerApp);
