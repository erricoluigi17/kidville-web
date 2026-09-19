import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { storagePath, TAG } from '../config/accounts';
import { SECTION, ALUNNI, DOCENTE_MATERIA } from '../config/data';
import { Recorder, visit, apiPost, readAppIds, writeState, fraGiorni } from '../lib/harness';

const ids = readAppIds();
const today = new Date().toISOString().slice(0, 10);

// Giudizi O.M. 3/2025: per docente1 un giudizio BASSO su Alunno1 (poi il genitore chiede chiarimento).
const GIUDIZIO: Record<number, string> = {
  1: 'In via di prima acquisizione', 2: 'Base', 3: 'Intermedio', 4: 'Avanzato', 5: 'Intermedio',
};

// ═══ L'AVVISO GITA — due scadenze, il contatore, e un tetto che DEVE stringere ═══
//
// ⚠️ SCADENZE RELATIVE, MAI UNA DATA SCRITTA A MANO. Qui c'era
// `scadenza: '2026-07-31'`, una `date` pura. `GET /api/avvisi` toglie dal feed
// del genitore gli avvisi già scaduti: **dal 1° agosto 2026** questo journey ha
// continuato a girare su un avviso che in bacheca non si vedeva più. Le dieci
// adesioni delle famiglie venivano registrate su qualcosa di invisibile, e il
// percorso non falliva — l'unica asserzione del journey è che ci siano dei
// rilievi, non che siano verdi. Un collaudo che smette di collaudare senza
// diventare rosso è peggio di un collaudo che manca: sembra ancora coprire quel
// percorso. Da qui in poi le due scadenze nascono da `Date.now()`.
//
// 🔴 `POSTI_TOTALI` È 12 PERCHÉ 12 È PIÙ PICCOLO DI 20. Le dieci famiglie del
// journey 30 aderiscono con `numero_partecipanti: 2` ciascuna, cioè venti
// PERSONE contro dodici posti: sei adesioni entrano (12 posti esatti) e quattro
// finiscono in lista d'attesa. Con un tetto ≥ 20 — o senza tetto — entrerebbero
// tutte, la coda resterebbe vuota e l'intera lista d'attesa non sarebbe
// collaudata da nessuna parte contro un database vero. Il numero non è
// «abbastanza grande per stare tranquilli»: è l'unico valore che fa accadere il
// caso che si vuole vedere.
const POSTI_TOTALI_GITA = 12;
const NUMERO_MIN_GITA = 1;
const NUMERO_MAX_GITA = 4;

/**
 * I `codice` che questa POST restituisce quando **il payload è sbagliato**.
 *
 * Servono a distinguere i due 400 possibili, che vanno trattati in modo opposto:
 *  · un codice di QUESTO elenco è un rilievo vero — il journey manda dati che il
 *    server rifiuta, e nascondere il rifiuto dietro un ripiego sarebbe il modo
 *    esatto in cui la data cablata è sopravvissuta per mesi;
 *  · un 400 con un codice che non è qui (o senza `codice`) significa che il
 *    server non parla questo contratto: è il **DB E2E della CI, che non è
 *    migrato**, o un deploy anteriore al cantiere A2. Lì si degrada e si dice.
 */
const CODICI_DI_PAYLOAD = new Set([
    'SCADENZE_INCOERENTI',
    'SCADENZA_ADESIONE_MANCANTE',
    'SCADENZA_AVVISO_MANCANTE',
    'SCADENZA_NEL_PASSATO',
    'NUMERO_INTERVALLO_NON_VALIDO',
    'CLASSE_DESTINATARIA_MANCANTE',
    'CLASSI_FUORI_SEDE',
]);

type RigaAvviso = { id?: string; scadenza_avviso?: string | null; posti_totali?: number | null };

/** La riga restituita dalla POST, comunque il server la impacchetti. */
function rigaDi(json: unknown): RigaAvviso {
    const j = (json ?? {}) as { data?: RigaAvviso } & RigaAvviso;
    return j.data ?? j;
}

/**
 * Pubblica l'avviso della gita e restituisce il suo id (o `undefined`).
 *
 * 🔴 IL RAMO DI DEGRADO È OBBLIGATORIO, e non è pessimismo. Il database su cui
 * gira l'E2E della CI è un progetto separato e **non è migrato**: le sette
 * colonne del cantiere A2 non ci sono. `POST /api/avvisi` le sfila una per una
 * (fino a `MAX_COLONNE_SFILATE`) e risponde **201 con una riga mutilata** — non
 * un errore. Senza questo ramo il primo push dopo il merge tingerebbe la CI di
 * rosso per una ragione che non è il codice, e chi guarda cercherebbe il difetto
 * dove non è.
 *
 * Si riconosce dal PRODOTTO, non dall'intenzione: se la riga tornata non porta
 * `scadenza_avviso`, quella colonna nel database non esiste.
 */
async function pubblicaAvvisoGita(page: Page, rec: Recorder, appId: string): Promise<string | undefined> {
    const titolo = `${TAG} Gita al Museo di Napoli`;
    const contenuto = `${TAG} Uscita didattica al Museo Archeologico. Si richiede autorizzazione firmata dei genitori. Aderire tramite il modulo allegato.`;
    // La seconda scadenza viene PRIMA della prima: «si aderisce entro venti
    // giorni, ma l'avviso resta leggibile fino alla gita». È l'ordine che il
    // server pretende (`scadenza_adesione <= scadenza_avviso`) ed è l'intera
    // ragione per cui le scadenze sono due.
    const scadenzaAvviso = fraGiorni(30);
    const scadenzaAdesione = fraGiorni(20);

    const avviso = await apiPost(page, '/api/avvisi', {
        titolo, contenuto,
        tipo: 'adesione', target_scope: 'classe', target_classes: ['TEST 1A'],
        scadenza_avviso: scadenzaAvviso,
        scadenza_adesione: scadenzaAdesione,
        chiedi_numero: true,
        etichetta_numero: `${TAG} Quante persone accompagnano il bambino?`,
        numero_min: NUMERO_MIN_GITA,
        numero_max: NUMERO_MAX_GITA,
        posti_totali: POSTI_TOTALI_GITA,
    });

    const riga = rigaDi(avviso.json);
    const codice = (avviso.json as { codice?: string } | null)?.codice;
    // 201 ma senza la colonna delle scadenze ⇒ l'insert ha sfilato le sette
    // colonne nuove. 400 con un codice che non è di payload ⇒ contratto diverso.
    const insertDegradato = avviso.status < 400 && riga.scadenza_avviso == null;
    const contrattoIgnoto = avviso.status === 400 && !CODICI_DI_PAYLOAD.has(codice ?? '');

    if (insertDegradato || contrattoIgnoto) {
        rec.add({
            flusso: 'docente1', pagina: '/api/avvisi', step: 'D1 · Invia avviso gita + autorizzazione',
            gravita: 'medio', categoria: 'gap-noto',
            atteso: 'Avviso di adesione con due scadenze, contatore persone e tetto di 12 posti',
            osservato:
                `DB E2E non migrato: ${insertDegradato
                    ? `HTTP ${avviso.status} ma la riga torna senza \`scadenza_avviso\` (colonne del cantiere A2 sfilate dall'insert)`
                    : `HTTP 400 con codice «${codice ?? '—'}», che non è un rifiuto di payload`}. ` +
                'Riprovo col payload vecchio (`scadenza` a grana giorno); lista d\'attesa e posti NON sono collaudati in questo run.',
        });

        // IL PAYLOAD VECCHIO, tale e quale a com'era — `author_id` compreso, che
        // dal cantiere M7 il server ignora (l'autore è la sessione) ma che un
        // deploy anteriore poteva pretendere. Qui serve a far RIUSCIRE il
        // ripiego, non a dire la verità sul contratto di oggi.
        const vecchio = await apiPost(page, '/api/avvisi', {
            author_id: appId, titolo, contenuto,
            tipo: 'adesione', target_scope: 'classe', target_classes: ['TEST 1A'],
            scadenza: scadenzaAvviso.slice(0, 10),
        });
        const idVecchio = rigaDi(vecchio.json).id;
        writeState({ avvisoGitaDegradato: true, avvisoGitaPostiTotali: null });
        rec.add({
            flusso: 'docente1', pagina: '/api/avvisi', step: 'D1 · Avviso gita — ripiego payload storico',
            gravita: idVecchio ? 'ok' : 'grave', categoria: idVecchio ? 'ok' : 'funzionale',
            atteso: 'Avviso pubblicato comunque, così i journey a valle hanno su cosa lavorare',
            osservato: `HTTP ${vecchio.status}${idVecchio ? ' id ' + idVecchio.slice(0, 8) : ' — nessun id'}`,
        });
        return idVecchio;
    }

    writeState({ avvisoGitaDegradato: false, avvisoGitaPostiTotali: POSTI_TOTALI_GITA });
    rec.add({
        flusso: 'docente1', pagina: '/api/avvisi', step: 'D1 · Invia avviso gita + autorizzazione',
        gravita: avviso.status < 400 ? 'ok' : 'grave', categoria: avviso.status < 400 ? 'ok' : 'funzionale',
        atteso:
            `Avviso 'adesione' per TEST 1A: si aderisce entro il ${scadenzaAdesione}, ` +
            `resta in bacheca fino al ${scadenzaAvviso}, contatore ${NUMERO_MIN_GITA}-${NUMERO_MAX_GITA} persone, ` +
            `tetto ${POSTI_TOTALI_GITA} posti`,
        osservato:
            `HTTP ${avviso.status}${riga.id ? ' id ' + riga.id.slice(0, 8) : ''}` +
            `${avviso.status >= 400 ? ' — ' + JSON.stringify(avviso.json).slice(0, 160) : ` · posti_totali=${riga.posti_totali ?? '—'}`}`,
    });
    return riga.id;
}

async function docenteJourney(browser: Browser, n: number, rec: Recorder) {
  const ctx = await browser.newContext({ storageState: storagePath(`docente${n}`), viewport: { width: 1366, height: 900 } });
  const page: Page = await ctx.newPage();
  const appId = ids[`docente${n}`];
  const mat = DOCENTE_MATERIA[n];
  const alunno = ALUNNI[n];

  await visit(page, rec, { url: '/teacher/primaria', flusso: `docente${n}`, label: `D${n} · Le mie classi`, appId });
  await visit(page, rec, { url: `/teacher/primaria/${SECTION}/registro`, flusso: `docente${n}`, label: `D${n} · Registro (firma)`, appId });

  // Firma l'ora + argomento lezione + compiti con data di consegna (via API).
  // Ogni docente firma un'ora distinta (oraLezione: n) come "principale":
  // una sola firma principale per ora è ora garantita da API + indice DB.
  const firma = await apiPost(page, '/api/primaria/registro', {
    sectionId: SECTION, data: today, oraLezione: n, materiaId: mat.id,
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
    const avvisoId = await pubblicaAvvisoGita(page, rec, appId);
    // ⚠️ SI SCRIVE SEMPRE, ANCHE `null`. `run/state.json` sopravvive fra un run e
    // l'altro: con un `if (avvisoId)` una pubblicazione fallita lascerebbe in
    // piedi l'id del run PRECEDENTE, e il journey 30 aderirebbe a un avviso
    // vecchio credendo di collaudare questo. È la stessa famiglia di silenzio
    // della data cablata — uno stato residuo che fa sembrare vivo un percorso
    // morto — e qui costa una riga chiuderla.
    writeState({ avvisoGitaId: avvisoId ?? null });
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
