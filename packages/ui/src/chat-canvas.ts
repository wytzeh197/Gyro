import type { ChatArtifact } from "./types.ts";

export type CanvasArtifact = Extract<
  ChatArtifact,
  { kind: "canvas" | "table" | "diagram" }
>;

/** Event history is the durable source; an id denotes one evolving artifact. */
export function latestCanvasArtifacts(
  artifacts: ChatArtifact[],
): CanvasArtifact[] {
  const latest = new Map<string, CanvasArtifact>();
  for (const artifact of artifacts) {
    if (
      artifact.kind !== "canvas" &&
      artifact.kind !== "table" &&
      artifact.kind !== "diagram"
    )
      continue;
    latest.delete(artifact.id);
    latest.set(artifact.id, artifact);
  }
  return [...latest.values()];
}
