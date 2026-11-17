import { useAppearance, userIsTypingElsewhere } from "@gyro-dev/ui";
import type { FitAddon as FitAddonInstance } from "@xterm/addon-fit";
import type { Terminal as XTermInstance } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { ResolvedTheme, TerminalPane } from "@gyro-dev/ui";
import { terminalOutputUpdate } from "./terminal-output";
import { isTauriRuntime } from "./tauri-runtime";

function terminalTypography(host: HTMLElement) {
  // Read resolved properties: custom font-size tokens contain calc(), which
  // cannot be passed directly to xterm's numeric options.
  const style = getComputedStyle(host);
  const fontSize = Number.parseFloat(style.fontSize);
  return {
    fontFamily: style.fontFamily,
    fontSize,
    lineHeight: Number.parseFloat(style.lineHeight) / fontSize,
  };
}

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
  onResize: (
    paneId: string,
    cols: number,
    rows: number,
  ) => void | boolean | Promise<void | boolean>;
  onSelect: (paneId: string) => void;
  /** Attach the selected output to the chat. */
  onSendSelection?: (paneId: string, selection: string) => void;
  onWrite: (paneId: string, input: string) => void;
  pane: TerminalPane;
  theme: ResolvedTheme;
}) {
  const { scale, reduceMotion } = useAppearance();
  const appearanceRef = useRef({ scale, reduceMotion });
  appearanceRef.current = { scale, reduceMotion };
  /** Whether this pane held the keyboard on the previous render. */
  const wasActiveRef = useRef(isActive);
  const [selectionText, setSelectionText] = useState("");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTermInstance | null>(null);
  const fitAddonRef = useRef<FitAddonInstance | null>(null);
  const paneOutputRef = useRef(pane.output ?? "");
  const renderedOutputRef = useRef("");
  const renderedCursorRef = useRef(pane.outputCursor);
  const cursorRef = useRef(pane.outputCursor);
  cursorRef.current = pane.outputCursor;
  const scheduleFitRef = useRef<() => void>();
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
      .then(async ([{ Terminal }, { FitAddon }]) => {
        if (disposed || !hostRef.current) {
          return;
        }
        const typography = terminalTypography(host);
        // Load the bundled face before xterm measures its character cells.
        await document.fonts.load(
          `${typography.fontSize}px ${typography.fontFamily}`,
        );
        if (disposed || !hostRef.current) return;

        const terminal = new Terminal({
          allowTransparency: true,
          cursorBlink: !appearanceRef.current.reduceMotion,
          // Browser preview fixtures are plain text; native output is a raw PTY stream.
          convertEol: !isTauriRuntime(),
          drawBoldTextInBrightColors: true,
          ...terminalTypography(host),
          macOptionIsMeta: true,
          minimumContrastRatio: 4.5,
          rightClickSelectsWord: true,
          scrollOnUserInput: true,
          scrollback: 5000,
          theme: terminalThemeFor(themeRef.current),
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        if (!mountRef.current) return;
        terminal.open(mountRef.current);
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        // Mounting is not a request for the keyboard: a command the model runs
        // creates a pane while the user may be mid-sentence in the composer,
        // and clicking into the composer never clears this pane's selection.
        if (isActive && !userIsTypingElsewhere(host)) {
          terminal.focus();
        }

        const dataDisposable = terminal.onData((data) => {
          // Replaying a finished PTY can generate terminal protocol replies.
          // Neither those replies nor keystrokes belong to an exited process.
          if (
            statusRef.current !== "running" &&
            statusRef.current !== "waiting"
          ) {
            return;
          }
          onWriteRef.current(pane.id, data);
        });
        const bellDisposable = terminal.onBell(() => {
          onBellRef.current(pane.id);
        });
        const selectionDisposable = terminal.onSelectionChange(() => {
          setSelectionText(terminal.getSelection());
        });

        let resizeInFlight = false;
        let retryTimer: number | undefined;
        const clearTerminal = (event: Event) => {
          event.preventDefault();
          terminal.clear();
        };
        host.addEventListener("gyro-terminal-clear", clearTerminal);
        const fitAndReport = async () => {
          if (disposed) return;
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
            const sizeKey = `${cursorRef.current?.generation ?? ""}:${cols}x${rows}`;
            if (resizeInFlight || sizeKey === lastSizeRef.current || disposed) {
              return;
            }
            // Tell the PTY for live sessions so full-screen CLIs (Claude Code)
            // redraw instead of leaving garbage from the previous geometry.
            if (
              statusRef.current === "running" ||
              statusRef.current === "waiting"
            ) {
              resizeInFlight = true;
              try {
                const accepted = await onResizeRef.current(pane.id, cols, rows);
                if (accepted !== false && !disposed)
                  lastSizeRef.current = sizeKey;
              } catch {
                // Creation may still be pending; retry without caching a failure.
              } finally {
                resizeInFlight = false;
                if (!disposed) {
                  window.clearTimeout(retryTimer);
                  retryTimer = window.setTimeout(scheduleFit, 200);
                }
              }
            }
          } catch {
            // The terminal can be hidden during route transitions; the next resize fixes it.
          }
        };

        const scheduleFit = () => {
          if (disposed) return;
          if (resizeFrameRef.current) {
            window.cancelAnimationFrame(resizeFrameRef.current);
          }
          // Double-rAF: wait until layout settles after the tool panel mounts.
          resizeFrameRef.current = window.requestAnimationFrame(() => {
            resizeFrameRef.current = window.requestAnimationFrame(fitAndReport);
          });
        };

        scheduleFitRef.current = scheduleFit;
        const resizeObserver = new ResizeObserver(scheduleFit);
        resizeObserver.observe(mountRef.current);
        // Fit before replaying cursor-addressed output; xterm defaults to 80×24.
        fitAndReport();
        const initialOutput = paneOutputRef.current;
        terminal.write(initialOutput);
        renderedOutputRef.current = initialOutput;
        renderedCursorRef.current = cursorRef.current;
        scheduleFit();
        // Panel height often animates open after mount; refit shortly after.
        const lateFit = window.setTimeout(scheduleFit, 120);
        const lateFit2 = window.setTimeout(scheduleFit, 320);

        disposeTerminal = () => {
          resizeObserver.disconnect();
          window.clearTimeout(retryTimer);
          host.removeEventListener("gyro-terminal-clear", clearTerminal);
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
      scheduleFitRef.current = undefined;
      renderedCursorRef.current = undefined;
    };
  }, [pane.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    const nextOutput = pane.output ?? "";
    const previousOutput = renderedOutputRef.current;
    if (
      nextOutput === previousOutput &&
      pane.outputCursor?.generation === renderedCursorRef.current?.generation &&
      pane.outputCursor?.end === renderedCursorRef.current?.end
    ) {
      return;
    }
    const update = terminalOutputUpdate(
      previousOutput,
      nextOutput,
      renderedCursorRef.current,
      pane.outputCursor,
    );
    if (update.reset) terminal.reset();
    terminal.write(update.data);
    renderedOutputRef.current = nextOutput;
    renderedCursorRef.current = pane.outputCursor;
  }, [pane.output, pane.outputCursor]);

  useEffect(() => {
    if (terminalRef.current && hostRef.current) {
      terminalRef.current.options = terminalTypography(hostRef.current);
      terminalRef.current.options.cursorBlink = !reduceMotion;
    }
    // Selecting this pane is the user asking for the keyboard; a PTY status
    // flip or an appearance change is not. Claim focus only on the
    // inactive → active edge, and never over a text field the user typed in.
    if (
      isActive &&
      !wasActiveRef.current &&
      !userIsTypingElsewhere(hostRef.current)
    ) {
      terminalRef.current?.focus();
    }
    wasActiveRef.current = isActive;
    // A new process needs a resize even at unchanged geometry.
    lastSizeRef.current = "";
    scheduleFitRef.current?.();
  }, [
    isActive,
    pane.id,
    pane.status,
    pane.outputCursor?.generation,
    scale,
    reduceMotion,
  ]);

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
        data-terminal-id={pane.id}
        className="gyro-xterm-host"
        onClick={(event) => {
          event.stopPropagation();
          onSelect(pane.id);
          terminalRef.current?.focus();
        }}
        onFocus={(event) => {
          if (event.target === event.currentTarget)
            terminalRef.current?.focus();
        }}
        ref={hostRef}
        role="textbox"
        tabIndex={0}
      >
        <div className="gyro-xterm-mount" ref={mountRef} />
      </div>
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
      {pane.status === "restored" || pane.status === "failed" ? (
        <div className="gyro-terminal-recovery" role="status">
          <span>
            {pane.status === "failed"
              ? "Process failed"
              : "Previous output · process is no longer running"}
          </span>
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
      background: "#f5f5f5",
      black: "#1f242c",
      blue: "#0d5dcc",
      brightBlack: "#626d7a",
      brightBlue: "#1568d5",
      brightCyan: "#087687",
      brightGreen: "#11774a",
      brightMagenta: "#a42ab8",
      brightRed: "#c03148",
      brightWhite: "#171a20",
      brightYellow: "#966000",
      cursor: "#1f242c",
      cursorAccent: "#f5f5f5",
      cyan: "#006b78",
      foreground: "#2c2c2c",
      green: "#096d43",
      magenta: "#8724ac",
      red: "#b5273d",
      selectionBackground: "#bcd9ff",
      white: "#535b66",
      yellow: "#835800",
    };
  }

  return {
    background: "#141414",
    black: "#080808",
    blue: "#54a8ff",
    brightBlack: "#959da9",
    brightBlue: "#83bdff",
    brightCyan: "#72e9ef",
    brightGreen: "#80e7b5",
    brightMagenta: "#d19aff",
    brightRed: "#ff9baa",
    brightWhite: "#f7f7f7",
    brightYellow: "#ffd166",
    cursor: "#ededed",
    cursorAccent: "#141414",
    cyan: "#44dbe0",
    foreground: "#dedede",
    green: "#53d69b",
    magenta: "#be83ff",
    red: "#ff7789",
    selectionBackground: "#245489",
    white: "#dddddd",
    yellow: "#f6c968",
  };
}
