// @effect-diagnostics nodeBuiltinImport:off
// Runs at pack time, inside vite.config.ts, before any Effect runtime exists.
import * as NodeChildProcess from "node:child_process";

/** The commit a bundle is built from, baked into `serverBuild`; undefined outside a git checkout. */
export const buildCommit = (cwd: string): string | undefined => {
  try {
    return NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
};
