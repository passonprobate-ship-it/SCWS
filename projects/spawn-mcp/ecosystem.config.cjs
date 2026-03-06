module.exports = {
  apps: [{
    name: "spawn-mcp",
    script: "dist/index.cjs",
    cwd: "/var/www/scws/projects/spawn-mcp",
    node_args: "--env-file=.env",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    max_memory_restart: "100M",
    env: {
      NODE_ENV: "production",
    },
  }],
};
