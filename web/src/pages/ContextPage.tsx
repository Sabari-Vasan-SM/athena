import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Link, timeAgo } from '../lib/router';
import { useApi, useLive } from '../lib/store';
import type { GraphSummary, RelevantContext } from '../lib/types';
import { Badge, Card, Empty, ErrorNote, Spinner } from '../components/ui';

const EXAMPLES = ['add refunds to the payments API', 'fix the failing checkout tests', 'speed up the dashboard query', 'require 2FA for admin login'];

export function ContextPage() {
  const { revision, toast } = useLive();
  const { data: graph, reload: reloadGraph } = useApi<GraphSummary>('/api/graph', [revision]);
  const [task, setTask] = useState('');
  const [result, setResult] = useState<RelevantContext | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [showFull, setShowFull] = useState(false);

  const run = async (value: string) => {
    const t = value.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api<RelevantContext>(`/api/context?task=${encodeURIComponent(t)}`));
    } catch (e) {
      setError(e as Error);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const build = async () => {
    setBuilding(true);
    try {
      await api('/api/graph/build', { method: 'POST', body: {} });
      toast('Project graph rebuilt', 'success');
      reloadGraph();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not build the graph', 'error');
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <div className="page__kicker">Context engine</div>
          <h1 className="page__title">Context</h1>
          <p className="page__subtitle">
            Describe a task and Athena shows exactly which knowledge an agent should read for it — chosen deterministically, with the reason for each choice. This is what the MCP tool <span className="mono">get_relevant_context</span> returns.
          </p>
        </div>
        <div className="page__meta">
          {graph?.built ? <span>Graph: {graph.stats!.nodes} nodes · {graph.stats!.edges} links · {timeAgo(graph.builtAt!)}</span> : <span className="muted">Graph not built</span>}
          <button className="btn btn--sm" onClick={build} disabled={building}>
            {building ? <><Spinner label="Building" /> Building…</> : graph?.built ? 'Rebuild graph' : 'Build graph'}
          </button>
        </div>
      </header>

      <form
        className="card add-rule"
        onSubmit={(e) => {
          e.preventDefault();
          void run(task);
        }}
      >
        <div className="add-rule__row">
          <input
            className="input add-rule__text"
            placeholder="What are you about to do?"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void run(task);
              }
            }}
            aria-label="Task description"
          />
          <button className="btn btn--primary" type="submit" disabled={busy || !task.trim()}>
            {busy ? 'Selecting…' : 'Show context'}
          </button>
        </div>
        <div className="examples">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              className="chip chip--button"
              onClick={() => {
                setTask(e);
                void run(e);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      </form>

      {error && <ErrorNote error={error} />}
      {!result && !error && (
        <Card>
          <Empty title="No task yet">Enter a task above, or try one of the examples.</Empty>
        </Card>
      )}

      {result && (
        <>
          <div className="sync-grid">
            <Card title="Documents selected, and why">
              <ul className="modelchanges">
                {result.areas.map((a) => (
                  <li key={a.id}>
                    <span className="modelchanges__label">
                      <Link to={a.id === 'rules' ? '/rules' : `/docs/${a.id}`}>{a.id}</Link>
                    </span>
                    <span className="muted">{a.why.join('; ')}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Related code (project graph)">
              {result.graphNodes.length || result.mentionedFiles.length ? (
                <ul className="filechanges">
                  {result.mentionedFiles.map((f) => (
                    <li key={f}><span className="filechanges__kind filechanges__kind--A">@</span><span className="mono">{f}</span></li>
                  ))}
                  {result.graphNodes.filter((n) => !result.mentionedFiles.includes(n.path ?? '')).slice(0, 12).map((n) => (
                    <li key={n.id}><span className="filechanges__kind filechanges__kind--R">{n.kind[0]!.toUpperCase()}</span><span className="mono">{n.name}{n.path ? ` · ${n.path}` : ''}</span></li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No related nodes. Name a file in the task, or build the graph.</p>
              )}
            </Card>
          </div>

          <Card
            title={`Sections an agent would read (${result.sections.length})`}
            actions={
              <label className="toggle-label">
                <input type="checkbox" checked={showFull} onChange={(e) => setShowFull(e.target.checked)} /> Show content
              </label>
            }
          >
            <div className="context-sections">
              {result.sections.map((s) => (
                <div key={`${s.doc}:${s.section}`} className="context-section">
                  <div className="context-section__head">
                    <span className="mono">{s.file}</span>
                    <Badge>{s.section}</Badge>
                  </div>
                  {showFull && <pre className="context-section__body">{s.content}</pre>}
                </div>
              ))}
            </div>
            <p className="fineprint">
              ~{result.approxChars.toLocaleString()} characters · {result.rules.length} project rules always included{result.truncated ? ' · lower-ranked sections omitted for budget' : ''}
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
