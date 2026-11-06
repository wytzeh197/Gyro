import { createContext } from "react";
export type ComposerContextCandidate = {
  path: string;
  label: string;
  workspacePath?: string;
  kind: "file" | "open-tab";
};
export const ComposerContextCandidates = createContext<
  ComposerContextCandidate[]
>([]);
export function contextMentionCandidates(
  candidates: ComposerContextCandidate[],
  query: string,
  workspacePath?: string,
) {
  const mode = query.startsWith("open-tab") ? "open-tab" : "file";
  const search = query.replace(/^(?:file|open-tab):?/, "").toLowerCase();
  return candidates
    .filter(
      (item) =>
        item.kind === mode &&
        (!workspacePath ||
          !item.workspacePath ||
          item.workspacePath === workspacePath) &&
        item.label.toLowerCase().includes(search),
    )
    .slice(0, 12);
}
