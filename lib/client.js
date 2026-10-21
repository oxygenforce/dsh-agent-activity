/**
 * dsh-agent-activity — the browser half.
 *
 * Renders one compact card in the conversation input dock ("conversation.input.dock",
 * the full-width strip right above the composer card), so the card is on screen
 * exactly while the agent works and the answer is still being produced.
 *
 * The card answers two questions, continuously:
 *   · 已经干了什么 — the tool calls of this turn in order, each with its target
 *     (a file, a command, a pattern …) and how long it took;
 *   · 接下来准备干什么 — the calls the model has just declared for the next
 *     step, plus the first open item of the agent's own plan (the `todos`
 *     projection), plus a one-line preview of the text it is writing.
 *
 * Data comes from the Host half: it folds the session log into the `activity`
 * projection and the projection seam delivers the finished value. This file
 * never subscribes to session events, replays a log or mutates the DOM outside
 * its own component tree.
 */
window.__ModuleLoader__.load({
  id: "dsh-agent-activity",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const NS = "dsh-agent-activity";
    const SLOT = "conversation.input.dock";
    const ENTRY_ID = "activity";
    const ORDER = 30;

    /** Keep the finished summary on screen briefly, then let the card go. */
    const REVEAL_MS = 120000;
    /** Entries rendered at once: enough to read a step, short enough to stay a card. */
    const VISIBLE_ITEMS = 7;
    /** Collapse-state preference survives reloads; a broken storage is not an error. */
    const PREF_KEY = "dsh-agent-activity:collapsed";

    // ── 文案 ────────────────────────────────────────────────────────────────
    // 宿主 locale 的插值语法是 {name}；未注入 t 时用 fallbackT 兜底。

    const MESSAGES_ZH = {
      "title": "Agent 动态",
      "phase.idle": "空闲",
      "phase.thinking": "思考中",
      "phase.tool": "执行中",
      "phase.writing": "生成回答",
      "phase.done": "已完成",
      "phase.error": "出错",
      "phase.aborted": "已停止",
      "step": "第 {step} 步",
      "counts": "{tools} 个工具",
      "countsWithErrors": "{tools} 个工具 · {errors} 失败",
      "seconds": "{seconds}秒",
      "minutes": "{minutes}分{seconds}秒",
      "done": "已完成",
      "next": "接下来",
      "running": "进行中",
      "queued": "即将运行",
      "earlier": "…之前的 {count} 步",
      "planProgress": "{done}/{total} 项计划",
      "planEmpty": "等待下一步",
      "draft": "正在写回答",
      "collapse": "收起 Agent 动态",
      "expand": "展开 Agent 动态",
      "statusOk": "成功",
      "statusError": "失败",
      "statusRunning": "运行中",
      "statusQueued": "排队中",
      "toolsLabel": "工具",
    };

    const MESSAGES_EN = {
      "title": "Agent activity",
      "phase.idle": "Idle",
      "phase.thinking": "Thinking",
      "phase.tool": "Working",
      "phase.writing": "Writing",
      "phase.done": "Done",
      "phase.error": "Failed",
      "phase.aborted": "Stopped",
      "step": "step {step}",
      "counts": "{tools} tools",
      "countsWithErrors": "{tools} tools · {errors} failed",
      "seconds": "{seconds}s",
      "minutes": "{minutes}m {seconds}s",
      "done": "Done",
      "next": "Up next",
      "running": "Running",
      "queued": "Queued",
      "earlier": "…{count} earlier steps",
      "planProgress": "{done}/{total} planned",
      "planEmpty": "Waiting for the next step",
      "draft": "Writing the answer",
      "collapse": "Collapse agent activity",
      "expand": "Expand agent activity",
      "statusOk": "succeeded",
      "statusError": "failed",
      "statusRunning": "running",
      "statusQueued": "queued",
      "toolsLabel": "tools",
    };

    function interpolate(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        params && Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
      ));
    }

    function makeDictionary(dictionary) {
      return function t(key, params) {
        const template = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key;
        return interpolate(template, params);
      };
    }

    const fallbackT = makeDictionary(MESSAGES_ZH);

    // ── 时间与状态 ──────────────────────────────────────────────────────────

    const LIVE_PHASES = new Set(["thinking", "tool", "writing"]);
    const FINISHED_PHASES = new Set(["done", "error", "aborted"]);
    /** 认识的全部阶段；未知值按 idle 处理，绝不把原始 key 画到界面上。 */
    const PHASES = new Set(["idle", ...LIVE_PHASES, ...FINISHED_PHASES]);

    /** 「12秒」/「2分03秒」——秒级读数，超过一分钟才进位。 */
    function formatDuration(ms, t) {
      const total = Math.max(0, Math.round(ms / 1000));
      const seconds = total % 60;
      const minutes = Math.floor(total / 60);
      if (minutes === 0) return t("seconds", { seconds });
      return t("minutes", { minutes, seconds: String(seconds).padStart(2, "0") });
    }

    /** 右对齐的毫秒读数：1.2s / 12s / 1m03s —— 取的是这个数本身，不用 t。 */
    function formatShort(ms) {
      if (!Number.isFinite(ms) || ms < 0) return "";
      if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
      const seconds = ms / 1000;
      if (seconds < 10) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
      const whole = Math.round(seconds);
      if (whole < 60) return `${whole}s`;
      return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s`;
    }

    function readCollapsedPreference() {
      try {
        const stored = globalThis.localStorage?.getItem(PREF_KEY);
        return stored === "1";
      } catch {
        return false;
      }
    }

    function writeCollapsedPreference(collapsed) {
      try {
        globalThis.localStorage?.setItem(PREF_KEY, collapsed ? "1" : "0");
      } catch {
        /* private mode / quota: the card still works, it just forgets */
      }
    }

    // ── 视图内容推导 ────────────────────────────────────────────────────────

    /**
     * 已完成的条目里只画最后几条；更早的折成一行计数，保持卡片高度稳定。
     * @param {readonly object[]} items - activity.items
     * @returns {{ listed: object[], hidden: number }} 可见条目与被折叠的数量
     */
    function listedItems(items, room) {
      if (items.length <= room) return { listed: items, hidden: 0 };
      return { listed: items.slice(items.length - room), hidden: items.length - room };
    }

    /**
     * 「接下来准备干什么」：先是模型刚刚声明的待执行调用（最临近），
     * 再是计划里的第一条未完成项（走向，而不是下一步）。
     * @param {object} activity - the activity projection value.
     * @param {object[] | null} todos - the `todos` projection value.
     * @returns {object[]} up to three entries: {kind:'call'|'todo', ...}
     */
    function nextUp(activity, todos) {
      const result = [];
      const plan = Array.isArray(activity.plan) ? activity.plan : [];
      for (const entry of plan.slice(0, 2)) result.push({ kind: "call", name: entry.name, target: entry.target });
      const open = Array.isArray(todos) ? todos.filter((todo) => todo && todo.status !== "completed") : [];
      const first = open[0];
      if (first && typeof first.content === "string") result.push({ kind: "todo", text: first.content });
      return result.slice(0, 3);
    }

    /** 计划进度：已完成 / 总数，以及下一项未完成的内容（计划这一步的走向）。 */
    function todoProgress(todos) {
      if (!Array.isArray(todos) || todos.length === 0) return null;
      const done = todos.filter((todo) => todo && todo.status === "completed").length;
      const open = todos.find((todo) => todo && todo.status !== "completed");
      return { done, total: todos.length, next: open && typeof open.content === "string" ? open.content : "" };
    }

    // ── 图形 ────────────────────────────────────────────────────────────────

    function CheckGlyph() {
      return h("svg", { viewBox: "0 0 16 16", width: 12, height: 12, "aria-hidden": true, focusable: false },
        h("path", {
          d: "M3.4 8.5 L6.3 11.4 L12.7 4.9",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.9,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }));
    }

    function CrossGlyph() {
      return h("svg", { viewBox: "0 0 16 16", width: 11, height: 11, "aria-hidden": true, focusable: false },
        h("path", {
          d: "M4.4 4.4 L11.6 11.6 M11.6 4.4 L4.4 11.6",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.9,
          strokeLinecap: "round",
        }));
    }

    function SpinnerGlyph() {
      return h("svg", { viewBox: "0 0 16 16", width: 13, height: 13, className: "dsh-aa-spin", "aria-hidden": true, focusable: false },
        h("circle", {
          cx: 8,
          cy: 8,
          r: 5.4,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.9,
          strokeLinecap: "round",
          strokeDasharray: "8.5 25.5",
        }));
    }

    function ChevronGlyph({ collapsed }) {
      return h("svg", { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": true, focusable: false },
        h("path", {
          d: collapsed ? "M5.2 10 L8 6.8 L10.8 10" : "M5.2 6.4 L8 9.6 L10.8 6.4",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }));
    }

    function HollowGlyph() {
      return h("span", { className: "dsh-aa-hollow", "aria-hidden": true });
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 只用宿主保证的 --dsw-alias-* 主题令牌（外加同族 teritory 令牌的兜底字面量），
    // 明暗两套主题由宿主切换，这里不写死颜色。

    const STYLE_TEXT = `
.dsh-aa-root{box-sizing:border-box;align-self:stretch;display:flex;flex-direction:column;position:relative;overflow:hidden;border:1px solid var(--dsw-alias-border-l1,#e4e6eb);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#ffffff);color:var(--dsw-alias-label-primary,#16181c);font-size:12px;line-height:18px;margin:0}
.dsh-aa-root[data-collapsed="true"]{border-color:var(--dsw-alias-border-l1,#e4e6eb)}
.dsh-aa-shimmer{position:absolute;inset:0 0 auto 0;height:2px;background:linear-gradient(90deg,transparent 0%,var(--dsw-alias-brand-primary,#4d6bfe) 35%,#8b5cf6 55%,transparent 100%);background-size:220% 100%;animation:dsh-aa-slide 1.6s linear infinite;opacity:.9;pointer-events:none}
@keyframes dsh-aa-slide{from{background-position:120% 0}to{background-position:-120% 0}}
.dsh-aa-header{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:7px 10px 7px 11px;margin:0;border:0;background:0 0;text-align:left;cursor:pointer;color:inherit;font:inherit;border-radius:12px}
.dsh-aa-header:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07))}
.dsh-aa-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px}
.dsh-aa-dot{flex:none;display:grid;place-items:center;width:14px;height:14px}
.dsh-aa-dot i{display:block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#9aa1ab)}
.dsh-aa-root[data-live="true"] .dsh-aa-dot i{background:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 18%,transparent);animation:dsh-aa-pulse 1.8s ease-in-out infinite}
.dsh-aa-root[data-phase="done"] .dsh-aa-dot i{background:var(--dsw-alias-state-success-primary,#16a34a)}
.dsh-aa-root[data-phase="error"] .dsh-aa-dot i{background:var(--dsw-alias-state-error-primary,#dc2626)}
.dsh-aa-root[data-phase="aborted"] .dsh-aa-dot i{background:var(--dsw-alias-state-warn-primary,#d97706)}
@keyframes dsh-aa-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(.82)}}
.dsh-aa-phase{flex:none;font-size:12.5px;font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary,#16181c)}
.dsh-aa-chip{flex:none;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));color:var(--dsw-alias-label-secondary,#4b5563);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}
.dsh-aa-meta{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#4b5563);font-size:11.5px;font-variant-numeric:tabular-nums;opacity:.85}
.dsh-aa-meta em{font-style:normal;color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsh-aa-chevron{flex:none;display:grid;place-items:center;color:var(--dsw-alias-label-secondary,#4b5563);opacity:.7}
.dsh-aa-body{display:flex;flex-direction:column;gap:7px;padding:0 10px 9px 11px}
.dsh-aa-plan{display:flex;align-items:center;gap:8px;min-width:0;padding-top:1px}
.dsh-aa-bar{flex:none;position:relative;width:54px;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18));overflow:hidden}
.dsh-aa-bar span{position:absolute;inset:0 auto 0 0;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary,#4d6bfe),#8b5cf6);transition:width .3s ease}
.dsh-aa-plan-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#4b5563);font-size:11.5px}
.dsh-aa-plan-count{flex:none;color:var(--dsw-alias-label-secondary,#4b5563);font-size:11px;font-variant-numeric:tabular-nums;opacity:.8}
.dsh-aa-list{display:flex;flex-direction:column;gap:3px;max-height:168px;overflow-y:auto;scrollbar-width:thin;overscroll-behavior:contain}
.dsh-aa-item{display:flex;align-items:center;gap:7px;min-width:0;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,#4b5563)}
.dsh-aa-glyph{flex:none;display:grid;place-items:center;width:14px;height:14px;color:var(--dsw-alias-label-secondary,#4b5563)}
.dsh-aa-item[data-status="ok"] .dsh-aa-glyph{color:var(--dsw-alias-state-success-primary,#16a34a)}
.dsh-aa-item[data-status="error"] .dsh-aa-glyph{color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsh-aa-item[data-status="running"] .dsh-aa-glyph{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-aa-item[data-status="running"] .dsh-aa-name{color:var(--dsw-alias-label-primary,#16181c)}
.dsh-aa-item[data-status="muted"]{font-size:11px;color:var(--dsw-alias-label-secondary,#8b929c);opacity:.7}
.dsh-aa-item[data-status="muted"] .dsh-aa-target{font-style:italic}
.dsh-aa-item[data-status="error"] .dsh-aa-name{color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsh-aa-name{flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--dsw-alias-label-primary,#16181c);font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:11.5px}
.dsh-aa-target{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}
.dsh-aa-dur{flex:none;color:var(--dsw-alias-label-secondary,#4b5563);font-size:10.5px;font-variant-numeric:tabular-nums;opacity:.6}
.dsh-aa-spin{animation:dsh-aa-rotate .9s linear infinite}
@keyframes dsh-aa-rotate{to{transform:rotate(360deg)}}
.dsh-aa-hollow{display:block;width:7px;height:7px;border-radius:50%;border:1.5px solid var(--dsw-alias-label-secondary,#8b929c);opacity:.6}
.dsh-aa-next{display:flex;flex-direction:column;gap:3px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1,#e4e6eb)}
.dsh-aa-next-label{color:var(--dsw-alias-label-secondary,#4b5563);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;opacity:.65}
.dsh-aa-next-item{display:flex;align-items:center;gap:7px;min-width:0;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,#4b5563)}
.dsh-aa-next .dsh-aa-glyph{width:14px}
.dsh-aa-next .dsh-aa-target{opacity:.7;font-style:italic}
.dsh-aa-draft{display:flex;gap:7px;min-width:0;margin:0;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary,#4b5563);font-size:11.5px;line-height:17px}
.dsh-aa-draft span:first-child{flex:none;opacity:.7}
.dsh-aa-draft span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:italic}
@media (prefers-reduced-motion:reduce){.dsh-aa-shimmer{animation:none;opacity:.35}.dsh-aa-dot i{animation:none!important}.dsh-aa-spin{animation-duration:1.8s}}
`;

    /** 样式随插件上下文注册（不是工厂副作用），卸载时自动摘除。 */
    function installStyle(document) {
      const style = document.createElement("style");
      style.setAttribute("data-dsh-agent-activity", "");
      style.textContent = STYLE_TEXT;
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    // ── 组件 ────────────────────────────────────────────────────────────────

    /** 一秒一跳的时钟：只在卡片可见且还在跑的时候走动。 */
    function useNow(active) {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        if (!active) return undefined;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => {
          clearInterval(timer);
        };
      }, [active]);
      return now;
    }

    function ActivityItem({ entry, now, t }) {
      const status = entry.status;
      const running = status === "running";
      const ended = typeof entry.t1 === "number" && entry.t1 > 0 ? entry.t1 : 0;
      const started = typeof entry.t0 === "number" ? entry.t0 : 0;
      const duration = started > 0 ? (running ? Math.max(0, now - started) : Math.max(0, ended - started)) : 0;
      const label = status === "ok" ? t("statusOk") : status === "error" ? t("statusError") : t("statusRunning");
      return h("div", {
        className: "dsh-aa-item",
        "data-status": status,
        title: [entry.name, entry.target, duration > 0 ? formatShort(duration) : "", label].filter(Boolean).join(" · "),
      },
        h("span", { className: "dsh-aa-glyph" }, status === "ok" ? h(CheckGlyph) : status === "error" ? h(CrossGlyph) : h(SpinnerGlyph)),
        h("span", { className: "dsh-aa-name" }, entry.name),
        entry.target ? h("span", { className: "dsh-aa-target" }, entry.target) : h("span", { className: "dsh-aa-target" }),
        duration > 0 ? h("span", { className: "dsh-aa-dur" }, formatShort(duration)) : null);
    }

    function NextItem({ entry, t }) {
      const isCall = entry.kind === "call";
      return h("div", {
        className: "dsh-aa-next-item",
        title: isCall ? `${entry.name} · ${t("statusQueued")}` : t("statusQueued"),
      },
        h("span", { className: "dsh-aa-glyph" }, h(HollowGlyph)),
        isCall ? h("span", { className: "dsh-aa-name" }, entry.name) : null,
        h("span", { className: "dsh-aa-target" }, isCall ? entry.target || "" : entry.text));
    }

    function ActivityDock({ useProjection, t = fallbackT }) {
      const read = typeof useProjection === "function" ? useProjection : () => undefined;
      const activity = read("activity");
      const todos = read("todos");

      const phase = activity && typeof activity.phase === "string" ? activity.phase : "idle";
      const live = LIVE_PHASES.has(phase);
      const finished = FINISHED_PHASES.has(phase);
      const endedAt = activity && typeof activity.endedAt === "number" ? activity.endedAt : 0;
      const clockAt = Date.now();
      const fresh = activity !== undefined && activity !== null
        && (typeof activity.turn === "number" && activity.turn > 0)
        && (live || (finished && (endedAt === 0 || clockAt - endedAt < REVEAL_MS)));

      // 收尾后没有新事件了，用一次性定时器把卡片自己收起来（无事件也会重渲染一次）。
      const [expired, setExpired] = React.useState(false);
      React.useEffect(() => {
        if (!finished || endedAt <= 0) {
          setExpired(false);
          return undefined;
        }
        const remaining = REVEAL_MS - (Date.now() - endedAt);
        if (remaining <= 0) {
          setExpired(true);
          return undefined;
        }
        const timer = setTimeout(() => {
          setExpired(true);
        }, remaining);
        return () => {
          clearTimeout(timer);
        };
      }, [finished, endedAt]);

      const visible = fresh && !expired;
      const now = useNow(visible && live);

      const [collapsed, setCollapsed] = React.useState(readCollapsedPreference);
      const turn = activity && typeof activity.turn === "number" ? activity.turn : 0;

      React.useEffect(() => {
        if (turn === 0) return;
        const next = finished;
        setCollapsed(next);
        writeCollapsedPreference(next);
      }, [turn, finished]);

      const listRef = React.useRef(null);
      const itemCount = activity && Array.isArray(activity.items) ? activity.items.length : 0;
      React.useEffect(() => {
        const node = listRef.current;
        if (node === null) return;
        node.scrollTop = node.scrollHeight;
      }, [itemCount, collapsed]);

      if (!visible) return null;

      const items = Array.isArray(activity.items) ? activity.items : [];
      const room = collapsed ? 0 : VISIBLE_ITEMS;
      const { listed, hidden } = listedItems(items, room);
      const progress = todoProgress(todos);
      const upcoming = collapsed ? [] : nextUp(activity, todos);
      const draft = !collapsed && typeof activity.draft === "string" ? activity.draft : "";
      const counts = activity.counts && typeof activity.counts === "object" ? activity.counts : { steps: 0, tools: 0, errors: 0 };
      const startedAt = typeof activity.startedAt === "number" ? activity.startedAt : 0;
      const elapsed = startedAt > 0 ? Math.max(0, (finished && endedAt > 0 ? endedAt : now) - startedAt) : 0;
      const step = typeof activity.step === "number" ? activity.step : 0;

      const metaParts = [t("counts", { tools: counts.tools })];
      if (counts.errors > 0) metaParts[0] = t("countsWithErrors", { tools: counts.tools, errors: counts.errors });
      if (elapsed > 0) metaParts.push(formatDuration(elapsed, t));
      const phaseKey = PHASES.has(phase) ? phase : "idle";
      const phaseLabel = t(`phase.${phaseKey}`);

      const toggle = () => {
        setCollapsed((value) => {
          writeCollapsedPreference(!value);
          return !value;
        });
      };

      const header = h("button", {
        type: "button",
        className: "dsh-aa-header",
        "aria-expanded": !collapsed,
        "aria-label": collapsed ? t("expand") : t("collapse"),
        title: collapsed ? t("expand") : t("collapse"),
        onClick: toggle,
      },
        h("span", { className: "dsh-aa-dot" }, h("i")),
        h("span", { className: "dsh-aa-phase" }, phaseLabel),
        step > 0 ? h("span", { className: "dsh-aa-chip" }, t("step", { step })) : null,
        h("span", { className: "dsh-aa-meta" }, metaParts.filter(Boolean).join(" · ")),
        h("span", { className: "dsh-aa-chevron" }, h(ChevronGlyph, { collapsed })));

      const body = collapsed ? null : h("div", { className: "dsh-aa-body" },
        progress ? h("div", { className: "dsh-aa-plan" },
          h("div", { className: "dsh-aa-bar", role: "presentation" },
            h("span", { style: { width: `${Math.round((progress.done / progress.total) * 100)}%` } })),
          h("span", { className: "dsh-aa-plan-text" }, progress.next || t("planEmpty")),
          h("span", { className: "dsh-aa-plan-count" }, t("planProgress", { done: progress.done, total: progress.total }))) : null,
        items.length > 0 || upcoming.length > 0 || draft
          ? h("div", { className: "dsh-aa-list", ref: listRef },
            hidden > 0 ? h("div", { className: "dsh-aa-item", "data-status": "muted", "aria-hidden": true },
              h("span", { className: "dsh-aa-glyph" }),
              h("span", { className: "dsh-aa-target" }, t("earlier", { count: hidden }))) : null,
            listed.map((entry, index) => h(ActivityItem, { key: `i${index}-${entry.id ?? entry.name}`, entry, now, t })))
          : null,
        upcoming.length > 0 ? h("div", { className: "dsh-aa-next" },
          h("span", { className: "dsh-aa-next-label" }, t("next")),
          upcoming.map((entry, index) => h(NextItem, { key: `n${index}-${entry.kind}`, entry, t }))) : null,
        draft ? h("p", { className: "dsh-aa-draft" },
          h("span", { "aria-hidden": true }, "✎"),
          h("span", { title: draft }, draft)) : null);

      return h("section", {
        className: "dsh-aa-root",
        "data-phase": phase,
        "data-live": String(live),
        "data-collapsed": String(collapsed),
        "data-testid": "agent-activity",
        "aria-label": t("title"),
      },
        live ? h("div", { className: "dsh-aa-shimmer", "aria-hidden": true }) : null,
        header,
        body);
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(() => installStyle(document), "dsh-agent-activity: styles");
        ctx.effect(
          () => ctx.locale.register(NS, { zh: MESSAGES_ZH, en: MESSAGES_EN }),
          "dsh-agent-activity: dictionaries",
        );
        ctx.slots.inject(SLOT, () => ctx.slots.register(
          { name: SLOT, id: ENTRY_ID, order: ORDER, locale: NS },
          ActivityDock,
        ));
      },
    };
  },
});
