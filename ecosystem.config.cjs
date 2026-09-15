const os = require('node:os');
const path = require('node:path');

const NODE = process.env.ACTPIPE_NODE || '/opt/homebrew/opt/node@22/bin/node';

module.exports = {
  apps: [
    {
      name: 'actpipe',
      script: path.join(__dirname, 'src', 'server', 'pm2-entry.cjs'),
      interpreter: NODE, // 钉死解释器路径，防 nvm 升级后复活失败
      node_args: ['--experimental-sqlite', '--experimental-strip-types'],
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      out_file: path.join(os.homedir(), 'Library', 'Logs', 'actpipe', 'server.out.log'),
      error_file: path.join(os.homedir(), 'Library', 'Logs', 'actpipe', 'server.err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
