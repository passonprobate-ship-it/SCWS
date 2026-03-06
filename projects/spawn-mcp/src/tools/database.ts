import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query } from "../db.js";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export function registerDatabaseTools(server: McpServer): void {
  server.registerTool("spawn_list_databases", {
    description: "List all PostgreSQL databases on SPAWN",
    inputSchema: {},
  }, async () => {
    const result = await query(
      `SELECT datname AS name,
              pg_size_pretty(pg_database_size(datname)) AS size,
              datdba::regrole::text AS owner
       FROM pg_database
       WHERE datistemplate = false
       ORDER BY datname`
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
    };
  });

  server.registerTool("spawn_create_database", {
    description:
      "Create a new PostgreSQL database owned by the scws user. For use by SPAWN projects.",
    inputSchema: {
      name: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,62}$/)
        .describe("Database name (lowercase, underscores ok, max 63 chars)"),
    },
  }, async ({ name }) => {
    // Check if it already exists
    const check = await query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [name]
    );
    if (check.rows.length > 0) {
      return {
        content: [{ type: "text", text: `Database '${name}' already exists` }],
        isError: true,
      };
    }

    try {
      await execFileAsync("sudo", [
        "-u", "postgres",
        "psql", "-c",
        `CREATE DATABASE ${name} OWNER scws;`,
      ], { timeout: 10000 });
      return {
        content: [{ type: "text", text: `Database '${name}' created successfully (owner: scws)` }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Failed to create database: ${err.message}` }],
        isError: true,
      };
    }
  });
}
