/**
 * seed-e2e.mjs — seed deterministico per la suite Playwright (M8.2).
 *
 * Crea DUE scuole E2E dedicate (UUID fissi, prefisso e2e00000-…) e i dati di
 * contorno che gli spec si aspettano (avviso, evento agenda, presenze,
 * pagamenti, armadietto, diario, notifica, modello+submission). Idempotente:
 * upsert su UUID fissi + reset dei soli dati E2E mutati dai test. NON tocca i
 * dati delle altre scuole.
 *
 * ── PERCHÉ LE SEDI SONO DUE (dal 2026-07-31, rilievo R132) ──────────────────
 * Fino a oggi il seed creava UNA sola scuola. Conseguenza: nessuno spec
 * Playwright poteva accorgersi di una perdita di dati fra sedi — non perché
 * l'isolamento fosse dimostrato, ma perché non c'era una seconda sede da cui
 * far entrare qualcosa. Il gate era verde per costruzione.
 * La seconda sede (`SCUOLA2`) esiste per rendere quel controllo POSSIBILE, e ha
 * di proposito una sezione OMONIMA («Girasoli») di una della prima: il nome
 * classe è la chiave con cui mezzo prodotto risolve una sezione, e con tre
 * plessi in produzione non identifica più niente. È il caso che il 2026-07-29
 * ha attivato le falle dormienti. La spec che lo verifica è
 * `e2e/isolamento-sedi.spec.ts`.
 *
 * Uso (dalla root del repo): node scripts/seed-e2e.mjs
 * Env richieste (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { requireE2EPassword } from '../e2e/lib/e2e-password.mjs';

// ── Env: process.env (CI) con fallback a .env.local (dev locale) ────────────
function loadEnvLocal() {
  const env = {};
  let raw;
  try {
    raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    return env; // in CI .env.local non esiste: si usano le env di processo
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const fileEnv = loadEnvLocal();
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL || fileEnv.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !SERVICE_KEY) {
  console.error('Mancano NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (env di processo o .env.local)');
  process.exit(1);
}

const db = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } });

// ── UUID fissi (prefisso e2e00000 = non-demo, esadecimale valido) ───────────
export const IDS = {
  SCUOLA: 'e2e00000-0000-4000-8000-000000000001',
  /**
   * ⚠️ LA SEDE CHE NON SI DICHIARA DI COLLAUDO — e il perché è tutto qui.
   *
   * `isScuolaE2E` (src/lib/scuole/reali.ts) riconosce una sede se l'id comincia
   * per `e2e00000` OPPURE se il nome contiene «e2e», e `sediReali` la toglie da
   * ogni elenco pubblico. Le due sedi qui sopra cadono in ENTRAMBI i criteri: è
   * voluto, perché una scrittura anonima su un plesso finto che in produzione
   * ESISTE non deve essere possibile.
   *
   * Conseguenza misurata: sul database della CI `sediReali` restituisce l'elenco
   * VUOTO, `GET /api/iscrizione/sedi` risponde `{data: []}`, e i due moduli
   * pubblici (`/iscrizione` a parte, che valida su `tutte`) non dipingono nemmeno
   * il primo passo. Il percorso felice di `/lavora-con-noi` è stato per questo in
   * `test.fixme` da quando è nato, e `/anagrafica-personale` non era collaudabile
   * affatto.
   *
   * Questa terza sede esiste per quello, e per niente altro: id che NON comincia
   * per `e2e00000` e nome che NON contiene «e2e», così `sediReali` la accetta e i
   * moduli pubblici hanno dove atterrare. È sicura perché **il progetto Supabase
   * della CI è separato dalla produzione**: questa riga non apre niente là.
   *
   * Il nome è esplicito («Plesso di Collaudo») perché chi la vedesse in un elenco
   * senza spiegazione la scambierebbe per una sede vera — ma NON contiene «e2e»,
   * altrimenti il criterio la riprenderebbe e non servirebbe a niente.
   */
  SCUOLA_COLLAUDO: 'c0110a0d-0000-4000-8000-000000000001',
  SEC_GIRASOLI: 'e2e00000-0000-4000-8000-000000000011',
  SEC_TULIPANI: 'e2e00000-0000-4000-8000-000000000012',
  // Sezione DEDICATA agli alunni importati dal flusso pubblico d'iscrizione:
  // isola il loro conteggio da Girasoli/Tulipani (l'appello docente su Girasoli
  // esige esattamente 2 alunni → "Completo"). Vedi public-iscrizione.spec.ts.
  SEC_ISCRIZIONE: 'e2e00000-0000-4000-8000-000000000013',
  /**
   * ⚠️ LA SEZIONE CHE ESISTE PER NON ESSERE QUELLA DEL DOCENTE-GENITORE.
   *
   * Ci sta UN bambino solo: il figlio del profilo doppio (`A5`). Non poteva
   * andare da nessun'altra parte, e le tre alternative sono tutte sbagliate per
   * un motivo diverso:
   *  · `SEC_TULIPANI` è LA SEZIONE CHE IL DOPPIO INSEGNA — ed è esattamente il
   *    difetto che questa sezione ripara (vedi il blocco sui legami, più sotto);
   *  · `SEC_GIRASOLI` ha un conteggio ESATTO in tre spec
   *    (`teacher-attendance` pretende «Completo» a 2/2,
   *    `isolamento-sedi` pretende l'insieme `[A1, A2]` carattere per carattere);
   *  · `SEC_ISCRIZIONE` è la parcheggio degli import pubblici, e un residuo fisso
   *    lì dentro cambierebbe ciò che `public-iscrizione.spec.ts` trova.
   *
   * L'omonimia con `SEC2_MARGHERITE` è VOLUTA, per la stessa ragione per cui
   * «Girasoli» esiste in entrambe le sedi: i due figli del doppio stanno in due
   * classi che si chiamano UGUALE in due plessi diversi, e ogni rotta che risolve
   * la sede dal nome-classe invece che dal bambino sbaglia in modo visibile.
   */
  SEC_MARGHERITE: 'e2e00000-0000-4000-8000-000000000014',
  A1: 'e2e00000-0000-4000-8000-000000000101', // Aurora Arcobaleno-E2E (Girasoli)
  A2: 'e2e00000-0000-4000-8000-000000000102', // Bruno Baleno-E2E (Girasoli)
  A3: 'e2e00000-0000-4000-8000-000000000103', // Clara Cometa-E2E (Tulipani)
  A4: 'e2e00000-0000-4000-8000-000000000104', // Dino Delfino-E2E (Tulipani)
  // ⚠️ `…105` è già di B1 (sede 2), qualche riga più sotto: A5 e B2 partono da 106.
  A5: 'e2e00000-0000-4000-8000-000000000106', // Fiore Fiocco-E2E — figlio del DOPPIO, ALTRA SEZIONE (Margherite, sede 1)
  B2: 'e2e00000-0000-4000-8000-000000000107', // Gigi Girandola-E2E — figlio del DOPPIO, ALTRA SEDE (Margherite, sede 2)
  ADMIN: 'e2e00000-0000-4000-8000-000000000201',
  DOCENTE: 'e2e00000-0000-4000-8000-000000000202',
  GENITORE: 'e2e00000-0000-4000-8000-000000000203',
  DOPPIO: 'e2e00000-0000-4000-8000-000000000204',
  P_GENITORE: 'e2e00000-0000-4000-8000-000000000301',
  P_DOPPIO: 'e2e00000-0000-4000-8000-000000000302',
  AVVISO: 'e2e00000-0000-4000-8000-000000000401',
  EVENTO: 'e2e00000-0000-4000-8000-000000000501',
  NOTIFICA: 'e2e00000-0000-4000-8000-000000000601',
  NOTIFICA_GENITORE: 'e2e00000-0000-4000-8000-000000000602',
  NOTIFICA_DOCENTE: 'e2e00000-0000-4000-8000-000000000603',
  PAG_APERTO: 'e2e00000-0000-4000-8000-000000000701',
  PAG_PAGATO: 'e2e00000-0000-4000-8000-000000000702',
  FORM_MODEL: 'e2e00000-0000-4000-8000-000000000801',
  FORM_SUB: 'e2e00000-0000-4000-8000-000000000802',
  DIARIO_UMORE: 'e2e00000-0000-4000-8000-000000000901',
  DIARIO_ATTIVITA: 'e2e00000-0000-4000-8000-000000000902',
  // Il diario del figlio del profilo doppio: senza una voce, «il diario si apre»
  // e «il diario è vuoto» si somigliano troppo per essere un'asserzione.
  DIARIO_A5: 'e2e00000-0000-4000-8000-000000000903',

  // ── Media di galleria, uno per sede ───────────────────────────────────────
  // Servono a distinguere «200 con la galleria del figlio» da «200 con la lista
  // vuota», che è il difetto peggiore perché somiglia a «non ci sono ancora
  // foto». Nessuno dei due è `is_broadcast`: sono TAGGATI sul singolo bambino,
  // così non compaiono nel diario/galleria degli altri alunni delle due sedi e
  // non muovono nessuno spec esistente.
  MEDIA_A5: 'e2e00000-0000-4000-8000-000000001001',
  MEDIA_B2: 'e2e00000-0000-4000-8000-000000001002',

  // ── Menu mensa di OGGI, uno per sede ──────────────────────────────────────
  // Due primi DIVERSI nello stesso giorno: è l'unico modo di distinguere «il
  // menu del plesso del FIGLIO» da «il menu di `utenti.scuola_id` del genitore»
  // guardando la risposta invece del codice. Sono `override` per data, quindi
  // valgono anche di sabato e di domenica (la rotazione no).
  MENU_OVR_S1: 'e2e00000-0000-4000-8000-000000001101',
  MENU_OVR_S2: 'e2e00000-0000-4000-8000-000000001102',

  // ── SEDE 2 — la sede che l'isolamento deve tenere fuori ───────────────────
  // Stesso prefisso `e2e00000`: `isScuolaE2E` (src/lib/scuole/reali.ts) riconosce
  // la scuola di collaudo dal PREFISSO (o da «e2e» nel nome), non dall'uuid
  // intero — quindi anche questa resta fuori dagli elenchi pubblici (il
  // selettore di sede del wizard /iscrizione) senza toccare una riga di prodotto.
  SCUOLA2: 'e2e00000-0000-4000-8000-000000000002',
  // OMONIMA di SEC_GIRASOLI: stesso nome, altra sede. È il cuore della prova.
  SEC2_GIRASOLI: 'e2e00000-0000-4000-8000-000000000021',
  /**
   * OMONIMA di `SEC_MARGHERITE`, e non ci va per caso: ci sta il SECONDO figlio
   * del profilo doppio, quello dell'altro plesso. Non è `SEC2_GIRASOLI` perché
   * `isolamento-sedi.spec.ts` pretende che l'elenco della maestra della sede 2
   * sia ESATTAMENTE `[B1]` — mettere qui un secondo bambino renderebbe rosso uno
   * spec che parla d'altro.
   */
  SEC2_MARGHERITE: 'e2e00000-0000-4000-8000-000000000022',
  B1: 'e2e00000-0000-4000-8000-000000000105', // Emma Eclissi-E2E (Girasoli, sede 2)
  // La segreteria della sede 1: l'admin E2E vedrebbe le stesse righe, ma il
  // ruolo che in produzione sta allo sportello — e che il modello del 2026-07-30
  // limita alla SOLA propria sede — è questo.
  SEGRETERIA: 'e2e00000-0000-4000-8000-000000000205',
  SEGRETERIA2: 'e2e00000-0000-4000-8000-000000000206',
  DOCENTE2: 'e2e00000-0000-4000-8000-000000000207',
  GENITORE2: 'e2e00000-0000-4000-8000-000000000208',
  P_GENITORE2: 'e2e00000-0000-4000-8000-000000000303',
  AVVISO_S2: 'e2e00000-0000-4000-8000-000000000402',
};

export const CREDENZIALI = {
  // Dall'ambiente, mai dal repo: `KV_E2E_PASSWORD` (in CI, secret CI_E2E_PASSWORD).
  // Assente ⇒ lo script esce con exit 1 — vedi e2e/lib/e2e-password.mjs per il
  // perché (il 29/07 questo account è finito in Direzione su due sedi VERE).
  password: requireE2EPassword(),
  admin: 'admin.e2e@kidville.test',
  docente: 'docente.e2e@kidville.test',
  genitore: 'genitore.e2e@kidville.test',
  doppio: 'doppio.e2e@kidville.test',
  // Sede 1: la segreteria (percorso 1 di e2e/isolamento-sedi.spec.ts).
  segreteria: 'segreteria.e2e@kidville.test',
  // Sede 2: personale e famiglia PROPRI, nessun ponte `utenti_scuole` verso la
  // sede 1 — l'isolamento si prova fra utenti che hanno una sede sola, com'è in
  // produzione per segreteria ed educator.
  segreteria2: 'segreteria2.e2e@kidville.test',
  docente2: 'docente2.e2e@kidville.test',
  genitore2: 'genitore2.e2e@kidville.test',
};

// Artefatti del flusso pubblico di iscrizione (creati DAI TEST, puliti qui).
export const ISCRIZIONE_E2E = {
  cfChild: 'TSTBNE20A01H501X',
  cfAdult: 'TSTDLT80A01H501Y',
  email: 'iscrizione.e2e@kidville.test',
};

/**
 * Le identità dei due moduli pubblici del PERSONALE — `/lavora-con-noi`
 * (candidatura) e `/anagrafica-personale` (anagrafica di chi è già assunto).
 *
 * ⚠️ FISSE E NON GENERATE, di proposito. Su entrambe le tabelle esiste un indice
 * unico PARZIALE su `lower(email)` limitato agli stati vivi, e le due rotte
 * pubbliche traducono il duplicato `23505` in **201, come al primo invio** (per
 * non fare da oracolo su chi lavora qui). Con un'email generata a ogni run il
 * duplicato non si verificherebbe mai e quel ramo resterebbe non collaudato; con
 * un'email fissa si verifica — ed è per questo che il reset qui sotto deve
 * cancellare ESATTAMENTE questi indirizzi. Se uno spec ne usa un altro, il run
 * successivo parte da uno stato sporco e passa per il motivo sbagliato.
 */
export const PERSONALE_E2E = {
  /** `/anagrafica-personale`: la pratica che il percorso felice invia. */
  emailPratica: 'anagrafica.e2e@kidville.test',
  /** `/anagrafica-personale`: la pratica che il cockpit approva (spec separato). */
  emailApprovazione: 'approvazione.e2e@kidville.test',
  /** `/lavora-con-noi`: la candidatura, già usata dallo spec esistente. */
  emailCandidatura: 'candidatura.e2e@kidville.test',
};

/**
 * Le ÀNCORE del profilo doppio: didascalie e primi piatti, uno per sede.
 *
 * ⚠️ SONO DATO DEL SEED, NON TESTO DI CATALOGO, ed è il punto. Uno spec che
 * asserisce su una frase dei `messages/` diventa rosso alla prima riscrittura
 * editoriale — è già successo due volte in questo repo (i puntini `...` → `…`,
 * l'apostrofo dritto → tipografico). Queste stringhe le scrive il seed e le
 * rilegge lo spec: se cambiano, cambiano insieme.
 *
 * Sono anche DIVERSE fra le due sedi di proposito: «c'è del contenuto» sarebbe
 * verde anche col contenuto dell'altro plesso. La differenza è ciò che rende
 * l'isolamento osservabile dalla risposta, non deducibile dal codice.
 */
export const DOPPIO_PROFILO_E2E = {
  /** Didascalia del media taggato su `A5` (sede 1). */
  fotoSede1: 'Foto E2E · Margherite della sede 1',
  /** Didascalia del media taggato su `B2` (sede 2). */
  fotoSede2: 'Foto E2E · Margherite della sede 2',
  /** Primo piatto dell'override mensa di OGGI nella sede 1. */
  primoSede1: 'Pasta E2E della sede 1',
  /** Primo piatto dell'override mensa di OGGI nella sede 2. */
  primoSede2: 'Riso E2E della sede 2',
  /** Nota di diario di `A5`: prova che il diario del figlio si APRE e ha contenuto. */
  notaDiarioA5: 'Nota E2E per il genitore-docente',
};

// Perimetri di reset: TUTTI gli alunni e TUTTI gli utenti E2E, sede 2 inclusa —
// un reset che dimentica la seconda sede lascia indietro dati fra un run e
// l'altro, e un test d'isolamento che vede residui non dimostra niente.
const ALUNNI_E2E = [IDS.A1, IDS.A2, IDS.A3, IDS.A4, IDS.B1, IDS.A5, IDS.B2];
const UTENTI_E2E = [
  IDS.ADMIN, IDS.DOCENTE, IDS.GENITORE, IDS.DOPPIO, IDS.SEGRETERIA,
  IDS.SEGRETERIA2, IDS.DOCENTE2, IDS.GENITORE2,
];
/** I record ANAGRAFICI (`parents`) del seed: perimetro del reset di `student_parents`. */
const PARENTS_E2E = [IDS.P_GENITORE, IDS.P_DOPPIO, IDS.P_GENITORE2];
/** Autori degli avvisi creati DAI TEST (la bacheca docente pubblica davvero). */
const AUTORI_AVVISI_TEST = [IDS.DOCENTE, IDS.DOCENTE2];

/**
 * Il giorno NEL FUSO DELL'ISTITUTO, come `oggiFiscaleISO()` lato prodotto.
 *
 * ⚠️ Era `ymdUTC`, e fra la mezzanotte e le due italiane seminava IERI.
 * Misurato il 2026-08-09 alle 00:04: il seed scriveva le presenze del giorno
 * 2026-08-08 (UTC) e `/api/admin/presenze/realtime` — che usa Europe/Rome —
 * cercava quelle del 2026-08-09. Nessuna riga, KPI a zero, e
 * `admin-dashboard.spec.ts` rosso tre volte di fila su un prodotto sano.
 * Cioè: **per due ore ogni notte l'E2E delle presenze non poteva passare.**
 *
 * È la terza faccia della stessa trappola, tutta nella stessa notte: il test
 * unitario che confrontava in UTC, il filtro che passava per coincidenza, e
 * questo. Il repo la conosce da tempo — `ComunicaAssenzaCard` la cita nel
 * proprio commento («`new Date().toISOString()` fra la mezzanotte e le due
 * italiane restituisce IERI») — ma la conosceva nel PRODOTTO, non nel banco di
 * prova. Un banco che vive in un altro fuso dal prodotto misura un altro
 * prodotto.
 *
 * `sv-SE` non è un vezzo: è l'unico locale che `Intl` formatta già come
 * `YYYY-MM-DD`, quindi non serve ricomporre i pezzi a mano.
 */
function ymdRoma(offsetGiorni = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetGiorni);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(d);
}

function must(label, { error }) {
  if (error) throw new Error(`${label}: ${error.message ?? JSON.stringify(error)}`);
}

// Auth user con UUID fisso: createUser accetta `id`; se esiste già, reset password.
async function ensureAuthUser(id, email) {
  const { error } = await db.auth.admin.createUser({
    id,
    email,
    password: CREDENZIALI.password,
    email_confirm: true,
  });
  if (!error) return console.log(`  auth ✚ ${email}`);
  const testo = `${error.message ?? ''} ${error.code ?? ''}`;
  if (/already|exists|registered/i.test(testo)) {
    const upd = await db.auth.admin.updateUserById(id, {
      password: CREDENZIALI.password,
      email_confirm: true,
    });
    must(`auth update ${email}`, upd);
    return console.log(`  auth = ${email}`);
  }
  throw new Error(`auth create ${email}: ${error.message}`);
}

// Bucket Storage privati usati dall'app ma NON auto-creati dalle route
// (form_attachments, chat-allegati, fatture): senza questi gli upload E2E
// falliscono con "Bucket not found". Idempotente.
async function ensureBuckets() {
  for (const name of ['form_attachments', 'chat-allegati', 'fatture']) {
    const { error } = await db.storage.createBucket(name, { public: false });
    if (error && !/exist|already|duplicate/i.test(error.message ?? '')) {
      console.error(`bucket ${name}:`, error.message);
    }
  }
}

/**
 * Ripulisce ciò che i moduli pubblici del personale lasciano dietro.
 *
 * Tollera la TABELLA ASSENTE (`PGRST205`/`42P01`) invece di far morire il seed:
 * vedi il commento nel punto in cui viene chiamata. Ogni altro errore si stampa
 * ma non ferma — una pulizia che non riesce produce al massimo un test rosso
 * leggibile, mentre un `throw` qui spegne l'intera suite.
 *
 * L'ORDINE È QUELLO DELLE CHIAVI ESTERNE, e non è intercambiabile:
 *   `caricamenti_personale.pratica_id → pratiche_personale.id` (on delete cascade)
 *   `pratiche_personale.utente_id`/`evasa_da` → `utenti.id`
 *   `anagrafica_personale.utente_id → utenti.id` (on delete cascade)
 * Quindi: prima le pratiche e le candidature (che si portano via il registro per
 * cascata e liberano i riferimenti a `utenti`), poi gli account che
 * l'approvazione ha creato — e con loro l'anagrafica, di nuovo per cascata.
 */
async function ripulisciModuliPersonale() {
  const emails = [
    PERSONALE_E2E.emailPratica,
    PERSONALE_E2E.emailApprovazione,
    PERSONALE_E2E.emailCandidatura,
  ];
  const assente = (e) => /PGRST205|42P01|does not exist|schema cache/i.test(
    `${e?.code ?? ''} ${e?.message ?? ''}`,
  );

  for (const tabella of ['pratiche_personale', 'candidature_insegnanti']) {
    const { error } = await db.from(tabella).delete().in('email', emails);
    if (error) {
      if (assente(error)) console.warn(`↷ reset saltato: la tabella ${tabella} non esiste su questo database`);
      else console.error(`reset ${tabella}:`, error.message);
    }
  }

  // Gli account che l'approvazione ha creato. `anagrafica_personale` se ne va per
  // cascata; l'utente `auth` va tolto a parte, o al run successivo
  // `ensureStaffIdentity` troverebbe un'identità orfana e riuserebbe quella.
  const { data: creati, error: erroreLettura } = await db
    .from('utenti').select('id').in('email', emails);
  if (erroreLettura) {
    if (!assente(erroreLettura)) console.error('lettura utenti dei moduli personale:', erroreLettura.message);
    return;
  }
  for (const u of creati ?? []) {
    const { error } = await db.from('utenti').delete().eq('id', u.id);
    if (error) console.error('reset utenti dei moduli personale:', error.message);
    await db.auth.admin.deleteUser(u.id).catch(() => {});
  }
}

/**
 * I due media di galleria dei figli del profilo doppio — uno per sede.
 *
 * ─── PERCHÉ NON BASTA CONTROLLARE LO STATO ──────────────────────────────────
 *
 * `GET /api/gallery?studentId=…` risponde **200 con `{media: [], total: 0}`**
 * tutte le volte che lo scope di sede non risolve: nessun errore, nessun log
 * `warn`, una pagina che dice «non ci sono ancora foto». È il difetto peggiore
 * di tutta la galleria, perché è indistinguibile dal caso normale. Un test che
 * asserisce `status() === 200` lo dichiara sano.
 *
 * ─── PERCHÉ QUESTO BLOCCO NON USA `must()` ──────────────────────────────────
 *
 * `galleria_media_v2.scuola_id` NON è nel baseline: l'ha aggiunta la migrazione
 * `20260714103000_galleria_scuola_id`, e il database E2E della CI è un progetto
 * separato che non viene migrato. Là l'INSERT con quella colonna risponde
 * `PGRST204` — e con `must()` l'INTERA suite morirebbe prima di eseguire un
 * test, per una colonna che in quell'ambiente non esiste. Si riprova senza la
 * sede (che è esattamente il degrado che la rotta fa in lettura, via
 * `colonnaSedeAssente` + `degradoSedeLecito`) e si prosegue.
 *
 * Il degrado NON indebolisce il test: i due media sono TAGGATI sul singolo
 * bambino e non sono `is_broadcast`, quindi il filtro `tag_students.cs.{…}` li
 * tiene separati anche senza la colonna di sede.
 *
 * `file_url` è un PERCORSO nel bucket privato `gallery`, non un indirizzo: è la
 * forma che il prodotto salva da quando il bucket è privato. Il file non esiste,
 * quindi la firma non riuscirà e la rotta restituirà `file_url: null` — la riga
 * esce lo stesso, con la sua didascalia, ed è quella che lo spec legge.
 */
async function seminaGalleriaDoppioProfilo() {
  const righe = (conSede) => [
    {
      id: IDS.MEDIA_A5, uploaded_by: IDS.DOCENTE, file_url: 'uploads/e2e/doppio-profilo-sede1.jpg',
      file_type: 'foto', caption: DOPPIO_PROFILO_E2E.fotoSede1,
      tag_students: [IDS.A5], is_broadcast: false, target_classes: ['Margherite'],
      ...(conSede ? { scuola_id: IDS.SCUOLA } : {}),
    },
    {
      id: IDS.MEDIA_B2, uploaded_by: IDS.DOCENTE2, file_url: 'uploads/e2e/doppio-profilo-sede2.jpg',
      file_type: 'foto', caption: DOPPIO_PROFILO_E2E.fotoSede2,
      tag_students: [IDS.B2], is_broadcast: false, target_classes: ['Margherite'],
      ...(conSede ? { scuola_id: IDS.SCUOLA2 } : {}),
    },
  ];

  const { error } = await db.from('galleria_media_v2').upsert(righe(true), { onConflict: 'id' });
  if (!error) return;

  const codice = `${error.code ?? ''}`;
  if (codice !== 'PGRST204' && codice !== '42703') {
    // Non è «schema più vecchio»: è un guasto, e va detto NOMINANDOLO. Non si
    // interrompe — lo spec della galleria diventerà rosso da solo, con un
    // messaggio che parla di contenuto mancante, e questa riga spiega perché.
    console.error('galleria_media_v2 (seed doppio profilo):', error.message ?? JSON.stringify(error));
    return;
  }
  console.warn('↷ galleria_media_v2 senza `scuola_id` su questo database: reinserisco senza la sede');
  const secondo = await db.from('galleria_media_v2').upsert(righe(false), { onConflict: 'id' });
  if (secondo.error) console.error('galleria_media_v2 (senza sede):', secondo.error.message);
}

async function main() {
  console.log('🌱 Seed E2E — sedi dedicate', IDS.SCUOLA, '+', IDS.SCUOLA2,
    '· sede visibile ai moduli pubblici', IDS.SCUOLA_COLLAUDO);
  const oggi = ymdRoma(0);
  await ensureBuckets();

  // 1. Scuole (schools = tabella referenziata dalle FK; scuole = registry admin)
  must('schools', await db.from('schools').upsert([
    { id: IDS.SCUOLA, nome: 'Kidville E2E', citta: 'Testville' },
    { id: IDS.SCUOLA2, nome: 'Kidville E2E Due', citta: 'Testville Due' },
    // La sede che i moduli pubblici possono vedere: vedi il commento su
    // `IDS.SCUOLA_COLLAUDO`. Senza di lei `sediReali` è vuoto e nessun wizard
    // pubblico comincia.
    { id: IDS.SCUOLA_COLLAUDO, nome: 'Plesso di Collaudo', citta: 'Testville' },
  ], { onConflict: 'id' }));
  must('scuole', await db.from('scuole').upsert([
    { id: IDS.SCUOLA, nome: 'Kidville E2E', citta: 'Testville', attiva: true },
    { id: IDS.SCUOLA2, nome: 'Kidville E2E Due', citta: 'Testville Due', attiva: true },
    // `attiva: true` è necessario quanto la riga in `schools`: `sediReali` scarta
    // le sedi con `scuole.attiva = false`, e una sede presente ma spenta
    // riprodurrebbe esattamente il difetto che questa riga esiste per togliere.
    { id: IDS.SCUOLA_COLLAUDO, nome: 'Plesso di Collaudo', citta: 'Testville', attiva: true },
  ], { onConflict: 'id' }));

  // 2. Config moduli delle SOLE scuole E2E: umore attivo nel diario docente,
  //    pubblicazione avvisi consentita anche ai docenti. Identica sulle due sedi
  //    di proposito: se la sede 2 fosse configurata diversamente, un test
  //    d'isolamento potrebbe passare per la configurazione invece che per il
  //    filtro — cioè essere verde per il motivo sbagliato.
  must('admin_settings', await db.from('admin_settings').upsert([
    {
      scuola_id: IDS.SCUOLA,
      diario_config: {
        routine_attive: ['attivita', 'merenda', 'pranzo', 'nanna_inizio', 'nanna_fine', 'bagno', 'umore'],
      },
      avvisi_config: { ruoli_pubblicazione: ['admin', 'teacher'] },
    },
    {
      scuola_id: IDS.SCUOLA2,
      diario_config: {
        routine_attive: ['attivita', 'merenda', 'pranzo', 'nanna_inizio', 'nanna_fine', 'bagno', 'umore'],
      },
      avvisi_config: { ruoli_pubblicazione: ['admin', 'teacher'] },
    },
  ], { onConflict: 'scuola_id' }));

  // 3. Sezioni (l'appello/diario docente sono agganciati al nome "Girasoli";
  //    "Nuovi Iscritti" è la sezione-parcheggio degli import pubblici).
  //    «Girasoli» esiste in ENTRAMBE le sedi: è l'omonimia che il 2026-07-29 ha
  //    reso il nome-classe una chiave ambigua. A DB l'unicità è per
  //    (scuola_id, name) — migrazione 20260731113406_sections_nome_per_sede —
  //    quindi questi due record convivono per progetto, non per fortuna.
  must('sections', await db.from('sections').upsert([
    { id: IDS.SEC_GIRASOLI, scuola_id: IDS.SCUOLA, name: 'Girasoli', school_type: 'infanzia' },
    { id: IDS.SEC_TULIPANI, scuola_id: IDS.SCUOLA, name: 'Tulipani', school_type: 'infanzia' },
    { id: IDS.SEC_ISCRIZIONE, scuola_id: IDS.SCUOLA, name: 'Nuovi Iscritti', school_type: 'infanzia' },
    { id: IDS.SEC2_GIRASOLI, scuola_id: IDS.SCUOLA2, name: 'Girasoli', school_type: 'infanzia' },
    // «Margherite» in ENTRAMBE le sedi: ci stanno i due figli del profilo doppio,
    // uno per plesso. Nessun docente vi è assegnato — è deliberato: il punto è che
    // quei bambini NON siano in una classe del loro genitore-insegnante.
    { id: IDS.SEC_MARGHERITE, scuola_id: IDS.SCUOLA, name: 'Margherite', school_type: 'infanzia' },
    { id: IDS.SEC2_MARGHERITE, scuola_id: IDS.SCUOLA2, name: 'Margherite', school_type: 'infanzia' },
  ], { onConflict: 'id' }));

  // 4. Utenti Auth reali (login UI con password) + righe utenti (id == auth.users.id)
  await ensureAuthUser(IDS.ADMIN, CREDENZIALI.admin);
  await ensureAuthUser(IDS.DOCENTE, CREDENZIALI.docente);
  await ensureAuthUser(IDS.GENITORE, CREDENZIALI.genitore);
  await ensureAuthUser(IDS.DOPPIO, CREDENZIALI.doppio);
  await ensureAuthUser(IDS.SEGRETERIA, CREDENZIALI.segreteria);
  await ensureAuthUser(IDS.SEGRETERIA2, CREDENZIALI.segreteria2);
  await ensureAuthUser(IDS.DOCENTE2, CREDENZIALI.docente2);
  await ensureAuthUser(IDS.GENITORE2, CREDENZIALI.genitore2);

  // NB: live `utenti.role` è colonna GENERATA da `ruolo` → mai scriverla.
  // Ogni account ha UNA sede primaria, come in produzione per segreteria ed
  // educator. Il multi-sede è della Direzione — e serve in un caso solo, più
  // sotto: il ponte dell'admin verso il «Plesso di Collaudo».
  must('utenti', await db.from('utenti').upsert([
    { id: IDS.ADMIN, email: CREDENZIALI.admin, nome: 'Alba', cognome: 'Admin-E2E', ruolo: 'admin', scuola_id: IDS.SCUOLA, gradi: [], attivo: true },
    { id: IDS.DOCENTE, email: CREDENZIALI.docente, nome: 'Dora', cognome: 'Docente-E2E', ruolo: 'educator', scuola_id: IDS.SCUOLA, gradi: ['infanzia'], attivo: true },
    { id: IDS.GENITORE, email: CREDENZIALI.genitore, nome: 'Gaia', cognome: 'Genitore-E2E', ruolo: 'genitore', scuola_id: IDS.SCUOLA, gradi: [], attivo: true },
    { id: IDS.DOPPIO, email: CREDENZIALI.doppio, nome: 'Duccio', cognome: 'Doppio-E2E', ruolo: 'educator', scuola_id: IDS.SCUOLA, gradi: ['infanzia'], attivo: true },
    { id: IDS.SEGRETERIA, email: CREDENZIALI.segreteria, nome: 'Sara', cognome: 'Segreteria-E2E', ruolo: 'segreteria', scuola_id: IDS.SCUOLA, gradi: [], attivo: true },
    { id: IDS.SEGRETERIA2, email: CREDENZIALI.segreteria2, nome: 'Sonia', cognome: 'Segreteria2-E2E', ruolo: 'segreteria', scuola_id: IDS.SCUOLA2, gradi: [], attivo: true },
    { id: IDS.DOCENTE2, email: CREDENZIALI.docente2, nome: 'Diana', cognome: 'Docente2-E2E', ruolo: 'educator', scuola_id: IDS.SCUOLA2, gradi: ['infanzia'], attivo: true },
    { id: IDS.GENITORE2, email: CREDENZIALI.genitore2, nome: 'Gilda', cognome: 'Genitore2-E2E', ruolo: 'genitore', scuola_id: IDS.SCUOLA2, gradi: [], attivo: true },
  ], { onConflict: 'id' }));

  // ── Il ponte dell'admin verso il «Plesso di Collaudo» ──────────────────────
  //
  // Le pratiche inviate dai moduli pubblici nascono su `SCUOLA_COLLAUDO` (è
  // l'unica sede che `sediReali` accetta). I cockpit di approvazione filtrano per
  // `resolveScuoleAttive`, che per un admin è `utenti.scuola_id` PIÙ le righe di
  // questo ponte: senza, l'admin E2E non vedrebbe le proprie pratiche e ogni
  // PATCH risponderebbe 404 — un 404 indistinguibile da «non esiste», cioè un
  // test rosso che sembra un difetto del prodotto.
  //
  // ⚠️ PERCHÉ IL PONTE E NON `utenti.scuola_id`. Spostare la sede PRIMARIA
  // dell'admin sembrerebbe più semplice ed è la cosa da non fare:
  // `isUtenteCollaudo` (src/lib/scuole/reali.ts) riconosce un account di
  // collaudo dalla sede primaria, e con una sede non-e2e l'admin diventerebbe
  // «un utente vero» — rientrando nelle liste di candidati di `admin/schools:POST`.
  // È il vettore dell'incidente del 2026-07-29 (`admin.e2e@kidville.test`
  // collegato alla Direzione di Aversa e Cesa, con la password in chiaro in un
  // repo pubblico). Col ponte le due proprietà convivono: `isUtenteCollaudo`
  // resta true perché guarda la primaria, e `scuoleDiUtente` include comunque la
  // sede di collaudo nello scope.
  must('utenti_scuole', await db.from('utenti_scuole').upsert([
    { utente_id: IDS.ADMIN, scuola_id: IDS.SCUOLA_COLLAUDO },
  ], { onConflict: 'utente_id,scuola_id' }));

  // Docente SOLO su Girasoli (activeSection deterministica); doppio su Tulipani.
  // La docente della sede 2 è assegnata alla Girasoli OMONIMA: le due maestre
  // chiedono al server la stessa identica stringa («Girasoli») e devono ricevere
  // due elenchi disgiunti — è esattamente la prova del percorso 2.
  must('utenti_sezioni', await db.from('utenti_sezioni').upsert([
    { utente_id: IDS.DOCENTE, section_id: IDS.SEC_GIRASOLI },
    { utente_id: IDS.DOPPIO, section_id: IDS.SEC_TULIPANI },
    { utente_id: IDS.DOCENTE2, section_id: IDS.SEC2_GIRASOLI },
  ], { onConflict: 'utente_id,section_id' }));

  // Bridge parents.auth_user_id: per il genitore puro e per il profilo doppio
  // (utenti educator + parents → picker multi-profilo al login).
  //
  // consensi_gdpr: { privacy, termini } — il seed crea i genitori DIRETTAMENTE
  // (bypassando l'onboarding reale), quindi senza questo campo la guardia C5
  // `assertTerminiAccettatiSeGenitore` in POST /api/chat/messages li blocca
  // con 403 (nessun genitore di seed ha mai "accettato" i Termini). Non è un
  // valore magico: è lo stesso stato che l'onboarding reale scrive.
  const CONSENSI_E2E = { privacy: true, termini: true };
  must('parents', await db.from('parents').upsert([
    { id: IDS.P_GENITORE, first_name: 'Gaia', last_name: 'Genitore-E2E', auth_user_id: IDS.GENITORE, consensi_gdpr: CONSENSI_E2E },
    { id: IDS.P_DOPPIO, first_name: 'Duccio', last_name: 'Doppio-E2E', auth_user_id: IDS.DOPPIO, consensi_gdpr: CONSENSI_E2E },
    { id: IDS.P_GENITORE2, first_name: 'Gilda', last_name: 'Genitore2-E2E', auth_user_id: IDS.GENITORE2, consensi_gdpr: CONSENSI_E2E },
  ], { onConflict: 'id' }));

  // 5. Alunni + legami (legame_genitori_alunni.genitore_id → utenti.id)
  //    Emma sta nella «Girasoli» della SEDE 2: stesso nome-classe di Aurora e
  //    Bruno, plesso diverso. Nessun test può più essere verde solo perché una
  //    seconda sede non esiste.
  must('alunni', await db.from('alunni').upsert([
    { id: IDS.A1, scuola_id: IDS.SCUOLA, nome: 'Aurora', cognome: 'Arcobaleno-E2E', data_nascita: '2022-04-10', section_id: IDS.SEC_GIRASOLI, classe_sezione: 'Girasoli', stato: 'iscritto' },
    { id: IDS.A2, scuola_id: IDS.SCUOLA, nome: 'Bruno', cognome: 'Baleno-E2E', data_nascita: '2022-07-21', section_id: IDS.SEC_GIRASOLI, classe_sezione: 'Girasoli', stato: 'iscritto' },
    { id: IDS.A3, scuola_id: IDS.SCUOLA, nome: 'Clara', cognome: 'Cometa-E2E', data_nascita: '2021-11-03', section_id: IDS.SEC_TULIPANI, classe_sezione: 'Tulipani', stato: 'iscritto' },
    { id: IDS.A4, scuola_id: IDS.SCUOLA, nome: 'Dino', cognome: 'Delfino-E2E', data_nascita: '2021-02-14', section_id: IDS.SEC_TULIPANI, classe_sezione: 'Tulipani', stato: 'iscritto' },
    { id: IDS.B1, scuola_id: IDS.SCUOLA2, nome: 'Emma', cognome: 'Eclissi-E2E', data_nascita: '2022-03-08', section_id: IDS.SEC2_GIRASOLI, classe_sezione: 'Girasoli', stato: 'iscritto' },
    // I due figli del profilo doppio. Nessuno dei due sta in `SEC_TULIPANI`:
    // vedi il blocco qui sotto, che è il motivo per cui esistono.
    { id: IDS.A5, scuola_id: IDS.SCUOLA, nome: 'Fiore', cognome: 'Fiocco-E2E', data_nascita: '2022-01-19', section_id: IDS.SEC_MARGHERITE, classe_sezione: 'Margherite', stato: 'iscritto' },
    { id: IDS.B2, scuola_id: IDS.SCUOLA2, nome: 'Gigi', cognome: 'Girandola-E2E', data_nascita: '2021-09-27', section_id: IDS.SEC2_MARGHERITE, classe_sezione: 'Margherite', stato: 'iscritto' },
  ], { onConflict: 'id' }));

  /* ═══════════════════════════════════════════════════════════════════════════
   * I LEGAMI DI FAMIGLIA — e il legame che è stato TOLTO, che è la parte da leggere.
   *
   * ─── IL DIFETTO, che era nel BANCO DI PROVA e non nel prodotto ──────────────
   *
   * Fino al 2026-09-01 qui c'era `{ genitore_id: IDS.DOPPIO, alunno_id: IDS.A3 }`,
   * e A3 (Clara) sta in `SEC_TULIPANI` — che è **LA SEZIONE CHE IL DOPPIO
   * INSEGNA** (`utenti_sezioni`, poche righe più sopra). Conseguenza: qualunque
   * test sul doppio profilo passava perché il DOCENTE vede la propria classe, non
   * perché il GENITORE vede suo figlio. Cioè non poteva diventare rosso nemmeno
   * con il gate della famiglia completamente rotto: un test che non prova nulla.
   *
   * ⚠️ NON RIMETTERE QUELLA RIGA. Se serve un figlio del doppio, dev'essere fuori
   * dalle sezioni che insegna — come lo sono i casi veri.
   *
   * ─── I DUE CASI, MISURATI IN PRODUZIONE IL 2026-09-01 ───────────────────────
   *
   * Cinque persone hanno insieme la riga `utenti` da personale e il ponte
   * `parents.auth_user_id`. SEI dei loro legami figlio↔genitore cadono FUORI
   * dalle sezioni che insegnano, e UNO è in un'ALTRA SEDE. Sono esattamente i due
   * casi che questo seed non sapeva produrre, e sono i due qui sotto:
   *   · `A5` — stessa sede, sezione «Margherite», che il doppio non insegna;
   *   · `B2` — sede 2, dove il doppio non ha né sezioni né `utenti_scuole`.
   *
   * ─── PERCHÉ SI CANCELLA PRIMA DI SCRIVERE ──────────────────────────────────
   *
   * Il seed è idempotente per UPSERT, che aggiunge e aggiorna ma non toglie: il
   * database E2E della CI è un progetto persistente, quindi il legame DOPPIO↔A3
   * dei run precedenti sopravviverebbe alla cancellazione di questa riga — e il
   * test tornerebbe verde per il motivo sbagliato senza che nessuno se ne
   * accorga. La lista qui sotto è la VERITÀ, non un incremento.
   * ═══════════════════════════════════════════════════════════════════════════ */
  must('reset legami E2E', await db.from('legame_genitori_alunni').delete().in('genitore_id', UTENTI_E2E));
  must('legami', await db.from('legame_genitori_alunni').upsert([
    { genitore_id: IDS.GENITORE, alunno_id: IDS.A1 },
    { genitore_id: IDS.GENITORE2, alunno_id: IDS.B1 },
    { genitore_id: IDS.DOPPIO, alunno_id: IDS.A5 }, // fuori sezione (i 6 casi reali)
    { genitore_id: IDS.DOPPIO, alunno_id: IDS.B2 }, // altra sede    (il caso reale)
  ], { onConflict: 'genitore_id,alunno_id' }));

  /* ── E LE STESSE DUE RIGHE ANCHE IN ANAGRAFICA (`student_parents`) ──────────
   *
   * Non è una ridondanza: le due sorgenti dicono cose diverse a lettori diversi.
   * Il codice applicativo fa l'UNIONE delle due (`getFigliDiGenitoreEsito`), ma
   * `current_parent_student_ids()` — la funzione SECURITY DEFINER su cui poggia
   * OGNI policy «(parents space)» — legge SOLTANTO `student_parents`. Con il solo
   * legame di runtime, quel disallineamento resta invisibile in CI: le rotte
   * rispondono (passano dal service-role) e nessuno scopre che la RLS, per lo
   * stesso genitore, direbbe di no.
   *
   * In produzione il caso c'era davvero — uno — ed è stato riparato il 2026-09-01
   * con la migrazione `20260901203333_legami_anagrafici_profili_doppi`.
   *
   * ⚠️ `relation_type` RESTA NULL. È nullable, e in produzione è NULL nell'83%
   * delle righe: inventare qui un 'padre' o un 'tutore' renderebbe il banco di
   * prova più ordinato del dato vero, che è il modo più silenzioso di non
   * collaudare il caso normale.
   *
   * Stessa regola dei legami di runtime: si cancella e si riscrive, perché
   * l'upsert non toglie e il database della CI è persistente.
   * ─────────────────────────────────────────────────────────────────────────── */
  must('reset student_parents E2E', await db.from('student_parents').delete().in('parent_id', PARENTS_E2E));
  must('student_parents', await db.from('student_parents').upsert([
    { parent_id: IDS.P_DOPPIO, student_id: IDS.A5 },
    { parent_id: IDS.P_DOPPIO, student_id: IDS.B2 },
  ], { onConflict: 'student_id,parent_id' }));

  // 6. Reset dei dati E2E mutabili (solo entità delle scuole/utenti E2E)
  must('reset presenze', await db.from('presenze').delete().in('alunno_id', ALUNNI_E2E));
  must('reset diario', await db.from('eventi_diario').delete().in('alunno_id', ALUNNI_E2E));
  must('reset agenda', await db.from('eventi_agenda').delete().in('scuola_id', [IDS.SCUOLA, IDS.SCUOLA2]));
  must('reset notifiche', await db.from('notifiche').delete().in('utente_id', UTENTI_E2E));

  // Avvisi: prima le RISPOSTE (FK avvisi_risposte.avviso_id → avvisi.id), poi
  // gli avvisi creati dai test. Fino al 2026-07-31 si cancellavano solo le
  // risposte dell'avviso seminato: un avviso pubblicato da uno spec e poi
  // "letto" da un genitore in un altro spec bloccava il delete con una
  // violazione di FK, e il seed sarebbe morto al run successivo — mai successo
  // per caso (nessuno spec risponde agli avvisi che crea), non per costruzione.
  const avvisiTest = await db.from('avvisi').select('id').in('author_id', AUTORI_AVVISI_TEST);
  must('lettura avvisi dei test', avvisiTest);
  const rispostaDaCancellare = [
    ...(avvisiTest.data ?? []).map((a) => a.id),
    IDS.AVVISO, IDS.AVVISO_S2,
  ];
  must('reset risposte avviso', await db.from('avvisi_risposte').delete().in('avviso_id', rispostaDaCancellare));
  must('reset avvisi dei test', await db.from('avvisi').delete().in('author_id', AUTORI_AVVISI_TEST));
  must('reset pagamenti', await db.from('pagamenti').delete().in('alunno_id', ALUNNI_E2E));
  must('reset armadietto', await db.from('armadietto').delete().in('alunno_id', ALUNNI_E2E));

  // Chat: thread e messaggi del genitore E2E
  const threads = await db.from('chat_threads').select('id').eq('parent_id', IDS.GENITORE);
  must('lettura thread', threads);
  const threadIds = (threads.data ?? []).map((t) => t.id);
  if (threadIds.length > 0) {
    must('reset chat_messages', await db.from('chat_messages').delete().in('thread_id', threadIds));
    must('reset chat_threads', await db.from('chat_threads').delete().in('id', threadIds));
  }

  // Artefatti del flusso pubblico d'iscrizione dei run precedenti.
  // NB: l'alunno importato ha id RANDOM (non è in ALUNNI_E2E), quindi le sue
  // righe dipendenti (diario/presenze/…, create dalla suite del run precedente)
  // vanno eliminate PRIMA, o il delete viola le FK (eventi_diario_alunno_id_fkey).
  const alunniIscr = await db.from('alunni').select('id').eq('codice_fiscale', ISCRIZIONE_E2E.cfChild);
  must('lettura alunni iscrizione', alunniIscr);
  const alunniIscrIds = (alunniIscr.data ?? []).map((a) => a.id);
  if (alunniIscrIds.length > 0) {
    must('reset diario iscrizione', await db.from('eventi_diario').delete().in('alunno_id', alunniIscrIds));
    must('reset presenze iscrizione', await db.from('presenze').delete().in('alunno_id', alunniIscrIds));
    must('reset pagamenti iscrizione', await db.from('pagamenti').delete().in('alunno_id', alunniIscrIds));
    must('reset armadietto iscrizione', await db.from('armadietto').delete().in('alunno_id', alunniIscrIds));
    must('reset legami iscrizione', await db.from('legame_genitori_alunni').delete().in('alunno_id', alunniIscrIds));
  }
  must('reset iscrizione alunni', await db.from('alunni').delete().eq('codice_fiscale', ISCRIZIONE_E2E.cfChild));
  must('reset iscrizione parents', await db.from('parents').delete().eq('fiscal_code', ISCRIZIONE_E2E.cfAdult));
  const utenteIscr = await db.from('utenti').select('id').eq('email', ISCRIZIONE_E2E.email).maybeSingle();
  if (utenteIscr.data?.id) {
    must('reset iscrizione utenti', await db.from('utenti').delete().eq('id', utenteIscr.data.id));
    await db.auth.admin.deleteUser(utenteIscr.data.id).catch(() => {});
  }
  must('reset enrollment_submissions', await db.from('enrollment_submissions').delete()
    .contains('data', { children: [{ codice_fiscale: ISCRIZIONE_E2E.cfChild }] }));

  // ── Artefatti dei DUE moduli pubblici del personale ────────────────────────
  //
  // Perché serve, e perché prima non serviva: finché il percorso felice era in
  // `test.fixme` nessuno inviava niente, e queste tabelle restavano vuote da sé.
  // Ora un test INVIA e un altro APPROVA, e l'approvazione lascia dietro cinque
  // cose: la pratica in stato `approvata`, la riga di `anagrafica_personale`, la
  // riga di `caricamenti_personale`, il file nel bucket e — la più fastidiosa —
  // un account `utenti` appena creato. Senza reset, al run successivo il secondo
  // invio non sarebbe più un duplicato e l'account resterebbe: il test
  // passerebbe per il motivo sbagliato.
  //
  // ⚠️ QUESTO BLOCCO NON USA `must()`, ed è l'unica eccezione deliberata del
  // seed insieme a `ensureBuckets`. `must()` fa `throw` su qualunque errore
  // PostgREST e `global-setup` lo propaga: su un ambiente dove queste tabelle
  // non sono ancora state migrate (`PGRST205`/`42P01`) l'INTERA suite morirebbe
  // prima di eseguire un test — per la pulizia di una funzionalità che lì non
  // esiste. Si avvisa NOMINANDO la tabella saltata, e si prosegue.
  await ripulisciModuliPersonale();

  // 7. Presenze di oggi: SOLO Tulipani (Girasoli resta "appello mancante")
  must('presenze', await db.from('presenze').insert([
    { alunno_id: IDS.A3, data: oggi, stato: 'presente', orario_entrata: '08:45', scuola_id: IDS.SCUOLA, section_id: IDS.SEC_TULIPANI },
    { alunno_id: IDS.A4, data: oggi, stato: 'assente', scuola_id: IDS.SCUOLA, section_id: IDS.SEC_TULIPANI },
  ]));

  // 8. Diario di oggi per Aurora (timeline + umore per il diario genitore)
  const now = new Date().toISOString();
  // creato_il oltre il buffer visibilità genitori (default 10', route /api/diary/entries):
  // orario_inizio resta "oggi" (navigazione + filtro data), ma la voce è abbastanza
  // "vecchia" da superare il buffer ed essere visibile subito nel diario genitore.
  const creato = new Date(Date.now() - 30 * 60_000).toISOString();
  must('eventi_diario', await db.from('eventi_diario').insert([
    { id: IDS.DIARIO_UMORE, alunno_id: IDS.A1, maestra_id: IDS.DOCENTE, tipo_evento: 'umore', orario_inizio: now, creato_il: creato, dettagli: { umore: 'felice' } },
    { id: IDS.DIARIO_ATTIVITA, alunno_id: IDS.A1, maestra_id: IDS.DOCENTE, tipo_evento: 'attivita', orario_inizio: now, creato_il: creato, dettagli: { activities: [{ tipo: 'Pittura', descrizione: 'Pittura con le dita', partecipazione: 'autonomia' }] }, nota_libera: 'Nota E2E per i genitori' },
    // Il diario del figlio del profilo doppio (A5, sezione «Margherite»): senza
    // una voce, «200 e il diario si apre» sarebbe indistinguibile da «200 e non
    // c'è niente da vedere» — cioè un'asserzione che il 403 lo vedrebbe, ma il
    // contenuto no. La maestra è quella della sede 1: chi ha scritto la voce non
    // c'entra col gate, e A5 non ha una propria sezione con docente assegnato.
    { id: IDS.DIARIO_A5, alunno_id: IDS.A5, maestra_id: IDS.DOCENTE, tipo_evento: 'attivita', orario_inizio: now, creato_il: creato, dettagli: { activities: [{ tipo: 'Lettura', descrizione: 'Lettura ad alta voce', partecipazione: 'autonomia' }] }, nota_libera: DOPPIO_PROFILO_E2E.notaDiarioA5 },
  ]));

  // 9. Avvisi: uno per sede.
  //  · sede 1 (adesione) ⇒ massima priorità nella card della home genitore;
  //  · sede 2 = ANCORA del test d'isolamento. Serve a distinguere «la bacheca
  //    della sede 2 non mostra l'avviso della sede 1» da «la bacheca della sede
  //    2 non ha caricato niente»: senza un elemento che DEVE esserci,
  //    un'asserzione negativa è verde anche quando la pagina è rotta.
  //    Stesso `target_classes: ['Girasoli']` dell'avviso della sede 1: se il
  //    filtro di sede cadesse, i due si mescolerebbero — ed è ciò che il test
  //    deve poter vedere.
  must('avvisi', await db.from('avvisi').upsert([
    {
      id: IDS.AVVISO, author_id: IDS.ADMIN, titolo: 'Avviso E2E: uscita al parco',
      contenuto: 'Gita della sezione Girasoli: serve la vostra adesione entro venerdì.',
      tipo: 'adesione', target_scope: 'classe', target_classes: ['Girasoli'],
      scuola_id: IDS.SCUOLA, scadenza: ymdRoma(60),
    },
    {
      id: IDS.AVVISO_S2, author_id: IDS.SEGRETERIA2, titolo: 'Avviso E2E sede 2: assemblea',
      contenuto: 'Assemblea della sezione Girasoli della seconda sede.',
      tipo: 'presa_visione', target_scope: 'classe', target_classes: ['Girasoli'],
      scuola_id: IDS.SCUOLA2, scadenza: ymdRoma(60),
    },
  ], { onConflict: 'id' }));

  // 10. Evento agenda futuro, visibile ai genitori (sezione Girasoli)
  must('eventi_agenda', await db.from('eventi_agenda').insert({
    id: IDS.EVENTO, scuola_id: IDS.SCUOLA, section_id: IDS.SEC_GIRASOLI,
    titolo: 'Gita al museo E2E', tipo: 'uscita', data: ymdRoma(7),
    orario_inizio: '09:30', visibile_genitori: true, creato_da: IDS.ADMIN,
  }));

  // 11. Notifiche non lette per admin, genitore e docente (centri notifiche)
  must('notifiche', await db.from('notifiche').insert([
    {
      id: IDS.NOTIFICA, utente_id: IDS.ADMIN, tipo: 'sistema',
      titolo: 'Notifica E2E', corpo: 'Notifica seminata per la suite Playwright.', letta_il: null,
    },
    {
      id: IDS.NOTIFICA_GENITORE, utente_id: IDS.GENITORE, tipo: 'sistema',
      titolo: 'Notifica genitore E2E', corpo: 'Notifica seminata per il pannello campanella genitore.', letta_il: null,
    },
    {
      id: IDS.NOTIFICA_DOCENTE, utente_id: IDS.DOCENTE, tipo: 'sistema',
      titolo: 'Notifica docente E2E', corpo: 'Notifica seminata per il pannello campanella docente.', letta_il: null,
    },
  ]));

  // 12. Pagamenti di Aurora (uno aperto + uno pagato)
  must('pagamenti', await db.from('pagamenti').insert([
    { id: IDS.PAG_APERTO, alunno_id: IDS.A1, scuola_id: IDS.SCUOLA, descrizione: 'Retta E2E luglio', importo: 150, importo_pagato: 0, scadenza: ymdRoma(10), stato: 'da_pagare', tipo: 'singolo', obbligatorio: true },
    { id: IDS.PAG_PAGATO, alunno_id: IDS.A1, scuola_id: IDS.SCUOLA, descrizione: 'Gita E2E', importo: 25, importo_pagato: 25, scadenza: ymdRoma(-5), stato: 'pagato', tipo: 'singolo', obbligatorio: false },
  ]));

  // 13. Armadietto di Aurora: stock 1 ⇒ bottone "Avvisa" visibile in home
  must('armadietto', await db.from('armadietto').insert({
    alunno_id: IDS.A1, nome_oggetto: 'Pannolini', materiale: 'Pannolini',
    quantita: 1, quantita_residua: 1, portato: true, date: oggi,
    livello_allerta: 5, livello_emergenza: 2,
  }));

  // 14. Modello form + submission "completed" non gestita (per "Segna gestita")
  must('form_models', await db.from('form_models').upsert({
    id: IDS.FORM_MODEL, title: 'Modulo E2E Gita', is_active: true,
    schema: { pages: [{ title: 'Dati', fields: [{ id: 'note', type: 'text', label: 'Note' }] }] },
  }, { onConflict: 'id' }));
  must('form_submissions', await db.from('form_submissions').upsert({
    id: IDS.FORM_SUB, model_id: IDS.FORM_MODEL, status: 'completed',
    data: { note: 'Compilazione E2E' }, gestita_il: null, gestita_da: null,
  }, { onConflict: 'id' }));

  // 15. Galleria: un media per ciascuno dei due figli del profilo doppio.
  await seminaGalleriaDoppioProfilo();

  // 16. Menu mensa di OGGI, diverso nelle due sedi.
  //
  // È un `override` per DATA e non una riga di rotazione: la rotazione dipende
  // dal giorno della settimana (`giorniAttivi` di default è lun-ven), quindi in
  // un run di sabato il menu sarebbe `null` e l'asserzione sarebbe rossa per il
  // calendario invece che per il prodotto. L'override vale sempre.
  //
  // I due primi sono DIVERSI di proposito: il genitore-docente ha
  // `utenti.scuola_id` = sede 1, e il figlio `B2` sta nella sede 2. Se la rotta
  // risolvesse la mensa dal record del GENITORE invece che dal BAMBINO,
  // risponderebbe comunque 200 — con il piatto sbagliato. È l'unico modo di
  // vedere la differenza dalla risposta.
  // ⚠️ SI CANCELLA E SI REINSERISCE, non si fa `upsert(onConflict:'id')`.
  // `uidx_mensa_ovr_legacy` è un indice unico PARZIALE — `(scuola_id, data) WHERE
  // menu_config_id IS NULL` — e `ON CONFLICT (id)` NON lo inferisce: un override
  // già presente su (sede, oggi) con un id diverso farebbe fallire l'insert con
  // `23505`, e `must()` ucciderebbe l'intera suite prima del primo test. È la
  // stessa trappola del commit «ON CONFLICT non infersce un indice parziale».
  // Il perimetro del delete sono le sole due sedi di collaudo.
  must('reset menu mensa E2E', await db.from('mensa_menu_override').delete()
    .in('scuola_id', [IDS.SCUOLA, IDS.SCUOLA2]));
  must('mensa_menu_override', await db.from('mensa_menu_override').insert([
    {
      id: IDS.MENU_OVR_S1, scuola_id: IDS.SCUOLA, data: oggi, chiuso: false,
      menu_config_id: null,
      portate: { primo: DOPPIO_PROFILO_E2E.primoSede1, secondo: 'Frittata E2E', contorno: 'Insalata E2E', frutta: 'Mela E2E' },
      note: 'Menu E2E della sede 1',
    },
    {
      id: IDS.MENU_OVR_S2, scuola_id: IDS.SCUOLA2, data: oggi, chiuso: false,
      menu_config_id: null,
      portate: { primo: DOPPIO_PROFILO_E2E.primoSede2, secondo: 'Platessa E2E', contorno: 'Carote E2E', frutta: 'Pera E2E' },
      note: 'Menu E2E della sede 2',
    },
  ]));

  console.log('✅ Seed E2E completato (idempotente, 2 sedi). Oggi (Europe/Rome):', oggi);
}

main().catch((err) => {
  console.error('❌ Seed E2E fallito:', err.message ?? err);
  process.exit(1);
});
