import { useLive } from '../lib/store';
import { timeAgo } from '../lib/router';
import type { AthenaEvent } from '../lib/types';
import { Robot, activityLabel } from './Robot';

const SOURCE_LABEL: Record<AthenaEvent['source'], string> = {
  athena: 'Athena',
  'web-ui': 'Web UI',
  filesystem: 'File system',
  agent: 'AI agent',
};

export function ActivityPanel({ compact = false }: { compact?: boolean }) {
  const { activity } = useLive();
  const idle = activity.state === 'IDLE';
  return (
    <div className={`activity-panel activity-panel--${activity.state.toLowerCase()} ${compact ? 'activity-panel--compact' : ''}`}>
      <Robot state={activity.state} size={compact ? 108 : 140} />
      <div className="activity-panel__body">
        <div className="activity-panel__kicker">{activity.actor === 'agent' ? 'AI agent' : 'Athena'}</div>
        <div className="activity-panel__state">
          <span className="pulse" aria-hidden="true" />
          {idle ? 'Athena is ready' : activityLabel(activity.state)}
        </div>
        {idle ? (
          <>
            <p className="activity-panel__task">Waiting for an AI coding agent…</p>
            <p className="activity-panel__note">Agents configured with hooks report their tool use here as it happens.</p>
          </>
        ) : (
          <>
            {activity.task && <p className="activity-panel__task">{activity.task}</p>}
            {activity.reading.length > 0 && (
              <ul className="activity-panel__reading">
                {activity.reading.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            <p className="activity-panel__note">Since {timeAgo(activity.since)}</p>
          </>
        )}
      </div>
    </div>
  );
}

export function EventList({ events, limit }: { events: AthenaEvent[]; limit?: number }) {
  const shown = [...events].reverse().slice(0, limit);
  if (!shown.length) return <div className="events-empty">No activity yet in this session.</div>;
  return (
    <ol className="timeline">
      {shown.map((e) => (
        <li key={e.id} className={`timeline__item timeline__item--${e.level}`}>
          <time className="timeline__time" dateTime={e.ts} title={new Date(e.ts).toLocaleString()}>
            {new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
          </time>
          <span className="timeline__marker" aria-hidden="true" />
          <span className="timeline__message">{e.message}</span>
          <span className="timeline__source">{SOURCE_LABEL[e.source]}</span>
        </li>
      ))}
    </ol>
  );
}
