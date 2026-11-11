// Explicit embedded acceptance entrypoint, excluded from normal Vite builds.
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  BrowserPreviewSurface,
  createInitialWorkbenchState,
  workbenchReducer,
  type BrowserPreview,
  type WorkbenchAction,
  type WorkbenchState,
} from "@gyro-dev/ui";
import {
  useSessionBrowserEvents,
  changeSessionBrowserViewport,
} from "./use-session-browser-events";
import { useModelBrowserReveal } from "./model-browser-reveal";
import { sessionBrowserNative } from "./session-browser-native";
import type { SessionBrowserSnapshot } from "./session-browser-queue";
import { createBrowserHostVisibility } from "./browser-host-visibility";
import { captureChatBrowserPage } from "./browser-capture";
import { requestBrowserAnnotation } from "./browser-annotations";
let annotationToken = "";
let annotationSent = false;
let annotationCaptureSize: {width:number;height:number} | undefined;
import "@gyro-dev/ui/styles.css";

type Owner = { id: string; workspaceKey: string };
const options = (
  window as typeof window & {
    __nativeBrowserEvents?: {
      sessions: Owner[];
      pageUrl: string;
      visualReview?: boolean;
      navigationOnly?: boolean;
    };
  }
).__nativeBrowserEvents;
const checks: string[] = [];
const errors: string[] = [];
const violations: string[] = [];
const commands: string[] = [];
const measurements: Record<string, unknown> = {};
const captures: BrowserPreview["latestCapture"][] = [];
const actions: WorkbenchAction[] = [];
let state: () => WorkbenchState;
let dispatch: React.Dispatch<WorkbenchAction>;
let flushReact: () => Promise<void>;
let requestedCommit = 0;
let committed = 0;
let enableReviewContinue: () => void;
let reviewContinued = false;
let started = false;
// Observe completion of the production hook's actual work. Native event-listener
// acknowledgement alone does not order another listener's delivery or React.
const routed: {
  sessionId: string;
  resourceId?: string;
  kind: string;
  result: Promise<boolean>;
  accepted?: boolean;
}[] = [];
const nativeObserve = sessionBrowserNative.observe;
sessionBrowserNative.observe = (sessionId, resourceId, kind, success) => {
  const result = nativeObserve(sessionId, resourceId, kind, success);
  const entry = {
    sessionId,
    resourceId,
    kind,
    result,
    accepted: undefined as boolean | undefined,
  };
  routed.push(entry);
  void result.then((accepted) => {
    entry.accepted = accepted;
  });
  return result;
};
const first = options?.sessions[0]?.id ?? "missing";
const updateHost = createBrowserHostVisibility((command, args) =>
  invoke(command, args),
);
window.addEventListener("error", (event) => {
  if (event.message) errors.push(event.message);
});
window.addEventListener("unhandledrejection", (event) =>
  errors.push(String(event.reason)),
);
window.addEventListener("securitypolicyviolation", (event) =>
  violations.push(`${event.effectiveDirective}: ${event.blockedURI}`),
);
const send = (sessionId: string, action: WorkbenchAction) =>
  dispatch({ type: "browser-session", sessionId, action });
const preview = (sessionId = first) =>
  state().browserPreviewsBySession?.[sessionId];
const call = <T,>(command: string, args: Record<string, unknown>) => {
  commands.push(command);
  return invoke<T>(command, args);
};
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  checks.push(message);
  document.title =
    "GYRO_BROWSER_CAPTURE_PROGRESS:" +
    JSON.stringify({ count: checks.length, message });
}
async function until<T>(
  read: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  message: string,
  milliseconds = 10000,
): Promise<T> {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== null && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const fail = (error: unknown) => {
  throw error;
};
const page = (label: string) => {
  const url = new URL(options!.pageUrl);
  url.searchParams.set("label", label);
  return url.toString();
};
async function open(owner: Owner, label: string) {
  send(owner.id, {
    type: "browser-navigate",
    url: page(label),
    background: true,
  });
  const opened = await sessionBrowserNative.replace(
    owner.id,
    () =>
      call<SessionBrowserSnapshot>("session_browser_open", {
        request: {
          sessionId: owner.id,
          workspaceKey: owner.workspaceKey,
          url: page(label),
          visible: false,
        },
      }),
    (snapshot) => {
      send(owner.id, { type: "browser-title", title: snapshot.title });
      send(owner.id, { type: "browser-viewport", viewport: snapshot.viewport });
    },
    fail,
  );
  if (!opened) throw new Error("fixture open was superseded");
  await until(
    () =>
      preview(owner.id)?.status === "ready" &&
      preview(owner.id)?.title === `Gyro Fixture ${label}`,
    `${label} did not reach React through native events`,
  );
  return call<SessionBrowserSnapshot>("session_browser_snapshot", {
    sessionId: owner.id,
  });
}
async function close(owner: Owner) {
  const progress = (stage: string) => {
    document.title =
      "GYRO_BROWSER_CAPTURE_PROGRESS:" +
      JSON.stringify({
        count: checks.length,
        message: `Close ${owner.id} ${stage}`,
      });
  };
  progress("requested");
  const closing = sessionBrowserNative.close(owner.id, fail);
  send(owner.id, { type: "browser-close" });
  await closing;
  progress("native completed");
  await until(
    () => preview(owner.id)?.status === "idle",
    "close did not clear the React preview",
  );
  progress("React idle");
}
async function event(name: string, payload: Record<string, unknown>) {
  const before = routed.length;
  const marker = crypto.randomUUID();
  const received = deferred();
  const stop = await listen<{ fixtureMarker?: string }>(name, ({ payload }) => {
    if (payload.fixtureMarker === marker) received.resolve();
  });
  try {
    await emit(name, { ...payload, fixtureMarker: marker });
    await Promise.race([
      received.promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("native event acknowledgement timed out")),
          3000,
        ),
      ),
    ]);
    const kind = name === "session-browser-opened" ? "opened" : payload.kind;
    const observation = await until(
      () =>
        routed
          .slice(before)
          .find(
            (entry) =>
              entry.sessionId === payload.sessionId &&
              entry.resourceId === payload.resourceId &&
              entry.kind === kind,
          ),
      "production hook did not receive the native event",
    );
    const accepted = await observation.result;
    await flushReact();
    return accepted;
  } finally {
    stop();
  }
}
function screenshot() {
  const current = preview()!;
  send(first, { type: "browser-capture-start" });
  return sessionBrowserNative.run(
    first,
    () =>
      captureChatBrowserPage({
        sessionId: first,
        nativeHost: true,
        device: current.device,
        url: current.url,
      }),
    (capture) => {
      captures.push(capture);
      send(first, { type: "browser-capture-success", capture });
    },
    (error) =>
      send(first, { type: "browser-capture-failure", error: String(error) }),
  );
}

function Fixture() {
  const [workbench, sendAction] = useReducer(
    workbenchReducer,
    undefined,
    createInitialWorkbenchState,
  );
  const recordDispatch = useCallback((action: WorkbenchAction) => {
    actions.push(action);
    sendAction(action);
  }, []);
  const [commitMarker, markCommit] = useState(0);
  const [reviewReady, setReviewReady] = useState(false);
  enableReviewContinue = () => setReviewReady(true);
  useLayoutEffect(() => {
    committed = commitMarker;
  }, [commitMarker]);
  flushReact = async () => {
    const marker = ++requestedCommit;
    // This marker uses the same normal update priority as the native callback's
    // preceding dispatches. A forced sync render can skip those deferred lanes.
    markCommit(marker);
    await until(
      () => committed >= marker,
      "React did not commit native event updates",
    );
  };
  const latest = useRef(workbench);
  latest.current = workbench;
  state = () => latest.current;
  dispatch = recordDispatch;
  useSessionBrowserEvents(recordDispatch);
  useModelBrowserReveal({
    activeSessionId: first,
    dispatch: recordDispatch,
    hasMaximizedPane: false,
    isBrowserVisible: workbench.preferences.activeChatPanel === "browser",
    isTauriRuntime: true,
    occupiedPaneCount: 2,
  });
  const host = useCallback((bounds: Parameters<typeof updateHost>[1]) => {
    void updateHost(first, bounds);
  }, []);
  useEffect(() => {
    if (started) return;
    started = true;
    void run().then(
      () => report(true),
      (error) => report(false, error),
    );
  }, []);
  const current =
    workbench.browserPreviewsBySession?.[first] ?? workbench.browserPreview;
  return (
    <main
      style={{
        height: "100vh",
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        background: "var(--gyro-pane)",
        color: "var(--gyro-text)",
      }}
    >
      <header>
        <strong>Isolated native browser acceptance</strong>
        <output id="fixture-title">{current.title}</output>
        <output id="fixture-status">{current.status}</output>
        {options?.visualReview ? (
          <button
            disabled={!reviewReady}
            onClick={() => {
              reviewContinued = true;
            }}
          >
            Continue acceptance
          </button>
        ) : null}
      </header>
      <div className="gyro-chat-companion gyro-chat-companion-content">
        <BrowserPreviewSurface
          variant="chat"
          browserPreview={current}
          nativeHost
          onHostBoundsChange={host}
          onDeviceChange={(mode) => {
            void changeSessionBrowserViewport(
              first,
              mode,
              Boolean(current.url),
              sendAction,
              fail,
            );
          }}
          onScreenshot={async (action, feedback) => {
            if (action?.startsWith("annotate-")) {
              if(action === "annotate-start") annotationToken=feedback?.annotationToken ?? "";
              const result=await requestBrowserAnnotation({action,feedback,sessionId:first,capture:preview()?.latestCapture});
              if(result.capture) annotationCaptureSize={width:result.capture.width,height:result.capture.height};
              if(action==="annotate-send" && result.attachments) {
                assert(result.attachments.some(item=>item.kind==="image"),"Native annotation prepares the PNG attachment");
                assert(result.attachments.some(item=>item.kind==="browser-snapshot"),"Native annotation prepares immutable element context");
                annotationSent=true;
                // Submission acknowledgement is simulated; no provider is called by this fixture.
                return {sent:true};
              }
              return result;
            }
            await screenshot();
            return undefined;
          }}
          onReload={() => {
            dispatch({type:"browser-session",sessionId:first,action:{type:"browser-reload"}});
            void sessionBrowserNative.run(first,
              () => call<SessionBrowserSnapshot>("session_browser_reload",{sessionId:first}),
              (snapshot) => dispatch({type:"browser-session",sessionId:first,action:{type:"browser-native-state",...snapshot}}),
              fail);
          }}
        />
      </div>
    </main>
  );
}

async function run() {
  assert(
    options?.sessions.length === 2,
    "Native bootstrap supplies two isolated session owners",
  );
  assert(
    isTauri() && location.protocol === "tauri:",
    "Production hooks run from embedded Tauri assets",
  );
  assert(
    navigator.userAgent.includes("AppleWebKit"),
    "Renderer is native Apple WebKit",
  );
  await until(
    () => document.querySelector('[aria-label="Browser URL"]'),
    "production browser toolbar did not mount",
  );
  assert(
    document.body.textContent?.includes("Start browsing"),
    "Production browser renders its empty state",
  );
  const owner = options.sessions[0]!;
  const other = options.sessions[1]!;
  const original = await open(owner, "Original");
  assert(
    preview()?.url === page("Original"),
    "Native load notification updates the real reducer URL",
  );
  assert(
    preview()?.title === "Gyro Fixture Original",
    "Native title notification updates the real reducer title",
  );
  await until(
    () =>
      document.querySelector<HTMLInputElement>('[aria-label="Browser URL"]')
        ?.value === page("Original"),
    "rendered address did not update",
  );
  assert(
    document.querySelector<HTMLInputElement>('[aria-label="Browser URL"]')
      ?.value === page("Original"),
    "Production URL toolbar renders the native page URL",
  );
  assert(
    state().preferences.activeChatPanel === undefined,
    "Normal browser events do not reveal the active panel",
  );
  // Exercise production selection/capture UI with real WebKit + attachment IPC.
  document.querySelector<HTMLButtonElement>('[aria-label="Annotatie"]')!.click();
  await until(()=>Boolean(annotationToken),"annotation picker did not start");
  await flushReact();
  const annotationSource=await captureChatBrowserPage({
    sessionId:first,nativeHost:true,device:preview()!.device,url:preview()!.url,
  });
  assert(Boolean(annotationSource.annotationState),"Native capture records stable element context");
  const picked=await call<{annotation?:unknown;error?:string}>("session_browser_annotate",{
    sessionId:first,options:{action:"point",token:annotationToken,
      captureState:annotationSource.annotationState,
      x:annotationSource.annotationState!.viewport.width/2,y:60},
  });
  assert(Boolean(picked.annotation),`Native element hit test succeeds (${picked.error??"no error"})`);
  await until(()=>Boolean(document.querySelector(".gyro-browser-annotation-form.is-bubble")),
    "native annotation bubble did not appear");
  assert(Boolean(annotationCaptureSize?.width && annotationCaptureSize.height),
    "Native selected-region PNG decodes and crops");
  const annotationForm=document.querySelector<HTMLFormElement>(".gyro-browser-annotation-form.is-bubble")!;
  const annotationStage=document.querySelector<HTMLElement>(".gyro-browser-annotation-stage")!;
  const ab=annotationForm.getBoundingClientRect(),sb=annotationStage.getBoundingClientRect();
  assert(ab.left>=sb.left && ab.right<=sb.right+1 && ab.top>=sb.top && ab.bottom<=sb.bottom+1,
    "Native bubble remains within the browser panel");
  const field=annotationForm.querySelector<HTMLTextAreaElement>("textarea")!;
  assert(document.activeElement===field,"Native captured bubble focuses its comment field");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(field,"Make this heading clearer.");
  field.dispatchEvent(new Event("input",{bubbles:true}));
  await flushReact();
  annotationForm.requestSubmit();
  await until(()=>annotationSent,"native annotation attachment send did not complete");
  await until(()=>!document.querySelector(".gyro-browser-annotation-stage"),"native annotation did not restore Live");
  assert(true,"Native bubble closes after simulated chat acceptance and restores Live");
  await flushReact();

  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="Browser URL"]',
  )!;
  input.focus();
  assert(
    document.activeElement === input,
    "Production address field receives DOM focus",
  );
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert(
    document.activeElement !== input,
    "Production Escape handler releases DOM focus",
  );
  document
    .querySelector<HTMLButtonElement>('[aria-label="Browser options"]')!
    .click();
  await until(
    () =>
      document
        .querySelector('[aria-label="Browser options"]')
        ?.getAttribute("aria-expanded") === "true",
    "browser options did not open",
  );
  document.querySelector<HTMLButtonElement>('[aria-label="Mobile"]')!.click();
  await until(
    () =>
      preview()?.viewport?.width === 390 && preview()?.viewport?.height === 844,
    "native viewport command did not reach React",
  );
  const mobile = await call<SessionBrowserSnapshot>(
    "session_browser_snapshot",
    { sessionId: first },
  );
  assert(
    mobile.viewport.width === 390 && mobile.viewport.height === 844,
    "Rendered viewport control changes the native browser to 390x844",
  );
  assert(
    document
      .querySelector('[aria-label="Mobile"]')
      ?.getAttribute("aria-pressed") === "true",
    "Production viewport button reflects the native selection",
  );
  document
    .querySelector<HTMLButtonElement>('[aria-label="Browser options"]')!
    .click();
  await until(
    () =>
      document
        .querySelector('[aria-label="Browser options"]')
        ?.getAttribute("aria-expanded") === "true",
    "capture menu did not open",
  );
  document
    .querySelector<HTMLButtonElement>(
      '[aria-label="Capture browser screenshot"]',
    )!
    .click();
  await until(
    () =>
      preview()?.captureStatus === "captured" ||
      preview()?.captureStatus === "failed",
    "native capture did not settle",
  );
  assert(
    preview()?.captureStatus === "captured",
    `Native screenshot command succeeds (${preview()?.captureError ?? "no error"})`,
  );
  const currentCaptureDecoded = () => {
    const capture=preview()?.latestCapture;
    const image=document.querySelector<HTMLImageElement>(".gyro-browser-capture-image");
    return Boolean(capture && capture.width>0 && capture.height>0 &&
      image?.naturalWidth===capture.width && image.naturalHeight===capture.height);
  };
  await until(currentCaptureDecoded, "native screenshot asset did not render at its recorded dimensions");
  assert(captures[0]?.width===390 && captures[0]?.height===844,
    "Native PNG preserves the requested mobile viewport dimensions");
  assert(
    captures[0]?.resourceId === original.resourceId,
    "Native screenshot carries its browser resource ID",
  );
  assert(
    currentCaptureDecoded(),
    "Production capture view decodes the real native PNG at its recorded dimensions",
  );

  const unavailable = {
    ...captures[0]!,
    filename: "unavailable-preview.png",
    path: `${captures[0]!.path}.missing`,
    src: convertFileSrc(`${captures[0]!.path}.missing`),
  };
  send(first, { type: "browser-capture-success", capture: unavailable });
  const failedImage = await until(() => {
    const image = document.querySelector<HTMLImageElement>(
      ".gyro-browser-capture-image",
    );
    return image?.complete && image.naturalWidth === 0 ? image : undefined;
  }, "unavailable capture did not make a real failed asset request");
  assert(
    failedImage.naturalWidth === 0,
    "Missing asset produces a real image decode failure",
  );
  await until(
    () =>
      document
        .querySelector('[role="alert"]')
        ?.textContent?.includes("Screenshot unavailable"),
    "failed screenshot did not expose an unavailable state",
  );
  assert(
    document
      .querySelector('[role="alert"]')
      ?.textContent?.includes("Screenshot unavailable"),
    "Unavailable screenshot renders an accessible error message",
  );
  const commentButton = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".gyro-browser-capture-actions button",
      ),
    ).find((button) => button.textContent === "Comment on page");
  assert(
    commentButton()?.disabled === true,
    "Feedback stays disabled while the screenshot is unreadable",
  );
  assert(
    !document.querySelector(".gyro-browser-feedback-layer") &&
      !document.querySelector(".gyro-browser-feedback-form"),
    "Unreadable screenshot exposes no feedback selection or draft form",
  );
  const retry = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      ".gyro-browser-placeholder-actions button",
    ),
  ).find((button) => button.textContent === "Take new screenshot");
  assert(
    retry && !retry.disabled,
    "Unavailable screenshot offers an enabled new-capture action",
  );
  const beforeRetry = captures.length;
  if (options.visualReview) {
    document.title = "GYRO_BROWSER_CAPTURE_REVIEW_READY";
  } else {
    retry.focus();
    retry.click();
  }
  await until(
    () =>
      captures.length > beforeRetry &&
      preview()?.latestCapture?.filename !== unavailable.filename,
    "new screenshot action did not complete",
    options.visualReview ? 180000 : 10000,
  );
  await until(
    currentCaptureDecoded,
    "new screenshot did not decode at its recorded dimensions after recovery",
  );
  await until(
    () =>
      document
        .querySelector(".gyro-browser-capture-view")
        ?.getAttribute("data-image-state") === "ready",
    "decoded screenshot did not become ready for feedback",
  );
  assert(
    !document
      .querySelector('[role="alert"]')
      ?.textContent?.includes("Screenshot unavailable"),
    "New screenshot clears the unavailable message",
  );
  assert(
    commentButton()?.disabled === false,
    "Decoded replacement screenshot re-enables feedback",
  );
  assert(preview()?.latestCapture?.width===390 && preview()?.latestCapture?.height===844,
    "Recovered native PNG preserves the requested mobile viewport dimensions");
  failedImage.dispatchEvent(new Event("error"));
  await flushReact();
  assert(
    currentCaptureDecoded() && !document.querySelector('[role="alert"]'),
    "A detached old image error cannot replace the recovered screenshot",
  );
  measurements.imageRecovery = {
    missingAssetFailed: true,
    freshNativeCaptureDecoded: true,
    feedbackBlockedUntilReady: true,
  };
  if (options.visualReview) {
    enableReviewContinue();
    document.title = "GYRO_BROWSER_CAPTURE_REVIEW_RECOVERED";
    await until(() => reviewContinued, "visual review did not finish", 180000);
  }

  const pending = await call<SessionBrowserSnapshot>(
    "session_browser_navigate",
    {
      sessionId: first,
      url: page("Pending"),
    },
  );
  assert(
    pending.resourceId === original.resourceId && pending.loading,
    "Same-resource navigation reports pending before the new page finishes",
  );
  await until(
    () =>
      preview()?.title === "Gyro Fixture Pending" &&
      preview()?.status === "loading",
    "native title/start events did not retain the actual loading state",
  );
  assert(
    preview()?.status === "loading",
    "A title arriving before a held image does not mark the native page ready",
  );
  await event("session-browser-event", {
    sessionId: first,
    resourceId: pending.resourceId,
    kind: "loaded",
    url: page("Original"),
  });
  assert(
    preview()?.url === page("Pending") && preview()?.status === "loading",
    "Old loaded event cannot finish a pending navigation in the same native resource",
  );
  await event("session-browser-opened", {
    sessionId: first,
    resourceId: pending.resourceId,
    url: page("Pending"),
    reveal: false,
  });
  assert(
    preview()?.status === "loading" &&
      state().preferences.activeChatPanel === undefined,
    "Model-open notification retains pending state and background policy",
  );
  // A second isolated browser controls the loopback server's held response.
  // The main renderer keeps the production connect-src CSP unchanged.
  await open(other, "Release");
  await until(
    () => preview()?.status === "ready",
    "released page did not finish through native events",
  );
  const completed = await call<SessionBrowserSnapshot>(
    "session_browser_snapshot",
    { sessionId: first },
  );
  assert(
    !completed.loading && completed.url === page("Pending"),
    "Releasing the actual loopback image finishes the native loading state",
  );
  assert(
    preview()?.nativeNavigationId === completed.navigationId &&
      preview()?.status === "ready",
    "Current completion reaches React with its native navigation identity",
  );
  measurements.loadingState = {
    pendingObserved: true,
    staleLoadedRejected: true,
    actualCompletionObserved: true,
  };
  await call("session_browser_navigate",{sessionId:first,url:page("Failure")});
  await until(() => preview()?.status === "verification-failed", "actual network failure did not reach React");
  assert(preview()?.navigationError?.kind === "failed" && !preview()?.nativeLoading,
    "Actual network failure stops the frontend loading state");
  assert(document.querySelector(".gyro-browser-placeholder strong")?.textContent === "Can't reach this page" &&
    document.querySelector(".gyro-browser-placeholder p")?.textContent === preview()?.navigationError?.message,
    "Failed navigation renders the current native recovery message");
  await until(async () => !(await call<SessionBrowserSnapshot & {visible:boolean}>("session_browser_snapshot",{sessionId:first})).visible,
    "old native page remained visible over the recovery controls");
  assert(true,"Failed navigation hides the old native page so recovery controls remain reachable");
  const navigationRetry=Array.from(document.querySelectorAll<HTMLButtonElement>(".gyro-browser-placeholder button")).find(button=>button.textContent === "Try again");
  assert(Boolean(navigationRetry) && !navigationRetry!.disabled,"Failed navigation offers its existing Try again action");
  navigationRetry!.focus();
  assert(document.activeElement===navigationRetry,"Recovery action can receive keyboard focus");
  await open(other,"RetryRelease");
  navigationRetry!.click();
  await until(() => preview()?.status === "ready" && preview()?.url === page("Failure"),"Try again did not recover the failed destination");
  assert(!preview()?.navigationError && !document.querySelector(".gyro-browser-placeholder"),
    "Try again loads the failed URL and clears the recovery state");
  measurements.navigationRecovery={actualNetworkFailure:true,oldHostHidden:true,retryButtonRecoveredFailedUrl:true};
  await open(owner, "Original");

  const readStarted = deferred<SessionBrowserSnapshot>();
  const releaseRead = deferred();
  let staleReadApplied = false;
  const oldRead = sessionBrowserNative.run(
    first,
    async () => {
      const value = await call<SessionBrowserSnapshot>(
        "session_browser_snapshot",
        { sessionId: first },
      );
      readStarted.resolve(value);
      await releaseRead.promise;
      return value;
    },
    () => {
      staleReadApplied = true;
    },
    fail,
  );
  await readStarted.promise;
  const closingAt = performance.now();
  await close(owner);
  measurements.closeWithHeldNativeReadMs = performance.now() - closingAt;
  assert(
    (await call("session_browser_snapshot", { sessionId: first })) === null,
    "Close removes the native resource while an old read result is held",
  );
  const replacement = await open(owner, "Replacement");
  assert(
    replacement.resourceId !== original.resourceId,
    "Reopen creates a new native resource in the same chat",
  );
  assert(
    preview()?.status === "ready",
    "Replacement native load reaches React before the old read is released",
  );
  for (const kind of ["loaded", "title", "viewport"]) {
    await event("session-browser-event", {
      sessionId: first,
      resourceId: original.resourceId,
      kind,
      url: "https://stale.invalid/",
      title: "STALE",
      viewport: { width: 1, height: 1 },
    });
  }
  await event("session-browser-opened", {
    sessionId: first,
    resourceId: original.resourceId,
    url: "https://stale.invalid/",
    reveal: true,
  });
  assert(
    preview()?.url === page("Replacement") &&
      preview()?.title === "Gyro Fixture Replacement",
    "Native event bus rejects stale load/title events from the previous resource",
  );
  assert(
    preview()?.viewport?.width === 1280 && preview()?.viewport?.height === 800,
    "Stale viewport event cannot resize the replacement UI",
  );
  assert(
    state().preferences.activeChatPanel === undefined,
    "Stale native opened event cannot reveal the Browser panel",
  );
  releaseRead.resolve();
  assert(
    (await oldRead) === false && !staleReadApplied,
    "Released old native read does not publish after Close/reopen",
  );
  await event("session-browser-event", {
    sessionId: first,
    resourceId: replacement.resourceId,
    kind: "title",
    title: "STALE CURRENT PAYLOAD",
  });
  assert(
    preview()?.title === "Gyro Fixture Replacement",
    "Valid native event uses current snapshot data instead of its old payload",
  );
  const second = await open(other, "Second");
  await event("session-browser-opened", {
    sessionId: other.id,
    resourceId: second.resourceId,
    url: page("Second"),
    reveal: true,
  });
  assert(
    preview(other.id)?.title === "Gyro Fixture Second",
    "Second chat receives independent native browser metadata",
  );
  assert(
    preview()?.url === page("Replacement") &&
      state().preferences.activeChatPanel === undefined,
    "Inactive chat cannot replace or reveal the active chat browser",
  );
  await event("session-browser-opened", {
    sessionId: first,
    resourceId: replacement.resourceId,
    url: page("Replacement"),
    reveal: true,
  });
  assert(
    state().preferences.activeChatPanel === "browser",
    "Valid explicit native reveal still opens the active Browser panel",
  );

  const captureStarted = deferred<BrowserPreview["latestCapture"]>();
  const releaseCapture = deferred();
  let staleCaptureApplied = false;
  const staleCapture = sessionBrowserNative.run(
    first,
    async () => {
      const value = await captureChatBrowserPage({
        sessionId: first,
        nativeHost: true,
        device: preview()!.device,
        url: preview()!.url,
      });
      captureStarted.resolve(value);
      await releaseCapture.promise;
      return value;
    },
    (capture) => {
      staleCaptureApplied = true;
      send(first, { type: "browser-capture-success", capture });
    },
    fail,
  );
  const heldCapture = await captureStarted.promise;
  assert(
    heldCapture?.resourceId === replacement.resourceId,
    "Fault injection holds an actual native screenshot response",
  );
  await close(owner);
  const final = await open(owner, "Final");
  assert(
    final.resourceId !== replacement.resourceId,
    "Second reopen also replaces the native resource",
  );
  releaseCapture.resolve();
  assert(
    (await staleCapture) === false && !staleCaptureApplied,
    "Late real native screenshot result is discarded after Close",
  );
  assert(
    preview()?.captureStatus === "idle" && !preview()?.latestCapture,
    "Replacement capture view stays empty after late screenshot completion",
  );
  assert(
    errors.length === 0,
    `Native fixture has no script errors (${errors.join("; ")})`,
  );
  assert(
    violations.length === 0,
    `Production CSP has no violations (${violations.join("; ")})`,
  );
  await close(other);
  await close(owner);
  assert(
    (await call("session_browser_snapshot", { sessionId: first })) === null &&
      (await call("session_browser_snapshot", { sessionId: other.id })) ===
        null,
    "Fixture closes both native resources",
  );
}

async function report(passed: boolean, error?: unknown) {
  const payload = JSON.stringify({
    passed,
    href: location.href,
    userAgent: navigator.userAgent,
    checks,
    errors,
    violations,
    commands,
    measurements,
    captures,
    actions: actions.slice(-80),
    activeSessionId: first,
    finalPreferences: state().preferences,
    routed: routed.map(({ result: _result, ...entry }) => entry),
    captureImages: Array.from(
      document.querySelectorAll<HTMLImageElement>(
        ".gyro-browser-capture-image",
      ),
    ).map((image) => ({
      src: image.currentSrc,
      complete: image.complete,
      width: image.naturalWidth,
      height: image.naturalHeight,
    })),
    faultInjection:
      "unavailable asset record, held loopback image and real IPC results; native command responses unmodified",
    fullAppShellMounted: false,
    nativeOsMouseTested: false,
    ...(error ? { error: String(error) } : {}),
  });
  (
    window as typeof window & { __nativeBrowserReport?: string }
  ).__nativeBrowserReport = payload;
  document.title = "GYRO_BROWSER_FRONTEND_SMOKE_READY";
}
if (!options?.navigationOnly)
  createRoot(document.getElementById("root")!).render(<Fixture />);
