type Scope = {
  sessionId?: string;
  workspacePath?: string;
  providerId?: string;
  providerSessionId?: string;
};
type ImageRequest = {
  target: string;
  providerId?: string;
  providerSessionId?: string;
  scope?: Scope;
};
type Dependencies = {
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  convertFileSrc: (path: string) => string;
  open: (path: string) => void;
};

/** Shared across panes, but every request is keyed by its owning chat. */
export function createChatFileActions(deps: Dependencies) {
  const previews = new Map<string, Promise<string | undefined>>();
  const resolutions = new Map<string, Promise<string | undefined>>();
  const sizes = new Map<string, number>();
  const maxPreviewBytes = 24 * 1024 * 1024;
  const requestFor = ({ scope, ...request }: ImageRequest) => ({
    ...scope,
    ...request,
    sessionId: scope?.sessionId ?? "new",
    workspacePath: scope?.workspacePath,
  });
  const cached = (
    cache: Map<string, Promise<string | undefined>>,
    key: string,
    read: () => Promise<string | undefined>,
  ) => {
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = read()
      .then((value) => {
        // A file cited while it is being written must be able to appear later.
        if (!value && cache.get(key) === pending) cache.delete(key);
        if (cache === previews && value && cache.get(key) === pending) {
          sizes.set(key, value.length * 2);
          let total = [...sizes.values()].reduce((a, b) => a + b, 0);
          for (const [oldest, size] of sizes) {
            if (total <= maxPreviewBytes) break;
            sizes.delete(oldest);
            cache.delete(oldest);
            total -= size;
          }
        }
        return value;
      })
      .catch((error) => {
        if (cache.get(key) === pending) cache.delete(key);
        throw error;
      });
    if (cache.size >= 64) {
      const oldest = cache.keys().next().value!;
      cache.delete(oldest);
      if (cache === previews) sizes.delete(oldest);
    }
    cache.set(key, pending);
    return pending;
  };
  return {
    open: deps.open,
    preview: (
      path: string,
      kind: "image" | "video" | "audio",
      scope?: Scope,
    ) => {
      if (kind === "audio") return Promise.resolve(undefined);
      const request = requestFor({ target: path, scope });
      return cached(previews, JSON.stringify([kind, request]), async () => {
        if (kind === "image") {
          return (
            (await deps.invoke<string | null>("read_cited_chat_image", {
              request,
            })) ?? undefined
          );
        }
        const attachment = await deps.invoke<{ path: string }>(
          "prepare_chat_attachment",
          {
            request: {
              sessionId: scope?.sessionId ?? "new",
              workspacePath: scope?.workspacePath,
              path,
              kind,
            },
          },
        );
        return deps.convertFileSrc(attachment.path);
      });
    },
    resolveCitedImage: (input: ImageRequest) => {
      const request = requestFor(input);
      return cached(
        resolutions,
        JSON.stringify(request),
        async () =>
          (await deps.invoke<string | null>("resolve_cited_chat_image", {
            request,
          })) ?? undefined,
      );
    },
  };
}
