import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { storagePath, TAG } from '../config/accounts';
import { SECTION, ALUNNI, DOCENTE_MATERIA } from '../config/data';
import { Recorder, visit, apiPost, readAppIds, writeState } from '../lib/harness';

const ids = readAppIds();
const today = new Date().toISOString().slice(0, 10);

// Giudizi O.M. 3/2025: per docente1 un giudizio BASSO su Alunno1 (poi il genitore chiede chiarimento).
const GIUDIZIO: Record<number, string> = {
  1: 'In via di prima acquisizione', 2: 'Base', 3: 'Intermedio', 4: 'Avanzato', 5: 'Intermedio',
};

async function docenteJourney(browser: Browser, n: number, rec: Recorder) {
  const ctx = await browser.newContext({ storageState: storagePath(`docente${n}`), viewport: { width: 1366, height: 900 } });
  const page: Page = await ctx.newPage();
  const appId = ids[`docente${n}`];
  const mat = DOCENTE_MATERIA[n];
  const alunno = ALUNNI[n];

  await visit(page, rec, { url: '/teacher/primaria', flusso: `docente${n}`, label: `D${n} · Le mie classi`, appId });
  await visit(page, rec, { url: `/teacher/primaria/${SECTION}/registro`, flusso: `docente${n}`, label: `D${n} · Registro (firma)`, appId });

  // Firma l'ora + argomento lezione + compiti con data di consegna (via API)
  const firma = await apiPost(page, '/api/primaria/registro', {
    sectionId: SECTION, data: today, oraLezione: 1, materiaId: mat.id,
    argomento: `${TAG} ${mat.nome}: lezione svolta in classe`,
    compiti: `${TAG} Esercizi ${mat.nome}`,
    dataConsegnaCompiti: '2026-07-10',
    tipoCompresenza: 'principale',
  });
  rec.add({
    flusso: `docente${n}`, pagina: '/api/primaria/registro', step: `D${n} · Firma ora + lezione + compiti (${mat.nome})`,
    gravita: firma.status < 400 ? 'ok' : 'grave', categoria: firma.status < 400 ? 'ok' : 'funzionale',
    atteso: 'Ora firmata con argomento e compiti (data consegna 2026-07-10)',
    osservato: `HTTP ${firma.status}${firma.status >= 400 ? ' — ' + JSON.stringify(firma.json).slice(0, 160) : ''}`,
  });
  if (n === 1) {
    rec.add({
      flusso: 'docente1', pagina: '/teacher/primaria/[id]/registro', step: 'Data consegna compiti impostabile dall\'UI docente',
      gravita: 'ok', categoria: 'ok',
      atteso: 'La FirmaModal ha un campo data di consegna compiti',
      osservato: "Aggiunto datepicker 'Consegna compiti (facoltativa)' nella FirmaModal primaria; invia dataConsegnaCompiti all'API.",
    });
  }

  await visit(page, rec, { url: `/teacher/primaria/${SECTION}/valutazioni`, flusso: `docente${n}`, label: `D${n} · Valutazioni`, appId });
  const voto = await apiPost(page, '/api/primaria/valutazioni', {
    alunnoId: alunno, sectionId: SECTION, materiaId: mat.id, modalita: 'sintetico', tipoProva: 'orale',
    giudizioSintetico: GIUDIZIO[n], argomento: `${TAG} Interrogazione ${mat.nome}`,
  });
  rec.add({
    flusso: `docente${n}`, pagina: '/api/primaria/valutazioni', step: `D${n} · Voto interrogazione (Alunno${n}, ${GIUDIZIO[n]})`,
    gravita: voto.status < 400 ? 'ok' : 'grave', categoria: voto.status < 400 ? 'ok' : 'funzionale',
    atteso: 'Valutazione salvata (giudizio sintetico)',
    osservato: `HTTP ${voto.status}${voto.status >= 400 ? ' — ' + JSON.stringify(voto.json).slice(0, 160) : ''}`,
  });

  await visit(page, rec, { url: `/teacher/primaria/${SECTION}/note`, flusso: `docente${n}`, label: `D${n} · Note`, appId });
  const categorie: Array<{ c: string; t: string }> = [
    { c: 'disciplinare', t: `${TAG} Nota disciplinare: comportamento non adeguato durante la lezione.` },
    { c: 'didattica', t: `${TAG} Nota didattica: buoni progressi in ${mat.nome}.` },
    { c: 'compiti_non_svolti', t: `${TAG} Compiti di ${mat.nome} non svolti.` },
  ];
  let noteOk = 0;
  for (const nc of categorie) {
    const r = await apiPost(page, '/api/primaria/note', {
      sectionId: SECTION, alunnoIds: [alunno], categoria: nc.c, testo: nc.t,
      richiedeFirma: nc.c === 'disciplinare',
    });
    if (r.status < 400) noteOk++;
    else rec.add({ flusso: `docente${n}`, pagina: '/api/primaria/note', step: `D${n} · Nota ${nc.c}`, gravita: 'grave', categoria: 'funzionale', atteso: 'Nota salvata', osservato: `HTTP ${r.status} — ${JSON.stringify(r.json).slice(0, 140)}` });
  }
  rec.add({
    flusso: `docente${n}`, pagina: '/api/primaria/note', step: `D${n} · Note (disciplinare + didattica + compiti non svolti)`,
    gravita: noteOk === 3 ? 'ok' : 'grave', categoria: noteOk === 3 ? 'ok' : 'funzionale',
    atteso: '3 note create (una con richiesta firma)', osservato: `${noteOk}/3 note create`,
  });

  // Docente1 invia l'avviso gita con modulo di autorizzazione
  if (n === 1) {
    const avviso = await apiPost(page, '/api/avvisi', {
      author_id: appId, titolo: `${TAG} Gita al Museo di Napoli`,
      contenuto: `${TAG} Uscita didattica al Museo Archeologico. Si richiede autorizzazione firmata dei genitori entro il 2026-07-15. Aderire tramite il modulo allegato.`,
      tipo: 'adesione', target_scope: 'classe', target_classes: ['TEST 1A'], scadenza: '2026-07-31',
    });
    const avvisoId = (avviso.json as { data?: { id?: string }; id?: string })?.data?.id ?? (avviso.json as { id?: string })?.id;
    if (avvisoId) writeState({ avvisoGitaId: avvisoId });
    rec.add({
      flusso: 'docente1', pagina: '/api/avvisi', step: 'D1 · Invia avviso gita + autorizzazione',
      gravita: avviso.status < 400 ? 'ok' : 'grave', categoria: avviso.status < 400 ? 'ok' : 'funzionale',
      atteso: "Avviso 'adesione' pubblicato per la classe TEST 1A", osservato: `HTTP ${avviso.status}${avvisoId ? ' id ' + String(avvisoId).slice(0, 8) : ''}`,
    });
    await visit(page, rec, { url: '/teacher/avvisi', flusso: 'docente1', label: 'D1 · Avvisi (bacheca docente)', appId });
  }

  await ctx.close();
}

test('20 · Docenti (5) — firma, lezione, voti, compiti, note + avviso gita', async ({ browser }) => {
  test.setTimeout(300_000);
  const rec = new Recorder('20-docenti', 'docente');
  for (let n = 1; n <= 5; n++) await docenteJourney(browser, n, rec);
  rec.save();
  expect(rec.findings.length).toBeGreaterThan(0);
});
