/** Typed client for the Athena local API. The access token never leaves this tab. */

const TOKEN_KEY = 'athena.token';

export function captureToken(): string | null {
  const m = /[#&]token=([A-Za-z0-9_-]{20,})/.exec(window.location.hash);
  if (m) {
    try {
      sessionStorage.setItem(TOKEN_KEY, m[1]!);
    } catch {
      /* storage blocked: keep in memory only */
    }
    memoryToken = m[1]!;
    // Remove the token from the address bar and history.
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return getToken();
}

let memoryToken: string | null = null;
export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    memoryToken = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    memoryToken = null;
  }
  return memoryToken;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken() ?? ''}` };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: init.signal, cache: 'no-store' });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; hint?: string; details?: Record<string, unknown> };
    throw new ApiError(res.status, d.error ?? `Request failed (${res.status})`, d.hint, d.details);
  }
  return data as T;
}

/** Server-sent events over fetch (EventSource cannot send the Authorization header). */
export function streamEvents(onMessage: (event: string, data: unknown) => void, onState: (connected: boolean) => void): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let retry = 1000;

  const connect = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${getToken() ?? ''}` }, signal: controller.signal, cache: 'no-store' });
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        onState(true);
        retry = 1000;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = 'message';
            let data = '';
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data) {
              try {
                onMessage(event, JSON.parse(data));
              } catch {
                /* ignore malformed */
              }
            }
          }
        }
      } catch {
        /* fall through to reconnect */
      }
      if (stopped) return;
      onState(false);
      await new Promise((r) => setTimeout(r, retry));
      retry = Math.min(retry * 2, 15000);
    }
  };
  void connect();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
