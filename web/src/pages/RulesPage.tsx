import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Link } from '../lib/router';
import { useLive } from '../lib/store';
import type { Rule, RulesView } from '../lib/types';
import { ConfirmDialog, Empty, ErrorNote, Spinner } from '../components/ui';

function RuleRow({ rule, busy, onToggle, onEdit, onDelete }: { rule: Rule; busy: boolean; onToggle: () => void; onEdit: (text: string) => Promise<boolean>; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.text);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(rule.text), [rule.text]);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const commit = async () => {
    const t = text.trim();
    if (!t || t === rule.text) {
      setEditing(false);
      setText(rule.text);
      return;
    }
    if (await onEdit(t)) setEditing(false);
  };

  return (
    <li className={`rule ${rule.enabled ? '' : 'rule--disabled'}`}>
      <button role="switch" aria-checked={rule.enabled} aria-label={rule.enabled ? 'Disable rule' : 'Enable rule'} className={`switch ${rule.enabled ? 'switch--on' : ''}`} onClick={onToggle} disabled={busy}>
        <span className="switch__thumb" />
      </button>
      <span className="rule__index mono">#{rule.index}</span>
      {editing ? (
        <textarea
          ref={input}
          className="rule__input"
          value={text}
          rows={Math.min(4, Math.max(1, Math.ceil(text.length / 90)))}
          maxLength={1000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void commit();
            }
            if (e.key === 'Escape') {
              setEditing(false);
              setText(rule.text);
            }
          }}
          onBlur={() => void commit()}
          aria-label="Edit rule text"
        />
      ) : (
        <button className="rule__text" onClick={() => setEditing(true)} title="Click to edit">
          {rule.text}
          {!rule.enabled && <span className="rule__off">disabled</span>}
        </button>
      )}
      <button className="icon-btn" onClick={onDelete} disabled={busy} aria-label={`Delete rule #${rule.index}`} title="Delete rule">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" /></svg>
      </button>
    </li>
  );
}

export function RulesPage() {
  const { revision, toast, refreshDocs } = useLive();
  const [view, setView] = useState<RulesView | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState('');
  const [newSection, setNewSection] = useState('');
  const [text, setText] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Rule | null>(null);

  const load = async () => {
    try {
      setView(await api<RulesView>('/api/rules'));
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
  };
  useEffect(() => {
    void load();
  }, [revision]);

  const grouped = useMemo(() => {
    const m = new Map<string, Rule[]>();
    for (const s of view?.sections ?? []) m.set(s, []);
    for (const r of view?.rules ?? []) m.set(r.section, [...(m.get(r.section) ?? []), r]);
    return [...m.entries()].filter(([, rules]) => rules.length);
  }, [view]);

  const mutate = async (fn: (hash: string) => Promise<RulesView>, success?: string): Promise<boolean> => {
    if (!view) return false;
    setBusy(true);
    try {
      setView(await fn(view.hash));
      if (success) toast(success, 'success');
      refreshDocs();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast('rules.md changed on disk — reloaded the latest version. Please retry.', 'error');
        await load();
      } else toast(e instanceof Error ? e.message : 'Update failed', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!view) return <div className="page-loading"><Spinner /></div>;

  const targetSection = section === '__new' ? newSection.trim() : section || view.sections[0] || 'General';
  const enabled = view.rules.filter((r) => r.enabled).length;

  const add = async () => {
    if (!text.trim() || !targetSection) return;
    if (await mutate((baseHash) => api<RulesView>('/api/rules', { method: 'POST', body: { section: targetSection, text: text.trim(), baseHash } }), `Rule added to ${targetSection}`)) {
      setText('');
      if (section === '__new') {
        setSection(targetSection);
        setNewSection('');
      }
    }
  };

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <div className="page__kicker mono">.athena/rules.md</div>
          <h1 className="page__title">Project Rules</h1>
          <p className="page__subtitle">Rules every configured AI agent is instructed to follow. This page edits <span className="mono">rules.md</span> directly; the file stays the source of truth.</p>
        </div>
        <div className="page__meta">
          <span>{enabled} enabled · {view.rules.length - enabled} disabled</span>
          <Link to="/docs/rules" className="btn btn--sm">Edit raw Markdown</Link>
        </div>
      </header>

      <form
        className="card add-rule"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div className="add-rule__row">
          <select className="select" value={section || view.sections[0] || ''} onChange={(e) => setSection(e.target.value)} aria-label="Section">
            {view.sections.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
            <option value="__new">+ New section…</option>
          </select>
          {section === '__new' && <input className="input add-rule__section" placeholder="Section name" value={newSection} maxLength={80} onChange={(e) => setNewSection(e.target.value)} aria-label="New section name" />}
          <input className="input add-rule__text" placeholder="Add a rule, e.g. “Every tenant-owned table must include tenant_id.”" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void add();
            }
          }} aria-label="Rule text" />
          <button className="btn btn--primary" type="submit" disabled={busy || !text.trim() || !targetSection}>
            Add rule
          </button>
        </div>
      </form>

      {grouped.length === 0 ? (
        <Empty title="No rules yet">Add your first rule above.</Empty>
      ) : (
        grouped.map(([name, rules]) => (
          <section key={name} className="rule-section">
            <h2 className="rule-section__title">
              {name} <span className="muted">{rules.length}</span>
            </h2>
            <ul className="rules">
              {rules.map((r) => (
                <RuleRow
                  key={`${r.index}:${r.text}`}
                  rule={r}
                  busy={busy}
                  onToggle={() => void mutate((baseHash) => api<RulesView>(`/api/rules/${r.index}`, { method: 'PATCH', body: { enabled: !r.enabled, baseHash } }))}
                  onEdit={(t) => mutate((baseHash) => api<RulesView>(`/api/rules/${r.index}`, { method: 'PATCH', body: { text: t, baseHash } }), 'Rule updated')}
                  onDelete={() => setPendingDelete(r)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
      <p className="fineprint">Disabled rules stay in the file as <span className="mono">- [disabled] …</span> so they can be re-enabled later. Suggestions seeded by Athena start disabled.</p>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete rule?"
        body={<p className="dialog__quote">{pendingDelete?.text}</p>}
        confirmLabel="Delete"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const r = pendingDelete!;
          setPendingDelete(null);
          void mutate((baseHash) => api<RulesView>(`/api/rules/${r.index}?baseHash=${encodeURIComponent(baseHash)}`, { method: 'DELETE' }), 'Rule deleted');
        }}
      />
    </div>
  );
}
