export function out(msg = ""): void {
  process.stdout.write(msg + "\n");
}

export function warn(msg: string): void {
  process.stderr.write(`warning: ${msg}\n`);
}
