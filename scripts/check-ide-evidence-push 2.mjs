// Verifies that live IDE evidence pushes are coalesced rather than sent once
// per keystroke. Run with: node --experimental-strip-types scripts/check-ide-evidence-push.mjs
import assert from "node:assert/strict";
import { createIdeEvidenceScheduler } from "../apps/desktop/src/ide-evidence-push.ts";

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (handler, ms) => {
      const id = nextId++;
      timers.set(id, { handler, at: now + ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.handler();
        }
      }
    },
    pending: () => timers.size,
  };
}

function harness() {
  const clock = fakeClock();
  const sent = [];
  const scheduler = createIdeEvidenceScheduler((evidence) => sent.push(evidence), {
    idleMs: 300,
    throttleMs: 1000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, sent, scheduler };
}

// The first change of a burst is not delayed.
{
  const { sent, scheduler } = harness();
  scheduler.schedule("a");
  assert.deepEqual(sent, ["a"]);
  assert.equal(scheduler.isPending(), false);
}

// Typing inside the throttle window collapses to one trailing push that
// carries the newest evidence, not the first one.
{
  const { clock, sent, scheduler } = harness();
  scheduler.schedule("a");
  for (const value of ["ab", "abc", "abcd", "abcde"]) {
    clock.advance(50);
    scheduler.schedule(value);
  }
  assert.deepEqual(sent, ["a"], "in-window changes stay queued");
  assert.equal(scheduler.isPending(), true);
  clock.advance(300);
  assert.deepEqual(sent, ["a", "abcde"], "only the newest evidence ships");
  assert.equal(clock.pending(), 0);
}

// Sustained editing is throttled to roughly one push per second instead of
// one per change.
{
  const { clock, sent, scheduler } = harness();
  for (let index = 0; index < 100; index += 1) {
    scheduler.schedule(`v${index}`);
    clock.advance(100);
  }
  clock.advance(1000);
  assert.ok(sent.length <= 12, `expected a throttled push count, got ${sent.length}`);
  assert.ok(sent.length >= 9, `expected periodic refreshes, got ${sent.length}`);
  assert.equal(sent.at(-1), "v99", "the final change reaches the bridge");
  assert.equal(clock.pending(), 0, "no timer outlives the burst");
}

// A send that is about to transmit can be forced, which is what a turn start
// needs when it must not read stale editor text.
{
  const { clock, sent, scheduler } = harness();
  scheduler.schedule("a");
  scheduler.schedule("b");
  assert.deepEqual(sent, ["a"]);
  scheduler.flush();
  assert.deepEqual(sent, ["a", "b"]);
  scheduler.flush();
  assert.deepEqual(sent, ["a", "b"], "flushing twice does not duplicate");
  clock.advance(5000);
  assert.deepEqual(sent, ["a", "b"]);
}

// Cancelling drops queued evidence, e.g. when the open project changes.
{
  const { clock, sent, scheduler } = harness();
  scheduler.schedule("a");
  scheduler.schedule("b");
  scheduler.cancel();
  assert.equal(scheduler.isPending(), false);
  clock.advance(5000);
  assert.deepEqual(sent, ["a"]);
}

console.log("ide evidence push coalescing ok");
