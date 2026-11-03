import assert from "node:assert/strict";
import {
  addNotification,
  visibleFailureNotifications,
} from "../packages/ui/src/failure-notifications.ts";

const note = (id, kind = "command-failed", read = false, detail = id) => ({
  id,
  kind,
  title: "Media rejected",
  detail,
  createdAt: "2026-11-02T10:00:00.000Z",
  read,
});
const ids = (notifications) => notifications.map(({ id }) => id);

// Only unread failures appear, and the newest three are the ones shown.
assert.deepEqual(
  ids(
    visibleFailureNotifications([
      note("terminal", "terminal"),
      note("read", "command-failed", true),
      note("browser", "browser-failed"),
      note("a"),
      note("b"),
      note("c"),
    ]),
  ),
  ["browser", "a", "b"],
);

// A repeat replaces its unread twin without touching different failures.
const repeated = addNotification(
  [note("old", "command-failed", false, "same"), note("other")],
  note("new", "command-failed", false, "same"),
);
assert.deepEqual(ids(repeated), ["new", "other"]);

// A failure the person already dismissed can be raised again.
assert.deepEqual(
  ids(
    addNotification(
      [note("old", "command-failed", true, "same")],
      note("new", "command-failed", false, "same"),
    ),
  ),
  ["new", "old"],
);

// The stored list stays bounded.
let bounded = [];
for (let index = 0; index < 20; index += 1) {
  bounded = addNotification(bounded, note(`n${index}`));
}
assert.equal(bounded.length, 12);
assert.equal(bounded[0].id, "n19");

console.log("Failure notification checks passed.");
