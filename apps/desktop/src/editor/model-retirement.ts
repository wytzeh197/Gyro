/** Ownership-based retirement, independent of Monaco loading or React timing. */
type Disposable = { dispose(): void };
export type RetirableModel = Disposable & {
  isDisposed(): boolean;
  onWillDispose(listener: () => void): Disposable;
};
export type ModelOwner = {
  onDidChangeModel(listener: () => void): Disposable;
  onDidDispose(listener: () => void): Disposable;
};
type Retirement = {
  retire(path: string, isRetired: () => boolean): void;
  cancelAll(): void;
};

export function createModelRetirement<M extends RetirableModel>(options: {
  find(path: string): M | undefined;
  owners(model: M): ModelOwner[];
  schedule(callback: () => void): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
}): Retirement {
  const pending = new Map<M, { cancel(): void; isRetired: () => boolean }>();
  return {
    retire(path, isRetired) {
      const model = options.find(path);
      if (!model || model.isDisposed()) return;
      const existing = pending.get(model);
      if (existing) {
        existing.isRetired = isRetired;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let subscriptions: Disposable[] = [];
      let modelSubscription: Disposable | undefined;
      const clearSubscriptions = () => {
        subscriptions.forEach((subscription) => subscription.dispose());
        subscriptions = [];
      };
      const entry = {
        isRetired,
        cancel() {
          if (timer !== undefined) options.cancel(timer);
          timer = undefined;
          clearSubscriptions();
          modelSubscription?.dispose();
          pending.delete(model);
        },
      };
      const retry = () => {
        if (pending.get(model) !== entry || timer !== undefined) return;
        timer = options.schedule(() => {
          timer = undefined;
          if (model.isDisposed() || !entry.isRetired()) {
            entry.cancel();
            return;
          }
          clearSubscriptions();
          const owners = options.owners(model);
          if (!owners.length) {
            entry.cancel();
            model.dispose();
            return;
          }
          for (const owner of owners)
            subscriptions.push(
              owner.onDidChangeModel(retry),
              owner.onDidDispose(retry),
            );
        });
      };
      pending.set(model, entry);
      modelSubscription = model.onWillDispose(() => entry.cancel());
      // Let editor adapters detach and cancel pending token/diff work first.
      retry();
    },
    cancelAll() {
      for (const entry of [...pending.values()]) entry.cancel();
    },
  };
}

// Register only when the lazy Monaco module actually loads. Removing a recovered
// buffer without ever opening an editor must not download/start Monaco to clean up.
let retirement: Retirement | undefined;
export function installModelRetirement(next: Retirement) {
  retirement?.cancelAll();
  retirement = next;
}
export function retireEditorModels(
  paths: string[],
  isRetired: (path: string) => boolean,
) {
  for (const path of new Set(paths))
    retirement?.retire(path, () => isRetired(path));
}
