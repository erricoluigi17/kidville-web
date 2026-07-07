import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { SHOTS_DIR, FINDINGS_DIR, idsPath } from '../config/accounts';

export type Gravita = 'bloccante' | 'grave' | 'medio' | 'minore' | 'estetico' | 'ok';

export interface Finding {
  id: string;
  journey: string;
  ruolo: string;
  flusso: string;
  pagina: string;
  step: string;
  gravita: Gravita;
  categoria: string; // funzionale | estetico | riscontro | errore-console | http | gap-noto | ok
  atteso: string;
  osservato: string;
  screenshot?: string;
  screenshotBefore?: string;
  evidenza?: { netErrors?: { url: string; status: number }[]; consoleErrors?: string[] };
}

export function ensureDirs() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fs.mkdirSync(FINDINGS_DIR, { recursive: true });
}

export function readAppIds(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(idsPath, 'utf8')); } catch { return {}; }
}

// Stato condiviso tra journey (es. id avviso gita, thread chat).
import { RUN_DIR } from '../config/accounts';
const statePath = path.join(RUN_DIR, 'state.json');
export function readState(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; }
}
export function writeState(patch: Record<string, unknown>) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const cur = readState();
  fs.writeFileSync(statePath, JSON.stringify({ ...cur, ...patch }, null, 2));
}

export function withUser(url: string, appId?: string): string {
  if (!appId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}userId=${appId}`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

// Cattura errori console + risposte HTTP fallite (>=400) su una pagina.
export interface ErrorSink { consoleErrors: string[]; netErrors: { url: string; status: number }[] }
export function wireErrors(page: Page): ErrorSink {
  const sink: ErrorSink = { consoleErrors: [], netErrors: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text();
      // Rumore noto irrilevante (favicon, RSC prefetch dev) → ignora
      if (/favicon|Download the React DevTools|hydrat/i.test(t)) return;
      sink.consoleErrors.push(t.slice(0, 300));
    }
  });
  page.on('pageerror', (e) => sink.consoleErrors.push(`PAGEERROR: ${String(e).slice(0, 300)}`));
  page.on('response', (r) => {
    const s = r.status();
    const u = r.url();
    if (s >= 400 && u.includes('/api/')) sink.netErrors.push({ url: u.replace(/^https?:\/\/[^/]+/, ''), status: s });
  });
  return sink;
}

export class Recorder {
  journey: string;
  ruolo: string;
  findings: Finding[] = [];
  private seq = 0;

  constructor(journey: string, ruolo: string) {
    this.journey = journey;
    this.ruolo = ruolo;
    ensureDirs();
  }

  private nextName(label: string): string {
    this.seq += 1;
    return `${this.journey}-${String(this.seq).padStart(2, '0')}-${slug(label)}`;
  }

  // Screenshot full-page; ritorna il filename relativo (per il report).
  async shoot(page: Page, label: string): Promise<string> {
    const name = `${this.nextName(label)}.png`;
    try {
      await page.screenshot({ path: path.join(SHOTS_DIR, name), fullPage: true, animations: 'disabled' });
    } catch {
      try { await page.screenshot({ path: path.join(SHOTS_DIR, name), animations: 'disabled' }); } catch { /* ignore */ }
    }
    return name;
  }

  add(f: Omit<Finding, 'id' | 'journey' | 'ruolo'>): Finding {
    const full: Finding = { id: `F-${this.journey}-${this.findings.length + 1}`, journey: this.journey, ruolo: this.ruolo, ...f };
    this.findings.push(full);
    return full;
  }

  save() {
    fs.writeFileSync(path.join(FINDINGS_DIR, `${this.journey}.json`), JSON.stringify(this.findings, null, 2));
  }
}

// Naviga a una pagina, attende stabilità, screenshotta, registra errori console/HTTP.
export async function visit(
  page: Page,
  rec: Recorder,
  opts: { url: string; flusso: string; label: string; expectText?: string | RegExp; appId?: string },
): Promise<Finding> {
  const sink = wireErrors(page);
  let httpStatus = 0;
  try {
    const resp = await page.goto(withUser(opts.url, opts.appId), { waitUntil: 'domcontentloaded', timeout: 30000 });
    httpStatus = resp?.status() ?? 0;
  } catch { /* screenshot comunque */ }
  await page.waitForTimeout(1400); // lascia partire i fetch client
  const shot = await rec.shoot(page, opts.label);

  let gravita: Gravita = 'ok';
  let categoria = 'ok';
  let osservato = 'Pagina caricata';
  const netErrors = sink.netErrors.slice(0, 8);
  const consoleErrors = sink.consoleErrors.slice(0, 6);

  if (httpStatus >= 400) { gravita = 'grave'; categoria = 'http'; osservato = `HTTP ${httpStatus} sulla navigazione`; }
  else if (netErrors.length) { gravita = 'medio'; categoria = 'http'; osservato = `${netErrors.length} chiamate API in errore: ${netErrors.map(e => e.status + ' ' + e.url).join('; ')}`; }
  else if (consoleErrors.length) { gravita = 'minore'; categoria = 'errore-console'; osservato = `Errori console: ${consoleErrors.join(' | ')}`; }

  if (opts.expectText && gravita === 'ok') {
    const body = (await page.textContent('body').catch(() => '')) ?? '';
    const ok = typeof opts.expectText === 'string' ? body.includes(opts.expectText) : opts.expectText.test(body);
    if (!ok) { gravita = 'medio'; categoria = 'funzionale'; osservato = `Testo atteso non trovato: ${opts.expectText}`; }
  }

  return rec.add({
    flusso: opts.flusso, pagina: opts.url, step: `Apertura ${opts.label}`,
    gravita, categoria,
    atteso: opts.expectText ? `Pagina con "${opts.expectText}", nessun errore` : 'Pagina caricata senza errori',
    osservato, screenshot: shot,
    evidenza: { netErrors, consoleErrors },
  });
}

// Screenshot before → azione → screenshot after. Registra evidenze e verdetto.
export async function step(
  page: Page,
  rec: Recorder,
  opts: { flusso: string; pagina: string; label: string; action: () => Promise<void>; expect?: () => Promise<boolean>; atteso: string },
): Promise<Finding> {
  const sink = wireErrors(page);
  const before = await rec.shoot(page, `${opts.label}-before`);
  let ok = true;
  let err = '';
  try {
    await opts.action();
    await page.waitForTimeout(1200);
  } catch (e) {
    ok = false; err = String(e).slice(0, 200);
  }
  const after = await rec.shoot(page, `${opts.label}-after`);

  let confirmed: boolean | null = null;
  if (ok && opts.expect) { try { confirmed = await opts.expect(); } catch { confirmed = false; } }

  const netErrors = sink.netErrors.slice(0, 8);
  const consoleErrors = sink.consoleErrors.slice(0, 6);
  let gravita: Gravita = 'ok';
  let categoria = 'ok';
  let osservato = 'Azione eseguita';

  if (!ok) { gravita = 'grave'; categoria = 'funzionale'; osservato = `Azione fallita: ${err}`; }
  else if (confirmed === false) { gravita = 'grave'; categoria = 'funzionale'; osservato = 'Esito atteso non verificato dopo l\'azione'; }
  else if (netErrors.some(e => e.status >= 500)) { gravita = 'grave'; categoria = 'http'; osservato = `Errore server: ${netErrors.map(e => e.status + ' ' + e.url).join('; ')}`; }
  else if (netErrors.length) { gravita = 'medio'; categoria = 'http'; osservato = `API in errore: ${netErrors.map(e => e.status + ' ' + e.url).join('; ')}`; }
  else if (confirmed === true) { osservato = 'Azione eseguita e riscontro confermato'; }

  return rec.add({
    flusso: opts.flusso, pagina: opts.pagina, step: opts.label,
    gravita, categoria, atteso: opts.atteso, osservato,
    screenshot: after, screenshotBefore: before,
    evidenza: { netErrors, consoleErrors },
  });
}

// Chiamata API autenticata dentro il contesto pagina (usa i cookie di sessione).
// Resilienti: non lanciano mai (un fallimento → status 0), così una singola
// azione fallita non aborta l'intera journey.
async function apiCall(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  // page.request = APIRequestContext del context (stessi cookie di sessione +
  // baseURL della config): funziona anche se la pagina è su about:blank.
  try {
    const req = page.request;
    const opts = body !== undefined ? { data: body } : {};
    const r = method === 'POST' ? await req.post(url, opts)
      : method === 'PATCH' ? await req.patch(url, opts)
      : await req.get(url);
    let json: unknown = null; try { json = await r.json(); } catch { /* noop */ }
    return { status: r.status(), json };
  } catch (e) {
    return { status: 0, json: { error: String(e).slice(0, 200) } };
  }
}

// Successo HTTP reale (esclude lo 0 = errore di rete).
export const httpOk = (s: number) => s >= 200 && s < 400;

export const apiPost = (page: Page, url: string, body: unknown) => apiCall(page, 'POST', url, body);
export const apiPatch = (page: Page, url: string, body: unknown) => apiCall(page, 'PATCH', url, body);
export const apiGet = (page: Page, url: string) => apiCall(page, 'GET', url);
