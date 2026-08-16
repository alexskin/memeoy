// Guards against accidentally running two worker processes against the same
// DB at once. This actually happened during development: repeated
// restart-without-confirming-the-old-one-died left several worker
// processes racing the same non-transactional meta.virtual_balance_quote
// read-modify-write, silently losing debits and inflating the paper
// balance by several SOL. A stale PID check is enough for a single-local-
// user tool - no need for real file locking.
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const LOCK_PATH = path.join(process.cwd(), '.local-data', 'worker.lock');

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't kill anything - it just checks the PID exists and
    // is ours to signal, which is exactly the existence check we want.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireWorkerLock(): void {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });

  if (fs.existsSync(LOCK_PATH)) {
    const existingPid = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim());
    if (existingPid && isProcessAlive(existingPid)) {
      logger.error(
        { existingPid },
        `Another worker process (PID ${existingPid}) is already running against this DB. ` +
          `Running two workers at once corrupts the shared balance (confirmed - see project notes). ` +
          `Stop it first, or delete ${LOCK_PATH} if you're sure it's stale.`,
      );
      process.exit(1);
    }
    logger.warn({ stalePid: existingPid }, 'Found a stale worker.lock from a dead process - removing it');
  }

  fs.writeFileSync(LOCK_PATH, String(process.pid));

  const release = () => {
    try {
      if (fs.existsSync(LOCK_PATH) && Number(fs.readFileSync(LOCK_PATH, 'utf8').trim()) === process.pid) {
        fs.unlinkSync(LOCK_PATH);
      }
    } catch {
      // best-effort cleanup only
    }
  };

  process.on('exit', release);
}
