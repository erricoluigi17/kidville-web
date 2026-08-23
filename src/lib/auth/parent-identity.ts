import type { SupabaseClient } from '@supabase/supabase-js';
import { logEvento } from '@/lib/logging/logger';
import { passwordTemporanea } from '@/lib/auth/password-temporanea';

// =============================================================================
// Identità di accesso di un GENITORE — fonte unica (S6bis).
//
// Un genitore funzionante è composto da QUATTRO record che nessun trigger DB
// tiene allineati (verificato: zero trigger su auth.users):
//   1. `auth.users`                — account email+password (login);
//   2. `utenti` ruolo 'genitore'   — profilo con id == auth.uid(); è l'unica
//      tabella letta da loadAppUser: senza questa riga il login riesce ma ogni
//      route dati risponde 401 "Utente non trovato";
//   3. `parents.auth_user_id`      — ponte anagrafica↔account (UNIQUE, FK);
//   4. il legame col figlio (student_parents / legame_genitori_alunni).
//
// Storicamente ogni flusso ne creava un sottoinsieme diverso (anagrafica: solo
// 3-4; approvazione iscrizioni: 1-2; backfill S6: 1+3) producendo genitori
// "monchi": o il 409 all'invio credenziali, o login che entra e non vede nulla.
// `ensureParentIdentity` completa in modo IDEMPOTENTE i pezzi 1-3 mancanti; il
// legame (4) resta al chiamante, che conosce lo studente. Non lancia mai: ogni
// esito è un valore, così i chiamanti best-effort non falliscono il salvataggio.
// =============================================================================

export interface ParentIdentityInput {
  /** parents.id */
  id: string;
  auth_user_id?: string | null;
  emails?: unknown;
  first_name?: string | null;
  last_name?: string | null;
  /** telefono da riportare su utenti.cellulare (opzionale) */
  phone?: string | null;
}

export type EnsureParentIdentityResult =
  | {
      ok: true;
      authUserId: string;
      email: string;
      /** account auth.users creato ora (password temporanea in `password`) */
      createdAuth: boolean;
      /** riga `utenti` creata ora */
      createdUtenti: boolean;
      /** ponte parents.auth_user_id scritto ora */
      boundNow: boolean;
      /** password temporanea SOLO quando createdAuth (per invii immediati) */
      password: string | null;
      /**
       * La sede risolta per questo genitore (dai FIGLI, vedi `sedeDelGenitore`),
       * `null` quando non era deducibile. Non è un dettaglio interno: è ciò che
       * permette a chi manda le credenziali di NOMINARE la sede giusta nel
       * corpo dell'email — con tre plessi, «Kidville» non identifica più niente.
       */
      scuolaId: string | null;
    }
  | { ok: false; reason: 'no_email' | 'email_conflict' | 'error'; message: string };

/**
 * Password iniziale forte e non indovinabile (le credenziali reali si emettono via S11).
 *
 * ⚠️ IL GENERATORE NON STA PIÙ QUI, e non è un riordino di file. Fino al 2026-08-22
 * questa funzione era `randomBytes(18).toString('base64url') + 'Aa1!'`: forte, e
 * illeggibile per la persona che deve trascriverla. Quel giorno il cron ne ha
 * spedite 67 a famiglie vere e 30 non sono mai entrate. Il perché, l'alfabeto e il
 * conto dell'entropia stanno in `@/lib/auth/password-temporanea`, insieme al lock
 * che impedisce a un secondo generatore di rinascere da qualche altra parte.
 *
 * Il nome resta `randomPassword` perché è importato da cinque punti (invito,
 * staff, backfill, rigenerazione manuale, creazione genitore): cambiarlo qui
 * avrebbe spostato la modifica su file che non hanno niente a che vedere con
 * questo difetto.
 */
export function randomPassword(): string {
  return passwordTemporanea();
}

/** Prima email valida da `parents.emails` (array o stringa singola). */
export function firstEmail(emails: unknown): string | null {
  if (Array.isArray(emails)) {
    const e = emails.find((x) => typeof x === 'string' && x.includes('@'));
    return e ? String(e).trim() : null;
  }
  if (typeof emails === 'string' && emails.includes('@')) return emails.trim();
  return null;
}

const PER_PAGE = 100;

/**
 * IL CORPO DELL'ERRORE DI GoTrue, in una forma che dice sempre qualcosa.
 *
 * Tre modi in cui un errore di `auth.admin.*` riesce a non dire niente, tutti
 * incontrati per davvero:
 *  1. `message` è `undefined` — succede quando una riga di `auth.users` non è
 *     serializzabile e l'INTERA pagina fallisce (produzione, 2026-07-31:
 *     `banned_until = 'infinity'`, timestamp legittimo per Postgres e non per
 *     JSON). `Error: undefined` nasconde sia la causa sia la pagina;
 *  2. `message` è la stringa vuota: `error.message || …` scivola oltre, e senza
 *     un ripiego il messaggio finale finisce con i due punti e basta;
 *  3. l'errore è un vero `Error` (AuthApiError lo è): `message`/`name` NON sono
 *     enumerabili, quindi `JSON.stringify` restituisce `'{}'` — che è truthy, e
 *     quindi passa il `||` e diventa il «dettaglio». Un dettaglio che dice `{}`
 *     è peggio di nessun dettaglio: sembra un'informazione.
 *
 * Ordine: messaggio → corpo serializzato (se dice qualcosa) → status e codice.
 */
export function dettaglioErroreAuth(error: unknown): string {
  const e = (error ?? null) as { message?: string; status?: number; code?: string } | null;
  try {
    if (typeof e?.message === 'string' && e.message.trim() !== '') return e.message;
    const corpo = JSON.stringify(error);
    if (corpo && corpo !== '{}' && corpo !== 'null' && corpo !== '""') return corpo;
  } catch {
    // Oggetto ciclico o BigInt: si ripiega su status/codice, che bastano a cercare.
  }
  const stato = e?.status ?? '?';
  return e?.code ? `status ${stato} (${e.code})` : `status ${stato}`;
}

/**
 * Cerca un auth.users per email.
 *
 * ⚠️ LA SCANSIONE È IL RIPIEGO, NON LA STRADA — e il motivo è una misura.
 *
 * L'admin API di GoTrue non ha un `getUserByEmail`: qui si ripiegava su `listUsers`
 * paginata a 100, scandendo l'INTERA `auth.users` e confrontando le email in
 * JavaScript. Il commento diceva «accettabile alla scala attuale (decine di
 * account)», ed era vero quando è stato scritto.
 *
 * Il 2026-08-22 il cron delle iscrizioni si è fermato per `tempo-scaduto` con 50
 * domande in coda, a un tetto di 300 email mai sfiorato: l'intervallo mediano fra
 * un'email e l'altra era **3,35 s**, costante e senza coda lunga — cioè un numero
 * fisso di andate-e-ritorni in serie, ~27-29 per domanda. Resend ne pesa il 10%, la
 * pausa il 4,5%. Questa funzione era l'unico pezzo del giro **che peggiora con ciò
 * che il giro stesso produce**: ogni account creato allunga la scansione del
 * successivo. Oggi 166 account = 2 pagine; a fine finestra ~570 = 6 pagine, e la
 * 201ª e la 301ª cadono dentro questa finestra di iscrizioni.
 *
 * `utenti` in `public` ha `email`, ha `id` uguale all'auth user id, ed è tenuta
 * allineata dalla STESSA `ensureParentIdentity` che chiama questa funzione
 * (`ensureUtentiRow`): una SELECT indicizzata al posto di N pagine di GoTrue.
 *
 * Il confronto veloce è ESATTO (`.eq`) e non insensibile alle maiuscole, e va bene
 * così: in produzione le 166 righe di `utenti` hanno tutte l'email già in minuscolo
 * e senza spazi (misurato il 2026-08-23), e l'indice unique `utenti_email_key` c'è
 * già. Ma soprattutto il degrado è SICURO in entrambe le direzioni: se un domani
 * una riga avesse una maiuscola, la strada veloce non la troverebbe e la scansione
 * sì — si perderebbe velocità, mai correttezza. È la proprietà che rende questa
 * ottimizzazione innocua anche il giorno in cui il presupposto smette di valere.
 *
 * Il ripiego resta, e non per prudenza generica: il caso «account in `auth.users`
 * senza riga in `utenti`» esiste davvero ed è precisamente quello che
 * `ensureUtentiRow` ripara. Degradarlo a «non esiste» creerebbe un SECONDO account
 * per la stessa persona — un registro diviso in due, cioè il danno che questa
 * funzione esiste per impedire. Per la stessa ragione un ERRORE di lettura ripiega
 * invece di rispondere `null`: un errore PostgREST non è una risposta negativa.
 *
 * ⚠️ ESPORTATA dal 2026-08-10, ed è l'unico motivo per cui non è più privata:
 * `ensureStaffIdentity` (src/lib/auth/staff-identity.ts) deve fare la STESSA
 * domanda — «esiste già un account con questa email?» — prima di crearne uno per
 * un'insegnante approvata. Riscriverla lì significherebbe due scansioni di
 * `auth.users` che possono divergere sul confronto (minuscole), sulla
 * paginazione e sulla gestione dell'errore: e la divergenza si vedrebbe come un
 * SECONDO account per la stessa persona, cioè un registro diviso in due.
 * «Una regola valida per due strade deve vivere in un posto solo».
 */
export async function findAuthUserIdByEmail(admin: SupabaseClient, email: string): Promise<string | null> {
  const key = email.toLowerCase();

  // La strada veloce: una riga, un indice. `maybeSingle()` e non `single()`, perché
  // «non c'è» è un esito normale e non un errore da gestire.
  const { data: riga, error: erroreUtenti } = await admin
    .from('utenti')
    .select('id')
    .eq('email', key)
    .maybeSingle();
  if (!erroreUtenti && riga?.id) return String(riga.id);
  if (erroreUtenti) {
    // Non si tace e non si degrada: si dice che la strada veloce non ha risposto, e
    // si paga la scansione. Un catch muto qui è il difetto della regola 6 di
    // AGENTS.md, e per giunta invisibile — il giro continuerebbe a funzionare, solo
    // lento, e nessuno saprebbe perché.
    logEvento('auth', 'warn', {
      operazione: 'findAuthUserIdByEmail',
      esito: 'utenti-non-consultabile-si-scandisce',
    }, erroreUtenti);
  }

  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) {
      throw new Error(`auth.admin.listUsers (pagina ${page}): ${dettaglioErroreAuth(error)}`);
    }
    const users = data?.users ?? [];
    for (const u of users) if (u.email && u.email.toLowerCase() === key) return u.id;
    if (users.length < PER_PAGE) break;
    page++;
  }
  return null;
}

/**
 * Scuola per `utenti.scuola_id` (NOT NULL): quella passata, altrimenti l'unica
 * configurata (installazione mono-sede). Con più sedi il chiamante DEVE passarla.
 *
 * @deprecated DAL 2026-07-29 IL DEPLOYMENT HA TRE SEDI: il ramo `limit(2)` non
 * può più risolvere niente (e non escludeva nemmeno la sede finta della CI). Per
 * un GENITORE la sede si ricava dai FIGLI — `sedeDelGenitore` qui sotto. Resta
 * per il backfill S6 (`src/lib/auth/backfill.ts`), che opera su una sede
 * dichiarata dall'operatore e non ha un genitore da cui partire.
 */
export async function resolveScuolaId(
  admin: SupabaseClient,
  preferred: string | null | undefined
): Promise<string | null> {
  if (preferred) return preferred;
  const { data } = await admin.from('schools').select('id').limit(2);
  return data && data.length === 1 ? (data[0].id as string) : null;
}

/** Codici PostgREST/Postgres di «schema non ancora migrato» (DB E2E della CI). */
const SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);

export type MotivoSedeGenitore =
  /** Una sola sede fra i figli: decide il dato, e basta. */
  | 'figli'
  /** Più sedi possibili, e il chiamante ne ha DICHIARATA una fra quelle. */
  | 'dichiarata'
  /** Più sedi possibili, e l'operatore lavora in una di esse. */
  | 'operatore'
  /** Nessun figlio da cui dedurre: si ripiega sulla sede indicata dal chiamante. */
  | 'operatore-senza-figli'
  /** Più sedi e nessun criterio per scegliere: si rinuncia. */
  | 'ambigua'
  /** Tabelle non ancora migrate (DB E2E della CI): si usa ciò che è stato indicato. */
  | 'schema-assente'
  /** Lettura fallita: non è «nessun figlio», ed è un'altra cosa dall'ambiguità. */
  | 'errore';

export interface SedeGenitore {
  scuolaId: string | null;
  motivo: MotivoSedeGenitore;
  /** Sedi distinte dei figli, ordinate: nel log ne finisce solo il CONTEGGIO. */
  sediFigli: string[];
}

/**
 * LA SEDE DI UN GENITORE È QUELLA DEI SUOI FIGLI.
 *
 * `parents` non ha (e non deve avere) una colonna sede: un genitore può avere
 * legittimamente bambini in due plessi. Ma `utenti.scuola_id` è NOT NULL e serve
 * a cose che contano — è la sede con cui vengono registrate la richiesta GDPR di
 * cancellazione e la notifica dei moduli firmati — quindi UNA va scelta.
 *
 * Fino al 2026-07-31 la sceglieva l'OPERATORE: `ensureParentIdentity(admin, row,
 * { scuolaId: auth.user.scuola_id })`. L'unico admin reale ha come sede primaria
 * Giugliano ed è, per la decisione del 30/07, l'unico che possa gestire Aversa e
 * Cesa: al primo invio di credenziali a una famiglia di Aversa quel genitore
 * sarebbe nato «di Giugliano». Il dato giusto era già in mano al codice —
 * `assertParentInScope` fa la stessa identica query 28 righe sopra.
 *
 * Ordine, e nessun `[0]` da nessuna parte:
 *   1. una sola sede fra i figli (più l'eventuale sede DICHIARATA) ⇒ quella;
 *   2. più d'una, ma il chiamante ne ha dichiarata una fra quelle ⇒ la dichiarata
 *      (è il caso dell'import iscrizioni: la sede del bambino che si sta
 *      iscrivendo, e il legame non è ancora scritto);
 *   3. più d'una, e l'operatore lavora in una di esse ⇒ quella, e si scrive nei log;
 *   4. nessun figlio ⇒ non c'è nulla da cui dedurre: si usa la sede indicata dal
 *      chiamante, dicendolo (è l'anagrafica genitore creata senza alunno);
 *   5. altrimenti ⇒ **niente sede**. Chi scrive dovrà dichiararla.
 *
 * @param opts.dichiarata sede che il DATO in lavorazione porta con sé.
 * @param opts.sedeOperatore sede in cui sta lavorando chi ha premuto il bottone:
 *   NON è un dato del genitore, serve solo a sciogliere un'ambiguità.
 */
export async function sedeDelGenitore(
  admin: SupabaseClient,
  parentId: string,
  opts: { dichiarata?: string | null; sedeOperatore?: string | null } = {},
): Promise<SedeGenitore> {
  const dichiarata = opts.dichiarata ?? null;
  const sedeOperatore = opts.sedeOperatore ?? null;

  let sediFigli: string[] = [];
  try {
    // Stessa query di `assertParentInScope`: il join `!inner` scarta i legami
    // il cui alunno non esiste più.
    const { data, error } = await admin
      .from('student_parents')
      .select('student_id, alunni!inner(scuola_id)')
      .eq('parent_id', parentId);
    if (error) {
      const codice = (error as { code?: string }).code ?? '';
      if (SCHEMA_ASSENTE.has(codice)) {
        // DB E2E della CI, non migrato: si degrada a ciò che è stato indicato,
        // senza gridare (è una condizione nota, non un guasto).
        logEvento('multi_sede', 'info', {
          operazione: 'auth/parent-identity:sedeDelGenitore', esito: 'schema-assente',
        }, error);
        return { scuolaId: dichiarata ?? sedeOperatore, motivo: 'schema-assente', sediFigli: [] };
      }
      // PostgREST non lancia: senza questo controllo una lettura rotta si
      // travestirebbe da «genitore senza figli» e la sede la sceglierebbe di
      // nuovo l'operatore — cioè il difetto tornerebbe, mascherato da degrado.
      logEvento('multi_sede', 'error', {
        operazione: 'auth/parent-identity:sedeDelGenitore', esito: 'sede-genitore-non-risolta',
      }, error);
      return { scuolaId: null, motivo: 'errore', sediFigli: [] };
    }
    type Riga = { alunni?: { scuola_id?: string | null } | { scuola_id?: string | null }[] | null };
    const sedi = new Set<string>();
    for (const r of (data ?? []) as Riga[]) {
      const nodo = r.alunni;
      for (const a of Array.isArray(nodo) ? nodo : nodo ? [nodo] : []) {
        if (a?.scuola_id) sedi.add(String(a.scuola_id));
      }
    }
    sediFigli = [...sedi].sort();
  } catch (e) {
    logEvento('multi_sede', 'error', {
      operazione: 'auth/parent-identity:sedeDelGenitore', esito: 'sede-genitore-non-risolta',
    }, e);
    return { scuolaId: null, motivo: 'errore', sediFigli: [] };
  }

  if (sediFigli.length === 0) {
    const ripiego = dichiarata ?? sedeOperatore;
    if (ripiego) {
      // `warn` → persistito: un genitore senza figli collegati NON ha una sede
      // propria, e la riga `utenti` che sta per nascere la eredita da chi opera.
      logEvento('multi_sede', 'warn', {
        operazione: 'auth/parent-identity:sedeDelGenitore',
        esito: 'sede-genitore-senza-figli',
        dichiarata: Boolean(dichiarata),
      });
      return { scuolaId: ripiego, motivo: 'operatore-senza-figli', sediFigli };
    }
    return { scuolaId: null, motivo: 'ambigua', sediFigli };
  }

  const candidati = new Set(sediFigli);
  if (dichiarata) candidati.add(dichiarata);
  if (candidati.size === 1) {
    return { scuolaId: [...candidati][0], motivo: sediFigli.length === 1 ? 'figli' : 'dichiarata', sediFigli };
  }
  if (dichiarata && candidati.has(dichiarata)) {
    return { scuolaId: dichiarata, motivo: 'dichiarata', sediFigli };
  }
  if (sedeOperatore && candidati.has(sedeOperatore)) {
    // Scelta legittima ma non ovvia (il genitore ha figli in più plessi): resta
    // scritta, così il giorno in cui una notifica arriva «alla sede sbagliata»
    // si sa perché.
    logEvento('multi_sede', 'info', {
      operazione: 'auth/parent-identity:sedeDelGenitore',
      esito: 'sede-genitore-scelta', n: sediFigli.length,
    });
    return { scuolaId: sedeOperatore, motivo: 'operatore', sediFigli };
  }
  logEvento('multi_sede', 'warn', {
    operazione: 'auth/parent-identity:sedeDelGenitore',
    esito: 'sede-genitore-ambigua', n: sediFigli.length,
  });
  return { scuolaId: null, motivo: 'ambigua', sediFigli };
}

/**
 * Garantisce la riga `utenti` per un auth uid. Se esiste già NON la tocca (un
 * docente-genitore conserva il ruolo staff: il profilo genitore deriva dal
 * ponte, vedi getProfiliForAuthUid). `email`/`nome`/`cognome`/`scuola_id` sono
 * NOT NULL a DB; `role`/`first_name`/`last_name` sono colonne GENERATE: mai scriverle.
 */
export async function ensureUtentiRow(
  admin: SupabaseClient,
  row: { id: string; email: string; nome?: string | null; cognome?: string | null; cellulare?: string | null; scuolaId: string | null }
): Promise<{ created: boolean; error: string | null }> {
  const { data: ex, error: exErr } = await admin
    .from('utenti')
    .select('id')
    .eq('id', row.id)
    .maybeSingle();
  if (exErr) return { created: false, error: exErr.message };
  if (ex) return { created: false, error: null };
  if (!row.scuolaId) {
    return {
      created: false,
      error: 'scuola non determinabile (utenti.scuola_id è NOT NULL): impossibile creare il profilo genitore',
    };
  }
  const { error } = await admin.from('utenti').insert({
    id: row.id,
    email: row.email,
    nome: (row.nome ?? '').trim() || row.email.split('@')[0],
    cognome: (row.cognome ?? '').trim(),
    cellulare: row.cellulare ?? null,
    ruolo: 'genitore',
    scuola_id: row.scuolaId,
    attivo: true,
  });
  if (error) return { created: false, error: error.message };
  return { created: true, error: null };
}

/**
 * Completa l'identità di accesso di un genitore: crea/riusa l'account
 * `auth.users` (dedup per email), scrive il ponte `parents.auth_user_id` e
 * garantisce la riga `utenti` ruolo 'genitore'. Idempotente: i pezzi già
 * presenti vengono riusati senza modifiche. Non invia MAI email.
 *
 * @param opts.scuolaId sede DICHIARATA dal dato in lavorazione (es. l'iscrizione
 *   che si sta approvando: è la sede del bambino, il cui legame non è ancora
 *   scritto). Concorre con le sedi dei figli, non le sostituisce.
 * @param opts.sedeOperatore sede in cui lavora chi ha premuto il bottone. NON
 *   determina la sede del genitore: serve a sciogliere l'ambiguità di un
 *   genitore con figli in più plessi, e a coprire il caso «nessun figlio».
 */
export async function ensureParentIdentity(
  admin: SupabaseClient,
  parent: ParentIdentityInput,
  opts: { scuolaId?: string | null; sedeOperatore?: string | null } = {}
): Promise<EnsureParentIdentityResult> {
  try {
    const email = firstEmail(parent.emails);
    if (!email) {
      return { ok: false, reason: 'no_email', message: 'Genitore senza email in anagrafica' };
    }

    let authUserId = parent.auth_user_id ?? null;
    let createdAuth = false;
    let password: string | null = null;
    let boundNow = false;

    if (!authUserId) {
      authUserId = await findAuthUserIdByEmail(admin, email);
      if (!authUserId) {
        password = randomPassword();
        const { data, error } = await admin.auth.admin.createUser({
          email,
          email_confirm: true,
          password,
        });
        if (error || !data?.user) {
          // Il corpo dell'errore del provider non si butta via (AGENTS.md §3), e
          // nemmeno l'evento: fino al 2026-07-31 questo ramo restituiva
          // «errore sconosciuto» al chiamante e NON lasciava una sola riga di
          // log — l'account del genitore non nasceva e non c'era niente da
          // cercare. Il chiamante è best-effort: se non logga qui, non logga
          // nessuno.
          const dettaglio = error ? dettaglioErroreAuth(error) : 'nessun utente restituito';
          logEvento('auth', 'error', {
            operazione: 'auth/parent-identity:ensureParentIdentity',
            esito: 'creazione-account-non-riuscita',
            stato: typeof (error as { status?: number } | null)?.status === 'number'
              ? (error as { status?: number }).status
              : undefined,
          }, error ?? new Error('createUser: nessun utente restituito'));
          return {
            ok: false,
            reason: 'error',
            message: `Creazione account non riuscita: ${dettaglio}`,
          };
        }
        authUserId = data.user.id;
        createdAuth = true;
      }

      // Ponte anagrafica↔account. UNIQUE(auth_user_id): se l'email è già
      // collegata a un'ALTRA anagrafica il DB rifiuta (23505) — meglio un
      // messaggio chiaro di un doppio legame che romperebbe resolveIdentity
      // (maybeSingle su parents per auth_user_id).
      const upd = await admin
        .from('parents')
        .update({ auth_user_id: authUserId })
        .eq('id', parent.id)
        .is('auth_user_id', null)
        .select('id');
      if (upd.error) {
        if ((upd.error as { code?: string }).code === '23505') {
          return {
            ok: false,
            reason: 'email_conflict',
            message: `L'email ${email} risulta già collegata a un'altra anagrafica genitore: correggere l'email o unificare le anagrafiche.`,
          };
        }
        return {
          ok: false,
          reason: 'error',
          message: `Collegamento anagrafica↔account non riuscito: ${upd.error.message}`,
        };
      }
      boundNow = (upd.data?.length ?? 0) > 0;
      if (!boundNow) {
        // Nessuna riga aggiornata: il ponte è stato scritto da altri nel
        // frattempo (o l'input era stantio). Rileggi e verifica coerenza.
        const cur = await admin
          .from('parents')
          .select('auth_user_id')
          .eq('id', parent.id)
          .maybeSingle();
        const curId = (cur.data as { auth_user_id?: string | null } | null)?.auth_user_id ?? null;
        if (curId && curId !== authUserId) {
          return { ok: false, reason: 'error', message: 'Anagrafica già collegata a un altro account' };
        }
        if (!curId) {
          return {
            ok: false,
            reason: 'error',
            message: `Collegamento anagrafica↔account non riuscito${cur.error ? `: ${cur.error.message}` : ''}`,
          };
        }
      }
    }

    // LA SEDE VIENE DAI FIGLI, non da chi preme il bottone (audit 2026-07-31, R6).
    const sede = await sedeDelGenitore(admin, parent.id, {
      dichiarata: opts.scuolaId ?? null,
      sedeOperatore: opts.sedeOperatore ?? null,
    });
    const scuolaId = sede.scuolaId;
    const utenti = await ensureUtentiRow(admin, {
      id: authUserId,
      email,
      nome: parent.first_name ?? null,
      cognome: parent.last_name ?? null,
      cellulare: parent.phone ?? null,
      scuolaId,
    });
    if (utenti.error) {
      return { ok: false, reason: 'error', message: `Profilo genitore (utenti) non creato: ${utenti.error}` };
    }

    return {
      ok: true,
      authUserId,
      email,
      createdAuth,
      createdUtenti: utenti.created,
      boundNow,
      password: createdAuth ? password : null,
      scuolaId,
    };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
