import { useEffect, useMemo, useState } from "react";
import { resolveLanguage, editorFilePolicy } from "@gyro-dev/ui";
import type { SyntaxResult } from "./syntax-loader";

export function useSyntax(
  path: string,
  content: string,
  override?: string,
  sizeBytes?: number,
  truncated?: boolean,
) {
  const definition = useMemo(
    () => resolveLanguage({ path, content, override }),
    [path, content, override],
  );
  const policy = useMemo(
    () => editorFilePolicy(path, content, sizeBytes, truncated),
    [path, content, sizeBytes, truncated],
  );
  const [loaded, setLoaded] = useState<{ id: string; result: SyntaxResult }>();
  useEffect(() => {
    let cancelled = false;
    if (!policy.limited && !policy.binary)
      void import("../monaco-editor")
        .then((module) => module.loadSyntax(definition))
        .then((result) => {
          if (!cancelled) setLoaded({ id: definition.id, result });
        })
        .catch(() => {
          if (!cancelled)
            setLoaded({
              id: definition.id,
              result: {
                language: "plaintext",
                available: false,
                reason: "Highlighting could not be loaded.",
              },
            });
        });
    return () => {
      cancelled = true;
    };
  }, [definition, policy.limited, policy.binary]);
  const result = loaded?.id === definition.id ? loaded.result : undefined;
  return {
    definition,
    policy,
    language:
      policy.limited || policy.binary
        ? "plaintext"
        : (result?.language ?? "plaintext"),
    notice: policy.reason ?? result?.reason,
  };
}
