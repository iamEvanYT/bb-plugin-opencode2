# Architecture

## How the bridge works

The plugin connects to OpenCode's single shared background service only when
a thread needs it, and never stops it. Sharing the service matters because
OpenCode stores session state there, and BB may resume a thread from another
host worker.

For BB dynamic tools, the plugin starts a local, session-specific MCP
process. OpenCode sees the configured tools, while the plugin checks the
calling session and a random token before forwarding each call to BB. An
unchanged tool catalog keeps the live MCP child across BB's repeated session
setup. Discarding the thread removes its OpenCode MCP registration; a
persisted registry lets discards clean up even when another host worker owns
the thread.

OpenCode shells run under the background service, whose environment is fixed
at service start. The plugin sends each session a credential-filtered host
environment, BB's per-session `envVars`, and `PATH` with the `bb` binary
directory first.

## Code layout

```text
src/
  server.ts            BB server entry: provider metadata, settings storage, sync to hosts
  host.ts              Host entry: host RPC and the provider bridge (public test helpers too)
  app.tsx              Frontend entry: registers the settings slot
  app/                 Settings page
  components/, lib/    UI primitives used by the settings page
  settings-contract.ts Settings and RPC shapes shared by server, host, and app
  model-settings.ts    Model allowlist normalization
  host/                Host implementation, described below
tests/                 Node tests, plus a jsdom test for the settings UI
skills/                Agent skill shipped with the plugin
docs/                  Developer documentation
```

Inside `src/host/`:

- `provider-bridge.ts` validates and dispatches provider protocol requests.
- `opencode-server.ts` owns the service connection, HTTP client, model
  catalog, persistence, event stream, and turn reconciliation.
- `opencode-event-router.ts` translates OpenCode events into BB deltas,
  including live shell output and subagent nesting.
- `session-manager.ts` owns session setup, per-turn preparation (settings,
  permissions, agent, model), MCP registration, and shutdown.
- `maintenance.ts` implements health, install, and update.
- `dynamic-tools-mcp.ts` and `bridge-runtime.ts` expose BB dynamic tools to
  OpenCode and route their calls back.
- `opencode-config.ts` maintains the global deny rule that keeps BB's tools out
  of OpenCode's own sessions.
- `opencode-requests.ts`, `timeline.ts`, `tool-mapping.ts`, `prompt.ts`, and
  `models.ts` contain the testable protocol mappings.

## Design decisions

- **Native subagents are off by default** and enforced with a session `deny`
  rule. When the user enables them, they render as BB delegation rows.
- **Permission modes are session rulesets.** OpenCode's `build` agent allows
  everything, so BB encodes its modes as session rules (the last matching rule
  wins). `auto` keeps OpenCode's agent rules and answers remaining asks with
  `once`; `full` adds `*` → allow so nothing prompts. A denial is sent as a
  reject with a message, so the agent continues instead of the turn aborting.
- **BB tools are allowed by exact `<server>_<tool>` action name.** OpenCode
  shares MCP servers per directory, not per session, so each session allows only
  its own tools and hides the others.
- **The OpenCode service is shared** and must never be stopped by the plugin.
- **Events do not replay.** OpenCode's event stream is volatile, so the bridge
  reconciles active turns against `GET /api/session/:id` after a reconnect and
  every 30 seconds.
- **Terminal execution events wait for this turn's `session.inbox.delivered`.**
  Earlier work finishing must not end a new turn (this broke the turn after
  `/compact`).
- **Turn diffs are built from the turn's own patches**, because
  `/api/session/:id/diff` stays empty without snapshots.

## Known gaps

- Child-session questions: a subagent's question closes without its
  `parentRef`. Cosmetic and rare.
- Retry visibility and turn reconciliation are covered by unit tests only; a
  scheduled retry and a dropped event stream were never reproduced against a
  live service.
- Unknown OpenCode events are dropped rather than forwarded as diagnostics.

See [opencode-v2-api.md](opencode-v2-api.md) for the OpenCode routes and event
shapes the bridge depends on.
