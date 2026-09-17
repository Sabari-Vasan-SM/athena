import { useState } from 'react';
import { api } from '../lib/api';
import { timeAgo } from '../lib/router';
import { useApi, useLive } from '../lib/store';
import type { AgentView } from '../lib/types';
import { Badge, ConfirmDialog, ErrorNote, Spinner } from '../components/ui';

export function AgentsPage() {
  const { revision, toast } = useLive();
  const { data, error, reload } = useApi<AgentView[]>('/api/agents', [revision]);
  const [pending, setPending] = useState<{ agent: AgentView; action: 'configure' | 'remove' } | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page-loading"><Spinner /></div>;

  const run = async () => {
    if (!pending) return;
    const { agent, action } = pending;
    setPending(null);
    setBusy(true);
    try {
      await api(`/api/agents/${action}`, { method: 'POST', body: { agents: [agent.id] } });
      toast(action === 'configure' ? `${agent.name} integration configured` : `${agent.name} integration removed`, 'success');
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <div className="page__kicker">Integrations</div>
          <h1 className="page__title">AI Agents</h1>
          <p className="page__subtitle">Each agent is a separate client of the same project knowledge. Athena writes instructions using each agent's own supported mechanism.</p>
        </div>
      </header>

      <div className="note">
        <strong>What "configured" means:</strong> Athena's instruction files are in place for that agent. Athena cannot yet observe whether an agent is running or what it is doing — live activity requires hook integrations, planned for Phase 4.
      </div>

      <div className="agents">
        {data.map((a) => (
          <article key={a.id} className={`card agent ${a.configured ? 'agent--on' : ''}`}>
            <header className="agent__header">
              <span className={`dot ${a.configured ? 'dot--green' : 'dot--off'}`} />
              <h2 className="agent__name">{a.name}</h2>
              {a.configured ? <Badge tone="green">Configured</Badge> : <Badge>Not configured</Badge>}
              {a.detectedInProject && <Badge tone="accent" title={a.evidence.join(', ')}>Detected in project</Badge>}
            </header>
            <p className="agent__note">{a.note}</p>
            <dl className="facts facts--compact">
              <div><dt>Files</dt><dd className="mono">{a.files.length ? a.files.join(', ') : '—'}</dd></div>
              {a.configuredAt && <div><dt>Configured</dt><dd>{timeAgo(a.configuredAt)}</dd></div>}
              {a.detectedInProject && <div><dt>Evidence</dt><dd className="mono">{a.evidence.join(', ')}</dd></div>}
              <div><dt>Activity</dt><dd className="muted">Not available (Phase 4)</dd></div>
            </dl>
            {a.checks.length > 0 && (
              <ul className="checks">
                {a.checks.map((c, i) => (
                  <li key={i} className={`check check--${c.level}`}>
                    <span aria-hidden="true">{c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗'}</span> {c.message}
                  </li>
                ))}
              </ul>
            )}
            <footer className="agent__footer">
              {a.configured ? (
                <>
                  <button className="btn btn--sm" disabled={busy} onClick={() => setPending({ agent: a, action: 'configure' })}>Refresh instructions</button>
                  <button className="btn btn--sm btn--danger-ghost" disabled={busy} onClick={() => setPending({ agent: a, action: 'remove' })}>Remove</button>
                </>
              ) : (
                <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => setPending({ agent: a, action: 'configure' })}>Configure</button>
              )}
            </footer>
          </article>
        ))}
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.action === 'remove' ? `Remove ${pending.agent.name} integration?` : `Configure ${pending?.agent.name ?? ''}?`}
        body={
          pending?.action === 'remove' ? (
            <p>Athena will remove its block or file ({pending.agent.files.join(', ') || 'none recorded'}). Your own content in those files is kept.</p>
          ) : (
            <p>Athena will write instruction files for this agent into your project. Existing content in shared files is preserved; Athena only manages its own marked block.</p>
          )
        }
        confirmLabel={pending?.action === 'remove' ? 'Remove' : 'Configure'}
        danger={pending?.action === 'remove'}
        onCancel={() => setPending(null)}
        onConfirm={run}
      />
    </div>
  );
}
