# dsh-agent-activity

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在 agent **还在干活的时候**（给出最终回答之前），把它的工作过程实时显示出来。

卡片停靠在输入框上方（与 todo 面板同一位置），一眼回答三个问题：

- **已经做了什么**：本轮每一次工具调用，按顺序列出，带上目标与耗时（✓ / ✗ / 转圈）。
- **现在在做什么**：阶段标签（*思考中*、*执行工具*、*写回答*）与当前步骤序号。
- **接下来准备做什么**：模型已经声明但还没执行的工具调用，以及下一个未完成的 todo。

模型流式输出时还会显示回答的开头，于是"在思考"、"卡住了"、"在写"三者的区别是看得见的。

### 每一行说的是“在办哪件事”，不是“跑了哪个工具”

以前一行是“写文件 · client.js”，不看代码根本不知道在干什么。现在每行按这个顺序取最接近人话的说法：

1. **它正在办的那件待办** —— 只要这一轮维护了任务清单（输入框上方的待办面板），这一行就直接用清单里的原话，读起来是“把卡片改成常驻一行”；
2. **具体动的是哪一句** —— 修改类动作引用被替换掉的那一行（“改「收起时是一行」”），新建文件就点名文件；
3. **动作本身** —— 都没有时退回到“动词 + 具体对象”（“跑测试 · activity.test.mjs”），不再只给一个类别。

### 先看清单，再看动作

卡片现在和输入框上方那个内置「**任务**」面板用同一套读法：主体是清单。展开后一行一件事——
`✓ 已完成`、转圈的 `进行中`、空心的 `还没开始`；我实际跑的命令退到下面的「具体动作」小节。
收起时那一行就是当前正在做的那件事，后面跟 `2 已完成 · 1 正在做 · 1 待处理`。

动作行仍然说人话（`改「收起时是一行」`、`跑测试 · activity.test.mjs`），所以两半各答一个问题：
**清单说还剩什么，动作行动作说那一步到底干了啥。**

卡片可以折叠成一行（状态跨轮记忆）。**这一轮结束后它仍然留在底部**，于是它也成了“刚才到底干了什么”的入口：点开看明细，点 × 只收起这一轮，下一轮开始它会自己回来。切回历史会话时显示的是那个会话的**最近一轮**（投影只保留一轮历史，正好够卡片用）。

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

卡片用大白话讲，不堆工具名：做了什么、现在在做什么、接下来做什么。它**不重复你的原话**——
上面那段对话里已经有了。收起时就固定一行：

```
⠋ 正在做事   正在 改文件 · client.js                     已做 5 件事 · 12秒  ⌃
```

点开是浮在卡片上方的面板（Esc、点外面、再点一下都能收起），展开不会改变页面布局：

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

每一行下面都跟着模型自己给出的理由——它在调用前写的那句话，原样显示成“为了 …”。
如果模型没写理由（或者这一步是长串脚本），就退回到它当前正在做的那条任务，
所以不会出现“跑脚本 · x.py”这种看不出目的的行。

**先用一句大白话交代它做了哪些事**（`改文件 3 · 跑测试 2 · 发版 1`），然后才是
逐行细节和接下来要做的。行里不出现接口名：`npm test` 显示成 跑测试，
`"$NODE" --check lib/client.js` 显示成 检查语法 · client.js，`curl -o x.tgz …` 显示成
下载文件 · x.tgz，`git push` 显示成 提交代码。路径只留最后两段，搜索显示被搜的词，
实在认不出的命令就写 执行命令 并带上原命令——不会只剩一句空话。工具名只留在悬浮提示里。
文案跟随界面语言（中文/英文），长行换行到两行，回答预览保留原有的分点换行。

如果 agent 另外维护了任务清单，面板会在「为了完成你的要求，我打算」下面把它画成
✓ 做完 / ⠋ 正在做 / ○ 还没开始 的清单——那是它亲口说的计划，有就排在最前面。

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
