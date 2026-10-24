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

卡片默认是**固定的一行**，不会在你读的时候越长越高，也不会把对话最新的一行顶出视野：

```
⠋ 正在跑测试 · npm test   → 接下来 改文件 · …/lib/client.js   已做 5 件事 · 12秒  ⌃
```

这一行自己就回答了三个问题：现在在做什么（`正在跑测试 …`）、接下来要做什么（`→ 接下来 改文件 …`）、
已经做了多少（`已做 5 件事 · 12秒`）。

点它就弹出**浮在卡片上方的完整列表**：浮层不占布局，所以展开不会改变页面高度——
不会出现空白框、不会把对话顶跑、也不会触发重排。按 Esc、点浮层外面、或再点一次这一行即可收起：

```
✓  Agent 动态                    第 4 步   已做 7 件事 · 1分03秒   ⌃
──────────────────────────────────────────────────────────────────────
▮▮▮▯▯  计划 2/5 项 · 接下来: 给 README 加上截图
✓  跑测试     npm test                                              3.0s
✓  读文件     …/lib/client.js                                        0.1s
✗  跑测试     npm test                                             12.4s
⠋  改文件     …/lib/activity.js                                      1.2s
…  之前的 3 步
接下来
○  搜代码     “useProjection”
○  更新任务清单
✎  正在写回答  “现在把计划行接进头部……”
```

每一行回答的是**“它想干什么、对什么干”**，而不是“调用了哪个接口”：shell 命令按实际做的事
分类（`npm test` → 跑测试、`git push` → 提交代码、`python x.py` → 跑脚本 · x.py）；文件操作
只显示最后两段的路径；搜索显示带引号的关键词。工具名只留在悬停提示里，和原始命令放在一起。
文案随界面语言切换；长命令最多折行两行；回答预览**保留换行**——分点回答时一点一行（最多五行）。

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
