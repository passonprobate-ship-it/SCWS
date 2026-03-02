const { readFileSync } = require('fs');
const envFile = readFileSync('/var/www/scws/daemon/.env', 'utf-8');
const env = {};
for (const line of envFile.split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}
module.exports = {
  apps: [{
    name: 'scws-daemon',
    script: 'dist/index.cjs',
    cwd: '/var/www/scws/daemon',
    node_args: '--dns-result-order=ipv4first --max-old-space-size=192',
    max_memory_restart: '200M',
    env
  }]
};
