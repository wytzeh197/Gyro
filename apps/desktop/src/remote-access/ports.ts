import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NativePorts } from "./client";
export const nativePorts: NativePorts = { invoke, listen };
