import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';

const theme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--panel)', color: 'var(--text)' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
    '.cm-content': { caretColor: 'var(--accent)', padding: '12px 0' },
    '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--faint)', border: 'none', borderRight: '1px solid var(--border)' },
    '.cm-activeLine': { backgroundColor: 'var(--hover)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--muted)' },
    '&.cm-focused': { outline: 'none' },
    '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
    '.cm-searchMatch': { backgroundColor: 'var(--selection)' },
    '.cm-panels': { backgroundColor: 'var(--panel-2)', color: 'var(--text)' },
  },
  { dark: true },
);

export function Editor({ value, onChange, onSave }: { value: string; onChange: (v: string) => void; onSave: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cbs = useRef({ onChange, onSave });
  cbs.current = { onChange, onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (cbs.current.onSave(), true) }]),
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          theme,
          EditorView.updateListener.of((u) => u.docChanged && cbs.current.onChange(u.state.doc.toString())),
          EditorView.contentAttributes.of({ 'aria-label': 'Markdown editor', spellcheck: 'true' }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Replace content when the parent loads a different version (e.g. reload from disk).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div className="editor" ref={host} />;
}
