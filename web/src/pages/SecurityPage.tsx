import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Link, timeAgo } from '../lib/router';
import { useApi, useLive } from '../lib/store';
import type { SecurityState, Severity } from '../lib/types';
import { Badge, Card, Empty, ErrorNote, Spinner } from '../components/ui';

const SEVERITY_TONE: Record<Severity, 'red' | 'yellow' | 'blue' | 'neutral'> = {
  critical: 'red',
  high: 'red',
  moderate: 'yellow',
  low: 'blue',
  unknown: 'neutral',
};
const ORDER: Severity[] = ['critical', 'high', 'moderate', 'low', 'unknown'];

export function SecurityPage() {
  const { revision, toast, activity } = useLive();
  const { data, error, reload } = useApi<SecurityState>('/api/security', [revision]);
  const [busy, setBusy] = useState(false);

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page-loading"><Spinner /></div>;
  const scan = data.scan;
  const scanning = data.running || busy || (activity.state === 'REVIEWING' && activity.actor === 'athena');

  const runScan = async () => {
    setBusy(true);
    try {
      await api('/api/security/scan', { method: 'POST', body: {} });
      toast('Security scan started', 'success');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not start the scan', 'error');
    } finally {
      setBusy(false);
      setTimeout(reload, 1000);
    }
  };

  const findings = scan?.tools.flatMap((t) => t.findings.map((f) => ({ ...f, tool: t.tool }))) ?? [];
  const bySeverity = ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <div className="page__kicker">Dependencies & secrets</div>
          <h1 className="page__title">Security</h1>
          <p className="page__subtitle">
            Athena runs the audit tools installed for this project and reports what they find. It has no vulnerability database of its own, and a clean audit is not proof that the project is secure.
          </p>
        </div>
        <div className="page__meta">
          {scan && <span>Scanned {timeAgo(scan.scannedAt)}</span>}
          <button className="btn btn--primary btn--sm" onClick={runScan} disabled={scanning}>
            {scanning ? <><Spinner label="Scanning" /> Scanning…</> : scan ? 'Re-scan' : 'Run scan'}
          </button>
        </div>
      </header>

      {!scan ? (
        <Card>
          <Empty title="No scan yet">Run a scan to audit dependencies with the tools available on this machine (npm audit, pip-audit, govulncheck, cargo audit, composer audit).</Empty>
        </Card>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <div className="stat__label">Dependency findings</div>
              <div className={`stat__value ${findings.length ? 'stat__value--warn' : ''}`}>{findings.length}</div>
              <div className="stat__sub">{bySeverity.map(([s, n]) => `${n} ${s}`).join(' · ') || 'none reported'}</div>
            </div>
            <div className="stat">
              <div className="stat__label">Potential secrets</div>
              <div className={`stat__value ${scan.secrets.count ? 'stat__value--warn' : ''}`}>{scan.secrets.count}</div>
              <div className="stat__sub">{scan.secrets.count ? 'values never stored' : 'none matched'}</div>
            </div>
            <div className="stat">
              <div className="stat__label">Tools run</div>
              <div className="stat__value">{scan.tools.filter((t) => t.status === 'ok').length}/{scan.tools.length}</div>
              <div className="stat__sub">{(scan.durationMs / 1000).toFixed(1)}s</div>
            </div>
          </div>

          <Card title="Audit tools">
            <ul className="checks">
              {scan.tools.length === 0 && <li className="muted">No auditable ecosystems detected (no lockfiles or supported manifests).</li>}
              {scan.tools.map((t) => (
                <li key={t.tool} className={`check check--${t.status === 'ok' ? (t.findings.length ? 'warn' : 'ok') : 'warn'}`}>
                  <span aria-hidden="true">{t.status === 'ok' ? (t.findings.length ? '!' : '✓') : '○'}</span> <strong>{t.tool}</strong>{' '}
                  {t.status === 'ok' ? `${t.findings.length} finding(s) in ${(t.durationMs / 1000).toFixed(1)}s` : `${t.status} — ${t.message ?? ''}`}
                </li>
              ))}
            </ul>
            <p className="fineprint">An ecosystem without its tool installed is reported as unknown, never as "no problems".</p>
          </Card>

          {findings.length > 0 && (
            <Card title="Vulnerable dependencies" className="card--flush">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Severity</th><th>Package</th><th>Advisory</th><th>ID</th><th>Tool</th><th>Fix</th></tr>
                  </thead>
                  <tbody>
                    {findings.slice(0, 200).map((f, i) => (
                      <tr key={`${f.package}:${f.id ?? i}`}>
                        <td><Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge></td>
                        <td className="mono">{f.package}</td>
                        <td>{f.url ? <a href={f.url} target="_blank" rel="noopener noreferrer">{f.title}</a> : f.title}</td>
                        <td className="mono">{f.id ?? '—'}</td>
                        <td className="muted">{f.tool}</td>
                        <td>{f.fixAvailable ? 'available' : 'unknown'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card title="Potential secrets">
            {scan.secrets.count ? (
              <>
                <p>{scan.secrets.count} potential hardcoded secret(s) across {scan.secrets.files.length} file(s). Athena stores the type and location only — never the value.</p>
                <ul className="filechanges">
                  {scan.secrets.files.slice(0, 15).map((f) => (
                    <li key={f}><span className="filechanges__kind filechanges__kind--M">!</span><span className="mono">{f}</span></li>
                  ))}
                </ul>
                <p className="fineprint">Types and line numbers are listed in <Link to="/docs/security">security.md</Link>. Rotate anything real.</p>
              </>
            ) : (
              <p className="muted">No likely secrets matched Athena's patterns. Gitignored and oversized files are not scanned, so this is not proof that none exist.</p>
            )}
          </Card>

          <p className="fineprint">Scan results are stored in <span className="mono">.athena/security-scan.json</span> (gitignored). Run <span className="mono">athena sync</span> to record them in <Link to="/docs/security">security.md</Link>.</p>
        </>
      )}
    </div>
  );
}
