import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import "./chat-question-popup.css";
import "./plan-mode.css";
import {
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestion,
  Minus,
  PanelRight,
  PenLine,
  X,
} from "lucide-react";
import { InlineMarkdown } from "./chat-question-popup";
import type { ChatQuestionAnswer } from "./chat-questions";
import type { SessionPlan, SessionPlanItemStatus } from "./types";

const stepLabel = (count: number) =>
  `${count} ${count === 1 ? "step" : "steps"}`;

/** The plan's own first heading names it better than the generic "Plan". */
export function planDisplayTitle(plan: SessionPlan) {
  const heading = plan.content?.match(/^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/m)?.[1];
  return (
    heading?.replace(/\*\*/g, "").trim() ||
    (plan.title && plan.title !== "Plan" ? plan.title : "Implementation plan")
  );
}

/**
 * The decision after a plan: it takes the composer's place like a question, so
 * approving or redirecting never needs the plan panel open. Typing a change
 * keeps Plan mode and sends it as feedback on the draft.
 */
export function ImplementPlanDock({
  isPending,
  onDecision,
  onRevise,
  plan,
}: {
  isPending: boolean;
  onDecision: (decision: "approve" | "reject") => void;
  onRevise: (message: string) => void;
  plan: SessionPlan;
}) {
  const [feedback, setFeedback] = useState("");
  const rootRef = useRef<HTMLFormElement>(null);
  const steps = plan.items.length;

  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const inField = event.target instanceof HTMLInputElement;
    if (event.key === "Escape") {
      event.stopPropagation();
      if (inField && feedback) {
        setFeedback("");
        rootRef.current?.focus();
        return;
      }
      if (!isPending) onDecision("reject");
      return;
    }
    if (inField || event.metaKey || event.ctrlKey || event.altKey) return;
    if (
      !isPending &&
      (event.key === "1" ||
        (event.key === "Enter" && event.target === rootRef.current))
    ) {
      event.preventDefault();
      onDecision("approve");
    }
  };

  return (
    <form
      aria-label="Implement this plan?"
      className={`gyro-question-dock is-plan-decision${isPending ? " is-pending" : ""}`}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        const message = feedback.trim();
        if (!message || isPending) return;
        onRevise(message);
        setFeedback("");
      }}
      ref={rootRef}
      tabIndex={-1}
    >
      <header className="gyro-question-dock-head">
        <h3>Implement this plan?</h3>
        <span className="gyro-question-dock-count">
          {steps > 0 ? `${stepLabel(steps)} · ` : ""}Switches to Normal mode
        </span>
        <button
          aria-label="Keep planning"
          className="gyro-icon-button is-small gyro-question-dock-close"
          disabled={isPending}
          onClick={() => onDecision("reject")}
          title="Keep planning (Esc)"
          type="button"
        >
          <X size={14} />
        </button>
      </header>
      <div className="gyro-question-dock-options" role="group">
        <button
          className="gyro-question-option is-recommended"
          disabled={isPending}
          onClick={() => onDecision("approve")}
          type="button"
        >
          <kbd aria-hidden="true">1</kbd>
          <span className="gyro-question-option-text">
            <span className="gyro-question-option-label">
              {isPending ? "Starting…" : "Yes, implement this plan"}
            </span>
            <small>
              {steps > 0
                ? "Gyro works through the steps and checks them off as it goes."
                : "Gyro starts working from the plan."}
            </small>
          </span>
          <ArrowRight
            aria-hidden="true"
            className="gyro-question-option-go"
            size={14}
          />
        </button>
      </div>
      <div className="gyro-question-dock-other">
        <PenLine aria-hidden="true" size={13} />
        <input
          aria-label="Tell Gyro what to change in the plan"
          disabled={isPending}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder="No, and tell Gyro what to change"
          value={feedback}
        />
        {feedback.trim() ? (
          <button
            aria-label="Send plan feedback"
            className="gyro-button is-primary is-small gyro-question-dock-send"
            type="submit"
          >
            <ArrowUp size={13} />
          </button>
        ) : (
          <button
            className="gyro-button is-ghost is-small gyro-question-dock-skip"
            disabled={isPending}
            onClick={() => onDecision("reject")}
            type="button"
          >
            Keep planning
          </button>
        )}
      </div>
      {isPending ? (
        <span aria-hidden="true" className="gyro-question-dock-progress" />
      ) : null}
    </form>
  );
}

/**
 * The plan as one object in the conversation. The document itself is passed
 * in, so the card and the plan panel always render the same text. While the
 * panel shows the plan, the card folds to a single line.
 */
export function PlanCard({
  children,
  isOpenInPanel,
  onOpenInPanel,
  plan,
}: {
  children: ReactNode;
  isOpenInPanel: boolean;
  onOpenInPanel?: () => void;
  plan: SessionPlan;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const title = planDisplayTitle(plan);
  const steps = plan.items.length;
  const done = plan.items.filter((item) => item.status === "complete").length;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    if (!plan.content) return;
    void navigator.clipboard?.writeText(plan.content).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  const progress =
    steps > 0
      ? done > 0
        ? `${done} of ${stepLabel(steps)} done`
        : stepLabel(steps)
      : undefined;

  if (isOpenInPanel) {
    return (
      <section aria-label="Plan" className="gyro-plan-card is-folded">
        <button
          className="gyro-plan-card-fold"
          onClick={onOpenInPanel}
          title="Show the plan here instead"
          type="button"
        >
          <Lightbulb aria-hidden="true" size={13} />
          <span>{title}</span>
          <small>Showing in panel</small>
        </button>
      </section>
    );
  }

  return (
    <section
      aria-label="Plan"
      className={`gyro-plan-card${isExpanded ? " is-expanded" : ""}`}
    >
      <header className="gyro-plan-card-head">
        <Lightbulb aria-hidden="true" size={13} />
        <span className="gyro-plan-card-kind">Plan</span>
        {progress ? (
          <span className="gyro-plan-card-steps">· {progress}</span>
        ) : null}
        <span className="gyro-plan-card-actions">
          {plan.content ? (
            <button
              aria-label={copied ? "Copied" : "Copy plan as Markdown"}
              onClick={copy}
              title={copied ? "Copied" : "Copy as Markdown"}
              type="button"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          ) : null}
          {onOpenInPanel ? (
            <button
              aria-label="Open plan in panel"
              onClick={onOpenInPanel}
              title="Open in panel"
              type="button"
            >
              <PanelRight size={13} />
            </button>
          ) : null}
        </span>
      </header>
      <div className="gyro-plan-card-body">{children}</div>
      <button
        aria-expanded={isExpanded}
        className="gyro-icon-button is-small gyro-plan-card-more"
        onClick={() => setIsExpanded((current) => !current)}
        type="button"
      >
        {isExpanded ? "Show less" : "Show full plan"}
        <ChevronDown aria-hidden="true" size={13} />
      </button>
    </section>
  );
}

/**
 * The answers message folds into one run row, the way a burst of tool calls
 * does, and opens to the questions and what was chosen.
 */
export function ChatQuestionAnswers({
  answers,
  note,
}: {
  answers: ChatQuestionAnswer[];
  note?: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const count = answers.length;
  const skipped = answers.filter((item) => !item.answer).length;
  return (
    <div
      className={`gyro-question-answers${isExpanded ? " is-expanded" : ""}`}
    >
      <button
        aria-expanded={isExpanded}
        className="gyro-question-answers-toggle"
        onClick={() => setIsExpanded((current) => !current)}
        type="button"
      >
        <MessageCircleQuestion aria-hidden="true" size={14} />
        <span>
          Asked {count} {count === 1 ? "question" : "questions"}
          {skipped ? <small> · {skipped} skipped</small> : null}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="gyro-question-answers-chevron"
          size={12}
        />
      </button>
      {isExpanded ? (
        <dl className="gyro-question-answers-list">
          {answers.map((item, index) => (
            <div key={index}>
              <dt>
                <InlineMarkdown text={item.question} />
              </dt>
              <dd className={item.answer ? "" : "is-skipped"}>
                {item.answer ?? "Skipped"}
              </dd>
            </div>
          ))}
          {note ? (
            <div>
              <dt>Also</dt>
              <dd>{note}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

/**
 * One header for the plan panel in both views: what the plan is and how far
 * along it is on the left, the view switch and actions on the right, and the
 * progress as a hairline along the bottom edge.
 */
export function PlanPanelHeader({
  onClose,
  onViewChange,
  plan,
  variant = "panel",
  view,
}: {
  onClose?: () => void;
  onViewChange?: (view: "document" | "steps") => void;
  plan: SessionPlan;
  /** "section" sits inside the Environment panel under its own header. */
  variant?: "panel" | "section";
  view: "document" | "steps";
}) {
  const [copied, setCopied] = useState(false);
  const steps = plan.items.length;
  const done = plan.items.filter((item) => item.status === "complete").length;
  const blocked = plan.items.filter((item) => item.status === "blocked").length;
  const progress = steps ? Math.round((done / steps) * 100) : 0;
  const meta = [
    steps ? stepLabel(steps) : plan.content ? "Document" : "No steps yet",
    done ? `${done} done` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // Inside Environment this is a section heading, not the panel's header, and
  // a plain element keeps the rail's own header rules off it.
  const Head = variant === "section" ? "div" : "header";
  return (
    <Head className={`gyro-plan-panel-head is-${variant}`}>
      <div className="gyro-plan-panel-title">
        <span aria-hidden="true" className="gyro-plan-panel-icon">
          <Lightbulb size={14} />
        </span>
        <div>
          <strong title={planDisplayTitle(plan)}>
            {planDisplayTitle(plan)}
          </strong>
          <small>
            {meta}
            {blocked ? <em> · {blocked} blocked</em> : null}
          </small>
        </div>
      </div>
      <div className="gyro-plan-panel-tools">
        {onViewChange ? (
          <div
            aria-label="Plan view"
            className="gyro-plan-panel-views"
            role="group"
          >
            <button
              aria-pressed={view === "document"}
              onClick={() => onViewChange("document")}
              title="Document"
              type="button"
            >
              <FileText aria-hidden="true" size={13} />
              <span>Document</span>
            </button>
            <button
              aria-pressed={view === "steps"}
              onClick={() => onViewChange("steps")}
              title="Steps"
              type="button"
            >
              <ListChecks aria-hidden="true" size={13} />
              <span>Steps</span>
            </button>
          </div>
        ) : null}
        {plan.content ? (
          <button
            aria-label={copied ? "Copied" : "Copy plan as Markdown"}
            className="gyro-button is-secondary is-small gyro-plan-panel-action"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(plan.content ?? "")
                .then(() => setCopied(true), () => undefined);
            }}
            title={copied ? "Copied" : "Copy as Markdown"}
            type="button"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        ) : null}
        {onClose ? (
          <button
            aria-label="Close plan"
            className="gyro-button is-secondary is-small gyro-plan-panel-action"
            onClick={onClose}
            title="Close"
            type="button"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
      {steps ? (
        <div
          aria-label={`${done} of ${steps} steps completed`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress}
          className="gyro-plan-panel-progress"
          role="progressbar"
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      ) : null}
    </Head>
  );
}

/**
 * A step's state as one mark: an empty ring waiting, a turning ring while the
 * model works on it, a filled check once done, and an amber bar when blocked.
 */
export function PlanStepStatus({ status }: { status: SessionPlanItemStatus }) {
  return (
    <span aria-hidden="true" className={`gyro-plan-step-status is-${status}`}>
      {status === "complete" ? (
        <Check size={10} strokeWidth={3} />
      ) : status === "in-progress" ? (
        <LoaderCircle size={16} strokeWidth={2.2} />
      ) : status === "blocked" ? (
        <Minus size={10} strokeWidth={3} />
      ) : null}
    </span>
  );
}
