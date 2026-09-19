import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { IDS, STORAGE } from './fixtures';

// ═════════════════════════════════════════════════════════════════════════════
// LA LISTA D'ATTESA, DAL LATO IN CUI QUALCUNO DECIDE — e l'elenco che esce in CSV
//
// Due fatti che nessun test unitario può provare, perché vivono in PL/pgSQL e in
// un header HTTP:
//
//  1. la segreteria AMMETTE una riga che stava in coda, e la famiglia se ne
//     accorge: la campanella del genitore mostra `adesione_ammessa`. Nessuna
//     promozione è automatica — la migrazione A2 lo dichiara per esteso — quindi
//     fra «si è liberato un posto» e «tu sei dentro» c'è una persona che preme
//     un bottone, ed è quella catena che si misura qui;
//  2. l'esportazione dell'elenco risponde **200 alla segreteria** e **403 al
//     docente**. Non è una sfumatura di permessi: quel file contiene NOMI DI
//     MINORI e dei loro genitori, e i docenti sulle adesioni restano in sola
//     lettura per decisione del committente. Si verifica anche il
//     `Content-Disposition`, perché un CSV servito senza `attachment` si apre
//     nella scheda del browser invece di scaricarsi — e resta nella cronologia
//     di un computer di segreteria usato da più persone;
//  3. **i posti si contano in PERSONE, non in adesioni**. È il titolo della
//     funzione — `avviso_posti_occupati` somma
//     `SUM(COALESCE(numero_partecipanti, 1))` — ed è l'unica cosa che vive solo
//     in PL/pgSQL: `vitest` copre il gemello TypeScript `riepilogoPosti`, non la
//     funzione SQL. 🔑 Finché questo spec mandava `numero_partecipanti: 1`, una
//     regressione da SOMMA a CONTEGGIO sarebbe stata **verde**, perché con una
//     persona per adesione `SUM(…)` e `COUNT(*)` sono indistinguibili. Qui le
//     famiglie sono due DA DUE PERSONE su **tre** posti: la prima entra (2 su
//     3), la seconda trova `2+2 > 3` e va in coda — e sotto `COUNT(*)` finirebbe
//     dentro, facendo cadere l'asserzione invece di nascondersi.
//
// ─── 🔴 IL RAMO DI DEGRADO, E PERCHÉ NON È FACOLTATIVO ──────────────────────
//
// Il database su cui gira il job `e2e` della CI è un progetto Supabase separato
// e **non è migrato**: `supabase_migrations.schema_migrations` è vuoto, e la
// migrazione `20260919132612` la applicherà l'integrazione al merge (o, sul DB
// della CI, un lancio manuale di `.github/workflows/migrate-ci.yml`). Finché non
// succede:
//   · `POST /api/avvisi` sfila le sette colonne nuove e risponde **201 con una
//     riga mutilata** (`MAX_COLONNE_SFILATE`), non un errore;
//   · `POST /api/avvisi/[id]/risposte` non trova `avviso_adesione_registra` e
//     risponde **503 `ADESIONI_NON_DISPONIBILI`** — di proposito: la route
//     rifiuta ogni ripiego che ACCETTI, perché un upsert di comodo ricreerebbe
//     il buco delle adesioni fuori termine proprio nell'ambiente che nessuno
//     guarda;
//   · l'esportazione legge `stato_adesione`/`in_coda_dal` e cade sullo stesso
//     `42703`, quindi risponde 503.
//
// Questo spec riconosce quella condizione dal PRODOTTO (la riga tornata senza
// `scadenza_avviso`, il 503 col suo codice), la DICHIARA nel rapporto Playwright
// e sui log, e verifica ciò che resta vero comunque — il 403 al docente, che è
// un gate e non uno schema. Senza, il primo push dopo il merge tingerebbe la CI
// di rosso per una ragione che non è il codice, e chi guarda cercherebbe il
// difetto dove non è.
//
// ⚠️ E il degrado non si nasconde dietro un `test.skip()`: uno spec saltato
// sparisce dal conteggio e diventa indistinguibile da uno spec mai scritto. Qui
// resta, con le sue righe, e dice quale metà non ha potuto misurare.
// ═════════════════════════════════════════════════════════════════════════════

const RENDER = 60_000;

/** Un istante futuro nella forma `YYYY-MM-DDTHH:MM`, cifre locali italiane. */
const FORMATO_LOCALE = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Rome',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const fraGiorni = (giorni: number) =>
  FORMATO_LOCALE.format(new Date(Date.now() + giorni * 86_400_000)).replace(' ', 'T');

type Riga = Record<string, unknown>;

const corpo = (json: unknown): Riga => {
  const j = (json ?? {}) as { data?: Riga } & Riga;
  return (j.data as Riga | undefined) ?? j;
};

const codiceDi = (json: unknown): string | null =>
  ((json ?? {}) as { codice?: string }).codice ?? null;

/** Dichiara il degrado dove si vede: nel rapporto Playwright e nei log della CI. */
function dichiaraDegrado(motivo: string) {
  test.info().annotations.push({ type: 'DB E2E non migrato', description: motivo });
  console.warn(
    `[avvisi-lista-attesa] DB E2E non migrato — ${motivo}. La lista d'attesa e l'export ` +
      'non sono collaudati in questo run: applica `20260919132612` al DB della CI ' +
      '(.github/workflows/migrate-ci.yml) per riaccenderli.',
  );
}

test('lista d’attesa: la segreteria ammette, la famiglia lo vede in campanella; l’export è 200 per l’admin e 403 per il docente', async ({ browser }) => {
  test.setTimeout(180_000);

  // Ogni sessione parla al server con l'`APIRequestContext` del PROPRIO
  // BrowserContext: stessi cookie del browser, stesso `baseURL` della config.
  // I contesti si raccolgono qui per chiuderli tutti nel `finally`, anche quando
  // un'asserzione cade a metà.
  const contesti: BrowserContext[] = [];
  const apiDi = async (storageState: string): Promise<APIRequestContext> => {
    const ctx = await browser.newContext({ storageState });
    contesti.push(ctx);
    return ctx.request;
  };

  const admin = await apiDi(STORAGE.admin);
  const genitore = await apiDi(STORAGE.genitore);
  // Lo STESSO utente del docente, in veste di genitore: ha un figlio (`A5`) e
  // una sua casella di notifiche. Serve una SECONDA famiglia, perché la coda si
  // forma solo quando c'è qualcuno che arriva a posti finiti.
  const secondaFamiglia = await apiDi(STORAGE.doppioGenitore);
  const docente = await apiDi(STORAGE.docente);

  try {
    // ── 1. Un avviso di adesione con TRE posti, per DUE famiglie da DUE ──────
    //
    // 🔑 I tre posti sono la misura, non un numero di comodo, e vanno letti
    // insieme ai `numero_partecipanti: 2` più sotto: `3` è il valore che
    // distingue la SOMMA dal CONTEGGIO. Due famiglie da due persone fanno
    // `2 + 2 = 4 > 3` e la seconda entra in coda; se un giorno
    // `avviso_posti_occupati` tornasse a contare le RIGHE invece delle persone,
    // la seconda famiglia troverebbe `1 + 2 = 3 <= 3` (o `1 + 1 = 2 <= 3`) e
    // risulterebbe `ammessa`: l'asserzione cade, che è esattamente ciò che deve
    // fare. Con `posti_totali: 1` e una persona per adesione — com'era fino al
    // 2026-09-19 — quella regressione sarebbe passata VERDE, perché con un
    // partecipante a testa `SUM(numero_partecipanti)` e `COUNT(*)` danno lo
    // stesso numero. Non si abbassi questo `3` a `1` per «semplificare»: il
    // tetto in persone è il titolo della funzione, e questo è l'unico posto in
    // CI dove viene misurato contro un database vero.
    const creazione = await admin.post('/api/avvisi', {
      data: {
        titolo: 'E2E lista d’attesa: uscita al museo',
        contenuto: 'Tre posti in tutto: due famiglie da due persone, e la seconda trova il pullman pieno.',
        tipo: 'adesione',
        target_scope: 'globale',
        // La sede si DICHIARA, sempre: con tre plessi `resolveScuolaScrittura`
        // risponde 400 se resta ambigua, e una scrittura che «indovina» archivia
        // nel plesso sbagliato in silenzio.
        scuola_id: IDS.SCUOLA,
        scadenza_avviso: fraGiorni(5),
        scadenza_adesione: fraGiorni(3),
        chiedi_numero: true,
        etichetta_numero: 'Quante persone accompagnano il bambino?',
        numero_min: 1,
        numero_max: 4,
        posti_totali: 3,
      },
      timeout: RENDER,
    });
    expect(
      creazione.status(),
      `pubblicazione dell'avviso non riuscita: ${(await creazione.text()).slice(0, 300)}`,
    ).toBeLessThan(400);
    const avviso = corpo(await creazione.json());
    const avvisoId = String(avviso.id ?? '');
    expect(avvisoId, 'la POST non ha restituito l’id dell’avviso').toMatch(/^[0-9a-f-]{36}$/i);

    // 201 senza `scadenza_avviso` ⇒ l'insert ha sfilato le colonne del cantiere
    // A2: il database non le ha. Si riconosce dal prodotto, non dall'intenzione.
    let degradato = avviso.scadenza_avviso == null;
    if (degradato) dichiaraDegrado('la riga creata torna senza `scadenza_avviso`: colonne sfilate dall’insert');

    // ── 2. La prima famiglia prende DUE dei tre posti ────────────────────────
    const prima = await genitore.post(`/api/avvisi/${avvisoId}/risposte`, {
      data: { student_id: IDS.A1, risposta: 'si', ...(degradato ? {} : { numero_partecipanti: 2 }) },
      timeout: RENDER,
    });
    const primaJson = await prima.json().catch(() => null);
    if (!degradato && prima.status() === 503 && codiceDi(primaJson) === 'ADESIONI_NON_DISPONIBILI') {
      degradato = true;
      dichiaraDegrado('`avviso_adesione_registra` assente: le adesioni rispondono 503');
    }

    let rispostaInAttesa: string | null = null;
    let rispostaAmmessa: string | null = null;

    if (!degradato) {
      expect(prima.status(), 'la prima adesione doveva essere accettata').toBeLessThan(400);
      expect(
        corpo(primaJson).stato ?? (corpo(primaJson).riga as Riga | undefined)?.stato_adesione,
        'con tre posti liberi una famiglia da due entra: «ammessa»',
      ).toBe('ammessa');

      // ── 3. La seconda arriva a posti finiti: coda, non rifiuto ─────────────
      //
      // 🔴 A chi non ha posto la RPC NON restituisce mai `POSTI_ESAURITI`: quel
      // codice è riservato a chi è GIÀ dentro e prova ad aumentare il numero.
      // Chi arriva dopo entra in lista d'attesa con un 200 — dirgli che è fuori
      // mentre il sistema lo sta tenendo dentro sarebbe la bugia peggiore.
      //
      // 🔑 E QUI SI MISURA IL TETTO IN PERSONE. Le adesioni sono DUE e i posti
      // TRE: chi conta le righe vede `1 < 3` e fa entrare anche questa. Solo chi
      // somma i partecipanti vede `2 + 2 = 4 > 3` e la mette in coda. In coda
      // per intero, mai spezzata: un posto libero e una famiglia da due fanno
      // due persone in lista d'attesa, non una dentro e una fuori.
      const seconda = await secondaFamiglia.post(`/api/avvisi/${avvisoId}/risposte`, {
        data: { student_id: IDS.A5, risposta: 'si', numero_partecipanti: 2 },
        timeout: RENDER,
      });
      expect(seconda.status(), 'chi arriva a posti finiti non viene respinto: entra in coda').toBeLessThan(400);
      const secondaJson = corpo(await seconda.json());
      expect(
        secondaJson.stato ?? (secondaJson.riga as Riga | undefined)?.stato_adesione,
        'due famiglie da due persone su tre posti ⇒ la seconda è `in_attesa`. Se qui esce ' +
          '«ammessa», i posti sono tornati a contarsi in ADESIONI invece che in PERSONE',
      ).toBe('in_attesa');

      // ── 4. La segreteria legge l'elenco e trova le due righe ───────────────
      const elenco = await admin.get(`/api/avvisi/${avvisoId}/risposte`, { timeout: RENDER });
      expect(elenco.status(), 'la segreteria deve poter leggere le risposte').toBe(200);
      const righe = (await elenco.json()) as Array<{ id: string; student_id: string }>;
      // Asserzione POSITIVA prima di ogni negativa: un elenco che non ha
      // caricato soddisfa qualunque «non contiene».
      expect(righe.length, 'le due risposte devono esserci entrambe').toBeGreaterThanOrEqual(2);
      rispostaAmmessa = righe.find((r) => r.student_id === IDS.A1)?.id ?? null;
      rispostaInAttesa = righe.find((r) => r.student_id === IDS.A5)?.id ?? null;
      expect(rispostaAmmessa, 'manca la riga della prima famiglia').toBeTruthy();
      expect(rispostaInAttesa, 'manca la riga della famiglia in coda').toBeTruthy();

      // ── 5. Si liberano i posti, poi qualcuno DECIDE ────────────────────────
      //
      // Due gesti distinti, ed è il punto: togliere una famiglia libera i suoi
      // DUE posti ma NON promuove nessuno. Senza il secondo PATCH la riga in
      // coda resta in coda per sempre — è la decisione dichiarata nella
      // migrazione A2, non un pezzo mancante. E l'ammissione che segue passa il
      // controllo di capienza proprio perché sono tornati liberi in due: `0 + 2
      // <= 3`.
      const rimozione = await admin.patch(`/api/avvisi/${avvisoId}/risposte/${rispostaAmmessa}`, {
        data: { stato: 'nessuna' },
        timeout: RENDER,
      });
      expect(rimozione.status(), 'la segreteria può togliere un’adesione').toBe(200);

      const ammissione = await admin.patch(`/api/avvisi/${avvisoId}/risposte/${rispostaInAttesa}`, {
        data: { stato: 'ammessa' },
        timeout: RENDER,
      });
      expect(
        ammissione.status(),
        `ammissione dalla coda non riuscita: ${(await ammissione.text()).slice(0, 300)}`,
      ).toBe(200);
      expect((await ammissione.json()).stato, 'dopo l’ammissione lo stato è «ammessa»').toBe('ammessa');

      // ── 6. LA CAMPANELLA DELLA FAMIGLIA ────────────────────────────────────
      //
      // È la metà che rende vera l'altra: una riga cambiata in tabella che
      // nessuno annuncia lascia la famiglia a credersi ancora in lista d'attesa.
      // Si aspetta la PRESENZA della notifica, mai l'assenza di un errore: un
      // `waitFor` su un'assenza è già vero mentre la richiesta è in volo.
      await expect
        .poll(
          async () => {
            const res = await secondaFamiglia.get('/api/notifiche', { timeout: RENDER });
            if (!res.ok()) return [];
            const { data } = (await res.json()) as { data?: Array<{ tipo: string; entita_id: string | null }> };
            return (data ?? [])
              .filter((nota) => nota.entita_id === avvisoId)
              .map((nota) => nota.tipo);
          },
          {
            message: 'la famiglia ammessa dalla coda non ha ricevuto `adesione_ammessa` in campanella',
            timeout: 30_000,
          },
        )
        .toContain('adesione_ammessa');
    }

    // ── 7. L'export: 200 alla segreteria, 403 al docente ─────────────────────
    //
    // Il 403 del docente NON dipende dallo schema: è `requireStaff`, la prima
    // riga dell'handler, e vale anche su un database non migrato. È quindi
    // l'unica metà di questo spec che resta una misura vera in ogni ambiente.
    const esportaDocente = await docente.get(`/api/avvisi/${avvisoId}/risposte/esporta`, { timeout: RENDER });
    expect(
      esportaDocente.status(),
      'un docente non scarica l’elenco dei minori: sulle adesioni resta in sola lettura',
    ).toBe(403);

    const esportaAdmin = await admin.get(`/api/avvisi/${avvisoId}/risposte/esporta`, { timeout: RENDER });
    if (degradato) {
      // Su un DB non migrato la lettura di `stato_adesione`/`in_coda_dal` cade
      // con `42703` e la route risponde 503. Si accetta SOLO qui, e solo perché
      // il degrado è già stato dichiarato sopra: un `toBeLessThan(600)` avrebbe
      // accettato qualunque cosa in qualunque ambiente.
      expect([200, 503]).toContain(esportaAdmin.status());
    } else {
      expect(esportaAdmin.status(), 'la segreteria deve poter esportare l’elenco').toBe(200);
      expect(
        esportaAdmin.headers()['content-disposition'],
        'senza `attachment` il CSV si apre nella scheda del browser invece di scaricarsi, ' +
          'e resta nella cronologia di un computer di segreteria usato da più persone',
      ).toBe(`attachment; filename="adesioni-${avvisoId}.csv"`);
      expect(esportaAdmin.headers()['content-type']).toContain('text/csv');
      // È un elenco di minori: non deve finire in nessuna cache condivisa.
      expect(esportaAdmin.headers()['cache-control']).toBe('no-store');

      const csv = await esportaAdmin.text();
      // L'intestazione è il contratto del file. `etichetta_numero` è una colonna
      // a sé, scritta dalla segreteria: se manca, chi conta le sedie legge un
      // numero senza sapere di cosa sia il numero.
      expect(csv.split('\n')[0]).toContain('Stato adesione');
      // La famiglia appena ammessa dalla coda esce come «Confermata»: è lo stato
      // in chiaro, non il valore di colonna, perché a leggere il file è una
      // persona che deve contare le sedie.
      expect(csv).toContain('Confermata');
    }

    // ── 8. Ripulitura ────────────────────────────────────────────────────────
    // L'avviso creato qui resta altrimenti nella bacheca del seed e si somma a
    // ogni run: il seed ripulisce ciò che semina, non ciò che gli spec creano.
    await admin.delete(`/api/avvisi/${avvisoId}`, { timeout: RENDER }).catch(() => undefined);
  } finally {
    await Promise.all(contesti.map((ctx) => ctx.close()));
  }
});
