import { useEffect, useState } from 'react';
import { api, ApiError, captureToken, getToken } from './lib/api';
import { usePath } from './lib/router';
import { LiveProvider } from './lib/store';
import type { DocId } from './lib/types';
import { Sidebar, Toasts, TopBar } from './components/Shell';
import { Spinner } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Overview } from './pages/Overview';
import { DocPage } from './pages/DocPage';
import { RulesPage } from './pages/RulesPage';
import { AgentsPage } from './pages/AgentsPage';
import { ActivityPage } from './pages/ActivityPage';
import { SyncPage } from './pages/SyncPage';
import { SecurityPage } from './pages/SecurityPage';

const DOC_IDS = new Set<DocId>(['project', 'architecture', 'database', 'api', 'auth', 'security', 'testing', 'debugging', 'performance', 'code-review', 'deployment', 'rules']);

function Routes() {
  const path = usePath();
  return (
    <ErrorBoundary resetKey={path}>
      <Page path={path} />
    </ErrorBoundary>
  );
}

function Page({ path }: { path: string }) {
  const docMatch = /^\/docs\/([a-z-]+)\/?$/.exec(path);
  if (path === '/') return <Overview />;
  if (docMatch && DOC_IDS.has(docMatch[1] as DocId)) return <DocPage key={docMatch[1]} id={docMatch[1] as DocId} />;
  if (path === '/rules') return <RulesPage />;
  if (path === '/sync') return <SyncPage />;
  if (path === '/security') return <SecurityPage />;
  if (path === '/agents') return <AgentsPage />;
  if (path === '/activity') return <ActivityPage />;
  return (
    <div className="page">
      <h1 className="page__title">Not found</h1>
      <p className="muted">There is no page at {path}.</p>
    </div>
  );
}

type Session = { state: 'loading' } | { state: 'unauthorized' } | { state: 'error'; message: string } | { state: 'ready'; project: string };

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });

  // Opening a new `athena open` link in an existing tab only changes the fragment.
  useEffect(() => {
    const onHash = () => {
      const before = getToken();
      if (/[#&]token=/.test(window.location.hash) && captureToken() !== before) window.location.reload();
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const token = captureToken();
    if (!token) {
      setSession({ state: 'unauthorized' });
      return;
    }
    api<{ root: string }>('/api/session')
      .then(() => api<{ project: { name: string } }>('/api/overview'))
      .then((o) => setSession({ state: 'ready', project: o.project.name }))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setSession({ state: 'unauthorized' });
        else setSession({ state: 'error', message: e instanceof Error ? e.message : 'Could not reach the Athena server' });
      });
  }, []);

  if (session.state === 'loading') {
    return (
      <div className="gate">
        <Spinner />
      </div>
    );
  }
  if (session.state !== 'ready') {
    return (
      <div className="gate">
        <div className="gate__card">
          <div className="gate__mark">ATHENA</div>
          <h1>{session.state === 'unauthorized' ? 'Open Athena from your terminal' : 'Athena is unavailable'}</h1>
          {session.state === 'unauthorized' ? (
            <p>
              This local server only accepts requests with the private access link printed by <code>athena open</code>. Run it in your project and use the link it shows.
            </p>
          ) : (
            <p>{session.message}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <LiveProvider>
      <div className="app">
        <TopBar projectName={session.project} />
        <div className="app__body">
          <Sidebar />
          <main className="app__main" id="main">
            <Routes />
          </main>
        </div>
        <Toasts />
      </div>
    </LiveProvider>
  );
}
