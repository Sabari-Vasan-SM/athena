import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, streamEvents } from './api';
import type { Activity, AthenaEvent, DocMeta } from './types';

interface LiveState {
  connected: boolean;
  activity: Activity;
  events: AthenaEvent[];
  /** Increments whenever knowledge on disk may have changed; pages refetch on change. */
  revision: number;
  docs: DocMeta[];
  refreshDocs(): void;
  bump(): void;
  toast(message: string, level?: 'info' | 'success' | 'error'): void;
  toasts: Array<{ id: number; message: string; level: 'info' | 'success' | 'error' }>;
}

const Ctx = createContext<LiveState | null>(null);

const IDLE: Activity = { state: 'IDLE', actor: 'none', task: null, reading: [], since: new Date().toISOString() };

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [activity, setActivity] = useState<Activity>(IDLE);
  const [events, setEvents] = useState<AthenaEvent[]>([]);
  const [revision, setRevision] = useState(0);
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [toasts, setToasts] = useState<LiveState['toasts']>([]);
  const toastId = useRef(0);

  const bump = useCallback(() => setRevision((r) => r + 1), []);
  const refreshDocs = useCallback(() => {
    api<DocMeta[]>('/api/docs').then(setDocs).catch(() => {});
  }, []);
  const toast = useCallback((message: string, level: 'info' | 'success' | 'error' = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, level }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  useEffect(() => {
    api<{ activity: Activity; events: AthenaEvent[] }>('/api/activity')
      .then((r) => {
        setActivity(r.activity);
        setEvents(r.events);
      })
      .catch(() => {});
    refreshDocs();
    return streamEvents(
      (type, data) => {
        if (type === 'activity') setActivity(data as Activity);
        if (type === 'event') {
          const e = data as AthenaEvent;
          setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e].slice(-500)));
          if (/^(knowledge|analysis\.completed|rules|agents|sync|git)/.test(e.type)) {
            setRevision((r) => r + 1);
            refreshDocs();
          }
        }
      },
      setConnected,
    );
  }, [refreshDocs]);

  const value = useMemo(() => ({ connected, activity, events, revision, docs, refreshDocs, bump, toast, toasts }), [connected, activity, events, revision, docs, refreshDocs, bump, toast, toasts]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): LiveState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLive outside LiveProvider');
  return v;
}

/** Fetch JSON and refetch when `deps` change. */
export function useApi<T>(path: string | null, deps: unknown[] = []): { data: T | null; error: Error | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!path) return;
    const ac = new AbortController();
    setLoading(true);
    api<T>(path, { signal: ac.signal })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e);
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);
  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}
