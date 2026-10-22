/**
 * dsh-agent-activity — the fold.
 *
 * A pure, synchronous reduction of the committed session log into one small
 * activity record: which turn is running, how far into it the agent is, the
 * tool calls it already made (with their outcome and duration), the calls the
 * model has just declared it will run next, and a one-line preview of the text
 * it is writing. The unit is registered on `ctx.sessionProjections`
 * (`lib/index.js`), so the Host folds every event once and the Web client reads
 * the finished value through `useProjection('activity')` — the client never
 * sees or replays session events.
 *
 * Everything here is plain JSON: the projection cache checkpoints it, cold
 * reads restore it, and a stale checkpoint (older `stateVersion`) is discarded
 * and refolded from the log.
 *
 * @module dsh-agent-activity/activity
 */

/** Projection key the Host unit registers and the client reads. */
export const ACTIVITY_KEY = "activity";

/** How many finished/queued entries the client needs before it stops helping. */
const MAX_ITEMS = 32;

/** Preview budget for the streamed text: a single dimmed line in the card. */
const DRAFT_LIMIT = 240;

/** Label budget for a tool call's target (a path, a command, a query …). */
const TARGET_LIMIT = 120;

/**
 * Where a tool call points, as ordered rules: the first rule whose argument
 * field is present decides both the short text and its kind. The kind lets the
 * card render the target the way a person reads it — a file name rather than a
 * full path, a command as typed — instead of parsing strings in the browser.
 */
const TARGET_RULES = [
  { kind: "command", keys: ["command", "cmd", "script"] },
  { kind: "query", keys: ["pattern", "query", "q"] },
  { kind: "path", keys: ["file_path", "filePath", "path", "file", "paths"] },
  { kind: "url", keys: ["url"] },
  { kind: "list", keys: ["todos"] },
  { kind: "text", keys: ["description", "prompt", "name", "content", "text", "patch"] },
];

/**
 * Collapse whitespace and clip to `limit` from the end with a leading ellipsis
 * (paths keep their tail, which is the part a person reads), or from the start
 * when `fromEnd` is false.
 * @param {string} text - raw source text.
 * @param {number} limit - maximum code units of the result.
 * @param {boolean} fromEnd - keep the tail instead of the head.
 * @returns {string} the display-ready string.
 */
function clip(text, limit, fromEnd = false) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  if (fromEnd) return "…" + flat.slice(-(limit - 1));
  return flat.slice(0, limit - 1).trimEnd() + "…";
}

/**
 * Reduce a shell command to the part a reader cares about: agents habitually
 * wrap work in `cd "<dir>" && VAR=x && python - <<'PY' …`, and all of that
 * prologue is context noise in a status line. Only the leading, syntactic
 * parts are removed; the command itself is never rewritten.
 * @param {string} text - the raw command.
 * @returns {string} the command without its location/env/heredoc scaffolding.
 */
function tidyCommand(text) {
  let command = String(text).replace(/\s+/g, " ").trim();
  for (let round = 0; round < 8; round += 1) {
    const before = command;
    command = command
      .replace(/^(?:cd|pushd|Set-Location)\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;|\|\|)\s*/i, "")
      .replace(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/, "")
      .replace(/^(?:&&|\|\||;)\s*/, "");
    if (command === before) break;
  }
  // Everything from a heredoc marker on is the script body, not the action.
  command = command.replace(/\s*<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?.*$/s, "");
  return command.replace(/[\s|&;<>-]+$/, "").trim();
}

/**
 * Turn a tool call's raw argument JSON into the short text the card shows
 * beside the action name, plus the kind that says how to shorten it further
 * for display. Never throws: unparseable or partial JSON (a streamed tool-call
 * block is not guaranteed to be complete) degrades to the raw text.
 * @param {unknown} rawArguments - the `arguments` string from the model or log.
 * @returns {{ target: string, kind: string }} a single-line target and its kind
 *   (`command` | `path` | `query` | `url` | `list` | `text` | `other`).
 */
export function describeCall(rawArguments) {
  if (typeof rawArguments !== "string" || rawArguments.trim() === "") return { target: "", kind: "other" };
  let parsed;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return { target: clip(rawArguments, TARGET_LIMIT, false), kind: "other" };
  }
  if (parsed === null || typeof parsed !== "object") return { target: clip(parsed, TARGET_LIMIT, false), kind: "other" };
  for (const rule of TARGET_RULES) {
    for (const key of rule.keys) {
      const value = parsed[key];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value === "string") {
        if (value.trim() === "") continue;
        const trimmed = rule.kind === "command" ? tidyCommand(value) : value;
        return { target: clip(trimmed, TARGET_LIMIT, rule.kind === "path"), kind: rule.kind };
      }
      if (Array.isArray(value)) {
        if (value.length === 0) return { target: "[]", kind: rule.kind };
        const primitives = value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
        return { target: clip(primitives ? value.join(", ") : JSON.stringify(value), TARGET_LIMIT, false), kind: rule.kind };
      }
      if (typeof value === "number" || typeof value === "boolean") return { target: String(value), kind: rule.kind };
      if (typeof value === "object") {
        try {
          return { target: clip(JSON.stringify(value), TARGET_LIMIT, false), kind: rule.kind };
        } catch {
          /* circular or exotic: fall through to the next field */
        }
      }
    }
  }
  const keys = Object.keys(parsed);
  if (keys.length === 0) return { target: "", kind: "other" };
  const first = parsed[keys[0]];
  if (typeof first === "string") return { target: clip(first, TARGET_LIMIT, false), kind: "other" };
  if (typeof first === "number" || typeof first === "boolean") return { target: String(first), kind: "other" };
  return { target: clip(JSON.stringify(parsed) ?? "", TARGET_LIMIT, false), kind: "other" };
}

/** Identity-validated schema: the registry only calls `parse`, and a shape this
 * plugin authored can never fail it. Keeps the host half free of dependencies —
 * a plugin installed by directory link resolves modules from its own checkout,
 * where no third-party validator is installed. */
const plainSchema = Object.freeze({
  parse: (value) => value,
  safeParse: (value) => ({ success: true, data: value }),
});

/** The neutral record: no turn has started in this session yet. */
export function emptyState() {
  return Object.freeze({
    v: 2,
    turn: 0,
    step: 0,
    phase: "idle",
    startedAt: 0,
    updatedAt: 0,
    endedAt: 0,
    items: Object.freeze([]),
    plan: Object.freeze([]),
    draft: "",
    counts: Object.freeze({ steps: 0, tools: 0, errors: 0 }),
  });
}

/** @type {ReturnType<typeof emptyState>} */
const EMPTY = emptyState();

/**
 * Which phase a turn-end reason leaves behind. Only a hard failure is an error;
 * an abort or interruption is a stop, everything else is a clean finish.
 * @param {unknown} reason - `turn/end` reason union from the log.
 * @returns {"done" | "error" | "aborted"} the phase.
 */
function endPhase(reason) {
  const kind = reason && typeof reason === "object" && typeof reason.kind === "string" ? reason.kind : "completed";
  if (kind === "error") return "error";
  if (kind === "aborted" || kind === "interrupted") return "aborted";
  return "done";
}

/**
 * Mark the running entry for one call id finished.
 * @param {readonly object[]} items - current entries.
 * @param {string | undefined} callId - the tool call id, when the log carries one.
 * @param {boolean} failed - whether the call reported an error.
 * @param {number} at - completion time (epoch ms).
 * @returns {{ items: object[], hit: boolean }} the updated entries and whether a call matched.
 */
function finishItem(items, callId, failed, at) {
  if (callId === undefined) return { items, hit: false };
  let hit = false;
  let changed = false;
  const next = items.map((item) => {
    if (item.id !== callId || item.status !== "running") return item;
    hit = true;
    changed = true;
    return { ...item, status: failed ? "error" : "ok", t1: at };
  });
  return { items: changed ? next : items, hit };
}

/**
 * Fold one committed session event into the activity record.
 *
 * Purity contract of the projection seam: returns the *same reference* for
 * every event it does not care about, so an unchanged fold costs nothing
 * downstream and publishes nothing.
 * @param {object} state - the current record (see {@link emptyState}).
 * @param {{ type: string, seq: number, time: number, data: any }} event - one log event.
 * @returns {object} the next record.
 */
export function applyEvent(state, event) {
  const data = event && event.data ? event.data : {};
  const at = typeof event?.time === "number" ? event.time : state.updatedAt;
  switch (event?.type) {
    case "turn/start":
      return {
        v: 2,
        turn: typeof data.turn === "number" ? data.turn : state.turn + 1,
        step: 0,
        phase: "thinking",
        startedAt: at,
        updatedAt: at,
        endedAt: 0,
        items: [],
        plan: [],
        draft: "",
        counts: { steps: 0, tools: 0, errors: 0 },
      };
    case "step/start": {
      if (state.phase === "idle") return state;
      const step = typeof data.step === "number" ? data.step : state.step;
      if (step === state.step && state.phase === "thinking") return state;
      return { ...state, step, phase: "thinking", updatedAt: at };
    }
    case "assistant/message": {
      const content = Array.isArray(data.message?.content) ? data.message.content : [];
      const text = content
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join(" ");
      const calls = content
        .filter((block) => block && block.type === "tool-call" && typeof block.name === "string")
        .map((block) => ({ id: block.id, name: block.name, ...describeCall(block.arguments) }));
      const draft = text.trim() === "" ? "" : clip(text, DRAFT_LIMIT, false);
      if (calls.length === 0 && draft === "" && state.phase === "thinking") return state;
      return {
        ...state,
        phase: calls.length > 0 ? "thinking" : "writing",
        plan: calls,
        draft: draft === "" ? state.draft : draft,
        updatedAt: at,
        counts: { ...state.counts, steps: state.counts.steps + 1 },
      };
    }
    case "tool/call": {
      const callId = data.callId;
      const name = typeof data.name === "string" ? data.name : "tool";
      if (state.items.some((item) => item.id === callId && item.status === "running")) return state;
      const item = {
        id: callId,
        name,
        ...describeCall(data.arguments),
        status: "running",
        t0: at,
        t1: 0,
      };
      const items = [...state.items, item];
      return {
        ...state,
        phase: "tool",
        items: items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items,
        plan: state.plan.filter((entry) => entry.id !== callId),
        updatedAt: at,
        counts: { ...state.counts, tools: state.counts.tools + 1 },
      };
    }
    case "tool/result": {
      const callId = data.message?.toolCallId;
      const failed = data.error !== undefined || data.message?.isError === true;
      const finished = finishItem(state.items, callId, failed, at);
      if (!finished.hit) return { ...state, updatedAt: at };
      return {
        ...state,
        phase: "thinking",
        items: finished.items,
        updatedAt: at,
        counts: { ...state.counts, errors: state.counts.errors + (failed ? 1 : 0) },
      };
    }
    case "turn/end": {
      const phase = endPhase(data.reason);
      return { ...state, phase, plan: [], endedAt: at, updatedAt: at };
    }
    default:
      return state;
  }
}

/**
 * The `activity` projection unit: one record per session, folded over the whole
 * log, published to the client as-is (the client renders, it does not compute).
 */
export const activityProjection = {
  key: ACTIVITY_KEY,
  stateVersion: 2,
  stateSchema: plainSchema,
  init: () => EMPTY,
  apply: (state, event) => applyEvent(state, event),
  wire: {
    viewSchema: plainSchema,
    view: (state) => state,
  },
};
