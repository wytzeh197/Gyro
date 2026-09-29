import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Button,
  Dialog,
  Dot,
  EmptyState,
  IconButton,
  Segmented,
  SelectMenu,
  Skeleton,
  Spinner,
  ToastStack,
  createNotification,
  type Notification,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import "./theme.css";

const glyph = (d: string) => (
  <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24" width="14">
    <path d={d} />
  </svg>
);
const Plus = () => glyph("M12 5v14M5 12h14");
const X = () => glyph("M18 6 6 18M6 6l12 12");
const Trash2 = () => glyph("M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14");
const Inbox = () => glyph("M22 12h-6l-2 3h-4l-2-3H2M5 5h14l3 7v7H2v-7z");

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme =
  params.get("theme") === "light" ? "light" : "dark";

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 10 }}>
      <h2 style={{ fontSize: 12, color: "var(--gyro-muted)", margin: 0 }}>{title}</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        {children}
      </div>
    </section>
  );
}

function Gallery() {
  const [segment, setSegment] = useState<"off" | "peek" | "follow">("peek");
  const [choice, setChoice] = useState("project");
  const [dialog, setDialog] = useState(params.get("dialog") === "1");
  const [notes, setNotes] = useState<Notification[]>(() => [
    createNotification("n1", "command-failed", "Push failed", "remote rejected main: fetch first"),
    createNotification("n2", "tests-passed", "Commit created", "Limit sync retries"),
  ]);
  return (
    <main
      style={{
        background: "var(--gyro-app)",
        color: "var(--gyro-text)",
        display: "grid",
        gap: 28,
        minHeight: "100vh",
        padding: 32,
        boxSizing: "border-box",
        alignContent: "start",
      }}
    >
      <Row title="Button">
        <Button variant="primary">Use in chat</Button>
        <Button>Check connection</Button>
        <Button variant="ghost">Skip</Button>
        <Button variant="danger" icon={<Trash2 />}>Reset UI state</Button>
        <Button disabled variant="primary">Disabled</Button>
        <Button size="small" variant="primary">Small</Button>
        <Button size="small">Review</Button>
        <Button size="small" variant="ghost">Continue</Button>
      </Row>
      <Row title="Icon button">
        <IconButton label="Add">
          <Plus />
        </IconButton>
        <IconButton label="Close" size="small">
          <X />
        </IconButton>
      </Row>
      <Row title="Segmented">
        <Segmented
          label="Model activity previews"
          onChange={setSegment}
          options={[
            { label: "Off", value: "off" },
            { label: "Peek", value: "peek" },
            { label: "Follow", value: "follow" },
          ]}
          value={segment}
        />
        <Segmented
          label="Size"
          onChange={setSegment}
          options={[
            { label: "Off", value: "off" },
            { label: "Peek", value: "peek" },
          ]}
          size="small"
          value={segment}
        />
      </Row>
      <Row title="Select">
        <SelectMenu
          label="New chats start in"
          onChange={setChoice}
          options={[
            { value: "project", label: "Project folder" },
            { value: "agent", label: "Agent workspace", detail: "A private branch under Gyro" },
          ]}
          value={choice}
        />
        <SelectMenu
          label="Minimap"
          onChange={setChoice}
          options={[
            { value: "project", label: "On" },
            { value: "agent", label: "Off" },
          ]}
          showLabel
          size="small"
          value={choice}
        />
      </Row>
      <Row title="Badge and dot">
        <Badge>Core</Badge>
        <Badge tone="accent">Recommended</Badge>
        <Badge tone="success">Connected</Badge>
        <Badge tone="warn">Waiting</Badge>
        <Badge tone="danger">Failed</Badge>
        <Dot />
        <Dot tone="success" />
        <Dot tone="warn" pulse />
        <Dot tone="danger" />
      </Row>
      <Row title="Empty, loading">
        <div style={{ border: "1px solid var(--gyro-border)", borderRadius: 12, width: 320 }}>
          <EmptyState
            action={<Button size="small">Select a file</Button>}
            detail="Changed files appear here after the agent edits."
            icon={<Inbox />}
            title="No changes yet"
          />
        </div>
        <div style={{ border: "1px solid var(--gyro-border)", borderRadius: 12, width: 240 }}>
          <EmptyState compact title="No commits yet" />
          <Skeleton lines={3} />
        </div>
        <Spinner size={16} label="Loading" />
      </Row>
      <Row title="Dialog">
        <Button onClick={() => setDialog(true)}>Open dialog</Button>
      </Row>
      <Dialog
        actions={
          <>
            <Button onClick={() => setDialog(false)}>Keep chat</Button>
            <Button onClick={() => setDialog(false)} variant="danger">
              Delete chat
            </Button>
          </>
        }
        description="This removes the chat and its history from Gyro. Files in the project are not touched."
        icon={<Trash2 />}
        onClose={() => setDialog(false)}
        open={dialog}
        role="alertdialog"
        title="Delete “Bound the sync queue retries”?"
        tone="danger"
      />
      <ToastStack
        notifications={notes}
        onDismiss={(id) => setNotes((all) => all.filter((note) => note.id !== id))}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Gallery />);
