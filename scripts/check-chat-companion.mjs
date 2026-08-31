import assert from "node:assert/strict";

import {
  CHAT_COMPANION_DEFAULT_WIDTH,
  CHAT_COMPANION_KEYBOARD_STEP,
  CHAT_COMPANION_MAX_WIDTH,
  CHAT_COMPANION_MIN_WIDTH,
  activeChatCompanionTab,
  chatCompanionPane,
  chatCompanionReducer,
  clampChatCompanionWidth,
  createInitialChatCompanionState,
  discardedSideChatSessionIds,
  keyboardChatCompanionWidth,
  staleSideChatSessionIds,
  withoutSideChatSessions,
} from "../packages/ui/src/chat-companion.ts";

// The companion dock is one column shared by every chat pane in the grid, so
// the state has to answer two questions at once: which tools this pane opened,
// and which pane the dock is currently speaking for. Getting the second one
// wrong is what makes a dock "follow" the wrong chat, so most of what follows
// exercises the two together.

const PANE_A = "pane-a";
const PANE_B = "pane-b";

const reduce = (state, ...actions) =>
  actions.reduce(chatCompanionReducer, state);

const focused = (paneId = PANE_A) =>
  reduce(createInitialChatCompanionState(), { type: "focus-pane", paneId });

// --- One tab per tool -------------------------------------------------------

{
  const state = reduce(
    focused(),
    { type: "open-tab", tab: "terminal" },
    { type: "open-tab", tab: "review" },
    { type: "open-tab", tab: "terminal" },
  );
  assert.deepEqual(
    chatCompanionPane(state).openTabs,
    ["terminal", "review"],
    "reopening a tool must focus its existing tab, not stack a second one",
  );
  assert.equal(
    activeChatCompanionTab(state),
    "terminal",
    "reopening a tool focuses it",
  );
}

{
  // Strip order is the order tools were opened, and stays put as focus moves.
  const state = reduce(
    focused(),
    { type: "open-tab", tab: "files" },
    { type: "open-tab", tab: "browser" },
    { type: "open-tab", tab: "review" },
    { type: "select-tab", tab: "files" },
  );
  assert.deepEqual(chatCompanionPane(state).openTabs, [
    "files",
    "browser",
    "review",
  ]);
  assert.equal(activeChatCompanionTab(state), "files");
}

// --- Closing ---------------------------------------------------------------

{
  // Closing the active tab hands focus to its left-hand neighbour.
  const state = reduce(
    focused(),
    { type: "open-tab", tab: "review" },
    { type: "open-tab", tab: "terminal" },
    { type: "open-tab", tab: "browser" },
    { type: "close-tab", tab: "browser" },
  );
  assert.deepEqual(chatCompanionPane(state).openTabs, ["review", "terminal"]);
  assert.equal(activeChatCompanionTab(state), "terminal");
}

{
  // Closing the leftmost tab falls to what is now leftmost, not to undefined.
  const state = reduce(
    focused(),
    { type: "open-tab", tab: "review" },
    { type: "open-tab", tab: "terminal" },
    { type: "select-tab", tab: "review" },
    { type: "close-tab", tab: "review" },
  );
  assert.equal(activeChatCompanionTab(state), "terminal");
}

{
  // Closing an inactive tab leaves the active one alone.
  const state = reduce(
    focused(),
    { type: "open-tab", tab: "review" },
    { type: "open-tab", tab: "terminal" },
    { type: "close-tab", tab: "review" },
  );
  assert.equal(activeChatCompanionTab(state), "terminal");
  assert.deepEqual(chatCompanionPane(state).openTabs, ["terminal"]);
}

{
  // The last close shuts the dock.
  const state = reduce(
    focused(),
    { type: "open-tab", tab: "review" },
    { type: "close-tab", tab: "review" },
  );
  assert.deepEqual(chatCompanionPane(state).openTabs, []);
  assert.equal(activeChatCompanionTab(state), undefined);
}

{
  // Closing the dock keeps the strip, so reopening restores where you were.
  const opened = reduce(
    focused(),
    { type: "open-tab", tab: "review" },
    { type: "open-tab", tab: "terminal" },
  );
  const closed = chatCompanionReducer(opened, { type: "close-dock" });
  assert.equal(activeChatCompanionTab(closed), undefined);
  assert.deepEqual(chatCompanionPane(closed).openTabs, ["review", "terminal"]);
  const reopened = chatCompanionReducer(closed, { type: "reopen-dock" });
  assert.equal(activeChatCompanionTab(reopened), "terminal");
}

{
  // Reopening an empty dock has nothing to show and must stay closed rather
  // than render a tab strip with no tabs in it.
  const state = chatCompanionReducer(focused(), { type: "reopen-dock" });
  assert.equal(activeChatCompanionTab(state), undefined);
}

// --- Following the focused pane --------------------------------------------

{
  // Each pane keeps its own strip; moving focus swaps which one is on screen
  // and leaves the other exactly as it was.
  let state = reduce(
    focused(PANE_A),
    { type: "open-tab", tab: "review" },
    { type: "open-tab", tab: "terminal" },
  );
  state = reduce(
    state,
    { type: "focus-pane", paneId: PANE_B },
    { type: "open-tab", tab: "browser" },
  );

  assert.equal(activeChatCompanionTab(state), "browser", "dock follows pane B");
  assert.deepEqual(chatCompanionPane(state, PANE_A).openTabs, [
    "review",
    "terminal",
  ]);
  assert.equal(activeChatCompanionTab(state, PANE_A), "terminal");

  state = chatCompanionReducer(state, { type: "focus-pane", paneId: PANE_A });
  assert.equal(
    activeChatCompanionTab(state),
    "terminal",
    "returning to pane A restores its own active tab",
  );
}

{
  // An action naming a pane explicitly also moves focus there — that is the
  // click-a-background-pane path, where the dock has to follow the click.
  const state = reduce(focused(PANE_A), {
    type: "open-tab",
    tab: "files",
    paneId: PANE_B,
  });
  assert.equal(state.focusedPaneId, PANE_B);
  assert.equal(activeChatCompanionTab(state, PANE_B), "files");
  assert.equal(activeChatCompanionTab(state, PANE_A), undefined);
}

{
  // With no pane focused there is nothing to open a tab against.
  const state = chatCompanionReducer(createInitialChatCompanionState(), {
    type: "open-tab",
    tab: "review",
  });
  assert.deepEqual(state.panes, {});
}

{
  // A closed chat pane takes its strip with it.
  const state = reduce(
    focused(PANE_A),
    { type: "open-tab", tab: "review" },
    { type: "forget-pane", paneId: PANE_A },
  );
  assert.deepEqual(state.panes, {});
  assert.equal(state.focusedPaneId, undefined);
}

// --- Dock width -------------------------------------------------------------

{
  const state = chatCompanionReducer(createInitialChatCompanionState(), {
    type: "resize-dock",
    width: 640,
  });
  assert.equal(state.dockWidth, 640);
  // Width is shared, so it survives a focus change rather than resetting.
  assert.equal(
    chatCompanionReducer(state, { type: "focus-pane", paneId: PANE_B })
      .dockWidth,
    640,
  );
}

assert.equal(
  clampChatCompanionWidth(10),
  CHAT_COMPANION_MIN_WIDTH,
  "the dock never narrows past its minimum",
);
assert.equal(clampChatCompanionWidth(10_000), CHAT_COMPANION_MAX_WIDTH);
assert.equal(clampChatCompanionWidth(Number.NaN), CHAT_COMPANION_DEFAULT_WIDTH);
assert.equal(
  clampChatCompanionWidth(800, 900),
  420,
  "a known container leaves the transcript its readable 480px minimum",
);
assert.equal(
  clampChatCompanionWidth(800, 400),
  CHAT_COMPANION_MIN_WIDTH,
  "a container too narrow for both still respects the dock minimum, and the " +
    "surface falls back to the overlay presentation instead",
);
assert.equal(
  keyboardChatCompanionWidth(520, "ArrowLeft"),
  520 + CHAT_COMPANION_KEYBOARD_STEP,
  "Left Arrow widens the right-hand companion dock",
);
assert.equal(
  keyboardChatCompanionWidth(520, "ArrowRight"),
  520 - CHAT_COMPANION_KEYBOARD_STEP,
  "Right Arrow gives the transcript more room",
);
assert.equal(
  keyboardChatCompanionWidth(520, "Home"),
  CHAT_COMPANION_MIN_WIDTH,
  "Home collapses the dock to its safe minimum",
);
assert.equal(
  keyboardChatCompanionWidth(520, "End", 900),
  420,
  "End respects the transcript floor in a constrained chat surface",
);
assert.equal(
  keyboardChatCompanionWidth(520, "PageUp"),
  undefined,
  "unrelated keys leave the dock unchanged",
);

// --- Transient side chat ----------------------------------------------------

{
  // Closing the Side chat tab has to release its session id, or the cleanup
  // pass has no way to tell a live side chat from one already gone.
  const opened = reduce(
    focused(),
    { type: "open-tab", tab: "side-chat" },
    { type: "bind-side-chat", sessionId: "side-1" },
  );
  assert.equal(chatCompanionPane(opened).sideChatSessionId, "side-1");

  const closed = chatCompanionReducer(opened, {
    type: "close-tab",
    tab: "side-chat",
  });
  assert.equal(chatCompanionPane(closed).sideChatSessionId, undefined);
  assert.deepEqual(
    discardedSideChatSessionIds(opened, closed),
    ["side-1"],
    "closing Side chat marks its session for deletion",
  );
}

{
  // Closing the dock is not closing the tab: the side chat stays alive so
  // reopening the dock returns to the same conversation.
  const opened = reduce(
    focused(),
    { type: "open-tab", tab: "side-chat" },
    { type: "bind-side-chat", sessionId: "side-1" },
  );
  const hidden = chatCompanionReducer(opened, { type: "close-dock" });
  assert.equal(chatCompanionPane(hidden).sideChatSessionId, "side-1");
  assert.deepEqual(discardedSideChatSessionIds(opened, hidden), []);
}

{
  // Closing the whole chat pane discards its side chat too.
  const opened = reduce(
    focused(),
    { type: "open-tab", tab: "side-chat" },
    { type: "bind-side-chat", sessionId: "side-1" },
  );
  const forgotten = chatCompanionReducer(opened, {
    type: "forget-pane",
    paneId: PANE_A,
  });
  assert.deepEqual(discardedSideChatSessionIds(opened, forgotten), ["side-1"]);
}

{
  // Two panes, two side chats: closing one must not sweep the other.
  let state = reduce(
    focused(PANE_A),
    { type: "open-tab", tab: "side-chat" },
    { type: "bind-side-chat", sessionId: "side-a" },
    { type: "focus-pane", paneId: PANE_B },
    { type: "open-tab", tab: "side-chat" },
    { type: "bind-side-chat", sessionId: "side-b" },
  );
  const next = chatCompanionReducer(state, {
    type: "close-tab",
    tab: "side-chat",
    paneId: PANE_A,
  });
  assert.deepEqual(discardedSideChatSessionIds(state, next), ["side-a"]);
  assert.equal(chatCompanionPane(next, PANE_B).sideChatSessionId, "side-b");
}

{
  // Rebinding (a fresh side chat in the same tab) retires the previous one.
  const first = reduce(
    focused(),
    { type: "open-tab", tab: "side-chat" },
    { type: "bind-side-chat", sessionId: "side-1" },
  );
  const second = chatCompanionReducer(first, {
    type: "bind-side-chat",
    sessionId: "side-2",
  });
  assert.deepEqual(discardedSideChatSessionIds(first, second), ["side-1"]);
}

{
  // Unclean exit: ids recorded on disk with no live dock holding them get
  // swept on the next launch. Anything still bound is left alone.
  const state = reduce(
    focused(),
    { type: "open-tab", tab: "side-chat" },
    { type: "bind-side-chat", sessionId: "side-live" },
  );
  assert.deepEqual(
    staleSideChatSessionIds(
      ["side-dead", "side-live", "side-dead"],
      state,
    ).sort(),
    ["side-dead"],
  );
  assert.deepEqual(
    staleSideChatSessionIds(["side-dead"], createInitialChatCompanionState()),
    ["side-dead"],
    "after a cold start nothing is bound, so every recorded id is stale",
  );
}

{
  // Side chats never appear alongside real sessions.
  const sessions = [{ id: "chat-1" }, { id: "side-1" }, { id: "chat-2" }];
  assert.deepEqual(
    withoutSideChatSessions(sessions, ["side-1"]).map((session) => session.id),
    ["chat-1", "chat-2"],
  );
  assert.equal(
    withoutSideChatSessions(sessions, []),
    sessions,
    "with nothing to hide the original list is returned untouched",
  );
}

console.log("chat companion checks passed");
