import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { storagePath, TAG } from '../config/accounts';
import { ALUNNI, FORM_MODEL_GITA } from '../config/data';
import { Recorder, visit, apiPost, apiPatch, apiGet, apiPut, readAppIds, readState, writeState, fraGiorni } from '../lib/harness';

const ids = readAppIds();
const today = new Date().toISOString().slice(0, 10);

/**
 * QUANTE PERSONE PORTA OGNI FAMIGLIA — e perché il numero è 2.
 *
 * Il tetto dell'avviso è 12 posti (`20-docenti.spec.ts`), le famiglie sono 10:
 * 10 × 2 = **20 persone contro 12 posti**. Il conto si chiude in un modo solo —
 * sei adesioni confermate (12 posti esatti) e quattro in lista d'attesa — ed è
 * l'unica configurazione in cui la coda si forma davvero contro un database
 * vero. Con `numero_partecipanti: 1` entrerebbero tutte e dieci e la lista
 * d'attesa resterebbe una funzione collaudata solo da test con i finti.
 */
const PERSONE_PER_FAMIGLIA = 2;
const AMMESSE_ATTESE = 6;
const POSTI_ATTESI = 12;
const IN_ATTESA_ATTESE = 4;

/** Lo stato che la RPC ha assegnato a una risposta, comunque sia impacchettata. */
function statoDi(json: unknown): string | null {
    const j = (json ?? {}) as { stato?: string | null; riga?: { stato_adesione?: string | null } };
    return j.stato ?? j.riga?.stato_adesione ?? null;
}

function codiceDi(json: unknown): string | null {
    return ((json ?? {}) as { codice?: string }).codice ?? null;
}

/**
 * «Le adesioni non sono disponibili» = la funzione di database non c'è.
 *
 * 🔴 IL RAMO DI DEGRADO, OBBLIGATORIO. Sul DB E2E della CI — progetto separato,
 * **non migrato** — `avviso_adesione_registra` non esiste, e
 * `POST /api/avvisi/[id]/risposte` risponde **503** a qualunque adesione: la
 * route rifiuta di proposito ogni ripiego che ACCETTI, perché un upsert di
 * comodo rimetterebbe il buco («adesioni dopo la scadenza», «posti oltre il
 * tetto») proprio sulla strada che nessuno guarda. Il journey lo registra, dice
 * che questo percorso non è stato collaudato in questo run, e prosegue col
 * payload vecchio invece di tingere di rosso la CI per una migrazione che
 * l'integrazione applicherà al merge.
 */
function rpcAssente(status: number, json: unknown): boolean {
    return status === 503 && codiceDi(json) === 'ADESIONI_NON_DISPONIBILI';
}

test('30 · Genitori (10) — visione, adesione+firma gita, mensa, chiarimenti chat', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(360_000);
  const rec = new Recorder('30-genitori', 'genitore');
  const state = readState();
  const avvisoId = state.avvisoGitaId as string | undefined;
  const threads: Record<string, string> = {};

  // 🔴 L'UNICA ASSERZIONE DURA DI QUESTO JOURNEY, ed è qui per una ragione
  // precisa. Senza `avvisoGitaId` i dieci blocchi qui sotto saltano dentro
  // `if (avvisoId)` e il journey finisce VERDE avendo collaudato zero adesioni:
  // è la stessa forma di silenzio della data cablata — il percorso smette di
  // esistere e nessuna riga diventa rossa. Il resto del journey resta un
  // REGISTRO di rilievi (vedi `Recorder`): un `gravita: 'grave'` non fa cadere
  // il test, di proposito, perché la campagna 360° produce un rapporto da
  // triagiare, non un semaforo. Ma «non c'era niente da collaudare» non è un
  // rilievo: è l'assenza del collaudo, e deve fermarsi qui.
  expect(
    avvisoId,
    '20-docenti non ha lasciato `avvisoGitaId` in `run/state.json`: senza avviso le dieci ' +
      'adesioni non partono e questo journey non collauderebbe niente restando verde.',
  ).toBeTruthy();

  // Se l'avviso è nato col payload STORICO (DB non migrato), il contatore delle
  // persone non esiste: mandarlo produrrebbe un rifiuto che accusa il journey.
  let degradato = state.avvisoGitaDegradato === true;
  let degradoDichiarato = false;

  const dichiaraDegrado = (dove: string, osservato: string) => {
    degradato = true;
    if (degradoDichiarato) return;
    degradoDichiarato = true;
    rec.add({
      flusso: 'gita', pagina: dove, step: 'Adesioni con numero di partecipanti',
      gravita: 'medio', categoria: 'gap-noto',
      atteso: 'La RPC `avviso_adesione_registra` decide numero, tetto e lista d’attesa',
      osservato:
        `DB E2E non migrato: ${osservato}. Proseguo col payload vecchio (senza ` +
        '`numero_partecipanti`): tetto dei posti e lista d’attesa NON sono collaudati in questo run.',
    });
  };

  let adesioni = 0, mensaOk = 0, mensaBlocked = 0;
  let ammesse = 0, inAttesa = 0, postiOccupati = 0;

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

    // ── Adesione alla gita (tutti e 10), con il NUMERO DI PERSONE ────────────
    //
    // `parent_id` NON si manda più: dal cantiere G4 l'autore della risposta è la
    // SESSIONE, e il campo del client era forgiabile (adesioni e prese visione
    // false su minori). Resta nel ripiego storico, che è il payload di allora.
    if (avvisoId) {
      let ad = await apiPost(page, `/api/avvisi/${avvisoId}/risposte`, {
        student_id: studentId,
        risposta: 'si',
        ...(degradato ? {} : { numero_partecipanti: PERSONE_PER_FAMIGLIA }),
      });
      if (!degradato && rpcAssente(ad.status, ad.json)) {
        dichiaraDegrado('/api/avvisi/[id]/risposte', `HTTP 503 ADESIONI_NON_DISPONIBILI al genitore ${n}`);
        ad = await apiPost(page, `/api/avvisi/${avvisoId}/risposte`, {
          parent_id: parentId, student_id: studentId, risposta: 'si',
        });
      }
      if (ad.status < 400) {
        adesioni++;
        const stato = statoDi(ad.json);
        if (stato === 'ammessa') { ammesse++; postiOccupati += PERSONE_PER_FAMIGLIA; }
        else if (stato === 'in_attesa') inAttesa++;
      }
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

  // ═══ L'UNDICESIMA ADESIONE — quella che trova i posti finiti ═══════════════
  //
  // Il PADRE di A1 (`genitore1p`), non una delle dieci madri: `avvisi_risposte`
  // è unica su `(avviso_id, parent_id, student_id)`, quindi un secondo genitore
  // dello STESSO bambino è una riga nuova — ed è anche il caso vero, perché
  // madre e padre hanno due account distinti (in produzione ognuno mette la
  // propria email, niente alias). Dopo le dieci di sopra i 12 posti sono
  // esauriti: questa deve finire in coda, non essere respinta.
  //
  // ⚠️ E non è un doppione contabile mascherato da collaudo: il DOPPIO CONTEGGIO
  // FRATELLI/GENITORI è un debito dichiarato di questo cantiere (l'etichetta del
  // contatore è riferita al bambino, ma nulla impedisce a due genitori di
  // contare due volte lo stesso accompagnatore). Qui serve a far accadere il
  // caso «posti residui zero» senza inventare un undicesimo bambino.
  if (avvisoId) {
    const ctx = await browser.newContext({ storageState: storagePath('genitore1p'), viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const ad = await apiPost(page, `/api/avvisi/${avvisoId}/risposte`, {
      student_id: ALUNNI[1],
      risposta: 'si',
      ...(degradato ? {} : { numero_partecipanti: PERSONE_PER_FAMIGLIA }),
    });
    const stato = statoDi(ad.json);
    const atteso = degradato
      ? 'DB non migrato: l’adesione non può essere valutata contro il tetto'
      : 'Posti residui zero ⇒ `in_attesa` (mai un rifiuto: chi non ha posto entra in coda)';
    rec.add({
      flusso: 'gita', pagina: '/api/avvisi/[id]/risposte',
      step: 'Undicesima adesione a posti esauriti (padre di A1)',
      gravita: degradato ? 'medio' : stato === 'in_attesa' ? 'ok' : 'grave',
      categoria: degradato ? 'gap-noto' : stato === 'in_attesa' ? 'ok' : 'funzionale',
      atteso,
      osservato: `HTTP ${ad.status} · stato «${stato ?? '—'}»${ad.status >= 400 ? ' — ' + JSON.stringify(ad.json).slice(0, 140) : ''}`,
    });
    if (ad.status < 400 && stato === 'in_attesa') inAttesa++;
    await ctx.close();
  }

  // ── Le DUE righe di riepilogo: quante adesioni, e come sono state ripartite ──
  rec.add({
    flusso: 'gita', pagina: '/api/avvisi/[id]/risposte',
    step: `Adesione gita di 10 genitori (${PERSONE_PER_FAMIGLIA} persone ciascuna)`,
    gravita: adesioni >= 10 ? 'ok' : adesioni >= 5 ? 'medio' : 'grave', categoria: adesioni >= 10 ? 'ok' : 'funzionale',
    atteso: `10 adesioni registrate, ${PERSONE_PER_FAMIGLIA} persone ciascuna = ${10 * PERSONE_PER_FAMIGLIA} persone`,
    osservato: `${adesioni}/10 adesioni ok`,
  });
  // 🔴 È L'UNICO PUNTO IN CUI IL CONTEGGIO DEI POSTI È VERIFICATO CONTRO UN
  // DATABASE VERO. `vitest` misura `riepilogoPosti` e la RPC con dei finti: la
  // somma in PERSONE, il `FOR UPDATE` e la coda che non si spezza vivono in
  // PL/pgSQL, e nessun test unitario li esegue. Qui l'atteso è scritto in
  // chiaro — non «abbastanza adesioni», ma i tre numeri esatti che 20 persone
  // contro 12 posti possono produrre.
  const ripartizioneOk = ammesse === AMMESSE_ATTESE && postiOccupati === POSTI_ATTESI && inAttesa === IN_ATTESA_ATTESE + 1;
  rec.add({
    flusso: 'gita', pagina: '/api/avvisi/[id]/risposte', step: 'Tetto di 12 posti e lista d’attesa',
    gravita: degradato ? 'medio' : ripartizioneOk ? 'ok' : 'grave',
    categoria: degradato ? 'gap-noto' : ripartizioneOk ? 'ok' : 'funzionale',
    atteso: degradato
      ? 'Non valutabile: senza la RPC il tetto non esiste e nessuno va in coda'
      : `${AMMESSE_ATTESE} confermate (${POSTI_ATTESI} posti) + ${IN_ATTESA_ATTESE} in attesa, ` +
        `più l’undicesima ⇒ ${IN_ATTESA_ATTESE + 1} in coda`,
    osservato: `${ammesse} confermate (${postiOccupati} posti) + ${inAttesa} in attesa`,
  });

  // ═══ LA SCADENZA SPOSTATA INDIETRO — «la gita è annullata, si chiude adesso» ═══
  //
  // La segreteria (qui il docente autore, che sull'avviso ha lo stesso potere)
  // porta le due scadenze nel PASSATO: sul PUT è un gesto legittimo
  // (`vietaPassato: false`), l'unico modo di fermare le adesioni senza
  // cancellare l'avviso e buttare via quelle già raccolte.
  //
  // ⚠️ SI MANDANO ENTRAMBE. `scadenza_adesione` assente vuol dire «non toccare»,
  // e resterebbe quella di venti giorni: il server confronta lo STATO
  // RISULTANTE e rifiuterebbe con `SCADENZE_INCOERENTI` — un 400 che accusa il
  // journey di un errore che non ha fatto.
  //
  // Poi il padre di A2 prova ad aderire: deve prendere **409 ADESIONE_SCADUTA**.
  // È il difetto preesistente che questo cantiere chiude, e il campo lo ha già
  // dimostrato una volta: dieci adesioni registrate su un avviso scaduto dal 1°
  // agosto, dal server, senza un errore.
  if (avvisoId) {
    const ctxDocente = await browser.newContext({ storageState: storagePath('docente1') });
    const pageDocente = await ctxDocente.newPage();
    const chiusuraLocale = fraGiorni(-1);
    const put = await apiPut(pageDocente, `/api/avvisi/${avvisoId}`, {
      titolo: `${TAG} Gita al Museo di Napoli`,
      contenuto: `${TAG} Uscita didattica al Museo Archeologico — ADESIONI CHIUSE dal collaudo 360°.`,
      tipo: 'adesione',
      scadenza_avviso: chiusuraLocale,
      scadenza_adesione: chiusuraLocale,
    });
    rec.add({
      flusso: 'gita', pagina: '/api/avvisi/[id]', step: 'La segreteria sposta la scadenza INDIETRO',
      gravita: put.status < 400 ? 'ok' : 'grave', categoria: put.status < 400 ? 'ok' : 'funzionale',
      atteso: `Le due scadenze portate a ${chiusuraLocale} (nel passato): sul PUT è permesso`,
      osservato: `HTTP ${put.status}${put.status >= 400 ? ' — ' + JSON.stringify(put.json).slice(0, 160) : ''}`,
    });
    await ctxDocente.close();

    const ctxTardivo = await browser.newContext({ storageState: storagePath('genitore2p'), viewport: { width: 390, height: 844 } });
    const pageTardivo = await ctxTardivo.newPage();
    const tardiva = await apiPost(pageTardivo, `/api/avvisi/${avvisoId}/risposte`, {
      student_id: ALUNNI[2],
      risposta: 'si',
      ...(degradato ? {} : { numero_partecipanti: PERSONE_PER_FAMIGLIA }),
    });
    const codice = codiceDi(tardiva.json);
    const rifiutata = tardiva.status === 409 && codice === 'ADESIONE_SCADUTA';
    rec.add({
      flusso: 'gita', pagina: '/api/avvisi/[id]/risposte', step: 'Adesione DOPO la scadenza (padre di A2)',
      gravita: degradato ? 'medio' : rifiutata ? 'ok' : 'grave',
      categoria: degradato ? 'gap-noto' : rifiutata ? 'ok' : 'funzionale',
      atteso: degradato
        ? 'Non valutabile: senza la RPC il termine non lo fa valere nessuno'
        : '409 `ADESIONE_SCADUTA` — il SERVER rifiuta, non l’interfaccia',
      osservato: `HTTP ${tardiva.status} · codice «${codice ?? '—'}»`,
    });
    await ctxTardivo.close();
  }

  rec.add({
    flusso: 'mensa', pagina: '/api/mensa/prenotazioni', step: 'Prenotazione mensa odierna (5 genitori)',
    gravita: mensaOk >= 5 ? 'ok' : mensaOk >= 1 ? 'medio' : 'grave', categoria: mensaOk >= 1 ? 'ok' : 'funzionale',
    atteso: '5 prenotazioni mensa per oggi (visibili a segreteria/docente)', osservato: `${mensaOk} ok, ${mensaBlocked} bloccate`,
  });

  rec.save();
  expect(rec.findings.length).toBeGreaterThan(0);
});
