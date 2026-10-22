# dsh-agent-activity

[![ci](https://github.com/oxygenforce/dsh-agent-activity/actions/workflows/ci.yml/badge.svg)](https://github.com/oxygenforce/dsh-agent-activity/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4d6bfe.svg)](https://github.com/deepseek-ai/deepseek-harness)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that makes the agent's working process visible **while it is still working** — before the final answer lands.

The card docks right above the composer, in the same place as the todo panel, and answers three questions at a glance:

- **What has it already done?** Every tool call of the current turn, in order, with its target and how long it took (✓ / ✗ / spinner).
- **What is it doing now?** A phase label — *thinking*, *running a tool*, *writing the answer* — plus the current step number.
- **What is it about to do?** The tool calls the model has just announced but not yet run, followed by the next unfinished todo.

While the model streams a reply, the card also shows the leading edge of that reply, so you can tell the difference between "thinking", "stuck" and "writing".

It collapses to a single line (state persists across turns) and hides itself again once the turn has been finished for two minutes, so it never lingers over a finished conversation.

## Why a plugin and not a skill

A skill can only add instructions to the model's context; it cannot render anything. This is a UI plugin: a Host half that folds the session event log into a small "activity" projection, and a Client half that renders it in the Harness Web UI.

## Install

The package is a DeepSeek Harness bundle. Install it from a directory or from a packed tarball with the Plugin Manager:

```
plugin_manager action=install_bundle target=/path/to/dsh-agent-activity
```

`application: applied` means the Host half is live; the card appears above the composer in the Web UI. Replacing an already-installed version needs a Harness restart to pick up the new browser bundle.

There is nothing to configure. No data leaves the machine.

## What it renders

By default the card is **one stable line** — it never grows while you read, so it cannot
push the newest line of the conversation out of view:

```
⠋ 正在操作 · 运行命令 "$NODE" --test tests/   → 改文件 …/lib/client.js   已做 5 件事 · 12秒  ⌃
```

That line carries the three answers on its own: what it is doing now (`运行命令 …`), what
it is about to do next (`→ 改文件 …`), and how far it has got (`已做 5 件事 · 12秒`). Click
it to expand the full log — the expanded body has a fixed height, so opening it is one
movement, not a growing panel:

```
✓  Agent 动态                    第 4 步   已做 7 件事 · 1分03秒   ⌃
──────────────────────────────────────────────────────────────────────
▮▮▮▯▯  计划 2/5 项 · 接下来: 给 README 加上截图
✓  运行命令   pnpm run build                                     12.4s
✓  读文件     …/lib/client.js                                      0.1s
✗  运行命令   node --test tests/                                   3.0s
⠋  改文件     …/lib/activity.js                                    1.2s
…  之前的 3 步
接下来
○  搜索代码   “useProjection”
○  更新计划   [{"content":"verify in the live UI"}]
✎  正在写回答  “现在把计划行接进头部…”
```

Everything reads as an action, not an API name — `read` becomes “read file”, `ops_bash`
“run command”, `grep` “search code”, and so on. The mapping follows the UI language
(Chinese and English), a file path collapses to its last two segments, a search term is
quoted, and shell prologues (`cd … &&`, env assignments, heredocs) are stripped. Hovering
a row reveals the exact tool name, the untouched target and the duration.

## How it works

- **Host** (`lib/index.js`, `lib/activity.js`) registers the session projection `activity` with a single `apply(state, event)` fold over the durable event log: `turn/start`, `step/start`, `assistant/message`, `tool/call`, `tool/result`, `turn/end`. The fold is pure and synchronous, returns the same state reference for events it does not care about, and keeps a bounded log (32 tool calls) so long turns stay cheap.
- **Wire** (`wire.view`) hands the finished value to the Client. The Client never folds events itself — it reads `useProjection("activity")` and, for the plan row, the built-in `todos` projection.
- Because the projection is registered at boot and has no persisted rows yet, sessions restored from an older checkpoint simply re-fold their log through `init` + `apply`; no migration is needed.

The projection key is `activity`, and its state is plain JSON:

```ts
{
  v: 2,
  turn: number, step: number,
  phase: "idle" | "thinking" | "tool" | "writing" | "done" | "error" | "aborted",
  startedAt: number, updatedAt: number, endedAt: number | null,
  items: { id, name, target, kind, status: "running" | "ok" | "error", t0, t1 }[],
  plan:  { id, name, target, kind }[],
  draft: string,
  counts: { steps: number, tools: number, errors: number }
}
```

## Development

```bash
node scripts/check-manifest.mjs   # manifest, export map, patch row, icon, locales
node --test tests/activity.test.mjs
node --check lib/client.js && node --check lib/activity.js && node --check lib/index.js
```

`tests/activity.test.mjs` replays synthetic session events through the fold and asserts the item list, plan, phase transitions, error accounting and the projection's wire identity — no browser required.

## Layout

```
lib/index.js       Host entry: registers the session projection
lib/activity.js    Pure event fold + tool-call summarizer (no dependencies)
lib/client.js      Web UI card, dictionaries, styles
locale/*.json      meta.title / meta.description for the Plugin Manager
icon.svg           Original artwork shown in the plugin list
cordis.patch.yml   Bundle patch row
```

## License

MIT © oxygenforce
