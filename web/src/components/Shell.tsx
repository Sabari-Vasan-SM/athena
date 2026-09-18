import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { Link, navigate, usePath } from '../lib/router';
import { useApi, useLive } from '../lib/store';
import type { DocId, SearchHit, StatusReport, SyncStatus } from '../lib/types';
import { SyncDot } from './ui';

const NAV_DOCS: Array<{ id: DocId; label: string }> = [
  { id: 'architecture', label: 'Architecture' },
  { id: 'database', label: 'Database' },
  { id: 'api', label: 'API' },
  { id: 'auth', label: 'Auth' },
  { id: 'security', label: 'Security' },
  { id: 'testing', label: 'Testing' },
  { id: 'debugging', label: 'Debugging' },
  { id: 'performance', label: 'Performance' },
  { id: 'code-review', label: 'Code Review' },
  { id: 'deployment', label: 'Deployment' },
];

function NavItem({ to, label, icon, trailing }: { to: string; label: string; icon: ReactNode; trailing?: ReactNode }) {
  const path = usePath();
  const active = path === to || (to !== '/' && path.startsWith(`${to}/`));
  return (
    <Link to={to} className={`nav__item ${active ? 'nav__item--active' : ''}`}>
      <span className="nav__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="nav__label">{label}</span>
      {trailing}
    </Link>
  );
}

const Icon = {
  overview: <svg viewBox="0 0 16 16"><path d="M2 2h5v5H2zM9 2h5v3H9zM9 7h5v7H9zM2 9h5v5H2z" /></svg>,
  doc: <svg viewBox="0 0 16 16"><path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3" /></svg>,
  project: <svg viewBox="0 0 16 16"><path d="M2 4.5h4l1.5 1.5H14v7.5H2z" /></svg>,
  rules: <svg viewBox="0 0 16 16"><path d="M3 3.5h10M3 8h10M3 12.5h6" /></svg>,
  agents: <svg viewBox="0 0 16 16"><rect x="3" y="4.5" width="10" height="8" rx="2.5" /><path d="M8 4.5V2M6 8.5h.01M10 8.5h.01" /></svg>,
  activity: <svg viewBox="0 0 16 16"><path d="M1.5 8.5h3l2-5 3 9 2-4h3" /></svg>,
  shield: <svg viewBox="0 0 16 16"><path d="M8 1.5 13 3.5v4c0 3.2-2.1 6.1-5 7-2.9-.9-5-3.8-5-7v-4z" /></svg>,
  sync: <svg viewBox="0 0 16 16"><path d="M13 6.5A5 5 0 0 0 4 4.5L2.5 6M3 9.5a5 5 0 0 0 9 2l1.5-1.5M2.5 2.5V6H6M13.5 13.5V10H10" /></svg>,
};

export function Sidebar() {
  const { docs, revision } = useLive();
  const { data: sync } = useApi<SyncStatus>('/api/sync', [revision]);
  const pending = sync?.plan && !sync.plan.ignored ? sync.plan.documents.length : 0;
  const syncOf = (id: DocId) => docs.find((d) => d.id === id)?.sync;
  const dot = (id: DocId) => {
    const s = syncOf(id);
    return s ? <SyncDot state={s} /> : null;
  };
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="nav__group">
        <NavItem to="/" label="Overview" icon={Icon.overview} />
        <NavItem to="/sync" label="Sync" icon={Icon.sync} trailing={pending ? <span className="count" title={`${pending} document update${pending === 1 ? '' : 's'} proposed`}>{pending}</span> : undefined} />
        <NavItem to="/docs/project" label="Project" icon={Icon.project} trailing={dot('project')} />
      </div>
      <div className="nav__heading">Knowledge</div>
      <div className="nav__group">
        {NAV_DOCS.map((d) => (
          <NavItem key={d.id} to={`/docs/${d.id}`} label={d.label} icon={Icon.doc} trailing={dot(d.id)} />
        ))}
        <NavItem to="/rules" label="Rules" icon={Icon.rules} trailing={dot('rules')} />
      </div>
      <div className="nav__heading">Tools</div>
      <div className="nav__group">
        <NavItem to="/security" label="Security scan" icon={Icon.shield} />
        <NavItem to="/agents" label="AI Agents" icon={Icon.agents} />
        <NavItem to="/activity" label="Activity" icon={Icon.activity} />
      </div>
      <div className="sidebar__legend">
        <span><SyncDot state="synchronized" /> in sync</span>
        <span><SyncDot state="may-be-outdated" /> may be outdated</span>
      </div>
    </nav>
  );
}

function Search() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      api<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`, { signal: ac.signal })
        .then((h) => {
          setHits(h);
          setActive(0);
        })
        .catch(() => {});
    }, 120);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q]);

  const go = (h: SearchHit) => {
    setOpen(false);
    setQ('');
    navigate(h.id === 'rules' ? '/rules' : `/docs/${h.id}`);
  };

  return (
    <div className="search" role="search">
      <svg className="search__icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></svg>
      <input
        ref={input}
        className="search__input"
        placeholder="Search knowledge"
        aria-label="Search knowledge"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, hits.length - 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          else if (e.key === 'Enter' && hits[active]) go(hits[active]!);
          else if (e.key === 'Escape') input.current?.blur();
        }}
      />
      <kbd className="search__kbd">⌘K</kbd>
      {open && q.trim().length >= 2 && (
        <div className="search__results" role="listbox">
          {hits.length === 0 ? (
            <div className="search__empty">No matches</div>
          ) : (
            hits.map((h, i) => (
              <button key={`${h.id}:${h.line}:${i}`} className={`search__hit ${i === active ? 'search__hit--active' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => go(h)} role="option" aria-selected={i === active}>
                <span className="search__file">{h.file}<span className="search__line">:{h.line}</span></span>
                <span className="search__text">{h.text}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function TopBar({ projectName }: { projectName: string | null }) {
  const { connected, revision } = useLive();
  const { data: status } = useApi<StatusReport>('/api/status', [revision]);
  const health = status?.health;
  const label = health === 'healthy' ? 'Knowledge in sync' : health === 'needs-update' ? 'Knowledge needs update' : health === 'degraded' ? 'Knowledge files missing' : 'Checking…';
  const tone = health === 'healthy' ? 'green' : health === 'needs-update' ? 'yellow' : health === 'degraded' ? 'red' : 'neutral';
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <svg className="brand__mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" /><path d="M16 6 25 26h-4.2l-1.9-4.4h-5.8L11.2 26H7L16 6Zm0 8.6-1.9 4.3h3.8L16 14.6Z" /></svg>
        <span className="brand__name">Athena</span>
        {projectName && <span className="brand__project">/ {projectName}</span>}
      </Link>
      <Search />
      <div className="topbar__right">
        <span className={`health health--${tone}`} title={status ? `Last analysis ${new Date(status.analyzedAt).toLocaleString()}` : undefined}>
          <span className={`dot dot--${tone}`} /> {label}
        </span>
        <span className={`conn ${connected ? 'conn--on' : 'conn--off'}`} title={connected ? 'Live updates connected' : 'Live updates disconnected — reconnecting'}>
          {connected ? 'Live' : 'Offline'}
        </span>
      </div>
    </header>
  );
}

export function Toasts() {
  const { toasts } = useLive();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.level}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
