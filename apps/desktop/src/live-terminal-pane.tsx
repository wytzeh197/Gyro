import type { FitAddon as FitAddonInstance } from "@xterm/addon-fit";
import type { Terminal as XTermInstance } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { ResolvedTheme, TerminalPane } from "@gyro-dev/ui";
import { terminalOutputUpdate } from "./terminal-output";
import { isTauriRuntime } from "./tauri-runtime";

export function LiveTerminalPaneBody({
  isActive,
  onBell,
  onReconnect,
  onResize,
  onSelect,
  onSendSelection,
  onWrite,
  pane,
  theme,
}: {
  isActive: boolean;
  onBell: (paneId: string) => void;
  onReconnect: (paneId: string) => void;
  onResize: (paneId: string, cols: number, rows: number) => void;
  onSelect: (paneId: string) => void;
  /** Attach the selected output to the chat. */
  onSendSelection?: (paneId: string, selection: string) => void;
  onWrite: (paneId: string, input: string) => void;
  pane: TerminalPane;
  theme: ResolvedTheme;
}) {
  const [selectionText, setSelectionText] = useState("");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTermInstance | null>(null);
  const fitAddonRef = useRef<FitAddonInstance | null>(null);
  const paneOutputRef = useRef(pane.output ?? "");
  const renderedOutputRef = useRef("");
  const resizeFrameRef = useRef<number | undefined>();
  const lastSizeRef = useRef("");
  const statusRef = useRef(pane.status);
  const themeRef = useRef(theme);
  const onResizeRef = useRef(onResize);
  const onBellRef = useRef(onBell);
  const onWriteRef = useRef(onWrite);

  paneOutputRef.current = pane.output ?? "";
  themeRef.current = theme;

  useEffect(() => {
    statusRef.current = pane.status;
    onResizeRef.current = onResize;
    onBellRef.current = onBell;
    onWriteRef.current = onWrite;
  }, [onBell, onResize, onWrite, pane.status]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    let disposed = false;
    let disposeTerminal: (() => void) | undefined;

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !hostRef.current) {
          return;
        }

        const terminal = new Terminal({
          allowTransparency: true,
          cursorBlink: true,
          // Browser preview fixtures are plain text; native output is a raw PTY stream.
          convertEol: !isTauriRuntime(),
          drawBoldTextInBrightColors: true,
          fontFamily:
            "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
          fontSize: 12,
          lineHeight: 1.2,
          macOptionIsMeta: true,
          minimumContrastRatio: 1,
          rightClickSelectsWord: true,
          scrollOnUserInput: true,
          scrollback: 5000,
          theme: terminalThemeFor(themeRef.current),
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(hostRef.current);
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        if (isActive) {
          terminal.focus();
        }

        const dataDisposable = terminal.onData((data) => {
          onWriteRef.current(pane.id, data);
        });
        const bellDisposable = terminal.onBell(() => {
          onBellRef.current(pane.id);
        });
        const selectionDisposable = terminal.onSelectionChange(() => {
          setSelectionText(terminal.getSelection());
        });

        const fitAndReport = () => {
          try {
            const hostEl = hostRef.current;
            // Fitting at 0×0 is what scatters TUI apps across the window.
            if (
              !hostEl ||
              hostEl.clientWidth < 24 ||
              hostEl.clientHeight < 24
            ) {
              return;
            }
            fitAddon.fit();
            const cols = terminal.cols;
            const rows = terminal.rows;
            if (cols < 2 || rows < 2) {
              return;
            }
            const sizeKey = `${cols}x${rows}`;
            if (sizeKey === lastSizeRef.current) {
              return;
            }
            // Tell the PTY for live sessions so full-screen CLIs (Claude Code)
            // redraw instead of leaving garbage from the previous geometry.
            if (
              statusRef.current === "running" ||
              statusRef.current === "waiting"
            ) {
              lastSizeRef.current = sizeKey;
              onResizeRef.current(pane.id, cols, rows);
            }
          } catch {
            // The terminal can be hidden during route transitions; the next resize fixes it.
          }
        };

        const scheduleFit = () => {
          if (resizeFrameRef.current) {
            window.cancelAnimationFrame(resizeFrameRef.current);
          }
          // Double-rAF: wait until layout settles after the tool panel mounts.
          resizeFrameRef.current = window.requestAnimationFrame(() => {
            resizeFrameRef.current = window.requestAnimationFrame(fitAndReport);
          });
        };

        const resizeObserver = new ResizeObserver(scheduleFit);
        resizeObserver.observe(hostRef.current);
        // Fit before replaying cursor-addressed output; xterm defaults to 80×24.
        fitAndReport();
        const initialOutput = paneOutputRef.current;
        terminal.write(initialOutput);
        renderedOutputRef.current = initialOutput;
        scheduleFit();
        // Panel height often animates open after mount; refit shortly after.
        const lateFit = window.setTimeout(scheduleFit, 120);
        const lateFit2 = window.setTimeout(scheduleFit, 320);

        disposeTerminal = () => {
          resizeObserver.disconnect();
          window.clearTimeout(lateFit);
          window.clearTimeout(lateFit2);
          if (resizeFrameRef.current) {
            window.cancelAnimationFrame(resizeFrameRef.current);
          }
          dataDisposable.dispose();
          bellDisposable.dispose();
          selectionDisposable.dispose();
          terminal.dispose();
        };
      })
      .catch(() => {
        if (!disposed && hostRef.current) {
          hostRef.current.textContent = "Terminal renderer failed to load.";
        }
      });

    return () => {
      disposed = true;
      disposeTerminal?.();
      terminalRef.current = null;
      fitAddonRef.current = null;
      renderedOutputRef.current = "";
      lastSizeRef.current = "";
    };
  }, [pane.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    const nextOutput = pane.output ?? "";
    const previousOutput = renderedOutputRef.current;
    if (nextOutput === previousOutput) {
      return;
    }
    const update = terminalOutputUpdate(previousOutput, nextOutput);
    if (update.reset) terminal.reset();
    terminal.write(update.data);
    renderedOutputRef.current = nextOutput;
  }, [pane.output]);

  useEffect(() => {
    if (isActive) terminalRef.current?.focus();
    // Also report dimensions when a stopped pane gets a new live process.
    const timer = window.setTimeout(() => {
      try {
        const host = hostRef.current;
        const fitAddon = fitAddonRef.current;
        const terminal = terminalRef.current;
        if (
          !host ||
          !fitAddon ||
          !terminal ||
          host.clientWidth < 24 ||
          host.clientHeight < 24
        ) {
          return;
        }
        fitAddon.fit();
        if (
          terminal.cols >= 2 &&
          terminal.rows >= 2 &&
          (statusRef.current === "running" || statusRef.current === "waiting")
        ) {
          const sizeKey = `${terminal.cols}x${terminal.rows}`;
          if (sizeKey !== lastSizeRef.current) {
            lastSizeRef.current = sizeKey;
            onResizeRef.current(pane.id, terminal.cols, terminal.rows);
          }
        }
      } catch {
        // ignore fit races during unmount
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [isActive, pane.id, pane.status]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.options.theme = terminalThemeFor(theme);
    }
  }, [theme]);

  return (
    <div className="gyro-xterm-frame">
      {pane.owner?.kind === "model" ? (
        <div className="gyro-model-terminal-notice" role="note">
          Model-owned process · your typed input and echoed output may be
          visible to this Chat
        </div>
      ) : null}
      <div
        aria-label="Terminal input"
        className="gyro-xterm-host"
        onClick={(event) => {
          event.stopPropagation();
          onSelect(pane.id);
          if (
            statusRef.current === "restored" ||
            statusRef.current === "failed"
          ) {
            onReconnect(pane.id);
            return;
          }
          terminalRef.current?.focus();
        }}
        ref={hostRef}
        role="textbox"
        tabIndex={0}
      />
      {onSendSelection && selectionText.trim() ? (
        <button
          className="gyro-terminal-send-selection"
          onClick={(event) => {
            event.stopPropagation();
            onSendSelection(pane.id, selectionText);
            terminalRef.current?.clearSelection();
          }}
          // Keep the xterm selection: a mousedown here would clear it first.
          onMouseDown={(event) => event.preventDefault()}
          title="Attach the selected output to the chat"
          type="button"
        >
          Send selection to chat
        </button>
      ) : null}
      {pane.status === "restored" ? (
        <div className="gyro-terminal-recovery" role="status">
          <span>Previous output · process is no longer running</span>
          <button
            className="gyro-terminal-reconnect"
            onClick={(event) => {
              event.stopPropagation();
              onReconnect(pane.id);
            }}
            type="button"
          >
            Start again
          </button>
        </div>
      ) : null}
    </div>
  );
}

function terminalThemeFor(theme: ResolvedTheme) {
  if (theme === "light") {
    return {
      background: "#ffffff",
      black: "#1f242c",
      blue: "#1f66d1",
      brightBlack: "#8e8e93",
      brightBlue: "#2f7dff",
      brightCyan: "#008f9a",
      brightGreen: "#168a50",
      brightMagenta: "#b034c9",
      brightRed: "#d92d20",
      brightWhite: "#171a20",
      brightYellow: "#ffbf00",
      cursor: "#1f242c",
      cursorAccent: "#ffffff",
      cyan: "#007c89",
      foreground: "#25272d",
      green: "#087443",
      magenta: "#9b26b6",
      red: "#b42318",
      selectionBackground: "#dfe2e6",
      white: "#ededed",
      yellow: "#875200",
    };
  }

  return {
    background: "#0c0c0c",
    black: "#080808",
    blue: "#6ea8ff",
    brightBlack: "#858585",
    brightBlue: "#99c2ff",
    brightCyan: "#7ce7e1",
    brightGreen: "#7ee2a8",
    brightMagenta: "#f08cff",
    brightRed: "#ff8a88",
    brightWhite: "#f7f7f7",
    brightYellow: "#ffd166",
    cursor: "#ededed",
    cursorAccent: "#0b0b0b",
    cyan: "#51d7d0",
    foreground: "#e6e6e6",
    green: "#52d985",
    magenta: "#d86cff",
    red: "#ff6f6f",
    selectionBackground: "#343434",
    white: "#dddddd",
    yellow: "#f2c94c",
  };
}
