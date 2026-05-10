/**
 * PM2 ecosystem file for VPS / non-container production deployments.
 *
 * Use cases:
 *   - bare-metal or single-VPS deployment without Docker
 *   - the Dockerfile path remains the recommended approach for cloud
 *
 * Run:
 *   npm run build
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save  # persist across reboots (with `pm2 startup`)
 *
 * Cluster mode forks one node process per CPU. The API is fully
 * stateless (no per-process session store), so this scales horizontally
 * on a single host with zero coordination cost.
 *
 * `kill_timeout` matches the graceful-shutdown deadline in
 * `src/server.ts` so PM2 doesn't SIGKILL mid-drain.
 */
module.exports = {
  apps: [
    {
      name: 'splitzy-api',
      script: './dist/server.js',
      cwd: __dirname,
      instances: 'max',
      exec_mode: 'cluster',

      // Restart policy
      max_memory_restart: '512M',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '60s',

      // Graceful shutdown — must be ≥ the 10s deadline in server.ts
      kill_timeout: 12_000,
      shutdown_with_message: false,
      wait_ready: false,

      // Logs (rotate via pm2-logrotate or your platform's log shipping)
      out_file: './logs/api-out.log',
      error_file: './logs/api-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
        // Real values come from the host's process env / dotenv-cli /
        // a secrets manager. PM2 only injects NODE_ENV here.
      },
    },
  ],
};
