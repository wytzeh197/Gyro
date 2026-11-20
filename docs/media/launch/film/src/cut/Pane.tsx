// One real ChatSurface for parallel/tiled panes.
import { ChatSurface } from "@gyro-ui/surfaces.tsx";
import { config } from "../fixtures/config.js";
import { W, branch, paneBusy, paneEvents, panes } from "./data";

const noop = () => undefined;
export const Pane: React.FC<{ i: number; t: number; tiled?: boolean; options?: any; every?: number }> = ({ i, t, tiled, options = {}, every = 22 }) => {
  const p = panes[i];
  return (
    <ChatSurface
      config={config as never}
      events={paneEvents(i, t, every) as never}
      paneKey={"pane-" + i}
      sessionTitle={p.title}
      workspacePath={W}
      branchName={branch(i)}
      sessionModel={{ providerId: p.providerId, modelId: p.modelId } as never}
      isTiled={options.isTiled ?? tiled}
      isComposerSending={paneBusy(i, t, every)}
      onPaneDragStart={options.onPaneDragStart ?? noop}
      onPaneDragEnd={options.onPaneDragEnd ?? noop}
      onPanePointerDown={options.onPanePointerDown ?? noop}
      onComposerAction={noop}
      onSend={noop}
      shellReady
    />
  );
};
