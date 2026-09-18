import { aiStatus, buildEnrichPayload, enrich } from '../../services/ai.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import * as ui from '../ui/term.js';

export interface AiOptions extends GlobalOptions {
  docs?: string;
  consent?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export async function aiStatusCommand(opts: GlobalOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  const status = await aiStatus(root);
  if (ui.isJson()) {
    ui.json(status);
    return;
  }
  ui.heading('AI providers');
  ui.line();
  for (const p of status.providers) {
    const icon = p.availability.ok ? ui.c.green(ui.sym.ok) : ui.c.dim(ui.sym.ring);
    ui.line(`${icon} ${ui.c.bold(p.name)}${p.selected ? ui.c.cyan('  (selected)') : ''}`);
    ui.line(`    ${ui.dim(`${p.remote ? 'sends data to' : 'runs locally at'} ${p.availability.endpoint} · default model ${p.defaultModel}`)}`);
    if (!p.availability.ok) ui.line(`    ${ui.dim(p.availability.reason ?? '')}`);
  }
  ui.line();
  ui.line(`Consent to send project knowledge: ${status.consent ? ui.c.green('granted in config') : ui.c.yellow('not granted')}`);
  ui.line(ui.dim('Athena never needs AI: analysis, sync, context and MCP are deterministic. AI only produces INFERRED suggestions you review.'));
  ui.line(ui.dim('Configure in .athena/config.json → "ai": { "provider": "ollama" } for a fully local setup.'));
}

export async function aiEnrichCommand(opts: AiOptions): Promise<number> {
  const root = await requireProjectRoot(opts);
  const docs = opts.docs?.split(',').map((d) => d.trim()).filter(Boolean);
  const payload = await buildEnrichPayload(root, { docs });

  if (!ui.isJson()) {
    ui.heading('AI enrichment');
    ui.line();
    ui.line(`Provider:  ${ui.c.bold(payload.provider.name)} ${ui.dim(`(${payload.model})`)}`);
    ui.line(`Sends to:  ${payload.remote ? ui.c.yellow(payload.endpoint) : ui.c.green(`${payload.endpoint} (local)`)}`);
    ui.line(`Content:   ${payload.documents.join(', ')} ${ui.dim(`(${payload.chars} characters, redacted knowledge only — no source code)`)}`);
    ui.line();
  }
  if (opts.dryRun) {
    if (ui.isJson()) ui.json({ ...payload, provider: payload.provider.id });
    else ui.line(ui.dim('Dry run — nothing was sent.'));
    return 0;
  }

  const sp = ui.spinner(`Asking ${payload.provider.name}...`);
  let result;
  try {
    result = await enrich(root, { docs, consent: opts.consent, signal: opts.signal });
    sp.succeed(`Suggestions written to .athena/${result.file}`);
  } catch (err) {
    sp.stop();
    throw err;
  }
  if (ui.isJson()) ui.json(result);
  else {
    ui.line();
    ui.line(result.markdown.split('\n').slice(0, 40).join('\n'));
    ui.line();
    ui.line(ui.dim(`Full suggestions: .athena/${result.file} (gitignored). These are INFERRED — nothing was added to your knowledge base.`));
  }
  return 0;
}
