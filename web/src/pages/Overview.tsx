import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Link, timeAgo } from '../lib/router';
import { useApi, useLive } from '../lib/store';
import type { AgentView, Overview as OverviewData, StatusReport, SyncStatus } from '../lib/types';
import { ActivityPanel, EventList } from '../components/ActivityPanel';
import { Badge, Card, Empty, ErrorNote, Spinner, SyncDot } from '../components/ui';

function Stat({ label, value, sub, tone, to }: { label: string; value: string | number; sub?: string; tone?: 'warn'; to?: string }) {
  const body = (
    <>
      <div className="stat__label">{label}</div>
      <div className={`stat__value ${tone === 'warn' ? 'stat__value--warn' : ''}`}>{value}</div>
      {sub && <div className="stat__sub">{sub}</div>}
    </>
  );
  return to ? (
    <Link to={to} className="stat stat--link">
      {body}
    </Link>
  ) : (
    <div className="stat">{body}</div>
  );
}

export function Overview() {
  const { revision, events, activity, docs, toast } = useLive();
  const { data, error } = useApi<OverviewData>('/api/overview', [revision]);
  const { data: status } = useApi<StatusReport>('/api/status', [revision]);
  const { data: agents } = useApi<AgentView[]>('/api/agents', [revision]);
  const { data: sync } = useApi<SyncStatus>('/api/sync', [revision]);
  const proposal = sync?.plan && !sync.plan.ignored ? sync.plan : null;
  const [starting, setStarting] = useState(false);

  if (error) return <ErrorNote error={error} />;
  if (!data) return <div className="page-loading"><Spinner /></div>;
  const s = data.summary;
  const analyzing = activity.state === 'ANALYZING';

  const reanalyze = async () => {
    setStarting(true);
    try {
      await api('/api/analyze', { method: 'POST', body: {} });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not start analysis', 'error');
    } finally {
      setStarting(false);
    }
  };

  const changeCount = status ? status.changes.added.length + status.changes.modified.length + status.changes.deleted.length : 0;

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <div className="page__kicker">Project Overview</div>
          <h1 className="page__title">{data.project.name}</h1>
          <p className="page__subtitle">{data.project.description ?? <span className="muted">No project description found in manifests.</span>}</p>
        </div>
        <div className="page__meta">
          <span>Analyzed {timeAgo(data.analyzedAt)}</span>
          {data.git.branch && <span className="mono">⎇ {data.git.branch}</span>}
          <span className="mono">Athena {data.athenaVersion}</span>
        </div>
      </header>

      {proposal && (
        <Link to="/sync" className="proposal proposal--link">
          <div className="proposal__text">
            <strong>Knowledge update proposed</strong>
            <span className="muted"> · {proposal.documents.map((d) => d.file).join(', ')}</span>
            <div className="fineprint">{proposal.modelChanges[0] ? `${proposal.modelChanges[0].label}: ${proposal.modelChanges[0].summary}` : proposal.documents[0]?.reasons[0]}</div>
          </div>
          <span className="btn btn--primary btn--sm">Review changes</span>
        </Link>
      )}

      <div className="overview-grid">
        <div className="overview-main">
          {s ? (
            <div className="stats">
              <Stat label="Files analyzed" value={s.filesAnalyzed.toLocaleString()} sub={s.languages.slice(0, 3).map((l) => l.name).join(' · ') || undefined} to="/docs/project" />
              <Stat label="Frameworks" value={new Set(s.frameworks.map((f) => f.name)).size} sub={s.monorepo.isMonorepo ? `Monorepo · ${s.monorepo.packages} packages` : undefined} to="/docs/architecture" />
              <Stat label="API routes" value={s.routes} sub={s.apiSpecs ? `${s.apiSpecs} spec files` : undefined} to="/docs/api" />
              <Stat label="DB entities" value={s.entities} sub={s.databases.slice(0, 2).join(' · ') || undefined} to="/docs/database" />
              <Stat label="Test files" value={s.testFiles} sub={s.testFrameworks.slice(0, 2).join(' · ') || 'No framework detected'} to="/docs/testing" />
              <Stat label="Potential secrets" value={s.potentialSecrets} sub={s.potentialSecrets ? 'Review security.md' : 'None matched'} tone={s.potentialSecrets ? 'warn' : undefined} to="/docs/security" />
            </div>
          ) : (
            <Card>
              <Empty title="Analysis summary not available">model.json is missing (it is not committed to Git). Re-analyze to rebuild it.</Empty>
            </Card>
          )}

          <Card
            title="Knowledge synchronization"
            actions={
              <button className="btn btn--primary" onClick={reanalyze} disabled={starting || analyzing}>
                {analyzing ? <><Spinner label="Analyzing" /> Analyzing…</> : 'Re-analyze project'}
              </button>
            }
          >
            {!status ? (
              <Spinner />
            ) : (
              <div className="sync">
                <div className="sync__summary">
                  {proposal ? (
                    <><Badge tone="yellow">Update proposed</Badge><Link to="/sync">Review {proposal.documents.length} document update{proposal.documents.length === 1 ? '' : 's'}</Link></>
                  ) : status.sync === 'up-to-date' ? (
                    <><Badge tone="green">Up to date</Badge><span className="muted">No file changes since the last analysis.</span></>
                  ) : (
                    <><Badge tone="yellow">Needs update</Badge><span>{changeCount} file{changeCount === 1 ? '' : 's'} changed since the last analysis <span className="muted">({status.changes.modified.length} modified · {status.changes.added.length} added · {status.changes.deleted.length} deleted)</span></span></>
                  )}
                </div>
                {status.affectedDocuments.length > 0 && (
                  <div className="sync__affected">
                    <div className="label">Potentially affected knowledge</div>
                    <ul>
                      {status.affectedDocuments.map((a) => {
                        const doc = docs.find((d) => d.file === a.file);
                        return (
                          <li key={a.file}>
                            <Link to={doc?.id === 'rules' ? '/rules' : `/docs/${doc?.id ?? ''}`} className="mono">{a.file}</Link>
                            <span className="muted"> — {a.reasons.join(', ')}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                <p className="fineprint">Re-analysis regenerates only Athena-managed sections. Your edits and Developer Notes are preserved.</p>
              </div>
            )}
          </Card>

          {s && (
            <Card title="Detected stack">
              {s.frameworks.length ? (
                <div className="chips">
                  {s.frameworks.map((f) => (
                    <span key={`${f.name}@${f.root}`} className="chip" title={`${f.status} · ${f.confidence} confidence · ${f.root}`}>
                      <span className={`chip__conf chip__conf--${f.confidence}`} />
                      {f.name}
                      {f.root !== '.' && <span className="chip__root">{f.root}</span>}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="muted">No known frameworks detected.</p>
              )}
              <dl className="facts">
                <div><dt>Databases</dt><dd>{s.databases.join(', ') || <span className="muted">Not detected</span>}</dd></div>
                <div><dt>Auth</dt><dd>{s.auth.join(', ') || <span className="muted">Not detected</span>}</dd></div>
                <div><dt>CI/CD</dt><dd>{s.ci.join(', ') || <span className="muted">Not detected</span>}</dd></div>
                <div><dt>Hosting</dt><dd>{s.hosting.join(', ') || <span className="muted">Not detected</span>}</dd></div>
              </dl>
              <p className="fineprint">"Not detected" means Athena found no evidence. It does not prove absence.</p>
            </Card>
          )}

          <Card title="Knowledge" className="card--flush">
            <ul className="doclist">
              {docs.map((d) => (
                <li key={d.id}>
                  <Link to={d.id === 'rules' ? '/rules' : `/docs/${d.id}`} className="doclist__row">
                    <SyncDot state={d.sync} />
                    <span className="doclist__title">{d.title}</span>
                    <span className="doclist__file mono">{d.file}</span>
                    {d.editedSections.length > 0 && <Badge tone="blue" title={d.editedSections.join(', ')}>{d.editedSections.length} edited</Badge>}
                    <span className="doclist__time">{d.id === 'rules' ? 'developer-owned' : d.lastChangedAt ? `changed ${timeAgo(d.lastChangedAt)}` : ''}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <aside className="overview-side">
          <Card title="Current activity">
            <ActivityPanel compact />
          </Card>
          <Card title="AI agents" actions={<Link to="/agents" className="btn btn--ghost btn--sm">Manage</Link>}>
            <ul className="agentlist">
              {(agents ?? []).map((a) => (
                <li key={a.id}>
                  <span className={`dot ${a.configured ? 'dot--green' : 'dot--off'}`} />
                  <span>{a.name}</span>
                  <span className="muted">{a.configured ? 'configured' : a.detectedInProject ? 'detected, not configured' : 'not configured'}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Recent activity" actions={<Link to="/activity" className="btn btn--ghost btn--sm">All</Link>}>
            <EventList events={events} limit={6} />
          </Card>
        </aside>
      </div>
    </div>
  );
}
