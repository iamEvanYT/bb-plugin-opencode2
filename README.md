# OpenCode v2 for BB

A [BB](https://getbb.app) plugin that runs BB threads through an installed
[OpenCode v2](https://opencode.ai/v2/docs/) server. OpenCode owns the model
connection, model credentials, and its own tool execution. The plugin translates
between OpenCode's v2 API and events and BB's provider bridge protocol.

Verified against OpenCode 2.0.26–2.0.27 and BB 0.46 (Plugin SDK 0.6.37).

## Requirements

- BB 0.41 or newer (developed and verified on 0.46)
- OpenCode v2 2.0.26 or newer (`opencode2` on the host's `PATH`). BB can
  install it (`npm install -g @opencode/cli`) or update it
  (`opencode2 upgrade`) from the provider settings.
- At least one model provider connected in OpenCode: `opencode2 auth login`

## Install

From the BB plugin store, or from the command line:

```sh
bb plugin install git:https://github.com/iamEvanYT/bb-plugin-opencode2.git
```

BB shows OpenCode v2 in the provider picker when `opencode2` is installed and
the provider is enabled in the plugin settings.

## Supported BB features

| BB feature             | Details                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider picker        | Visible when `opencode2` is installed and the provider is enabled.                                                                                                                                                                                                  |
| Health                 | Reports not installed, unsupported version, no model provider connected, or service unreachable, with the command to fix it.                                                                                                                                        |
| Install and update     | Install through npm; update through `opencode2 upgrade`, which handles npm, bun, brew, and curl installs.                                                                                                                                                           |
| Model discovery        | Models come from OpenCode for the thread's workspace. OpenCode's default model is BB's default. The settings page can allow or block individual models.                                                                                                             |
| Reasoning levels       | BB levels map to each model's OpenCode variants (`minimal` serves as low and `thinking` as high when the model lacks those levels). Models without variants run on their defaults.                                                                                  |
| New, resumed threads   | BB creates or reconnects to an OpenCode session and keeps its ID.                                                                                                                                                                                                   |
| Fork at a checkpoint   | Forks copy history through the checkpoint turn into a new OpenCode session.                                                                                                                                                                                         |
| Rewind and edit        | Same-thread rewinds and message edits revert the OpenCode session in place, restoring files.                                                                                                                                                                        |
| Prompts                | Text, local files, local images, and image URLs.                                                                                                                                                                                                                    |
| Steering               | Follow-up input is queued into the running OpenCode turn.                                                                                                                                                                                                           |
| Stop, discard, rename  | Stop interrupts the session; discard deletes it and its BB tool server; rename sets the OpenCode title.                                                                                                                                                             |
| Manual `/compact`      | Runs OpenCode compaction; automatic compactions also appear in the timeline.                                                                                                                                                                                        |
| Agents                 | Models list an `agent` option with every OpenCode primary agent, `build` and `plan` included. Pick it in the Agent row of BB's model switcher, or run `bb thread spawn --option agent=<name>`. Project-level agents show up too. BB's own plan mode is not offered. |
| Permission modes       | Encoded as OpenCode session rules. Accept edits asks before shell, web, and other non-edit tools; auto answers OpenCode's remaining asks once; full allows everything. A denial goes back to the agent as feedback and the turn continues.                          |
| Questions              | OpenCode's question tool uses BB's native question UI.                                                                                                                                                                                                              |
| BB dynamic tools       | Exposed to OpenCode through a per-session local MCP server, rendered with the presentation BB supplies, and approved by BB rather than prompting twice.                                                                                                             |
| OpenCode MCP Code Mode | Your MCP servers keep OpenCode's default Code Mode. Each `execute` call shows as a "Ran code" row titled with the MCP tools it calls; each of those calls is approved like any other tool.                                                                          |
| BB CLI in shells       | OpenCode shells get BB's per-session environment and `bb` on `PATH`.                                                                                                                                                                                                |
| Native subagents       | Off by default: OpenCode's `subagent` tool is denied and hidden, so agents delegate through BB. When allowed, each subagent is a BB delegation row with its work nested inside.                                                                                     |
| Skills                 | BB's `/` menu lists every skill OpenCode discovers for the workspace (`~/.agents/skills`, `~/.claude/skills`, project and config roots), and picking one activates it in OpenCode. BB's own skills that OpenCode does not know are attached as `SKILL.md` files.    |
| Timeline rows          | Reads, searches, directory listings, web search and fetch, commands with live output and exit codes, and file changes built from OpenCode's own patches.                                                                                                            |
| Turn diff              | Each turn's file patches are reported as the turn diff.                                                                                                                                                                                                             |
| Usage and context      | OpenCode's cumulative session tokens, the last request's tokens, and the model's context limit drive BB's usage and context meter.                                                                                                                                  |
| Errors and retries     | Failures settle the turn with a visible error; scheduled model retries show as retrying errors.                                                                                                                                                                     |
| Recovery               | OpenCode's event stream does not replay. After a reconnect, and every 30 seconds, turns whose OpenCode session already went idle are settled from its recorded outcome.                                                                                             |
| Large tool results     | Timeline values are bounded to 64 KiB per delta, keeping the beginning and end.                                                                                                                                                                                     |

## Not supported

OpenCode v2 has no API for these, so the provider declares them unsupported.

| BB feature                        | Why                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| Archive and unarchive             | Sessions record an archive time, but the API cannot set it.                                  |
| Thread goals                      | No equivalent in OpenCode.                                                                   |
| Service tiers                     | No equivalent in OpenCode.                                                                   |
| Usage dashboard                   | OpenCode exposes cost totals, not rate-limit windows. Per-turn usage still works.            |
| `instructionMode: "replace"`      | Session instruction entries add to OpenCode's own instructions; they cannot replace them.    |
| Filtering native tools per prompt | `disallowedTools` filters BB dynamic tools; native OpenCode tools have no per-prompt switch. |

## Settings

Open the plugin settings page in BB (Settings → OpenCode v2).

- **Status** shows each connected host's OpenCode version, available updates,
  and model count, with the command to run when something is missing.
- **Show in the provider picker** enables or hides the provider.
- **Allow OpenCode subagents** lets OpenCode use its native subagents (off by
  default).
- **Keep BB tools inside BB** (on by default). OpenCode shares MCP servers
  across a directory, so your own OpenCode sessions (TUI, web) would
  otherwise list BB threads' tools. This adds one rule,
  `{ "action": "bb_opencode2_*", "resource": "*", "effect": "deny" }`, at the
  end of `permissions` in your global `~/.config/opencode/opencode.json`,
  and changes nothing else. OpenCode applies it at its next idle moment.
  Turning the setting off restores the file byte-for-byte if you haven't
  edited it since, or removes just that rule if you have. BB threads are
  unaffected: each allows its own tools in its session rules.
- **Models** controls the allowlist, grouped by OpenCode provider.

Settings apply from the next turn. See
[`skills/opencode2-provider/SKILL.md`](skills/opencode2-provider/SKILL.md) for
the CLI equivalents and troubleshooting.

## Development

```sh
npm install
bb plugin types
npm run check
```

`npm run check` verifies formatting, typechecks sources and tests, builds all
plugin artifacts, runs the Node test suite against the built host artifact, and
mounts the settings UI in jsdom. To try a local checkout in BB, run
`bb plugin install .` from the repository root.

See [docs/architecture.md](docs/architecture.md) for the code layout and design
decisions, and [docs/opencode-v2-api.md](docs/opencode-v2-api.md) for the
OpenCode routes and events the bridge depends on.

## License

[MIT](LICENSE)
