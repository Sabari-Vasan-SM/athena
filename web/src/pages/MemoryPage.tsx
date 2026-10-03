import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { timeAgo } from '../lib/router';
import { useLive } from '../lib/store';
import type { MemoryKind, MemoryList, MemoryStatus, MemoryView } from '../lib/types';
import { Badge, ConfirmDialog, Empty, ErrorNote, Spinner } from '../components/ui';

export const MEMORY_KINDS: Array<{ id: MemoryKind; label: string; plural: string }> = [
  { id: 'decision', label: 'Decision', plural: 'Decisions' },
  { id: 'gotcha', label: 'Gotcha', plural: 'Gotchas' },
  { id: 'bug', label: 'Bug', plural: 'Bugs' },
  { id: 'convention', label: 'Convention', plural: 'Conventions' },
  { id: 'todo', label: 'To-do', plural: 'To-dos' },
  { id: 'fact', label: 'Fact', plural: 'Facts' },
];
const kindLabel = (k: MemoryKind) => MEMORY_KINDS.find((x) => x.id === k)?.label ?? k;

const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  'github-copilot': 'GitHub Copilot',
  windsurf: 'Windsurf',
  gemini: 'Gemini',
  'gemini-cli': 'Gemini CLI',
  cline: 'Cline',
  aider: 'Aider',
  zed: 'Zed',
};

/** `developer` → "Developer", `agent:claude-code` → "Claude Code", `agent:foo-bar` → "Foo Bar". */
export function sourceLabel(source: string): string {
  if (source === 'developer') return 'Developer';
  const m = /^agent:(.+)$/.exec(source);
  if (!m) return source;
  return AGENT_NAMES[m[1]!] ?? m[1]!.split('-').map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
}

/** Undo the escaping the store applies to keep entries from breaking the file format (display only; still rendered as text). */

const splitList = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

export interface MemoryDraft {
  kind: MemoryKind;
  title: string;
  details: string;
  files: string[];
  tags: string[];
  evidence?: string;
  supersedes?: string;
}

export interface MemoryActions {
  confirm(id: string): Promise<boolean>;
  save(id: string, patch: Omit<MemoryDraft, 'kind' | 'supersedes'>): Promise<boolean>;
  forget(id: string): Promise<boolean>;
  add(draft: MemoryDraft): Promise<boolean>;
}

function MemoryForm({ initial, replaceable, submitLabel, onSubmit, onCancel, busy }: { initial?: MemoryView; replaceable?: MemoryView[]; submitLabel: string; onSubmit: (d: MemoryDraft) => Promise<boolean>; onCancel: () => void; busy: boolean }) {
  const uid = useId();
  const [kind, setKind] = useState<MemoryKind>(initial?.kind ?? 'decision');
  const [title, setTitle] = useState(initial ? initial.title : '');
  const [details, setDetails] = useState(initial ? initial.details : '');
  const [files, setFiles] = useState(initial?.files.join(', ') ?? '');
  const [tags, setTags] = useState(initial?.tags.join(', ') ?? '');
  const [evidence, setEvidence] = useState(initial?.evidence ? initial.evidence : '');
  const [supersedes, setSupersedes] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (title.trim().length < 3) return;
    await onSubmit({ kind, title: title.trim(), details: details.trim(), files: splitList(files), tags: splitList(tags), evidence: evidence.trim() || undefined, supersedes: supersedes || undefined });
  };

  return (
    <form className="memory-form" onSubmit={submit} aria-label={initial ? `Edit memory ${initial.id}` : 'Add memory'}>
      <div className="memory-form__row">
        {!initial && (
          <label className="memory-form__field memory-form__field--kind" htmlFor={`${uid}-kind`}>
            <span>Kind</span>
            <select id={`${uid}-kind`} className="select" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
              {MEMORY_KINDS.map((k) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
          </label>
        )}
        <label className="memory-form__field memory-form__field--grow" htmlFor={`${uid}-title`}>
          <span>Title</span>
          <input id={`${uid}-title`} className="input" value={title} maxLength={200} required minLength={3} placeholder="e.g. Orders are soft-deleted; always filter on deleted_at" onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
      </div>
      <label className="memory-form__field" htmlFor={`${uid}-details`}>
        <span>Details <span className="muted">(plain text)</span></span>
        <textarea id={`${uid}-details`} className="input memory-form__textarea" value={details} maxLength={4000} rows={4} onChange={(e) => setDetails(e.target.value)} />
      </label>
      <div className="memory-form__row">
        <label className="memory-form__field memory-form__field--grow" htmlFor={`${uid}-files`}>
          <span>Files <span className="muted">(project-relative, comma-separated)</span></span>
          <input id={`${uid}-files`} className="input mono" value={files} placeholder="src/orders/repo.ts" onChange={(e) => setFiles(e.target.value)} />
        </label>
        <label className="memory-form__field" htmlFor={`${uid}-tags`}>
          <span>Tags</span>
          <input id={`${uid}-tags`} className="input" value={tags} placeholder="orders, db" onChange={(e) => setTags(e.target.value)} />
        </label>
      </div>
      <label className="memory-form__field" htmlFor={`${uid}-evidence`}>
        <span>Evidence <span className="muted">(optional: a commit, issue or test that backs it up)</span></span>
        <input id={`${uid}-evidence`} className="input" value={evidence} maxLength={500} onChange={(e) => setEvidence(e.target.value)} />
      </label>
      {!initial && replaceable && replaceable.length > 0 && (
        <label className="memory-form__field" htmlFor={`${uid}-supersedes`}>
          <span>Replaces <span className="muted">(optional: marks an older memory as superseded)</span></span>
          <select id={`${uid}-supersedes`} className="select" value={supersedes} onChange={(e) => setSupersedes(e.target.value)}>
            <option value="">Nothing</option>
            {replaceable.map((m) => (
              <option key={m.id} value={m.id}>{m.id} · {m.title.slice(0, 80)}</option>
            ))}
          </select>
        </label>
      )}
      <div className="memory-form__actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn--primary" disabled={busy || title.trim().length < 3}>{submitLabel}</button>
      </div>
    </form>
  );
}

export function MemoryCard({ entry, busy, editing, onConfirm, onEdit, onCancelEdit, onSave, onForget }: { entry: MemoryView; busy: boolean; editing: boolean; onConfirm: () => void; onEdit: () => void; onCancelEdit: () => void; onSave: (d: MemoryDraft) => Promise<boolean>; onForget: () => void }) {
  const title = entry.title;
  const isAgent = entry.source.startsWith('agent:');
  return (
    <article className={`memory memory--${entry.status} ${entry.flags.length ? 'memory--flagged' : ''}`} aria-label={`${kindLabel(entry.kind)}: ${title}`} data-testid={`memory-${entry.id}`}>
      <header className="memory__meta">
        <Badge tone="accent">{kindLabel(entry.kind)}</Badge>
        {entry.status === 'superseded' ? (
          <Badge title={entry.supersededBy ? `Replaced by ${entry.supersededBy}` : undefined}>Superseded</Badge>
        ) : (
          <Badge tone={entry.label === 'FACT' ? 'green' : 'yellow'} title={entry.label === 'FACT' ? 'Confirmed by a developer' : 'Written by an AI agent, not yet reviewed'}>{entry.label}</Badge>
        )}
        {entry.stale && <Badge tone="yellow">Stale</Badge>}
        <span className="memory__source">
          {isAgent ? 'by ' : ''}
          <strong>{sourceLabel(entry.source)}</strong> · recorded <time dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString()}>{timeAgo(entry.createdAt)}</time>
          {entry.confirmedAt && entry.status !== 'unreviewed' && <> · confirmed <time dateTime={entry.confirmedAt} title={new Date(entry.confirmedAt).toLocaleString()}>{timeAgo(entry.confirmedAt)}</time></>}
        </span>
        <span className="memory__id mono">{entry.id}</span>
      </header>

      {entry.flags.length > 0 && (
        <div className="note note--error memory__flag" role="alert">
          <strong>Possible prompt injection.</strong> This entry {entry.flags.join('; ')}. Memory text is read by AI agents, so text like this may be an attempt to steer them. Athena never recalls flagged entries automatically. Read it carefully before confirming, or forget it.
        </div>
      )}

      {editing ? (
        <MemoryForm initial={entry} submitLabel="Save" busy={busy} onSubmit={onSave} onCancel={onCancelEdit} />
      ) : (
        <>
          <h3 className="memory__title">{title}</h3>
          {entry.details && <p className="memory__details">{entry.details}</p>}
          {(entry.files.length > 0 || entry.tags.length > 0 || entry.evidence) && (
            <dl className="memory__facts">
              {entry.files.length > 0 && (
                <div>
                  <dt>Files</dt>
                  <dd>{entry.files.map((f) => <span key={f} className={`mono memory__file ${entry.changedFiles.includes(f) ? 'memory__file--changed' : ''}`}>{f}</span>)}</dd>
                </div>
              )}
              {entry.tags.length > 0 && (
                <div>
                  <dt>Tags</dt>
                  <dd>{entry.tags.map((t) => <span key={t} className="tag">#{t}</span>)}</dd>
                </div>
              )}
              {entry.evidence && (
                <div>
                  <dt>Evidence</dt>
                  <dd className="memory__evidence">{entry.evidence}</dd>
                </div>
              )}
            </dl>
          )}
          {entry.supersedes && <p className="fineprint">Replaces <span className="mono">{entry.supersedes}</span></p>}
          {entry.status === 'superseded' && entry.supersededBy && <p className="fineprint">Replaced by <span className="mono">{entry.supersededBy}</span></p>}
        </>
      )}

      {entry.stale && !editing && (
        <div className="note note--warn memory__stale">
          <strong>May be out of date.</strong> {entry.changedFiles.length === 1 ? 'A linked file has' : 'Linked files have'} changed since this was {entry.status === 'confirmed' ? 'confirmed' : 'recorded'}:{' '}
          {entry.changedFiles.map((f, i) => <span key={f}>{i > 0 && ', '}<span className="mono">{f}</span></span>)}.
          {entry.status === 'confirmed' && (
            <div className="note__actions">
              <button className="btn btn--sm" onClick={onConfirm} disabled={busy} aria-label={`Re-confirm “${title}” against the current files`}>Re-confirm</button>
            </div>
          )}
        </div>
      )}

      {!editing && (
        <footer className="memory__actions">
          {entry.status === 'unreviewed' && (
            <button className="btn btn--primary btn--sm" onClick={onConfirm} disabled={busy} aria-label={`Confirm “${title}”`}>Confirm</button>
          )}
          {entry.status !== 'superseded' && (
            <button className="btn btn--sm" onClick={onEdit} disabled={busy} aria-label={`Edit “${title}”`}>Edit</button>
          )}
          <button className="btn btn--sm btn--danger-ghost" onClick={onForget} disabled={busy} aria-label={`Forget “${title}”`}>Forget</button>
        </footer>
      )}
    </article>
  );
}

type KindFilter = MemoryKind | 'all';
type StatusFilter = MemoryStatus | 'all';

function Chip({ pressed, onClick, children, count }: { pressed: boolean; onClick: () => void; children: string; count?: number }) {
  return (
    <button type="button" className={`chip chip--button ${pressed ? 'chip--on' : ''}`} aria-pressed={pressed} onClick={onClick}>
      {children}
      {count !== undefined && <span className="chip__count">{count}</span>}
    </button>
  );
}

/** The Memory page without data fetching (also used by tests). */
export function MemoryBoard({ list, actions, busy = false }: { list: MemoryList; actions: MemoryActions; busy?: boolean }) {
  const [kind, setKind] = useState<KindFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [staleOnly, setStaleOnly] = useState(false);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<MemoryView | null>(null);
  const { entries, counts } = list;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter((e) => {
      if (kind !== 'all' && e.kind !== kind) return false;
      if (status !== 'all' && e.status !== status) return false;
      if (staleOnly && !e.stale) return false;
      if (flaggedOnly && e.flags.length === 0) return false;
      if (!needle) return true;
      return [e.id, e.title, e.details, e.evidence ?? '', ...e.files, ...e.tags, sourceLabel(e.source)].join('\n').toLowerCase().includes(needle);
    });
  }, [entries, kind, status, staleOnly, flaggedOnly, q]);

  const queue = filtered.filter((e) => e.status === 'unreviewed');
  const confirmed = filtered.filter((e) => e.status === 'confirmed');
  const superseded = filtered.filter((e) => e.status === 'superseded');
  const replaceable = entries.filter((e) => e.status !== 'superseded');
  const kindCount = (k: MemoryKind) => entries.filter((e) => e.kind === k).length;

  const card = (e: MemoryView) => (
    <MemoryCard
      key={e.id}
      entry={e}
      busy={busy}
      editing={editing === e.id}
      onConfirm={() => void actions.confirm(e.id)}
      onEdit={() => setEditing(e.id)}
      onCancelEdit={() => setEditing(null)}
      onSave={async (d) => {
        const ok = await actions.save(e.id, { title: d.title, details: d.details, files: d.files, tags: d.tags, evidence: d.evidence ?? '' });
        if (ok) setEditing(null);
        return ok;
      }}
      onForget={() => setForgetting(e)}
    />
  );

  return (
    <div className="page memory-page">
      <header className="page__header">
        <div>
          <div className="page__kicker mono">.athena/memory/</div>
          <h1 className="page__title">Project Memory</h1>
          <p className="page__subtitle">Decisions, gotchas and bug causes that AI agents and developers recorded, so later sessions don't rediscover them. Agent entries stay INFERRED until you confirm them.</p>
        </div>
        <div className="page__meta">
          <span>{counts.total} total</span>
          <span className={counts.unreviewed ? 'memory-page__count--warn' : ''}>{counts.unreviewed} to review</span>
          <span>{counts.confirmed} confirmed</span>
          {counts.stale > 0 && <span className="memory-page__count--warn">{counts.stale} stale</span>}
          {counts.flagged > 0 && <span className="memory-page__count--danger">{counts.flagged} flagged</span>}
          <button className="btn btn--primary btn--sm" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            Add memory
          </button>
        </div>
      </header>

      {adding && (
        <section className="card memory-add" aria-label="Add memory">
          <p className="fineprint memory-add__hint">Memories you add are confirmed right away (FACT).</p>
          <MemoryForm
            replaceable={replaceable}
            submitLabel="Add memory"
            busy={busy}
            onCancel={() => setAdding(false)}
            onSubmit={async (d) => {
              const ok = await actions.add(d);
              if (ok) setAdding(false);
              return ok;
            }}
          />
        </section>
      )}

      {counts.total === 0 ? (
        <div className="card">
          <Empty title="No project memory yet">
            <p>Project memory holds what a codebase can't tell you: why a decision was made, a gotcha that cost an afternoon, the real cause of a bug. It lives in <span className="mono">.athena/memory/*.md</span>, is committed with the code, and is recalled for agents when they work on related files.</p>
            <p>AI agents add to it with the MCP <span className="mono">remember</span> tool; you can add entries here or with <span className="mono">athena memory add</span>. Agent entries wait here for your review.</p>
          </Empty>
        </div>
      ) : (
        <>
          <div className="memory-filters" role="group" aria-label="Filter memories">
            <div className="chips" role="group" aria-label="Kind">
              <Chip pressed={kind === 'all'} onClick={() => setKind('all')}>All kinds</Chip>
              {MEMORY_KINDS.map((k) => (
                <Chip key={k.id} pressed={kind === k.id} onClick={() => setKind(kind === k.id ? 'all' : k.id)} count={kindCount(k.id)}>{k.plural}</Chip>
              ))}
            </div>
            <div className="chips" role="group" aria-label="Status">
              <Chip pressed={status === 'all'} onClick={() => setStatus('all')}>Any status</Chip>
              <Chip pressed={status === 'unreviewed'} onClick={() => setStatus(status === 'unreviewed' ? 'all' : 'unreviewed')} count={counts.unreviewed}>Unreviewed</Chip>
              <Chip pressed={status === 'confirmed'} onClick={() => setStatus(status === 'confirmed' ? 'all' : 'confirmed')} count={counts.confirmed}>Confirmed</Chip>
              <Chip pressed={status === 'superseded'} onClick={() => setStatus(status === 'superseded' ? 'all' : 'superseded')} count={counts.superseded}>Superseded</Chip>
              <Chip pressed={staleOnly} onClick={() => setStaleOnly((v) => !v)} count={counts.stale}>Stale</Chip>
              <Chip pressed={flaggedOnly} onClick={() => setFlaggedOnly((v) => !v)} count={counts.flagged}>Flagged</Chip>
            </div>
            <input className="input memory-filters__search" type="search" placeholder="Filter by text, file or tag" aria-label="Filter memories by text" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>

          {filtered.length === 0 && <Empty title="No memories match">Clear a filter or the search to see more.</Empty>}

          {queue.length > 0 && (
            <section className="memory-section" aria-labelledby="memory-queue">
              <h2 className="memory-section__title" id="memory-queue">Review queue <span className="muted">{queue.length}</span></h2>
              <p className="fineprint memory-section__hint">Written by AI agents. Confirm what is true, edit what is close, forget the rest.</p>
              <div className="memory-list">{queue.map(card)}</div>
            </section>
          )}

          {confirmed.length > 0 && (
            <section className="memory-section" aria-labelledby="memory-confirmed">
              <h2 className="memory-section__title" id="memory-confirmed">Confirmed <span className="muted">{confirmed.length}</span></h2>
              <div className="memory-list">{confirmed.map(card)}</div>
            </section>
          )}

          {superseded.length > 0 && (
            <details className="memory-section memory-superseded" open={status === 'superseded'}>
              <summary className="memory-section__title">Superseded <span className="muted">{superseded.length}</span></summary>
              <div className="memory-list">{superseded.map(card)}</div>
            </details>
          )}
        </>
      )}

      <ConfirmDialog
        open={forgetting !== null}
        title="Forget this memory?"
        body={
          <>
            <p className="dialog__quote">{forgetting ? forgetting.title : ''}</p>
            <p className="muted">It is removed from <span className="mono">.athena/memory/</span>. Git history keeps the old version.</p>
          </>
        }
        confirmLabel="Forget"
        danger
        onCancel={() => setForgetting(null)}
        onConfirm={() => {
          const e = forgetting!;
          setForgetting(null);
          void actions.forget(e.id);
        }}
      />
    </div>
  );
}

export function MemoryPage() {
  const { revision, toast } = useLive();
  const [list, setList] = useState<MemoryList | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setList(await api<MemoryList>('/api/memory'));
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
  };
  useEffect(() => {
    void load();
  }, [revision]);

  const run = async (fn: () => Promise<unknown>, success: string): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      toast(success, 'success');
      await load();
      return true;
    } catch (e) {
      const err = e as Error & { hint?: string };
      toast(err.hint ? `${err.message} ${err.hint}` : err.message || 'Update failed', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const actions: MemoryActions = {
    confirm: (id) => run(() => api(`/api/memory/${id}/confirm`, { method: 'POST' }), 'Memory confirmed'),
    save: (id, patch) => run(() => api(`/api/memory/${id}`, { method: 'PATCH', body: patch }), 'Memory updated'),
    forget: (id) => run(() => api(`/api/memory/${id}`, { method: 'DELETE' }), 'Memory forgotten'),
    add: (d) => run(() => api('/api/memory', { method: 'POST', body: { kind: d.kind, title: d.title, details: d.details || undefined, files: d.files, tags: d.tags, evidence: d.evidence, supersedes: d.supersedes } }), 'Memory added'),
  };

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!list) return <div className="page-loading"><Spinner /></div>;
  return <MemoryBoard list={list} actions={actions} busy={busy} />;
}
