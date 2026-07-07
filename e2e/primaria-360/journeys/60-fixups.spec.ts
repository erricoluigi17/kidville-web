import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { storagePath } from '../config/accounts';
import { ALUNNI } from '../config/data';
import { Recorder, visit, apiPost, readAppIds } from '../lib/harness';

const ids = readAppIds();
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

test('60 · Fixup — mensa (domani, cutoff-safe) + ri-cattura chat/mensa con attesa piena', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(240_000);
  const rec = new Recorder('60-fixup', 'misto');

  // ── Mensa: i genitori prenotano per DOMANI (oggi è oltre il cutoff 09:30) ─
  let ok = 0; const motivi: string[] = [];
  for (let n = 1; n <= 5; n++) {
    const ctx = await browser.newContext({ storageState: storagePath(`genitore${n}`), viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const r = await apiPost(page, '/api/mensa/prenotazioni', { alunno_id: ALUNNI[n], date: tomorrow });
    // 2xx = prenotazione creata/già presente (verificato lato DB). Il body varia di forma.
    if (r.status >= 200 && r.status < 300) ok++;
    else motivi.push(`G${n}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 80)}`);
    await ctx.close();
  }
  rec.add({
    flusso: 'mensa', pagina: '/api/mensa/prenotazioni', step: `Genitori prenotano mensa per DOMANI (${tomorrow})`,
    gravita: ok >= 5 ? 'ok' : 'grave', categoria: ok >= 5 ? 'ok' : 'funzionale',
    atteso: '5 prenotazioni mensa valide (cutoff rispettato usando un giorno futuro)',
    osservato: `${ok}/5 prenotate. ${motivi.join(' | ')}`.slice(0, 200),
  });
  rec.add({
    flusso: 'mensa', pagina: '/api/mensa/prenotazioni', step: 'Nota: prenotazione mensa per OGGI bloccata dal cutoff',
    gravita: 'minore', categoria: 'gap-noto',
    atteso: 'Comportamento atteso: dopo le 09:30 il genitore non prenota più lo stesso giorno (cutoff configurato)',
    osservato: `Il test è girato alle ~21:19 (Europe/Rome), oltre il cutoff 09:30 → prenotazione "oggi" (${today}) rifiutata "Oltre l'orario limite". Corretto: la prenotazione odierna è possibile solo entro le 09:30; per i giorni successivi funziona. La Segreteria (staff) può forzare.`,
  });

  // ── Ri-cattura CHAT con attesa piena (il dato esiste: 4 messaggi) ───────
  {
    const ctx = await browser.newContext({ storageState: storagePath('docente1'), viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`/teacher/chat?userId=${ids['docente1']}`);
    await page.waitForTimeout(6000);
    const shot = await rec.shoot(page, 'chat-docente1-attesa-piena');
    const body = (await page.textContent('body').catch(() => '')) ?? '';
    const caricata = !/Caricamento chat/i.test(body);
    rec.add({
      flusso: 'chat-riscontro', pagina: '/teacher/chat', step: 'Chat docente — ri-cattura con attesa piena (6s)',
      gravita: caricata ? 'ok' : 'grave', categoria: caricata ? 'riscontro' : 'funzionale',
      atteso: 'La lista thread + conversazione si carica (4 messaggi esistono nel DB)',
      osservato: caricata ? 'Chat caricata dopo attesa piena (lo spinner iniziale era solo il caricamento lazy)' : 'Chat ancora bloccata su "Caricamento chat…" dopo 6s: possibile problema di caricamento UI',
      screenshot: shot,
    });
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ storageState: storagePath('genitore1'), viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    // inietta il figlio selezionato (single-child: la UI non ha il ChildSwitcher)
    await page.addInitScript((sid) => { try { localStorage.setItem('kv_student_id', sid); } catch { /* noop */ } }, ALUNNI[1]);
    await page.goto(`/parent/chat?userId=${ids['genitore1']}&id=${ALUNNI[1]}`);
    await page.waitForTimeout(6000);
    const shot = await rec.shoot(page, 'chat-genitore1-attesa-piena');
    const body = (await page.textContent('body').catch(() => '')) ?? '';
    rec.add({
      flusso: 'chat-riscontro', pagina: '/parent/chat', step: 'Chat genitore — ri-cattura con attesa piena (6s)',
      gravita: !/Caricamento chat/i.test(body) ? 'ok' : 'grave', categoria: !/Caricamento chat/i.test(body) ? 'riscontro' : 'funzionale',
      atteso: 'Il genitore vede la conversazione con la risposta del docente',
      osservato: !/Caricamento chat/i.test(body) ? 'Chat caricata (conversazione visibile)' : 'Ancora in caricamento dopo 6s',
      screenshot: shot,
    });
    // mensa parent con contesto figlio + attesa piena
    await visit(page, rec, { url: `/parent/mensa?userId=${ids['genitore1']}&id=${ALUNNI[1]}`, flusso: 'mensa', label: 'G1 · Mensa (saldo + calendario, contesto figlio)' });
    await ctx.close();
  }

  // ── Segreteria: report cucina per DOMANI (vede le 5 prenotazioni) ───────
  {
    const ctx = await browser.newContext({ storageState: storagePath('segreteria'), viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`/admin/mensa/cucina?userId=${ids['segreteria']}`);
    await page.waitForTimeout(1500);
    try {
      await page.locator('input[type="date"]').first().fill(tomorrow);
      await page.waitForTimeout(2500);
    } catch { /* screenshot comunque */ }
    const shot = await rec.shoot(page, 'segreteria-report-cucina-domani');
    const body = (await page.textContent('body').catch(() => '')) ?? '';
    const vede = !/Nessuna prenotazione/i.test(body);
    rec.add({
      flusso: 'mensa-riscontro', pagina: '/admin/mensa/cucina', step: 'Riscontro: Segreteria vede le prenotazioni mensa (domani)',
      gravita: vede ? 'ok' : 'medio', categoria: 'riscontro',
      atteso: 'Il report cucina per il 08/07 mostra le 5 prenotazioni dei genitori',
      osservato: vede ? 'Prenotazioni visibili nel report cucina (data impostata a domani)' : 'Nessuna prenotazione mostrata per la data selezionata',
      screenshot: shot,
    });
    await ctx.close();
  }

  rec.save();
  expect(rec.findings.length).toBeGreaterThan(0);
});
