import { useRef, useState } from "react";
import "./workflow-forms.css";
export type PullRequestDraft = {
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
};
export function PullRequestForm({
  initial,
  onClose,
}: {
  initial: PullRequestDraft;
  onClose: (draft?: PullRequestDraft) => void;
}) {
  const [value, setValue] = useState(initial);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <div
      className="gyro-workflow-overlay"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
        if (event.key === "Tab") {
          const elements = Array.from(
            formRef.current?.querySelectorAll<HTMLElement>(
              "input,textarea,select,button",
            ) ?? [],
          ).filter((node) => !node.hasAttribute("disabled"));
          const first = elements[0],
            last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <form
        ref={formRef}
        className="gyro-workflow-form gyro-workflow-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Create pull request"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.title.trim())
            onClose({ ...value, title: value.title.trim() });
        }}
      >
        <h2>Create pull request</h2>
        <label>
          Title
          <input
            autoFocus
            required
            value={value.title}
            onChange={(e) => setValue({ ...value, title: e.target.value })}
          />
        </label>
        <label>
          Description
          <textarea
            rows={7}
            value={value.body}
            onChange={(e) => setValue({ ...value, body: e.target.value })}
          />
        </label>
        <div className="gyro-workflow-form-row">
          <label>
            Base branch
            <input
              placeholder="Repository default"
              value={value.base}
              onChange={(e) => setValue({ ...value, base: e.target.value })}
            />
          </label>
          <label>
            Head branch
            <input
              value={value.head}
              onChange={(e) => setValue({ ...value, head: e.target.value })}
            />
          </label>
        </div>
        <label>
          <input
            type="checkbox"
            checked={value.draft}
            onChange={(e) => setValue({ ...value, draft: e.target.checked })}
          />{" "}
          Create as draft
        </label>
        <p>Continue comments, review, and merge on GitHub.</p>
        <div className="gyro-workflow-form-actions">
          <button
            type="button"
            className="gyro-button"
            onClick={() => onClose()}
          >
            Cancel
          </button>
          <button className="gyro-button gyro-button-primary" type="submit">
            Create pull request
          </button>
        </div>
      </form>
    </div>
  );
}
