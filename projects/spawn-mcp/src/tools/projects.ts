import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query } from "../db.js";
import { daemonPost, daemonGet } from "../daemon-client.js";

export function registerProjectTools(server: McpServer): void {
  server.registerTool("spawn_list_projects", {
    description:
      "List all SPAWN projects with their status, port, framework, and description",
    inputSchema: {},
  }, async () => {
    const result = await query(
      `SELECT name, display_name, description, port, status, framework,
              git_repo, db_name, entry_file, build_command,
              last_build_at, created_at, updated_at
       FROM projects ORDER BY created_at DESC`
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
    };
  });

  server.registerTool("spawn_get_project", {
    description: "Get detailed information about a specific SPAWN project",
    inputSchema: {
      name: z.string().describe("Project name (e.g. 'solbot', 'galleria')"),
    },
  }, async ({ name }) => {
    const result = await query(`SELECT * FROM projects WHERE name = $1`, [name]);
    if (result.rows.length === 0) {
      return {
        content: [{ type: "text", text: `Project '${name}' not found` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result.rows[0], null, 2) }],
    };
  });

  server.registerTool("spawn_create_project", {
    description:
      "Create a new SPAWN project. Creates directory, registers in database. Does NOT write code — use Claude Code's file tools for that.",
    inputSchema: {
      name: z.string().describe("Project name (lowercase, no spaces)"),
      displayName: z.string().optional().describe("Display name"),
      description: z.string().optional().describe("Project description"),
      framework: z
        .enum(["express", "next", "static", "other"])
        .default("express")
        .describe("Framework type"),
    },
  }, async ({ name, displayName, description, framework }) => {
    const res = await daemonPost("/api/projects", {
      name,
      displayName: displayName || name,
      description: description || "",
      framework,
    });
    if (!res.ok) {
      return {
        content: [{ type: "text", text: `Failed to create project: ${JSON.stringify(res.data)}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  });

  server.registerTool("spawn_start_project", {
    description: "Start a SPAWN project via PM2",
    inputSchema: {
      name: z.string().describe("Project name"),
    },
  }, async ({ name }) => {
    const res = await daemonPost(`/api/projects/${encodeURIComponent(name)}/start`);
    if (!res.ok) {
      return {
        content: [{ type: "text", text: `Failed to start '${name}': ${JSON.stringify(res.data)}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Project '${name}' started successfully` }],
    };
  });

  server.registerTool("spawn_stop_project", {
    description: "Stop a running SPAWN project via PM2",
    inputSchema: {
      name: z.string().describe("Project name"),
    },
  }, async ({ name }) => {
    const res = await daemonPost(`/api/projects/${encodeURIComponent(name)}/stop`);
    if (!res.ok) {
      return {
        content: [{ type: "text", text: `Failed to stop '${name}': ${JSON.stringify(res.data)}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Project '${name}' stopped successfully` }],
    };
  });

  server.registerTool("spawn_build_project", {
    description: "Run the build command for a SPAWN project",
    inputSchema: {
      name: z.string().describe("Project name"),
    },
  }, async ({ name }) => {
    const res = await daemonPost(`/api/projects/${encodeURIComponent(name)}/build`);
    if (!res.ok) {
      return {
        content: [{ type: "text", text: `Build failed for '${name}': ${JSON.stringify(res.data)}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  });

  server.registerTool("spawn_get_project_logs", {
    description: "Get recent PM2 logs for a SPAWN project",
    inputSchema: {
      name: z.string().describe("Project name"),
      lines: z.number().default(50).describe("Number of log lines to return"),
    },
  }, async ({ name, lines }) => {
    const res = await daemonGet(
      `/api/projects/${encodeURIComponent(name)}/logs?lines=${lines}`
    );
    if (!res.ok) {
      return {
        content: [{ type: "text", text: `Failed to get logs for '${name}': ${JSON.stringify(res.data)}` }],
        isError: true,
      };
    }
    // Strip ANSI codes for cleaner output
    const logs = (res.data?.logs || "").replace(
      /\x1b\[[0-9;]*m/g,
      ""
    );
    return {
      content: [{ type: "text", text: logs || "No logs available" }],
    };
  });
}
