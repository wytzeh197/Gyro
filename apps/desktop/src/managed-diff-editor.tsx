import { useLayoutEffect, useRef } from "react";
import {
  DiffEditor,
  type DiffEditorProps,
  type DiffOnMount,
} from "@monaco-editor/react";

/** Release preview models after Monaco has canceled its pending diff work. */
export function ManagedDiffEditor({ onMount, ...props }: DiffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Parameters<DiffOnMount>[0]>();
  const monacoRef = useRef<Parameters<DiffOnMount>[1]>();
  const keepModels = useRef(props);
  keepModels.current = props;

  useLayoutEffect(
    () => () => {
      // The adapter creates its widget before its passive onMount callback.
      // A quick cancel can unmount in that gap, so also locate our widget by
      // its container instead of relying on onMount having run.
      const editor =
        editorRef.current ??
        monacoRef.current?.editor.getDiffEditors().find((candidate) => {
          const node = candidate.getContainerDomNode();
          return !!node && !!containerRef.current?.contains(node);
        });
      editorRef.current = undefined;
      if (!editor) return;
      const models = editor.getModel();
      // Monaco releases the previous diff view model in a queued task. Keep
      // its text models alive until that task cancels pending worker requests.
      // The adapter only disposes its widget in its later passive cleanup.
      editor.setModel(null);
      const { keepCurrentOriginalModel, keepCurrentModifiedModel } =
        keepModels.current;
      setTimeout(() => {
        // A caller using model paths can mount another editor with the same
        // model before this task runs. Its live reference owns that model now.
        const inUse = (model: NonNullable<typeof models>["original"]) =>
          monacoRef.current?.editor.getEditors().some((editor) => editor.getModel() === model) ||
          monacoRef.current?.editor.getDiffEditors().some((editor) => {
            const pair = editor.getModel();
            return pair?.original === model || pair?.modified === model;
          });
        if (models?.original && !keepCurrentOriginalModel && !inUse(models.original))
          models.original.dispose();
        if (models?.modified && !keepCurrentModifiedModel && !inUse(models.modified))
          models.modified.dispose();
      }, 0);
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      style={{ height: props.height ?? "100%", width: props.width ?? "100%", minWidth: 0 }}
    >
      <DiffEditor
        {...props}
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        beforeMount={(monaco) => {
          monacoRef.current = monaco;
          props.beforeMount?.(monaco);
        }}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
          onMount?.(editor, monaco);
        }}
      />
    </div>
  );
}
