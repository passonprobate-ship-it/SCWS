import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const FINWIZ_URL = process.env.FINWIZ_URL || "http://localhost:5031";
const FINWIZ_TOKEN = process.env.FINWIZ_TOKEN || "finwiz_secure_token_change_me";

async function finwizGet(path: string): Promise<any> {
  const res = await fetch(`${FINWIZ_URL}${path}`, {
    headers: { Authorization: `Bearer ${FINWIZ_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return res.json();
}

async function finwizPost(path: string, body?: any): Promise<any> {
  const res = await fetch(`${FINWIZ_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FINWIZ_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return res.json();
}

export function registerFinwizTools(server: McpServer): void {
  server.registerTool(
    "finwiz_portfolio",
    {
      description:
        "Get the user's aggregated portfolio summary from FinWiz — total value, fiat/crypto split, holdings, risk score (HHI concentration), and 24h change.",
      inputSchema: {},
    },
    async () => {
      const data = await finwizGet("/api/portfolio");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "finwiz_recommendations",
    {
      description:
        "Get active recommendations from FinWiz — investment opportunities, yield alerts, rebalancing suggestions, money-movement strategies, and risk warnings.",
      inputSchema: {
        status: z
          .string()
          .default("active")
          .describe(
            "Filter by status: active, dismissed, acted, expired (default: active)"
          ),
        category: z
          .string()
          .optional()
          .describe(
            "Filter by category: invest, rebalance, hedge, move_money, alert, yield"
          ),
      },
    },
    async ({ status, category }) => {
      let path = `/api/recommendations?status=${status}`;
      const data = await finwizGet(path);
      let recs = Array.isArray(data) ? data : [];
      if (category) {
        recs = recs.filter((r: any) => r.category === category);
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(recs, null, 2) }],
      };
    }
  );

  server.registerTool(
    "finwiz_analyze",
    {
      description:
        "Trigger an immediate FinWiz analysis cycle — gathers portfolio state, scans markets (crypto prices, FX rates, Fear & Greed), finds opportunities, checks alerts, and returns findings.",
      inputSchema: {},
    },
    async () => {
      const result = await finwizPost("/api/analysis/cycle");
      // Also fetch the latest market overview for context
      const market = await finwizGet("/api/market/overview");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                cycle: result,
                market,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
