import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { SizingMotionFixture } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import "../../../packages/ui/src/appearance.css";
import "./sizing-motion-fixture.css";

const root = (import.meta.hot?.data.root as Root | undefined) ?? createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<SizingMotionFixture />);
