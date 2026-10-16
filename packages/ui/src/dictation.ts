/**
 * Composer dictation.
 *
 * `dictationDraft` places words into the draft the user will choose to send.
 * Partials rewrite the same span, so a later result replaces the earlier one
 * instead of appending. `createBrowserDictation` owns the speech recognizer.
 */

export type DictationListener = {
  /** In-progress words. Replaces the previous partial from this session. */
  onPartial: (utterance: string) => void;
  /** Finished words. Replaces the partial. */
  onFinal: (utterance: string) => void;
  onError: (message: string) => void;
  signal: AbortSignal;
};

export type DictationController = {
  /**
   * Begin one exclusive session. A second start replaces the session this
   * controller already owns. `stop` releases the microphone and must not call
   * back into the listener.
   */
  start: (listener: DictationListener) => void;
  stop: () => void;
};

export function dictationDraft(
  base: string,
  caret: number,
  utterance: string,
  maxLength?: number,
): { draft: string; caret: number } {
  const at = Math.min(Math.max(0, Math.trunc(caret)), base.length);
  const spoken = utterance.trim();
  const gap =
    spoken.length > 0 && at > 0 && !/\s$/u.test(base.slice(0, at))
      ? " "
      : "";
  let insert = gap + spoken;
  if (maxLength != null) {
    const room = Math.max(0, maxLength - base.length);
    insert = insert.slice(0, room);
  }
  return {
    draft: base.slice(0, at) + insert + base.slice(at),
    caret: at + insert.length,
  };
}

export type BrowserDictationRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  abort: () => void;
  onresult:
    | ((event: {
        results: ArrayLike<{
          isFinal: boolean;
          0?: { transcript?: string };
        }>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type RecognitionConstructor = new () => BrowserDictationRecognition;

function speechRecognitionConstructor(): RecognitionConstructor | null {
  if (typeof globalThis === "undefined") return null;
  const host = globalThis as typeof globalThis & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
}

function dictationErrorMessage(error: string): string | null {
  switch (error) {
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Allow the microphone to dictate.";
    case "audio-capture":
      return "No microphone is available.";
    case "network":
      return "Dictation needs a network connection.";
    case "no-speech":
      return "No speech was heard.";
    case "language-not-supported":
      return "This language cannot be dictated.";
    default:
      return "Dictation stopped.";
  }
}

function spokenUtterance(event: {
  results: ArrayLike<{ isFinal: boolean; 0?: { transcript?: string } }>;
}): { text: string; isFinal: boolean } {
  let text = "";
  let isFinal = false;
  for (let index = 0; index < event.results.length; index += 1) {
    const result = event.results[index];
    text += result?.[0]?.transcript ?? "";
    if (result?.isFinal && index === event.results.length - 1) isFinal = true;
  }
  return { text, isFinal };
}

let accessRequest: (() => Promise<string | null>) | null = null;

/**
 * Desktop installs this so the first click can raise the system permission
 * sheets before the recognizer starts. A returned string is shown and the
 * microphone stays closed. `null` leaves browser dictation unchanged.
 */
export function setDictationAccessRequest(
  request: (() => Promise<string | null>) | null,
): void {
  accessRequest = request;
}

/** Composer copy for a macOS microphone or speech-recognition decision. */
export function dictationAccessError(
  access: { microphone?: string; speech?: string } | null | undefined,
): string | null {
  if (
    access?.microphone === "unsupported" &&
    access.speech === "unsupported"
  ) {
    return null;
  }
  if (access?.microphone !== "authorized") {
    return "Allow the microphone to dictate.";
  }
  if (access.speech === "denied" || access.speech === "restricted") {
    return "Allow Speech Recognition to dictate.";
  }
  return null;
}

/**
 * One browser speech session. `ctor` is injectable so tests can avoid the
 * microphone. A missing constructor reports that dictation is unavailable.
 * An installed access request runs first and can cancel the session.
 */
export function createBrowserDictation(
  ctor: RecognitionConstructor | null = speechRecognitionConstructor(),
): DictationController {
  let recognition: BrowserDictationRecognition | null = null;
  let listener: DictationListener | null = null;
  let settle: (() => void) | null = null;
  let generation = 0;

  const stop = () => {
    generation += 1;
    const current = recognition;
    recognition = null;
    listener = null;
    settle?.();
    settle = null;
    if (!current) return;
    current.onresult = null;
    current.onerror = null;
    current.onend = null;
    try {
      current.abort();
    } catch {
      /* The recognizer had already ended. */
    }
  };

  const begin = (next: DictationListener, id: number) => {
    if (generation !== id || next.signal.aborted) return;
    if (!ctor) {
      next.onError("Dictation is not available in this window.");
      return;
    }
    let settled = false;
    settle = () => {
      settled = true;
    };
    let session: BrowserDictationRecognition;
    try {
      session = new ctor();
    } catch {
      settle = null;
      next.onError("Dictation is not available in this window.");
      return;
    }
    if (generation !== id || next.signal.aborted) {
      settle = null;
      try {
        session.abort();
      } catch {
        /* constructed after the click was released */
      }
      return;
    }
    recognition = session;
    listener = next;
    session.continuous = false;
    session.interimResults = true;
    session.lang =
      typeof navigator !== "undefined" && navigator.language
        ? navigator.language
        : "en-US";
    let latest = "";
    session.onresult = (event) => {
      if (settled || next.signal.aborted || listener !== next) return;
      const spoken = spokenUtterance(event);
      latest = spoken.text;
      if (!spoken.isFinal) {
        next.onPartial(spoken.text);
        return;
      }
      settled = true;
      next.onFinal(spoken.text);
    };
    session.onerror = (event) => {
      if (settled || listener !== next) return;
      const message = dictationErrorMessage(event.error);
      if (!message) return;
      settled = true;
      next.onError(message);
    };
    session.onend = () => {
      if (settled || listener !== next) return;
      settled = true;
      next.onFinal(latest);
    };
    try {
      session.start();
    } catch {
      settled = true;
      recognition = null;
      listener = null;
      try {
        session.abort();
      } catch {
        /* start failed before the recognizer was running */
      }
      next.onError("Dictation is not available in this window.");
    }
  };

  return {
    start(next) {
      stop();
      const id = ++generation;
      const request = accessRequest;
      if (!request) {
        begin(next, id);
        return;
      }
      void Promise.resolve()
        .then(() => {
          if (generation !== id || next.signal.aborted) return null;
          return request();
        })
        .then((message) => {
          if (generation !== id || next.signal.aborted) return;
          if (message) {
            next.onError(message);
            return;
          }
          begin(next, id);
        })
        .catch(() => {
          if (generation !== id || next.signal.aborted) return;
          next.onError("Allow the microphone to dictate.");
        });
    },
    stop,
  };
}

let sharedBrowserDictation: DictationController | undefined;

/** The microphone shared by composers that did not bring a transcriber. */
export function browserDictation(): DictationController {
  sharedBrowserDictation ??= createBrowserDictation();
  return sharedBrowserDictation;
}
