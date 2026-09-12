import { useCallback, useState } from "react";

import {
  chatEnvironmentPaneKey,
  defaultChatEnvironmentVisible,
  shouldRevealChatEnvironment,
  type ChatCompanionAction,
  type ChatSidePanelId,
  type WorkbenchAction,
} from "@gyro-dev/ui";

/**
 * How the Environment behaves on a chat's right edge.
 *
 * It is that edge's resting state rather than a panel competing for it, so the
 * two controls below share one shape. Revealing it means handing the rail back
 * from whatever holds it — the plan document and the companion dock both — and
 * the toggle only withdraws or restores it once the rail is already free.
 */
export type ChatEnvironmentControls = {
  show: () => void;
  toggle: () => void;
};

/**
 * Per-pane Environment visibility.
 *
 * A pane records only its deviation from the default: a single chat shows the
 * Environment, a tiled pane does not. The record is keyed by pane *and* layout
 * because splitting is what changes that default — a chat that opened the
 * Environment on its own must not drag it into the split, and must still have
 * it on the way back out.
 */
export function useChatEnvironmentVisibility() {
  const [visibleByKey, setVisibleByKey] = useState<Record<string, boolean>>({});
  const isVisible = useCallback(
    (paneId: string, isTiled: boolean) =>
      visibleByKey[chatEnvironmentPaneKey(paneId, isTiled)] ??
      defaultChatEnvironmentVisible(isTiled),
    [visibleByKey],
  );
  const setVisible = useCallback(
    (paneId: string, isTiled: boolean, visible: boolean) => {
      setVisibleByKey((current) => ({
        ...current,
        [chatEnvironmentPaneKey(paneId, isTiled)]: visible,
      }));
    },
    [],
  );
  return { isVisible, setVisible };
}

export type ChatEnvironmentVisibility = ReturnType<
  typeof useChatEnvironmentVisibility
>;

/** The solo chat surfaces, whose visibility is a workbench preference. */
export function useSoloChatEnvironmentControls(options: {
  companionPanel?: ChatSidePanelId;
  dispatchCompanion: (action: ChatCompanionAction) => void;
  dispatchWorkbench: (action: WorkbenchAction) => void;
  legacyPanel?: ChatSidePanelId;
  paneId: string;
}): ChatEnvironmentControls {
  const {
    companionPanel,
    dispatchCompanion,
    dispatchWorkbench,
    legacyPanel,
    paneId,
  } = options;
  const show = useCallback(() => {
    dispatchCompanion({ type: "close-dock", paneId });
    dispatchWorkbench({ type: "set-chat-environment-rail", open: true });
  }, [dispatchCompanion, dispatchWorkbench, paneId]);
  const toggle = useCallback(() => {
    if (shouldRevealChatEnvironment(legacyPanel, companionPanel)) {
      show();
      return;
    }
    dispatchWorkbench({ type: "toggle-chat-environment-rail" });
  }, [companionPanel, dispatchWorkbench, legacyPanel, show]);
  return { show, toggle };
}

/** A pane in the chat grid, whose visibility is local to the pane. */
export function chatPaneEnvironmentControls(options: {
  clearLegacyPanel: () => void;
  closeDock: () => void;
  companionPanel?: ChatSidePanelId;
  focusPane: () => void;
  isTiled: boolean;
  isVisible: boolean;
  legacyPanel?: ChatSidePanelId;
  paneId: string;
  visibility: ChatEnvironmentVisibility;
}): ChatEnvironmentControls {
  const show = () => {
    options.focusPane();
    options.clearLegacyPanel();
    options.closeDock();
    options.visibility.setVisible(options.paneId, options.isTiled, true);
  };
  return {
    show,
    toggle: () => {
      if (
        shouldRevealChatEnvironment(options.legacyPanel, options.companionPanel)
      ) {
        show();
        return;
      }
      options.focusPane();
      options.visibility.setVisible(
        options.paneId,
        options.isTiled,
        !options.isVisible,
      );
    },
  };
}
