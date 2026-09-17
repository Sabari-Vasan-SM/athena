import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { timeAgo } from '../lib/router';
import { useApi, useLive } from '../lib/store';
import type { DocContent, DocId, HistoryResponse, Segment } from '../lib/types';
import { Markdown } from '../components/Markdown';
import { Badge, ConfirmDialog, Empty, ErrorNote, Spinner, SYNC_LABEL } from '../components/ui';

// CodeMirror is only needed when editing; keep it out of the initial bundle.
const Editor = lazy(() => import('../components/Editor').then((m) => ({ default: m.Editor })));

type Tab = 'preview' | 'edit' | 'history';

function SegmentView({ segment, showLabels }: { segment: Segment; showLabels: boolean }) {
  if (segment.kind === 'developer') {
    return (
      <div className={`segment segment--developer ${showLabels ? 'segment--labeled' : ''}`}>
        {showLabels && <div className="segment__label">Developer content · never modified by Athena</div>}
        <Markdown source={segment.content} />
      </div>
    );
  }
  return (
    <div className={`segment segment--generated ${segment.modified ? 'segment--modified' : ''} ${showLabels ? 'segment--labeled' : ''}`}>
      {showLabels && (
        <div className="segment__label">
          {segment.modified ? 'Generated section · edited by a developer — preserved, not refreshed' : 'Generated section · refreshed by athena analyze'}
          <span className="mono segment__id">{segment.id}</span>
        </div>
      )}
      <Markdown source={segment.content} />
    </div>
  );
}

function History({ id }: { id: DocId }) {
  const { revision } = useLive();
  const { data, error } = useApi<HistoryResponse>(`/api/docs/${id}/history`, [revision]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<Error | null>(null);

  useEffect(() => {
    setSelected(null);
    setContent(null);
  }, [id]);

  const open = async (sha: string) => {
    setSelected(sha);
    setContent(null);
    setLoadErr(null);
    try {
      setContent((await api<{ content: string }>(`/api/docs/${id}/history/${sha}`)).content);
    } catch (e) {
      setLoadErr(e as Error);
    }
  };

  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;
  if (!data.available || !data.entries.length) return <Empty title="No history">{data.reason}</Empty>;
  return (
    <div className="history">
      <ol className="history__list">
        {data.entries.map((e, i) => (
          <li key={e.sha}>
            <button className={`history__item ${selected === e.sha ? 'history__item--active' : ''}`} onClick={() => open(e.sha)}>
              <span className="history__version">v{data.entries.length - i}</span>
              <span className="history__subject">{e.subject || '(no message)'}</span>
              <span className="history__meta mono">{e.sha.slice(0, 8)} · {timeAgo(e.date)}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="history__view">
        {!selected && <Empty title="Select a version">History comes from Git commits that touched this file.</Empty>}
        {loadErr && <ErrorNote error={loadErr} />}
        {selected && !content && !loadErr && <Spinner />}
        {content !== null && (
          <>
            <div className="note">Read-only view of <span className="mono">{selected?.slice(0, 12)}</span></div>
            <Markdown source={content.replace(/<!-- athena:[^>]*-->/g, '')} />
          </>
        )}
      </div>
    </div>
  );
}

export function DocPage({ id }: { id: DocId }) {
  const { revision, toast, refreshDocs } = useLive();
  const [doc, setDoc] = useState<DocContent | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [tab, setTab] = useState<Tab>('preview');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [confirmDiscard, setConfirmDiscard] = useState<null | (() => void)>(null);
  const dirty = doc !== null && draft !== doc.content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const load = useCallback(async () => {
    try {
      const d = await api<DocContent>(`/api/docs/${id}`);
      setDoc(d);
      setDraft(d.content);
      setError(null);
      setExternalChange(false);
      setSaveError(null);
    } catch (e) {
      setError(e as Error);
    }
  }, [id]);

  useEffect(() => {
    setDoc(null);
    setTab('preview');
    void load();
  }, [load]);

  // Knowledge changed on disk (analysis, CLI, editor): reload unless the user has unsaved edits.
  useEffect(() => {
    if (revision === 0 || !doc) return;
    api<DocContent>(`/api/docs/${id}`)
      .then((d) => {
        if (d.hash === doc.hash) {
          setDoc((cur) => (cur ? { ...cur, sync: d.sync, affectedBy: d.affectedBy, lastChangedAt: d.lastChangedAt } : cur));
          return;
        }
        if (dirtyRef.current) setExternalChange(true);
        else {
          setDoc(d);
          setDraft(d.content);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const save = async () => {
    if (!doc || !dirtyRef.current || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const d = await api<DocContent>(`/api/docs/${id}`, { method: 'PUT', body: { content: draft, baseHash: doc.hash } });
      setDoc((cur) => ({ ...cur, ...d }));
      setDraft(d.content);
      setExternalChange(false);
      toast(`Saved ${d.file}`, 'success');
      refreshDocs();
    } catch (e) {
      if (e instanceof ApiError) {
        setSaveError(e);
        if (e.status === 409) setExternalChange(true);
      } else toast('Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!doc) return <div className="page-loading"><Spinner /></div>;

  const sync = SYNC_LABEL[doc.sync] ?? SYNC_LABEL.synchronized;
  const switchTab = (t: Tab) => setTab(t);

  return (
    <div className="page page--doc">
      <header className="page__header page__header--doc">
        <div>
          <div className="page__kicker mono">.athena/{doc.file}</div>
          <h1 className="page__title">{doc.title}</h1>
          <p className="page__subtitle">{doc.purpose}</p>
        </div>
        <div className="doc-meta">
          <Badge tone={sync.tone} title={doc.affectedBy.length ? `Changed files: ${doc.affectedBy.join(', ')}` : undefined}>{sync.label}</Badge>
          {doc.editedSections.length > 0 && <Badge tone="blue" title={doc.editedSections.join(', ')}>{doc.editedSections.length} developer-edited section{doc.editedSections.length === 1 ? '' : 's'}</Badge>}
          <span className="muted">{doc.lastGeneratedAt ? `Last synchronized ${timeAgo(doc.lastGeneratedAt)}` : 'Not generated by Athena'}</span>
        </div>
      </header>

      <div className="toolbar">
        <div className="tabs" role="tablist">
          {(['preview', 'edit', 'history'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'tab--active' : ''}`} onClick={() => switchTab(t)}>
              {t === 'preview' ? 'Preview' : t === 'edit' ? 'Edit' : 'History'}
              {t === 'edit' && dirty && <span className="tab__dirty" aria-label="unsaved changes" />}
            </button>
          ))}
        </div>
        <div className="toolbar__actions">
          {tab === 'preview' && (
            <label className="toggle-label">
              <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Show section ownership
            </label>
          )}
          {tab === 'edit' && (
            <>
              <span className="muted fineprint">{dirty ? 'Unsaved changes' : 'Saved'} · ⌘S</span>
              <button className="btn" disabled={!dirty || saving} onClick={() => setConfirmDiscard(() => () => setDraft(doc.content))}>
                Discard
              </button>
              <button className="btn btn--primary" disabled={!dirty || saving} onClick={save}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>

      {externalChange && (
        <div className="note note--warn" role="alert">
          <strong>{doc.file} changed on disk</strong> while you were editing.
          <div className="note__actions">
            <button className="btn btn--sm" onClick={() => setConfirmDiscard(() => () => void load())}>Reload from disk (discard my edits)</button>
            <button className="btn btn--sm" onClick={() => navigator.clipboard?.writeText(draft).then(() => toast('Your version was copied to the clipboard', 'success'))}>Copy my version</button>
          </div>
        </div>
      )}
      {saveError && saveError.status !== 409 && (
        <div className="note note--error" role="alert">
          <strong>{saveError.message}</strong>
          {saveError.hint && <div className="note__hint">{saveError.hint}</div>}
          {Array.isArray(saveError.details?.secrets) && (
            <ul className="note__list">
              {(saveError.details!.secrets as Array<{ type: string; line: number }>).map((s, i) => (
                <li key={i}>Line {s.line}: {s.type}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'preview' && (
        <article className="doc">
          {doc.segments.map((seg, i) => (
            <SegmentView key={seg.kind === 'generated' ? seg.id : `dev-${i}`} segment={seg} showLabels={showLabels} />
          ))}
        </article>
      )}
      {tab === 'edit' && (
        <div className="editor-wrap">
          <Suspense fallback={<div className="editor editor--loading"><Spinner label="Loading editor" /></div>}>
            <Editor value={draft} onChange={setDraft} onSave={save} />
          </Suspense>
          <p className="fineprint">
            Edits inside <span className="mono">athena:generated</span> markers are kept and stop that section from being refreshed. Put your own notes under <em>Developer Notes</em>. Saving is refused if the content looks like it contains a secret.
          </p>
        </div>
      )}
      {tab === 'history' && <History id={id} />}

      <ConfirmDialog
        open={confirmDiscard !== null}
        title="Discard unsaved changes?"
        body="Your edits to this document will be lost."
        confirmLabel="Discard"
        danger
        onCancel={() => setConfirmDiscard(null)}
        onConfirm={() => {
          confirmDiscard?.();
          setConfirmDiscard(null);
        }}
      />
    </div>
  );
}
