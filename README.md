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

### Every row says what is being done, not which tool ran

A row used to read `write file · client.js`, which tells you nothing unless you already know the code.
Each row now leads with the most human thing available, in this order:

1. **the todo it is serving** — when the agent keeps a todo list (the todo panel above the composer),
   the row borrows that sentence verbatim, so it reads *“keep the card after the turn ends”*;
2. **the exact thing being changed** — for an edit, the row quotes the line being replaced
   (*`edit “收起时是一行”`*), for a new file it names the file;
3. **the action** — otherwise the row falls back to a plain verb and its concrete object
   (`run tests · activity.test.mjs`) rather than a generic category.

It collapses to a single line and **stays there after the turn ends**, so the card doubles as the
entry point for "what did it just do?" — click it open, read the rows, click × to dismiss that turn
only. The card comes back by itself when the next turn starts, and reopening a past conversation
shows the last turn of that conversation (the projection keeps exactly one turn of history, which is
what the card needs).

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

The card speaks in plain language instead of tool names: what happened, what is happening
now, and what is queued. It deliberately does **not** echo your message — the transcript right
above already shows it. The collapsed line is one stable row:

```
⠋ 正在做事   正在 改文件 · client.js                     已做 5 件事 · 12秒  ⌃
```

Click it and the panel opens as a floating overlay above the card (Escape, outside click or
a second click closes it) — opening it never changes the page layout:

```
我做了什么   改文件 3 · 跑测试 2 · 发版 1
──────────────────────────────────────────────────────────────────────
✓  改文件     …/lib/client.js                                        1.2s
   为了 先确认卡片头部现在渲染的是什么
✓  跑测试     npm test                                               3.0s
⠋  改文件     …/lib/activity.js                                       0.8s
   为了 把“为什么做这一步”接进每一行
接下来
○  跑测试     npm test
✎  正在写回答  “现在把计划行接进头部…”
```

Every row carries the reason the agent gave for that step — the sentence it wrote right before the
call, quoted back as 为了 …. When the agent said nothing (or the step is a long scripted chain),
the card falls back to the todo item it is currently working on, so a row is never just
"跑脚本 · x.py" with no purpose.

That is the whole point: **plain words**, then a recap of what the agent did for the task
(`改文件 3 · 跑测试 2 · 发版 1`), then the rows and what is queued. No API names — `npm test`
reads 跑测试, `"$NODE" --check lib/client.js` reads 检查语法 · client.js, `curl -o x.tgz …`
reads 下载文件 · x.tgz, `git push` reads 提交代码. A file path collapses to its last two
segments, a search shows its quoted term, and a command that cannot be classified shows
执行命令 next to the command itself — never a vague label with no information. Tool names
survive only in the hover tooltip. Wording follows the UI language (Chinese and English),
long rows wrap to two lines, and the answer preview keeps its line breaks.

If the agent also keeps a todo list, the panel shows it as a checklist under
「为了完成你的要求，我打算」 with ✓ done / ⠋ running / ○ pending — that is the plan in the
agent's own words, so it leads the panel whenever it exists.

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
