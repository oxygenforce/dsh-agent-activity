# dsh-agent-activity

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在 agent **还在干活的时候**（给出最终回答之前），把它的工作过程实时显示出来。

卡片停靠在输入框上方（与 todo 面板同一位置），一眼回答三个问题：

- **已经做了什么**：本轮每一次工具调用，按顺序列出，带上目标与耗时（✓ / ✗ / 转圈）。
- **现在在做什么**：阶段标签（*思考中*、*执行工具*、*写回答*）与当前步骤序号。
- **接下来准备做什么**：模型已经声明但还没执行的工具调用，以及下一个未完成的 todo。

模型流式输出时还会显示回答的开头，于是"在思考"、"卡住了"、"在写"三者的区别是看得见的。

卡片可以折叠成一行（状态跨轮记忆），一轮结束两分钟后自动隐藏，不会一直压在已完成的对话上。

## 为什么是插件而不是 skill

skill 只能往模型上下文里加指令，无法渲染任何界面。所以这是一个 UI 插件：Host 半边把会话事件流派生出一份很小的 `activity` projection，Client 半边把它画在 Harness Web UI 里。

## 安装

这个包是一个 DeepSeek Harness bundle，用 Plugin Manager 从目录或 tarball 安装：

```
plugin_manager action=install_bundle target=/path/to/dsh-agent-activity
```

返回 `application: applied` 表示 Host 半边已生效，Web UI 输入框上方会出现卡片。替换已安装的版本需要重启 Harness 才能用上新的浏览器端代码。

无需任何配置，数据不出本机。

## 界面

卡片上读到的是动作，不是接口名——原始工具名留在悬停提示里，想深挖的人随时能看：

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
✎  正在写回答  “现在把计划行接进头部……”
```

`read` 显示为“读文件”、`ops_bash` 为“运行命令”、`grep` 为“搜索代码”……映射随界面语言
切换（中英双语）；文件路径只留最后两段，搜索词加引号。鼠标悬停能看到原始工具名、
完整目标和耗时。

## 实现

- **Host**（`lib/index.js`、`lib/activity.js`）用单个 `apply(state, event)` 折叠持久事件流，注册名为 `activity` 的 session projection：`turn/start`、`step/start`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`。折叠是纯函数且同步，不关心的世界返回同一个 state 引用；日志有上限（最近 32 次工具调用），长轮次也便宜。
- **Wire**（`wire.view`）把算好的值送到 Client。Client 自己绝不折叠事件——它只读 `useProjection("activity")`，计划行再读内置的 `todos` projection。
- projection 在启动时注册、尚无持久行，因此从旧 checkpoint 恢复的会话会自动用 `init` + `apply` 重折整段日志，不需要任何迁移。

projection key 是 `activity`，状态就是纯 JSON：

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

## 开发

```bash
node scripts/check-manifest.mjs   # manifest、导出表、patch 行、图标、语言包
node --test tests/activity.test.mjs
node --check lib/client.js && node --check lib/activity.js && node --check lib/index.js
```

`tests/activity.test.mjs` 把合成的会话事件回放进折叠函数，断言条目列表、计划、阶段切换、错误计数与 projection 的 wire 恒等性——不需要浏览器。

## 目录

```
lib/index.js       Host 入口：注册 session projection
lib/activity.js    纯事件折叠 + 工具调用摘要（零依赖）
lib/client.js      Web UI 卡片、文案、样式
locale/*.json      Plugin Manager 里显示的 meta.title / meta.description
icon.svg           插件列表里的原始图标
cordis.patch.yml   bundle patch 行
```

## 许可

MIT © oxygenforce
