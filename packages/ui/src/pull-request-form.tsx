import { useState } from "react";
import { Dialog } from "./primitives";
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
  return (
    <Dialog
      actions={
        <>
          <button
            type="button"
            className="gyro-button is-secondary"
            onClick={() => onClose()}
          >
            Cancel
          </button>
          <button
            className="gyro-button is-primary"
            disabled={!value.title.trim()}
            form="gyro-pull-request-form"
            type="submit"
          >
            Create pull request
          </button>
        </>
      }
      className="gyro-workflow-dialog"
      closeLabel="Cancel"
      description="Continue comments, review, and merge on GitHub."
      onClose={() => onClose()}
      onKeyDown={(event) => event.stopPropagation()}
      open
      size="wide"
      title="Create pull request"
    >
      <form
        className="gyro-workflow-form"
        id="gyro-pull-request-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.title.trim())
            onClose({ ...value, title: value.title.trim() });
        }}
      >
        <label className="gyro-field">
          Title
          <input
            className="gyro-input"
            required
            value={value.title}
            onChange={(e) => setValue({ ...value, title: e.target.value })}
          />
        </label>
        <label className="gyro-field">
          Description
          <textarea
            className="gyro-input"
            rows={7}
            value={value.body}
            onChange={(e) => setValue({ ...value, body: e.target.value })}
          />
        </label>
        <div className="gyro-workflow-form-row">
          <label className="gyro-field">
            Base branch
            <input
              className="gyro-input"
              placeholder="Repository default"
              value={value.base}
              onChange={(e) => setValue({ ...value, base: e.target.value })}
            />
          </label>
          <label className="gyro-field">
            Head branch
            <input
              className="gyro-input"
              value={value.head}
              onChange={(e) => setValue({ ...value, head: e.target.value })}
            />
          </label>
        </div>
        <label className="gyro-field is-inline">
          <input
            type="checkbox"
            checked={value.draft}
            onChange={(e) => setValue({ ...value, draft: e.target.checked })}
          />
          Create as draft
        </label>
      </form>
    </Dialog>
  );
}
