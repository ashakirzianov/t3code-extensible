// Bundles main.mjs for the server built from this checkout: `@t3code/plugin-host`
// stays external, everything else is inlined, and `builtFor` names this server build.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { build } from "esbuild";

const repo = new URL("../../../", import.meta.url);
const { version } = JSON.parse(
  NodeFS.readFileSync(new URL("apps/server/package.json", repo), "utf8"),
);
const commit = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
  .toString()
  .trim();
const buildId = process.argv[2] ?? `${commit.slice(0, 7)}-${Date.now()}`;

await build({
  entryPoints: [new URL("main.mjs", import.meta.url).pathname],
  outfile: new URL(`dist/${buildId}/main.mjs`, import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@t3code/plugin-host"],
  define: { __BUILT_FOR__: JSON.stringify({ version, commit }) },
});
console.log(`dist/${buildId}/main.mjs built for ${version}@${commit}`);
