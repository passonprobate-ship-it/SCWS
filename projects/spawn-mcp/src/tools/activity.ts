import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query } from "../db.js";

export function registerActivityTools(server: McpServer): void {
  server.registerTool("spawn_get_activity", {
    description:
      "Get recent activity log entries from SPAWN (project created, built, deployed, started, stopped, etc.)",
    inputSchema: {
      limit: z.number().default(20).describe("Number of entries to return (max 100)"),
      project: z.string().optional().describe("Filter by project name (optional)"),
    },
  }, async ({ limit, project }) => {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const params: any[] = [];

    let sql = `SELECT a.id, a.action, a.details, a.created_at, p.name AS project_name
               FROM activity_log a
               LEFT JOIN projects p ON a.project_id = p.id`;

    if (project) {
      sql += ` WHERE p.name = $1`;
      params.push(project);
    }

    sql += ` ORDER BY a.created_at DESC LIMIT $${params.length + 1}`;
    params.push(safeLimit);

    const result = await query(sql, params);
    return {
      content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
    };
  });
}
