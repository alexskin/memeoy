// PM2 process-manager config for the worker (scripts/worker.ts). Wherever
// you actually host the worker long-term (never Vercel - see README's
// "Public read-only dashboard" section, Vercel only ever runs the
// dashboard), this gives it auto-restart on crash and a start/stop that
// works from the command line, independent of the dashboard's own PAUSE/
// STOP controls (which are hidden entirely on a NEXT_PUBLIC_READ_ONLY
// deployment - there's nothing to click there).
module.exports = {
  apps: [
    {
      name: 'memeoy-worker',
      // Point straight at tsx's CLI entry (a plain .cjs file, run with the
      // default node interpreter) instead of 'npm run worker' - PM2's
      // script resolution doesn't reliably shell out through npm.cmd/
      // npx.cmd on Windows (it can end up trying to run the .cmd file
      // itself as JS), so going through tsx directly keeps this identical
      // on Windows and Linux.
      script: 'node_modules/tsx/dist/cli.cjs',
      args: '--env-file=.env.local scripts/worker.ts',
      cwd: __dirname,
      autorestart: true,
      // If it can't stay up at least this long between restarts, retrying
      // forever isn't productive - cap it and surface the failure instead
      // of masking a broken deploy behind an endless restart loop.
      min_uptime: '30s',
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
