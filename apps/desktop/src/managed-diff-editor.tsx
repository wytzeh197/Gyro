import { useLayoutEffect, useRef } from "react";
import {
  DiffEditor,
  type DiffEditorProps,
  type DiffOnMount,
} from "@monaco-editor/react";

/** Detach models before the React adapter disposes them during unmount. */
export function ManagedDiffEditor({ onMount, ...props }: DiffEditorProps) {
  const editorRef = useRef<Parameters<DiffOnMount>[0]>();
  const keepModels = useRef(props);
  keepModels.current = props;

  useLayoutEffect(
    () => () => {
      const editor = editorRef.current;
      editorRef.current = undefined;
      if (!editor) return;
      const models = editor.getModel();
      // The adapter currently disposes the models before its diff widget. Monaco
      // requires the opposite order; its passive cleanup will dispose the widget.
      editor.setModel(null);
      if (!keepModels.current.keepCurrentOriginalModel)
        models?.original.dispose();
      if (!keepModels.current.keepCurrentModifiedModel)
        models?.modified.dispose();
    },
    [],
  );

  return (
    <DiffEditor
      {...props}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        onMount?.(editor, monaco);
      }}
    />
  );
}
