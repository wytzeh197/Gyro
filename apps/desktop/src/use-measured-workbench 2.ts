import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useReducer,
  type Dispatch,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  workbenchReducer,
  type WorkbenchAction,
  type WorkbenchState,
} from "@gyro-dev/ui";
import { createSurfaceTiming, type TimingSurface } from "./surface-timing";

const NAVIGATION_ACTIONS = new Set<WorkbenchAction["type"]>([
  "select-destination",
  "select-surface",
  "select-sessions",
  "select-workspace-layout",
  "enter-workspace",
  "ide-select-view",
]);

export function useMeasuredWorkbenchReducer(initialize: () => WorkbenchState) {
  const [state, dispatch] = useReducer(workbenchReducer, undefined, initialize);
  return [state, useMeasuredWorkbenchDispatch(state, dispatch)] as const;
}

export function timingSurface(state: WorkbenchState): TimingSurface {
  if (state.activeDestination !== "workspace") return state.activeDestination;
  if (state.activeWorkspaceLayout === "thread") return "chat";
  if (state.activeWorkspaceLayout === "terminal-grid") return "terminal";
  return state.ide.activeView;
}

export function useMeasuredWorkbenchDispatch(
  state: WorkbenchState,
  dispatch: Dispatch<WorkbenchAction>,
) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const controller = useRef<ReturnType<typeof createSurfaceTiming> | null>(
    null,
  );
  const firstCommit = useRef<{ at: number; surface: TimingSurface }>();
  useLayoutEffect(() => {
    const surface = timingSurface(state);
    firstCommit.current ??= { at: performance.now(), surface };
    controller.current?.commit(surface);
  }, [state]);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || !firstCommit.current) return;
    const timing = createSurfaceTiming({
      now: () => performance.now(),
      frame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id),
      visible: () => document.visibilityState === "visible",
      firstCommit: firstCommit.current,
      save: (value) => {
        void invoke("record_surface_timing", { value }).catch(() => {
          console.warn("Gyro surface timing could not be saved");
        });
      },
    });
    controller.current = timing;
    timing.commit(timingSurface(stateRef.current));
    void invoke<boolean>("timing_diagnostics_enabled").then(
      (enabled) => timing.enable(enabled),
      () => timing.enable(false),
    );
    return () => {
      timing.dispose();
      if (controller.current === timing) controller.current = null;
    };
  }, []);
  return useCallback(
    (action: WorkbenchAction) => {
      if (
        NAVIGATION_ACTIONS.has(action.type) &&
        controller.current?.isEnabled()
      ) {
        const current = stateRef.current;
        // These navigation cases are pure; predict the target without reading DOM content.
        controller.current.begin(
          timingSurface(current),
          timingSurface(workbenchReducer(current, action)),
        );
      }
      dispatch(action);
    },
    [dispatch],
  );
}
