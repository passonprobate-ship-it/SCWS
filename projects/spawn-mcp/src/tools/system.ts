import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { daemonGet } from "../daemon-client.js";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export function registerSystemTools(server: McpServer): void {
  server.registerTool("spawn_system_status", {
    description:
      "Get SPAWN system status: CPU temp, memory, disk, load average, uptime, running projects",
    inputSchema: {},
  }, async () => {
    const res = await daemonGet("/api/system");
    if (!res.ok) {
      return {
        content: [{ type: "text", text: `Failed to get system status: ${JSON.stringify(res.data)}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  });

  server.registerTool("spawn_pm2_list", {
    description: "List all PM2 processes with their status, memory, CPU usage",
    inputSchema: {},
  }, async () => {
    try {
      const { stdout } = await execFileAsync("pm2", ["jlist"], {
        timeout: 10000,
      });
      const processes = JSON.parse(stdout);
      const summary = processes.map((p: any) => ({
        name: p.name,
        pm_id: p.pm_id,
        status: p.pm2_env?.status,
        memory: p.monit?.memory
          ? `${Math.round(p.monit.memory / 1024 / 1024)}MB`
          : "N/A",
        cpu: p.monit?.cpu ?? "N/A",
        uptime: p.pm2_env?.pm_uptime
          ? `${Math.round((Date.now() - p.pm2_env.pm_uptime) / 1000 / 60)}min`
          : "N/A",
        restarts: p.pm2_env?.restart_time ?? 0,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Failed to list PM2 processes: ${err.message}` }],
        isError: true,
      };
    }
  });
}
