import { useCallback, useEffect, useRef, useState } from "react";
import {
  normalizedCouncilConfig,
  toggleCouncilActivePreset,
  type CouncilSynthesizerChoice,
  type GyroConfig,
} from "@gyro-dev/ui";
import { readBoundedLocalStorage, safeSetLocalStorage } from "./ui-storage";

/**
 * Council presets loaded per chat. A chat without its own entry uses the
 * Settings default (`config.council.activePresetIds`); toggling a preset in
 * a chat's composer gives that chat its own list and leaves others alone.
 */
const STORAGE_KEY = "gyro.chat-council-presets-v1";

type PresetsByChat = Record<string, string[]>;

/** The model that writes each chat's final Council answer, when chosen. */
const WRITER_STORAGE_KEY = "gyro.chat-council-writer-v1";

type WritersByChat = Record<string, CouncilSynthesizerChoice>;

function loadChatCouncilWriters(): WritersByChat {
  const stored = readBoundedLocalStorage(WRITER_STORAGE_KEY, 64_000);
  if (!stored) return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, Partial<CouncilSynthesizerChoice>>).flatMap(
        ([key, choice]) =>
          typeof choice?.providerId === "string"
            ? [[key, { providerId: choice.providerId, modelId: choice.modelId ?? null }]]
            : [],
      ),
    );
  } catch {
    return {};
  }
}

function loadChatCouncilPresets(): PresetsByChat {
  const stored = readBoundedLocalStorage(STORAGE_KEY, 64_000);
  if (!stored) return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, ids]) =>
        Array.isArray(ids) && ids.every((id) => typeof id === "string") && ids.length
          ? [[key, ids as string[]]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

/** The config a chat sees: the global one with that chat's loaded presets. */
export function withChatCouncilPresets(
  config: GyroConfig,
  presetIds: string[] | undefined,
  writer?: CouncilSynthesizerChoice,
): GyroConfig {
  if (!presetIds?.length && !writer) return config;
  const normalized = normalizedCouncilConfig(config.council);
  const council = {
    ...normalized,
    activePresetIds: presetIds?.length ? presetIds : normalized.activePresetIds,
    synthesizer: writer ?? null,
  };
  return { ...config, council };
}

export function useChatCouncilPresets() {
  const [presetsByChat, setPresetsByChat] = useState(loadChatCouncilPresets);
  const presetsByChatRef = useRef(presetsByChat);
  presetsByChatRef.current = presetsByChat;
  const [writersByChat, setWritersByChat] = useState(loadChatCouncilWriters);
  const writersByChatRef = useRef(writersByChat);
  writersByChatRef.current = writersByChat;

  useEffect(() => {
    safeSetLocalStorage(STORAGE_KEY, JSON.stringify(presetsByChat));
  }, [presetsByChat]);
  useEffect(() => {
    safeSetLocalStorage(WRITER_STORAGE_KEY, JSON.stringify(writersByChat));
  }, [writersByChat]);

  /** Choose this chat's final-answer model; null goes back to the preset's. */
  const setChatCouncilWriter = useCallback(
    (chatKey: string, choice: CouncilSynthesizerChoice | null) => {
      setWritersByChat((current) => {
        const { [chatKey]: _previous, ...rest } = current;
        return choice ? { ...rest, [chatKey]: choice } : rest;
      });
    },
    [],
  );

  /** Load or unload one preset in one chat; a chat never ends up empty. */
  const toggleChatCouncilPreset = useCallback(
    (chatKey: string, config: GyroConfig, presetId: string) => {
      setPresetsByChat((current) => {
        const council = toggleCouncilActivePreset(
          normalizedCouncilConfig(withChatCouncilPresets(config, current[chatKey]).council),
          presetId,
        );
        return { ...current, [chatKey]: council.activePresetIds ?? [] };
      });
    },
    [],
  );

  /** A draft became a session: the session keeps the draft's presets. */
  const adoptChatCouncilPresets = useCallback((fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    setPresetsByChat((current) => {
      const ids = current[fromKey];
      if (!ids) return current;
      return { ...current, [toKey]: ids };
    });
    setWritersByChat((current) => {
      const writer = current[fromKey];
      if (!writer) return current;
      return { ...current, [toKey]: writer };
    });
  }, []);

  const configWithChatCouncilPresets = useCallback(
    (config: GyroConfig, chatKey: string | undefined) =>
      withChatCouncilPresets(
        config,
        chatKey ? presetsByChatRef.current[chatKey] : undefined,
        chatKey ? writersByChatRef.current[chatKey] : undefined,
      ),
    [],
  );

  return {
    presetsByChat,
    writersByChat,
    toggleChatCouncilPreset,
    setChatCouncilWriter,
    adoptChatCouncilPresets,
    configWithChatCouncilPresets,
  };
}
