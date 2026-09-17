import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Link, timeAgo } from '../lib/router';
import { useApi, useLive } from '../lib/store';
import type { SyncPlan, SyncStatus } from '../lib/types';
import { DiffView } from '../components/DiffView';
import { Badge, Card, Empty, ErrorNote, Spinner } from '../components/ui';

function FileChanges({ plan }: { plan: SyncPlan }) {
  const fc = plan.fileChanges;
  const rows = [
    ...fc.modified.map((p) => ({ k: 'M', p })),
    ...fc.added.map((p) => ({ k: 'A', p })),
    ...fc.deleted.map((p) => ({ k: 'D', p })),
    ...fc.renamed.map((r) => ({ k: 'R', p: `${r.from} → ${r.to}` })),
  ];
  const [all, setAll] = useState(false);
  if (!rows.length) return <p className="muted">No file changes since the last analysis.</p>;
  return (
    <>
      <ul className="filechanges">
        {(all ? rows : rows.slice(0, 8)).map((r) => (
          <li key={`${r.k}:${r.p}`}>
            <span className={`filechanges__kind filechanges__kind--${r.k}`}>{r.k}</span>
            <span className="mono">{r.p}</span>
          </li>
        ))}
      </ul>
      {rows.length > 8 && (
        <button className="btn btn--ghost btn--sm" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${rows.length}`}
        </button>
      )}
    </>
  );
}

export function SyncPage() {
  const { revision, toast, activity } = useLive();
  const { data, error, reload } = useApi<SyncStatus>('/api/sync', [revision]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<null | 'check' | 'apply' | 'ignore'>(null);

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page-loading"><Spinner /></div>;
  const plan = data.plan;
  const checking = activity.state === 'ANALYZING' || busy === 'check';

  const act = async (kind: 'check' | 'apply' | 'ignore') => {
    setBusy(kind);
    try {
      if (kind === 'check') {
        const r = await api<{ upToDate: boolean }>('/api/sync/check', { method: 'POST', body: {} });
        if (r.upToDate) toast('Knowledge is up to date', 'success');
      } else {
        await api(`/api/sync/${kind}`, { method: 'POST', body: { planId: plan!.id } });
        toast(kind === 'apply' ? 'Knowledge updated' : 'Proposal ignored until files change again', 'success');
      }
      reload();
    } catch (e) {
      toast(e instanceof ApiError ? `${e.message}${e.hint ? ` ${e.hint}` : ''}` : 'Request failed', 'error');
      reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <div className="page__kicker">Continuous synchronization</div>
          <h1 className="page__title">Sync</h1>
          <p className="page__subtitle">When project files change, Athena re-analyzes and proposes updates only for knowledge that actually changes. Nothing is written until you review it.</p>
        </div>
        <div className="page__meta">
          <span>{data.watching ? <Badge tone="green">Watching files</Badge> : <Badge>Not watching</Badge>}</span>
          <span>{data.lastCheckedAt ? `Checked ${timeAgo(data.lastCheckedAt)}` : 'Not checked yet'}</span>
          <button className="btn btn--sm" onClick={() => act('check')} disabled={busy !== null}>
            {checking ? <><Spinner label="Checking" /> Checking…</> : 'Check now'}
          </button>
        </div>
      </header>

      {!plan ? (
        <Card>
          <Empty title="Knowledge is up to date">
            {data.watching ? 'Athena is watching this project and will propose updates when relevant files change.' : 'Run a check to compare the project with its knowledge.'}
          </Empty>
        </Card>
      ) : (
        <>
          <div className={`proposal ${plan.ignored ? 'proposal--ignored' : ''}`}>
            <div className="proposal__text">
              <strong>{plan.documents.length} document{plan.documents.length === 1 ? '' : 's'} would change</strong>
              <span className="muted">
                {' '}
                · {plan.documents.reduce((n, d) => n + d.additions, 0)} additions, {plan.documents.reduce((n, d) => n + d.deletions, 0)} deletions · planned {timeAgo(plan.createdAt)}
              </span>
              {plan.ignored && <div className="muted fineprint">You ignored this proposal. It will resurface when files change again.</div>}
            </div>
            <div className="proposal__actions">
              {!plan.ignored && (
                <button className="btn" onClick={() => act('ignore')} disabled={busy !== null}>
                  Ignore
                </button>
              )}
              <button className="btn btn--primary" onClick={() => act('apply')} disabled={busy !== null}>
                {busy === 'apply' ? 'Updating…' : `Update ${plan.documents.length} document${plan.documents.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>

          <div className="sync-grid">
            <Card title="What changed in the project">
              <FileChanges plan={plan} />
              {plan.git.isRepo && plan.git.previousHead && plan.git.head !== plan.git.previousHead && (
                <div className="gitmove">
                  <div className="label">Git</div>
                  {plan.git.branchChanged && <p>Branch changed <span className="mono">{plan.git.previousBranch}</span> → <span className="mono">{plan.git.branch}</span></p>}
                  {plan.git.diverged ? (
                    <p className="muted">HEAD moved to a commit that does not descend from the last analysis (checkout, rebase or reset).</p>
                  ) : (
                    <ul className="commits">
                      {plan.git.commits.map((c) => (
                        <li key={c.sha}><span className="mono muted">{c.sha.slice(0, 8)}</span> {c.subject}</li>
                      ))}
                      {plan.git.truncated && <li className="muted">…more commits</li>}
                    </ul>
                  )}
                </div>
              )}
            </Card>
            <Card title="Detected project changes">
              {plan.modelChanges.length ? (
                <ul className="modelchanges">
                  {plan.modelChanges.map((m) => (
                    <li key={m.label}>
                      <span className="modelchanges__label">{m.label}</span>
                      <span className="muted">{m.summary}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No structural changes recorded (previous model unavailable, or changes are formatting-only).</p>
              )}
            </Card>
          </div>

          <h2 className="section-title">Proposed knowledge updates</h2>
          <div className="proposed">
            {plan.documents.map((d) => {
              const expanded = open[d.id] ?? plan.documents.length <= 2;
              return (
                <article key={d.id} className="card proposed__doc">
                  <button className="proposed__head" onClick={() => setOpen({ ...open, [d.id]: !expanded })} aria-expanded={expanded}>
                    <span className={`chevron ${expanded ? 'chevron--open' : ''}`} aria-hidden="true">›</span>
                    <span className="proposed__file mono">{d.file}</span>
                    {d.status === 'created' && <Badge tone="green">new</Badge>}
                    <span className="proposed__counts">
                      <span className="add">+{d.additions}</span> <span className="del">−{d.deletions}</span>
                    </span>
                  </button>
                  <ul className="reasons">
                    {d.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <div className="proposed__sections">
                    Sections: {d.changedSections.map((s) => <span key={s} className="mono tag">{s}</span>)}
                    <Link to={`/docs/${d.id}`} className="proposed__open">Open current</Link>
                  </div>
                  {d.preservedSections.length > 0 && (
                    <div className="note note--info">Your edits in <span className="mono">{d.preservedSections.join(', ')}</span> are kept and not overwritten.</div>
                  )}
                  {expanded && <DiffView patch={d.diff} truncated={d.diffTruncated} />}
                </article>
              );
            })}
          </div>
          {plan.checkedUnchanged.length > 0 && <p className="fineprint">Also checked and unchanged: {plan.checkedUnchanged.join(', ')}</p>}
        </>
      )}
    </div>
  );
}
