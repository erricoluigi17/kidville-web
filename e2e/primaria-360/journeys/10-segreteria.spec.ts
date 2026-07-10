import { test, expect } from '@playwright/test';
import { storagePath, SEGRETERIA, SCUOLA_GIUGLIANO, TAG } from '../config/accounts';
import { SECTION, ALUNNI, MATERIE } from '../config/data';
import { Recorder, visit, step, apiPost, apiPatch, apiGet, readAppIds, writeState } from '../lib/harness';

test.use({ storageState: storagePath('segreteria') });
test.describe.configure({ mode: 'serial' });

const ids = readAppIds();
const SEG = ids['segreteria'];

test('10 · Segreteria — anagrafiche, orario, pagamenti, ticket, config, logout', async ({ page }) => {
  const rec = new Recorder('10-segreteria', 'segreteria');
  test.setTimeout(180_000);

  // ── Sweep pagine cockpit ────────────────────────────────────────────────
  await visit(page, rec, { url: '/admin', flusso: 'dashboard', label: 'Dashboard cockpit', appId: SEG });
  await visit(page, rec, { url: '/admin/students', flusso: 'anagrafica', label: 'Anagrafica lista', appId: SEG, expectText: /Anagrafica/i });

  // ── FEATURE 1B: apertura anagrafica a TUTTA AREA (non drawer) ───────────
  await step(page, rec, {
    flusso: 'anagrafica', pagina: '/admin/students', label: 'Apri scheda alunno a tutta area (click riga)',
    atteso: 'Naviga a /admin/students/[id] a piena pagina (no drawer laterale), con la famiglia collegata',
    action: async () => {
      await page.locator('input[placeholder*="Cerca"]').first().fill('Alunno');
      await page.waitForTimeout(1500);
      // clic sulla RIGA (tr) dell'alunno — robusto rispetto al testo ambiguo
      const row = page.locator('tbody tr').filter({ hasText: 'Test PRI' }).first();
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await page.waitForURL(/\/admin\/students\/[0-9a-f-]{36}/, { timeout: 15000 });
      await page.waitForTimeout(1500);
    },
    expect: async () => /\/admin\/students\/[0-9a-f-]{36}/.test(page.url()) &&
      (await page.getByText(/Scheda Alunno/i).count()) > 0,
  });
  // verifica famiglia collegata visibile nella scheda
  await step(page, rec, {
    flusso: 'anagrafica', pagina: page.url(), label: 'Verifica famiglia collegata nella scheda',
    atteso: 'La sezione "Famiglia e Delegati" mostra il genitore associato (student_parents)',
    action: async () => { await page.getByText(/Famiglia e Delegati/i).scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(500); },
    expect: async () => (await page.getByText(/Famiglia e Delegati/i).count()) > 0,
  });

  // ── Config: abilita docenti a pubblicare avvisi + chat sempre in orario ──
  const cfg = await apiPatch(page, '/api/admin/settings', {
    scuola_id: SCUOLA_GIUGLIANO,
    avvisi_config: { ruoli_pubblicazione: ['admin', 'teacher'] },
    chat_config: { orario_docenti_da: '00:00', orario_docenti_a: '23:59' },
  });
  rec.add({
    flusso: 'impostazioni', pagina: '/api/admin/settings', step: 'Abilita docenti a pubblicare avvisi + chat 24h',
    gravita: cfg.status < 400 ? 'ok' : 'medio', categoria: cfg.status < 400 ? 'ok' : 'funzionale',
    atteso: 'PATCH impostazioni 200 (avvisi_config, chat_config)', osservato: `HTTP ${cfg.status}`,
  });
  rec.add({
    flusso: 'impostazioni', pagina: '/api/avvisi', step: 'Nota: pubblicazione avvisi docente governata da config',
    gravita: 'minore', categoria: 'gap-noto',
    atteso: 'Un docente deve poter inviare un avviso di classe (requisito gita)',
    osservato: "OK per questa scuola (avvisi_config.ruoli_pubblicazione già ['admin','teacher']). Se la config non è impostata, il default server è ['admin'] e i docenti riceverebbero 403.",
  });

  // ── Orario settimanale (set-tempo → campanelle → alcune celle) ──────────
  const setTempo = await apiPost(page, '/api/admin/primaria/orario?action=set-tempo', { sectionId: SECTION, modello: 27 });
  rec.add({
    flusso: 'orario', pagina: '/api/admin/primaria/orario', step: 'Genera modello orario 27h + campanelle',
    gravita: setTempo.status < 400 ? 'ok' : 'grave', categoria: setTempo.status < 400 ? 'ok' : 'funzionale',
    atteso: 'set-tempo 200 e campanelle generate', osservato: `HTTP ${setTempo.status}`,
  });
  // recupera campanelle e riempie qualche cella (Lun-Mar, prime ore)
  const orarioGet = await apiGet(page, `/api/admin/primaria/orario?sectionId=${SECTION}`);
  try {
    const data = (orarioGet.json as { data?: { campanelle?: Array<{ id: string; giorno_settimana: number; ordine: number; tipo?: string }> } })?.data;
    const camp = (data?.campanelle ?? []).filter((c) => c.tipo !== 'ricreazione' && c.tipo !== 'mensa');
    const materiaByDay = [MATERIE.italiano, MATERIE.matematica, MATERIE.inglese, MATERIE.arte, MATERIE.storia];
    let set = 0;
    for (const c of camp) {
      if (c.ordine > 3) continue; // prime 3 ore di ogni giorno
      const r = await apiPost(page, '/api/admin/primaria/orario?action=set-cell', {
        sectionId: SECTION, giorno: c.giorno_settimana, campanellaId: c.id,
        materiaId: materiaByDay[(c.giorno_settimana - 1) % materiaByDay.length],
      });
      if (r.status < 400) set++;
    }
    rec.add({
      flusso: 'orario', pagina: '/api/admin/primaria/orario', step: 'Compila celle orario (materie nei primi slot)',
      gravita: set > 0 ? 'ok' : 'medio', categoria: set > 0 ? 'ok' : 'funzionale',
      atteso: 'Celle orario popolate', osservato: `${set} celle impostate su ${camp.length} campanelle`,
    });
  } catch (e) {
    rec.add({ flusso: 'orario', pagina: '/api/admin/primaria/orario', step: 'Compila celle orario', gravita: 'medio', categoria: 'funzionale', atteso: 'Celle popolate', osservato: `Errore parsing campanelle: ${String(e).slice(0, 120)}` });
  }
  await visit(page, rec, { url: `/admin/primaria/${SECTION}/orario`, flusso: 'orario', label: 'Orario settimanale (UI)', appId: SEG });

  // ── Pagamenti odierni + ticket mensa ────────────────────────────────────
  const oggi = new Date().toISOString().slice(0, 10);
  let pagOk = 0, incOk = 0;
  for (const n of [1, 2, 3]) {
    const pag = await apiPost(page, '/api/pagamenti', {
      alunno_id: ALUNNI[n], descrizione: `${TAG} Quota gita museo`, importo: 15, scadenza: oggi,
    });
    if (pag.status < 400) {
      pagOk++;
      const pid = (pag.json as { id?: string; data?: { id?: string } })?.id ?? (pag.json as { data?: { id?: string } })?.data?.id;
      if (pid) {
        const inc = await apiPost(page, '/api/pagamenti/incassi', { pagamento_id: pid, importo: 15, metodo: 'contanti', data_incasso: oggi });
        if (inc.status < 400) incOk++;
      }
    }
  }
  rec.add({
    flusso: 'pagamenti', pagina: '/api/pagamenti', step: 'Registra pagamenti odierni (quota gita) di 3 alunni',
    gravita: incOk >= 2 ? 'ok' : 'medio', categoria: incOk >= 2 ? 'ok' : 'funzionale',
    atteso: 'Pagamenti creati e incassati (stato pagato)', osservato: `${pagOk} pagamenti creati, ${incOk} incassati`,
  });
  // ricarica ticket mensa per alunni 1..6 (prerequisito prenotazione genitore)
  let tick = 0;
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const t = await apiPost(page, '/api/pagamenti/ticket', { alunno_id: ALUNNI[n], pezzi: 10, costo: 40, metodo: 'contanti' });
    if (t.status < 400) tick++;
  }
  rec.add({
    flusso: 'pagamenti', pagina: '/api/pagamenti/ticket', step: 'Ricarica 10 ticket mensa a 6 alunni',
    gravita: tick >= 5 ? 'ok' : 'grave', categoria: tick >= 5 ? 'ok' : 'funzionale',
    atteso: 'Saldo ticket ricaricato (serve per la prenotazione genitore)', osservato: `${tick}/6 ricariche ok`,
  });
  writeState({ ticketAlunni: [1, 2, 3, 4, 5, 6] });

  await visit(page, rec, { url: '/admin/pagamenti', flusso: 'pagamenti', label: 'Dashboard Pagamenti', appId: SEG });
  await visit(page, rec, { url: '/admin/mensa', flusso: 'mensa', label: 'Mensa (segreteria)', appId: SEG });
  await visit(page, rec, { url: '/admin/avvisi', flusso: 'avvisi', label: 'Avvisi (segreteria)', appId: SEG });
  await visit(page, rec, { url: '/admin/modulistica', flusso: 'modulistica', label: 'Modulistica (segreteria)', appId: SEG });
  // NB: il test del logout è nella journey dedicata 50-logout (login fresco per
  // area), così non revoca la sessione condivisa qui.

  rec.save();
  expect(rec.findings.length).toBeGreaterThan(0);
});
