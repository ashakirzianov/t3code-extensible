# Decisions

What the code cannot say about itself: decisions in force, grouped by area.

## Repository

### repo-lineage
**`ashakirzianov/t3code-extensible` is a GitHub fork of `pingdotgg/t3code`; the earlier fork of that name is `t3code-extensible-bach`, detached from the fork network.** 2026-10-06. One account holds one fork of a repository, and only a fork can open pull requests upstream, which is how the fork's changes are offered. Anton's ruling. *See:* `pult/t3code-extensible`.

### fork-identity
**The fork keeps upstream's identity and home (`T3 Code`, `~/.t3`, port 3773, the `t3` CLI), and its build replaces the installed T3 Code app.** 2026-10-06. Anton has already migrated to Pult, so Bach's host need not be kept; two apps of one identity cannot coexist, so a Bach comparison, if ever wanted, gives `t3code-extensible-bach` a separate identity instead. Anton's ruling. *Rejected:* an identity patch on this fork. *See:* `pult/t3code-extensible`.

## Plugins

### plugins-in-process
**A plugin is a directory with a `main.mjs` whose `activate(host)` runs inside the server process with the server's own services, fully trusted, with no manifest, capabilities or consent; plugins contribute no UI.** 2026-10-06. Trust is placing it in the plugin directory, so nothing has to be exposed later; a separate process needs an API for each reach and cannot attribute a message to an agent; clients own the UI, so a plugin page never competes with it. Anton's ruling. *Rejected:* a supervised child process behind the client API; the shape of upstream's attempts (child processes, manifests, consent), knowingly; a standalone MCP server. *See:* `pult/t3code-extensible`.

### plugin-host-entry
**The server bundle has one stable entry, `dist/pluginHost.mjs`, re-exporting the server's modules; a plugin's build marks the specifier `@t3code/plugin-host` external and nothing else; the loader refuses a plugin not using the host's copy of Effect, or built for another server build.** 2026-10-06. The bundle inlines Effect into hashed chunks, so internals have no other address; a second Effect copy of the same version resolved the host's services silently in the spike, so the check is needed. *See:* `pult/t3code-extensible`.

### plugin-reload
**A plugin reloads only on an explicit admin-scoped request naming the build; the server imports the new build first, swaps on success, closes the old build's scope and answers with the result; at startup it loads each plugin's current build; a tool is replaced by name and never removed within a run; a change to existing server behaviour goes through a hook point in the fork, never a wrap; nothing in a plugin's memory survives a reload.** 2026-10-06. A watcher can import a half-written build and changes what the server runs with no one deciding; a failed import must reach the requester. Remote re-deploy is this request plus an upload. Anton's ruling. *Rejected:* reload on file change, the spike's loader; closing the old build before importing. *See:* `pult/t3code-extensible`.

### plugin-surface
**The fork exposes installed plugins and the reload request as HTTP routes under `/api/plugins` behind the host's auth: the list (name, build, loaded or failed, last error) with the read scope, reload with the admin scope; nothing in the descriptor or the RPC contracts changes.** 2026-10-06. A client must know what a server offers before relying on a plugin; routes keep the patch out of upstream's contracts, and the list is useless before auth. *Rejected:* a field in the public descriptor; RPC methods in `packages/contracts`. *See:* `pult/t3code-extensible`.

## Packaging

### update-feed
**A build names an update feed only when `T3CODE_DESKTOP_UPDATE_REPOSITORY` (or CI's `GITHUB_REPOSITORY`) names a repository; otherwise `publish` is set to null and the app ships no `app-update.yml`.** 2026-10-06. Left unset, electron-builder infers a GitHub feed from a `GH_TOKEN` or `GITHUB_TOKEN` in the shell or from the project's repository, so a local build shipped no feed only by luck; a feed naming upstream's releases would replace the fork with vanilla T3 Code on the next update. *Rejected:* a feed naming `pingdotgg/t3code`; Pult's build-time switch that drops every feed, since the fork expects a release feed of its own. *See:* `pult/fork-release-feed`.
