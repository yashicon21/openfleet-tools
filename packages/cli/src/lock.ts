import fs from "node:fs";

const STALE_MS = 10_000;
const TIMEOUT_MS = 15_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process exclusive lock using an O_EXCL lock file. Synchronous so it
 * can be used from short-lived hook processes. Stale locks (crashed holder)
 * are broken after STALE_MS.
 */
export function withLock<T>(lockFile: string, fn: () => T): T {
  const start = Date.now();
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, String(process.pid));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > STALE_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > TIMEOUT_MS) {
        throw new Error(`Timed out waiting for lock ${lockFile}`, { cause: err });
      }
      sleep(5 + Math.random() * 20);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockFile, { force: true });
  }
}
