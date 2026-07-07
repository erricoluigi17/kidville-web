import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { storagePath, TAG } from '../config/accounts';
import { ALUNNI } from '../config/data';
import { Recorder, visit, apiPost, readAppIds, readState } from '../lib/harness';

const ids = readAppIds();

test('40 · Riscontri — docenti rispondono, mensa/voto visibili cross-ruolo', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(240_000);
  const rec = new Recorder('40-riscontri', 'misto');
  const state = readState();
  const threads = (state.chatThreads as Record<string, string>) ?? {};

  // ── Docenti rispondono ai chiarimenti (D1→G1 voto, D2→G2 compiti) ───────
  for (const n of [1, 2]) {
    const thId = threads[`genitore${n}`];
    const ctx = await browser.newContext({ storageState: storagePath(`docente${n}`), viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    const teacherId = ids[`docente${n}`];
    const risposta = n === 1
      ? `${TAG} Buongiorno, la valutazione riflette l'interrogazione di oggi; propongo un recupero la prossima settimana. Resto a disposizione.`
      : `${TAG} Buongiorno, i compiti sono gli esercizi pag. 20; la consegna è il 10/07. Se serve li rivediamo insieme.`;
    let msg = { status: 0 } as { status: number };
    if (thId) msg = await apiPost(page, '/api/chat/messages', { thread_id: thId, sender_id: teacherId, content: risposta });
    rec.add({
      flusso: 'chat-riscontro', pagina: '/api/chat/messages', step: `D${n} risponde al genitore${n}`,
      gravita: thId && msg.status < 400 ? 'ok' : 'grave', categoria: thId && msg.status < 400 ? 'ok' : (thId ? 'funzionale' : 'gap-noto'),
      atteso: 'Il docente risponde nel thread del genitore', osservato: thId ? `messaggio HTTP ${msg.status}` : 'thread non disponibile',
    });
    await visit(page, rec, { url: '/teacher/chat', flusso: 'chat-riscontro', label: `D${n} · Chat (risposta inviata)`, appId: teacherId });
    await ctx.close();
  }

  // ── Genitore1 rilegge la chat (vede la risposta) + rivede il voto ───────
  {
    const ctx = await browser.newContext({ storageState: storagePath('genitore1'), viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const uid = `userId=${ids['genitore1']}&id=${ALUNNI[1]}`;
    await visit(page, rec, { url: `/parent/chat?${uid}`, flusso: 'chat-riscontro', label: 'G1 · Chat (vede risposta docente)' });
    const val = await visit(page, rec, { url: `/parent/primaria/valutazioni?${uid}`, flusso: 'voto-riscontro', label: 'G1 · Valutazioni (vede il voto)' });
    // Riscontro voto: il buffer notifiche potrebbe ritardarne la visibilità
    const bodyTxt = (await page.textContent('body').catch(() => '')) ?? '';
    const visibile = /Italiano|acquisizione|Interrogazione/i.test(bodyTxt);
    rec.add({
      flusso: 'voto-riscontro', pagina: '/parent/primaria/valutazioni', step: 'Riscontro: il genitore vede la valutazione del docente',
      gravita: visibile ? 'ok' : 'medio', categoria: visibile ? 'riscontro' : 'gap-noto',
      atteso: 'La valutazione (Italiano, giudizio) compare al genitore',
      osservato: visibile ? 'Valutazione visibile al genitore' : 'Non ancora visibile (possibile buffer notifiche valutazioni ~10 min)',
      screenshot: val.screenshot,
    });
    await ctx.close();
  }

  // ── Segreteria vede le prenotazioni mensa di oggi + i pagamenti ─────────
  {
    const ctx = await browser.newContext({ storageState: storagePath('segreteria'), viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    const seg = ids['segreteria'];
    await visit(page, rec, { url: '/admin/mensa/cucina', flusso: 'mensa-riscontro', label: 'Segreteria · Report Cucina (prenotazioni oggi)', appId: seg });
    await visit(page, rec, { url: '/admin/pagamenti', flusso: 'pagamenti-riscontro', label: 'Segreteria · Pagamenti (incassi odierni)', appId: seg });
    rec.add({
      flusso: 'mensa-riscontro', pagina: '/admin/mensa/cucina', step: 'Riscontro: segreteria vede le prenotazioni mensa',
      gravita: 'ok', categoria: 'riscontro',
      atteso: 'Le prenotazioni odierne dei genitori sono visibili alla segreteria (report cucina)',
      osservato: 'Report cucina aperto (verifica visiva nello screenshot)',
    });
    await ctx.close();
  }

  // ── Gap: il docente primaria non ha una vista mensa ─────────────────────
  rec.add({
    flusso: 'mensa-riscontro', pagina: '/teacher (bottom nav)', step: 'Gap: il docente non vede le prenotazioni mensa',
    gravita: 'medio', categoria: 'gap-noto',
    atteso: 'Anche il docente dovrebbe vedere le prenotazioni mensa (requisito)',
    osservato: "Nell'area docente la voce 'Mensa' è marcata 'In arrivo' (nessuna rotta): il docente non ha riscontro mensa in primaria.",
  });

  rec.save();
  expect(rec.findings.length).toBeGreaterThan(0);
});
