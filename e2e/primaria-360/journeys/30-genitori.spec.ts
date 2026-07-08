import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { storagePath, TAG } from '../config/accounts';
import { ALUNNI, FORM_MODEL_GITA } from '../config/data';
import { Recorder, visit, apiPost, apiPatch, apiGet, readAppIds, readState, writeState } from '../lib/harness';

const ids = readAppIds();
const today = new Date().toISOString().slice(0, 10);

test('30 · Genitori (10) — visione, adesione+firma gita, mensa, chiarimenti chat', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(360_000);
  const rec = new Recorder('30-genitori', 'genitore');
  const state = readState();
  const avvisoId = state.avvisoGitaId as string | undefined;
  const threads: Record<string, string> = {};

  let adesioni = 0, mensaOk = 0, mensaBlocked = 0;

  for (let n = 1; n <= 10; n++) {
    const ctx = await browser.newContext({ storageState: storagePath(`genitore${n}`), viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const parentId = ids[`genitore${n}`];
    const studentId = ALUNNI[n];
    const uid = `userId=${parentId}&id=${studentId}`;

    // Solo i primi 3 genitori fanno lo sweep completo (screenshot); tutti fanno le azioni.
    if (n <= 3) {
      await visit(page, rec, { url: `/parent/primaria/orario?${uid}`, flusso: `genitore${n}`, label: `G${n} · Orario di accesso` });
      await visit(page, rec, { url: `/parent/primaria?${uid}`, flusso: `genitore${n}`, label: `G${n} · Scuola (registro/valutazioni/note)` });
      await visit(page, rec, { url: `/parent/primaria/valutazioni?${uid}`, flusso: `genitore${n}`, label: `G${n} · Valutazioni` });
      await visit(page, rec, { url: `/parent/primaria/note?${uid}`, flusso: `genitore${n}`, label: `G${n} · Note` });
      await visit(page, rec, { url: `/parent/compiti?${uid}`, flusso: `genitore${n}`, label: `G${n} · Compiti` });
      await visit(page, rec, { url: `/parent/avvisi?${uid}`, flusso: `genitore${n}`, label: `G${n} · Avvisi (gita)` });
    }

    // Adesione alla gita (tutti e 10)
    if (avvisoId) {
      const ad = await apiPost(page, `/api/avvisi/${avvisoId}/risposte`, { parent_id: parentId, student_id: studentId, risposta: 'si' });
      if (ad.status < 400) adesioni++;
    }

    // Firma FEA dell'autorizzazione gita (OTP) — solo genitore1 (item 19).
    // POST send-otp crea la submission + restituisce devCode (dev); PATCH firma.
    if (n === 1) {
      const post = await apiPost(page, '/api/forms/send-otp', { modelId: FORM_MODEL_GITA, userId: parentId, data: { note: 'Autorizzo la gita' } });
      const pj = post.json as { submissionId?: string; devCode?: string };
      let firmaOk = false;
      if (pj.submissionId && pj.devCode) {
        const patch = await apiPatch(page, '/api/forms/send-otp', { submissionId: pj.submissionId, code: pj.devCode });
        firmaOk = (patch.json as { completed?: boolean })?.completed === true;
      }
      rec.add({
        flusso: 'genitore1', pagina: '/api/forms/send-otp', step: 'G1 · Firma FEA autorizzazione gita (OTP)',
        gravita: firmaOk ? 'ok' : 'grave', categoria: firmaOk ? 'ok' : 'funzionale',
        atteso: 'Firma OTP completata (form_submissions.signed_at valorizzato)',
        osservato: firmaOk ? 'Modulo firmato (completed=true)' : `Firma non completata (HTTP ${post.status})`,
      });
      writeState({ feaGitaModelId: FORM_MODEL_GITA, feaGitaSignerAlunno: studentId });
    }

    // Mensa: i primi 5 prenotano per oggi (ticket già ricaricati dalla segreteria)
    if (n <= 5) {
      const pren = await apiPost(page, '/api/mensa/prenotazioni', { alunno_id: studentId, date: today });
      const j = pren.json as { success?: boolean; esito?: { ok?: boolean; motivo?: string }; error?: string };
      const okPren = pren.status < 400 && (j?.success !== false) && (j?.esito?.ok !== false);
      if (okPren) mensaOk++; else mensaBlocked++;
      if (n <= 3) await visit(page, rec, { url: `/parent/mensa?${uid}`, flusso: `genitore${n}`, label: `G${n} · Mensa (prenotazione oggi)` });
      if (!okPren) {
        rec.add({
          flusso: `genitore${n}`, pagina: '/api/mensa/prenotazioni', step: `G${n} · Prenota ticket mensa oggi`,
          gravita: 'medio', categoria: 'funzionale', atteso: 'Prenotazione mensa per oggi accettata',
          osservato: `HTTP ${pren.status} — ${j?.esito?.motivo ?? j?.error ?? JSON.stringify(j).slice(0, 140)}`,
        });
      }
    }

    // Chiarimenti chat: G1 sul voto basso (→ D1), G2 sull'assegno poco chiaro (→ D2)
    if (n === 1 || n === 2) {
      const teacherId = ids[`docente${n}`];
      const th = await apiPost(page, '/api/chat/threads', { teacher_id: teacherId, parent_id: parentId, student_id: studentId });
      const thId = (th.json as { data?: { id?: string }; id?: string })?.data?.id ?? (th.json as { id?: string })?.id;
      const testo = n === 1
        ? `${TAG} Buongiorno maestra, ho visto la valutazione di Italiano molto bassa. Può darmi qualche chiarimento?`
        : `${TAG} Buongiorno, non ho capito bene l'assegno per casa di Matematica: può spiegare meglio la consegna?`;
      let msg = { status: 0 } as { status: number };
      if (thId) { threads[`genitore${n}`] = thId; msg = await apiPost(page, '/api/chat/messages', { thread_id: thId, sender_id: parentId, content: testo }); }
      rec.add({
        flusso: `genitore${n}`, pagina: '/api/chat', step: `G${n} · Chiede chiarimento al docente (${n === 1 ? 'voto basso' : 'assegno poco chiaro'})`,
        gravita: thId && msg.status < 400 ? 'ok' : 'grave', categoria: thId && msg.status < 400 ? 'ok' : 'funzionale',
        atteso: 'Thread creato e messaggio inviato al docente',
        osservato: `thread HTTP ${th.status}, messaggio HTTP ${msg.status}`,
      });
      if (n <= 2) await visit(page, rec, { url: `/parent/chat?${uid}`, flusso: `genitore${n}`, label: `G${n} · Chat (chiarimento)` });
    }

    await ctx.close();
  }

  writeState({ chatThreads: threads });
  rec.add({
    flusso: 'gita', pagina: '/api/avvisi/[id]/risposte', step: 'Adesione gita di 10 genitori',
    gravita: adesioni >= 10 ? 'ok' : adesioni >= 5 ? 'medio' : 'grave', categoria: adesioni >= 10 ? 'ok' : 'funzionale',
    atteso: '10 adesioni registrate', osservato: `${adesioni}/10 adesioni ok`,
  });
  rec.add({
    flusso: 'mensa', pagina: '/api/mensa/prenotazioni', step: 'Prenotazione mensa odierna (5 genitori)',
    gravita: mensaOk >= 5 ? 'ok' : mensaOk >= 1 ? 'medio' : 'grave', categoria: mensaOk >= 1 ? 'ok' : 'funzionale',
    atteso: '5 prenotazioni mensa per oggi (visibili a segreteria/docente)', osservato: `${mensaOk} ok, ${mensaBlocked} bloccate`,
  });

  rec.save();
  expect(rec.findings.length).toBeGreaterThan(0);
});
