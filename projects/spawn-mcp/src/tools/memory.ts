import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query } from "../db.js";

export function registerMemoryTools(server: McpServer): void {
  server.registerTool("spawn_remember", {
    description:
      "Store a key-value pair in SPAWN's persistent memory. Upserts — overwrites if key exists.",
    inputSchema: {
      key: z.string().describe("Memory key (unique identifier)"),
      value: z.string().describe("Value to store"),
      tags: z.array(z.string()).default([]).describe("Optional tags for categorization"),
    },
  }, async ({ key, value, tags }) => {
    await query(
      `INSERT INTO spawn_memories (key, value, tags)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, tags = $3, updated_at = NOW()`,
      [key, value, JSON.stringify(tags)]
    );
    return {
      content: [{ type: "text", text: `Remembered '${key}' successfully` }],
    };
  });

  server.registerTool("spawn_recall", {
    description: "Retrieve a memory by key from SPAWN's persistent memory",
    inputSchema: {
      key: z.string().describe("Memory key to retrieve"),
    },
  }, async ({ key }) => {
    const result = await query(
      `SELECT key, value, tags, created_at, updated_at FROM spawn_memories WHERE key = $1`,
      [key]
    );
    if (result.rows.length === 0) {
      return {
        content: [{ type: "text", text: `No memory found for key '${key}'` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result.rows[0], null, 2) }],
    };
  });

  server.registerTool("spawn_forget", {
    description: "Delete a memory by key from SPAWN's persistent memory",
    inputSchema: {
      key: z.string().describe("Memory key to delete"),
    },
  }, async ({ key }) => {
    const result = await query(
      `DELETE FROM spawn_memories WHERE key = $1 RETURNING key`,
      [key]
    );
    if (result.rowCount === 0) {
      return {
        content: [{ type: "text", text: `No memory found for key '${key}'` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Forgot '${key}' successfully` }],
    };
  });

  server.registerTool("spawn_list_memories", {
    description:
      "List all stored memories in SPAWN. Returns keys, tags, and timestamps (not values, to keep output concise).",
    inputSchema: {
      tag: z.string().optional().describe("Filter by tag (optional)"),
    },
  }, async ({ tag }) => {
    let sql = `SELECT key, tags, created_at, updated_at FROM spawn_memories`;
    const params: any[] = [];
    if (tag) {
      sql += ` WHERE tags @> $1`;
      params.push(JSON.stringify([tag]));
    }
    sql += ` ORDER BY updated_at DESC`;
    const result = await query(sql, params);
    return {
      content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
    };
  });
}
