import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatQuestionPopup, parseChatQuestions } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const sample =
  "Which GitHub actions break most often for you? - PRs, checks, and merges - Push, pull, and sync - Sign-in or repository access";
function Preview() {
  const [open, setOpen] = useState(true);
  const [response, setResponse] = useState("");
  return (
    <main
      style={{
        height: "100vh",
        background: "var(--gyro-pane)",
        padding: 24,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <h1 style={{ fontSize: 20 }}>Question popup preview</h1>
      <p>{sample}</p>
      <p role="status">
        {response ? "Answer sent: " + response : "Waiting for your answer"}
      </p>
      <button
        onClick={() => {
          setOpen(true);
          setResponse("");
        }}
      >
        Show question
      </button>
      <div
        style={{
          marginTop: "auto",
          position: "relative",
          width: "100%",
          maxWidth: 760,
          marginInline: "auto",
        }}
      >
        <textarea
          aria-label="Composer"
          placeholder="Message Gyro…"
          style={{ width: "100%", height: 130 }}
        />
        {open ? (
          <ChatQuestionPopup
            request={{ id: "preview", questions: parseChatQuestions(sample) }}
            draft=""
            onSend={setResponse}
            onDismiss={() => setOpen(false)}
          />
        ) : null}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
