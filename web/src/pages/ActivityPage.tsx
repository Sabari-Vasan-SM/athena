import { useMemo, useState } from 'react';
import { useLive } from '../lib/store';
import type { AthenaEvent } from '../lib/types';
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
  const { events, connected } = useLive();
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
            <li className="observe--yes">Analyses started from the web UI, with results</li>
            <li className="observe--yes">Knowledge and rules edits made in this UI</li>
            <li className="observe--yes">Changes to <span className="mono">.athena/*.md</span> made elsewhere (CLI, editors, agents)</li>
            <li className="observe--no">AI agent reasoning, plans, file reads or test runs — <em>not available until agent hook integrations (Phase 4)</em></li>
          </ul>
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
        {filter === 'agent' && !shown.length ? <div className="events-empty">No AI agent events. Agent activity observation is not available yet.</div> : <EventList events={shown} />}
      </Card>
    </div>
  );
}
