/**
 * Fold semantics of the `activity` projection unit.
 *
 * The fold is the whole Host half, so it is tested without Cordis: a small
 * synthetic log is replayed through `applyEvent` and the resulting record is
 * checked for the two things the card renders — what happened, and what is
 * queued next. Run with `node --test tests/`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ACTIVITY_KEY, activityProjection, applyEvent, describeCall, emptyState } from "../lib/activity.js";

/** Build one log event with a plausible envelope. */
function ev(type, time, data) {
  return { type, seq: 1, time, data };
}

/** Replay a list of events over the empty record. */
function replay(events) {
  return events.reduce((state, event) => applyEvent(state, event), emptyState());
}

test("the projection registers the documented key and carries a wire view", () => {
  assert.equal(ACTIVITY_KEY, "activity");
  assert.equal(activityProjection.key, "activity");
  assert.equal(activityProjection.stateVersion, 2);
  assert.equal(typeof activityProjection.stateSchema.parse, "function");
  assert.equal(typeof activityProjection.wire.view, "function");
  const blank = emptyState();
  assert.equal(activityProjection.wire.view(blank), blank);
});

test("a turn start clears the previous turn and starts thinking", () => {
  const state = replay([ev("turn/start", 1000, { turn: 3 })]);
  assert.equal(state.turn, 3);
  assert.equal(state.phase, "thinking");
  assert.equal(state.startedAt, 1000);
  assert.deepEqual(state.items, []);
  assert.deepEqual(state.plan, []);
});

test("tool calls accumulate in order and finish with their outcome", () => {
  const state = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("step/start", 1010, { turn: 1, step: 1 }),
    ev("tool/call", 1020, { turn: 1, step: 1, callId: "c1", name: "read", arguments: '{"file_path":"C:/work/a/b/client.js"}' }),
    ev("tool/result", 1120, { turn: 1, step: 1, message: { toolCallId: "c1", isError: false } }),
    ev("tool/call", 1130, { turn: 1, step: 1, callId: "c2", name: "bash", arguments: '{"command":"npm test"}' }),
    ev("tool/result", 1230, { turn: 1, step: 1, message: { toolCallId: "c2", isError: true } }),
  ]);
  assert.equal(state.phase, "thinking");
  assert.equal(state.items.length, 2);
  assert.equal(state.items[0].name, "read");
  assert.equal(state.items[0].target, "C:/work/a/b/client.js");
  assert.equal(state.items[0].status, "ok");
  assert.equal(state.items[0].t1, 1120);
  assert.equal(state.items[1].name, "bash");
  assert.equal(state.items[1].target, "npm test");
  assert.equal(state.items[1].status, "error");
  assert.equal(state.counts.tools, 2);
  assert.equal(state.counts.errors, 1);
});

test("the tool-call blocks of an assistant message are the upcoming plan", () => {
  const plan = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("assistant/message", 1100, {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: "text", text: "I will read the file first.\n" },
          { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"lib/client.js"}' },
          { type: "tool-call", id: "c2", name: "grep", arguments: '{"pattern":"useProjection"}' },
        ],
      },
    }),
  ]);
  assert.equal(plan.phase, "thinking");
  assert.equal(plan.plan.length, 2);
  assert.equal(plan.plan[0].name, "read");
  assert.equal(plan.plan[0].target, "lib/client.js");
  assert.equal(plan.plan[0].kind, "path");
  assert.equal(plan.draft, "I will read the file first.");
  assert.equal(plan.counts.steps, 1);

  const promoted = applyEvent(plan, ev("tool/call", 1200, { turn: 1, step: 1, callId: "c1", name: "read", arguments: '{"path":"lib/client.js"}' }));
  assert.equal(promoted.plan.length, 1);
  assert.equal(promoted.plan[0].id, "c2");
  assert.equal(promoted.items.length, 1);
  assert.equal(promoted.items[0].status, "running");
});

test("a text-only assistant message is the writing phase and keeps a preview", () => {
  const state = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("assistant/message", 1100, {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "Here is the   answer\nthat matters." }] },
    }),
  ]);
  assert.equal(state.phase, "writing");
  assert.equal(state.draft, "Here is the answer that matters.");
});

test("turn end closes the turn and maps a hard failure to the error phase", () => {
  const done = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("tool/call", 1010, { turn: 1, step: 1, callId: "c1", name: "read", arguments: "{}" }),
    ev("turn/end", 2000, { turn: 1, reason: { kind: "completed" } }),
  ]);
  assert.equal(done.phase, "done");
  assert.equal(done.endedAt, 2000);
  assert.deepEqual(done.plan, []);

  const failed = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("turn/end", 2000, { turn: 1, reason: { kind: "error" } }),
  ]);
  assert.equal(failed.phase, "error");

  const stopped = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("turn/end", 2000, { turn: 1, reason: { kind: "aborted" } }),
  ]);
  assert.equal(stopped.phase, "aborted");
});

test("ignored events return the same reference", () => {
  const state = replay([ev("turn/start", 1000, { turn: 1 }), ev("step/start", 1010, { turn: 1, step: 1 })]);
  assert.equal(applyEvent(state, ev("user/message", 1100, {})), state);
  assert.equal(applyEvent(state, ev("step/end", 1100, { turn: 1, step: 1 })), state);
  assert.equal(applyEvent(state, ev("request/header", 1100, {})), state);
});

test("describeCall reads the informative argument and labels its kind", () => {
  assert.deepEqual(describeCall('{"file_path":"C:/a/b/c.js"}'), { target: "C:/a/b/c.js", kind: "path" });
  assert.deepEqual(describeCall('{"command":"git status --short"}'), { target: "git status --short", kind: "command" });
  assert.deepEqual(describeCall(JSON.stringify({ command: 'cd "C:/work dir" && npm test' })), { target: "npm test", kind: "command" });
  assert.deepEqual(describeCall(JSON.stringify({ command: "Set-Location C:/x; pwsh -File a.ps1" })), { target: "pwsh -File a.ps1", kind: "command" });
  assert.deepEqual(describeCall(JSON.stringify({ command: 'NODE="/x/node" && "$NODE" --test' })), { target: '"$NODE" --test', kind: "command" });
  assert.deepEqual(describeCall(JSON.stringify({ command: "python - <<'PY'\nimport io\nPY" })), { target: "python", kind: "command" });
  assert.deepEqual(describeCall('{"pattern":"useProjection","path":"lib"}'), { target: "useProjection", kind: "query" });
  assert.deepEqual(describeCall('{"url":"https://example.com/x"}'), { target: "https://example.com/x", kind: "url" });
  assert.deepEqual(describeCall('{"todos":[{"content":"a"}]}'), { target: '[{"content":"a"}]', kind: "list" });
  assert.deepEqual(describeCall("not json at all"), { target: "not json at all", kind: "other" });
  assert.deepEqual(describeCall(""), { target: "", kind: "other" });
  assert.deepEqual(describeCall(undefined), { target: "", kind: "other" });
  assert.deepEqual(describeCall('{"count":3}'), { target: "3", kind: "other" });
});

test("a path target keeps its tail and a long command keeps its head", () => {
  const longPath = "C:/Users/someone/Documents/projects/deepseek-harness/skill/work/lib/client.js";
  const pathCall = describeCall(JSON.stringify({ file_path: longPath }));
  assert.equal(pathCall.kind, "path");
  assert.ok(pathCall.target.startsWith("…"), pathCall.target);
  assert.ok(pathCall.target.endsWith("client.js"), pathCall.target);
  assert.ok(pathCall.target.length <= 64, pathCall.target);

  const longCommand = "node -e \"console.log('a'.repeat(200))\" && npm test -- --grep something";
  const commandCall = describeCall(JSON.stringify({ command: longCommand }));
  assert.equal(commandCall.kind, "command");
  assert.ok(commandCall.target.endsWith("…"), commandCall.target);
  assert.ok(commandCall.target.length <= 64, commandCall.target);
});
