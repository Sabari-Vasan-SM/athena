import { useMemo, useState } from 'react';
import { useApi, useLive } from '../lib/store';
import { timeAgo } from '../lib/router';
import type { ActivityResponse, AthenaEvent } from '../lib/types';
import { ActivityPanel, EventList } from '../components/ActivityPanel';
import { Card } from '../components/ui';

const FILTERS: Array<{ id: 'all' | AthenaEvent['source']; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'athena', label: 'Athena' },
  { id: 'web-ui', label: 'Web UI' },
  { id: 'filesystem', label: 'File system' },
  { id: 'agent', label: 'AI agents' },
];

export function ActivityPage() {
  const { events, connected, revision } = useLive();
  const { data } = useApi<ActivityResponse>('/api/activity', [revision, events.length]);
  const observation = data?.agentObservation;
  const sessions = data?.sessions ?? [];
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const shown = useMemo(() => (filter === 'all' ? events : events.filter((e) => e.source === filter)), [events, filter]);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <div className="page__kicker">Timeline</div>
          <h1 className="page__title">Activity</h1>
          <p className="page__subtitle">Only events Athena directly observed in this session. Nothing here is simulated.</p>
        </div>
        <div className="page__meta">
          <span className={`conn ${connected ? 'conn--on' : 'conn--off'}`}>{connected ? 'Live' : 'Reconnecting'}</span>
        </div>
      </header>

      <div className="activity-layout">
        <Card>
          <ActivityPanel />
        </Card>
        <Card title="What Athena can observe">
          <ul className="observe">
            <li className="observe--yes">Analyses and knowledge updates (started here or by the CLI)</li>
            <li className="observe--yes">Changes to <span className="mono">.athena/*.md</span> made elsewhere</li>
            <li className={observation?.available ? 'observe--yes' : 'observe--no'}>
              AI agent tool use via hooks{observation?.available ? `: ${observation.agents.join(', ')}` : ' — no agent is reporting yet'}
            </li>
            <li className="observe--no">Agent reasoning or plans — hooks report which tool ran, never why</li>
          </ul>
          {observation && <p className="fineprint">{observation.reason}</p>}
          {sessions.length > 0 && (
            <>
              <div className="label" style={{ marginTop: 14 }}>Agent sessions seen</div>
              <ul className="agentlist">
                {sessions.slice(0, 4).map((s) => (
                  <li key={`${s.agent}:${s.session ?? '-'}`}>
                    <span className="dot dot--green" />
                    <span>{s.agent} <span className="muted mono">{s.session?.slice(0, 8) ?? ''}</span></span>
                    <span className="muted">{s.events} events · {timeAgo(s.lastEventAt)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      <Card
        title="Events"
        actions={
          <div className="segmented" role="tablist">
            {FILTERS.map((f) => (
              <button key={f.id} role="tab" aria-selected={filter === f.id} className={`segmented__btn ${filter === f.id ? 'segmented__btn--active' : ''}`} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        }
      >
        {filter === 'agent' && !shown.length ? (
          <div className="events-empty">No agent events recorded yet. Configure Claude Code, Cursor or Codex on the AI Agents page, then start a session.</div>
        ) : (
          <EventList events={shown} />
        )}
      </Card>
    </div>
  );
}
