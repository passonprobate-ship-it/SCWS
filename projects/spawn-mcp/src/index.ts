import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { authMiddleware } from "./auth.js";
import { ensureTables, query } from "./db.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerSystemTools } from "./tools/system.js";
import { registerDatabaseTools } from "./tools/database.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerActivityTools } from "./tools/activity.js";
import { registerAgentmailTools } from "./tools/agentmail.js";
import { registerSearchTools } from "./tools/search.js";
import { registerFinwizTools } from "./tools/finwiz.js";
import { checkNewEmail, startPoller } from "./email-poller.js";
import { amGet } from "./agentmail-client.js";

const PORT = parseInt(process.env.PORT || "5020", 10);
const INBOX_ID = "robot_001@agentmail.to";

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "spawn",
      version: "1.0.0",
    },
    { capabilities: { logging: {} } }
  );

  registerProjectTools(server);
  registerSystemTools(server);
  registerDatabaseTools(server);
  registerMemoryTools(server);
  registerActivityTools(server);
  registerAgentmailTools(server);
  registerSearchTools(server);
  registerFinwizTools(server);

  return server;
}

async function main(): Promise<void> {
  await ensureTables();
  console.log("[spawn-mcp] Database tables ensured");

  const app = express();
  app.use(express.json());

  // Health check (no auth)
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "spawn-mcp", version: "1.0.0" });
  });

  // --- AgentMail REST endpoints ---

  // Check for new email on demand
  app.post("/check-email", authMiddleware, async (_req, res) => {
    try {
      const result = await checkNewEmail();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "check-email failed" });
    }
  });

  // Get inbox status overview
  app.get("/inbox-status", authMiddleware, async (_req, res) => {
    try {
      const [inboxRes, messagesRes, lastCheckedRow] = await Promise.all([
        amGet(`/inboxes/${encodeURIComponent(INBOX_ID)}`),
        amGet(`/inboxes/${encodeURIComponent(INBOX_ID)}/messages?limit=5`),
        query(`SELECT value FROM spawn_memories WHERE key = $1`, [
          "agentmail-last-checked",
        ]),
      ]);

      res.json({
        connected: inboxRes.ok,
        inbox: inboxRes.ok ? inboxRes.data : null,
        recentMessages: messagesRes.ok
          ? messagesRes.data?.items || messagesRes.data?.messages || []
          : [],
        lastChecked:
          lastCheckedRow.rows.length > 0
            ? lastCheckedRow.rows[0].value
            : null,
      });
    } catch (err: any) {
      res.json({ connected: false, error: err.message || "inbox-status failed" });
    }
  });

  // MCP endpoint (auth required)
  app.post("/mcp", authMiddleware, async (req, res) => {
    const server = createServer();
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error: any) {
      console.error("[spawn-mcp] Error handling request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Reject GET/DELETE on /mcp (stateless mode)
  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`[spawn-mcp] MCP server listening on http://127.0.0.1:${PORT}/mcp`);
    startPoller();
  });
}

main().catch((err) => {
  console.error("[spawn-mcp] Fatal error:", err);
  process.exit(1);
});
