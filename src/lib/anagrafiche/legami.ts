import type { SupabaseClient } from '@supabase/supabase-js';
import { logEvento } from '@/lib/logging/logger';
import {
  COLONNE_VISIBILITA,
  motivoNascosto,
  type MotivoFiglioNascosto,
} from '@/lib/alunni/attivo';

// =============================================================================
// Risoluzione condivisa dei legami genitore(account)↔alunno.
//
// Due sorgenti storiche:
//  - `legame_genitori_alunni` (runtime): account `utenti` ↔ `alunni`, usata da
//    mensa/chat/pagamenti/primaria.
//  - `student_parents` (anagrafica/ETL): record `parents` ↔ `alunni`, collegata
//    all'account via ponte `parents.auth_user_id`.
// Possono divergere (un legame presente solo in una delle due). Questo helper fa
// l'UNIONE robusta delle due, così la risoluzione dei figli non dipende da quale
// tabella contiene il legame. È la fonte unica lato codice in vista del
// consolidamento fisico (VIEW) successivo.
// =============================================================================

/**
 * Un legame non letto NON è un dettaglio: è un genitore che non vede suo figlio
 * (galleria, agenda, chat, diario, pagamenti). PostgREST non lancia — torna
 * `{ error }` — quindi senza questa riga l'unione degraderebbe in SILENZIO a una
 * sola sorgente e nessuno se ne accorgerebbe. Livello `warn`: la risposta HTTP
 * resta valida (l'altra sorgente può bastare), ma la lettura è incompleta.
 * Nel log solo conteggi e il codice PostgREST: mai id/nomi di minori.
 */
function segnalaLetturaLegami(esito: string, tabella: string, n: number, err: unknown): void {
  logEvento('db', 'warn', {
    operazione: 'anagrafiche/legami',
    esito,
    entita_tipo: tabella,
    n,
    error_code: (err as { code?: string } | null)?.code ?? null,
  }, err);
}

/**
 * Alunni (id) collegati a un ACCOUNT genitore, CON il verdetto sulla completezza.
 *
 * ─── PERCHÉ L'ELENCO DA SOLO NON BASTA (rilievo T13) ────────────────────────
 *
 * Le tre letture qui sotto possono fallire, e PostgREST non lancia: ritorna
 * `{ error }`. Restituendo il solo elenco, una lettura fallita usciva come
 * «questo genitore non ha quel figlio» — cioè un guasto del database travestito
 * da risposta di merito. Su `genitoreHasFiglio` quel `false` diventava un 403
 * «Accesso negato» addosso al genitore TITOLARE, e per giunta accendeva il
 * contatore di sicurezza `alunno-non-della-famiglia`: un rilevatore di IDOR che
 * si riempie di blip del DB smette di essere un rilevatore.
 *
 * `completo: false` significa esattamente «l'elenco può essere corto: non
 * trarne conclusioni negative». Chi decide un ACCESSO deve guardarlo; chi
 * ELENCA può ignorarlo (mostrerà meno figli, non i figli di un altro).
 *
 * ─── «SCHEMA ASSENTE» NON È UN GUASTO ───────────────────────────────────────
 *
 * Sul DB E2E della CI (mai migrato) una delle due sorgenti può non esistere
 * affatto. Lì il codice PostgREST è `42P01`/`42703`/`PGRST20x`: non è una
 * lettura fallita, è un ambiente in cui quella sorgente non ha legami da dare.
 * Trattarlo da guasto renderebbe `non-deciso` OGNI verifica in CI, cioè un 500
 * su ogni rotta del genitore. Vedi `SCHEMA_ASSENTE` più sotto.
 */
export async function getFigliDiGenitoreEsito(
  supabase: SupabaseClient,
  accountId: string,
): Promise<{ figli: string[]; completo: boolean }> {
  const ids = new Set<string>();
  let completo = true;
  /** Un errore che NON è «schema assente» rende l'elenco inaffidabile. */
  const registra = (esito: string, tabella: string, n: number, err: unknown) => {
    segnalaLetturaLegami(esito, tabella, n, err);
    if (livelloPerErrore(err) !== 'info') completo = false;
  };

  const { data: runtime, error: errRuntime } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id')
    .eq('genitore_id', accountId);
  if (errRuntime) registra('figli-runtime-non-letti', 'legame_genitori_alunni', 1, errRuntime);
  for (const r of runtime ?? []) if (r.alunno_id) ids.add(r.alunno_id as string);

  // Ponte anagrafico: parents di questo account → student_parents.
  const { data: parentRows, error: errParents } = await supabase
    .from('parents')
    .select('id')
    .eq('auth_user_id', accountId);
  if (errParents) registra('figli-ponte-non-letto', 'parents', 1, errParents);
  const parentIds = (parentRows ?? []).map((p) => p.id as string);
  if (parentIds.length > 0) {
    const { data: sp, error: errSp } = await supabase
      .from('student_parents')
      .select('student_id')
      .in('parent_id', parentIds);
    if (errSp) registra('figli-anagrafica-non-letti', 'student_parents', parentIds.length, errSp);
    for (const r of sp ?? []) if (r.student_id) ids.add(r.student_id as string);
  }

  return { figli: [...ids], completo };
}

/** Alunni (id) collegati a un ACCOUNT genitore (utenti.id), unione runtime+anagrafica. */
export async function getFigliDiGenitore(
  supabase: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  return (await getFigliDiGenitoreEsito(supabase, accountId)).figli;
}

/**
 * Verso INVERSO dell'unione: alunno → ACCOUNT genitore (`utenti.id`), CON il
 * verdetto sulla completezza.
 *
 * Serve a chi elenca i tutori di un bambino (diario, chat lato docente,
 * destinatari). Stessa semantica di `getFigliDiGenitoreEsito`, stessa doppia
 * sorgente; qui il ponte si percorre al contrario (`student_parents.parent_id`
 * → `parents.auth_user_id`).
 *
 * ─── PERCHÉ ANCHE QUESTO VERSO HA BISOGNO DI `completo` ─────────────────────
 *
 * Le tre letture qui sotto possono fallire, e PostgREST non lancia: ritorna
 * `{ error }`. Per un anno il verso inverso ha loggato un `warn` e proseguito,
 * quindi un guasto usciva come «questo adulto NON è un genitore di questo
 * bambino» — un'affermazione senza misura. Su `adultoEGenitoreDi` quel `false`
 * diventava un **422** in faccia alla Segreteria («l'intestatario scelto non
 * risulta fra i genitori»), dove la verità era «non lo so» e la risposta giusta
 * è un **503** che invita a riprovare: la differenza fra un rifiuto di merito e
 * un guasto del database.
 *
 * Chi ELENCA può ignorare il flag (mostrerà meno destinatari, non i destinatari
 * di un altro bambino): per loro resta `getGenitoriDiAlunno`, invariata.
 * Chi RIFIUTA deve guardarlo.
 *
 * «Schema assente» (`SCHEMA_ASSENTE`, DB E2E della CI mai migrato) NON abbassa
 * `completo`: là quella sorgente non esiste e non ha legami da dare — trattarla
 * da guasto significherebbe 503 su ogni emissione in CI.
 *
 * Un `parents` SENZA account (`auth_user_id` nullo) non produce nulla: non
 * esiste un `utenti.id` da restituire, e inventarne uno romperebbe ogni
 * chiamante (che con quell'id legge `utenti`, manda notifiche, apre chat).
 *
 * In BLOCCO (3 query fisse, mai N+1): i chiamanti hanno tipicamente in mano
 * un'intera classe. Il verdetto è quello dell'intera lettura, non del singolo
 * alunno: le tre query sono per blocco, e un guasto le riguarda tutte.
 */
export async function getGenitoriDiAlunniEsito(
  supabase: SupabaseClient,
  alunnoIds: string[],
): Promise<{ perAlunno: Map<string, string[]>; completo: boolean }> {
  const perAlunno = new Map<string, string[]>();
  const unici = [...new Set((alunnoIds ?? []).filter(Boolean))];
  if (unici.length === 0) return { perAlunno, completo: true };

  let completo = true;
  /** Un errore che NON è «schema assente» rende l'elenco inaffidabile. */
  const registra = (esito: string, tabella: string, n: number, err: unknown) => {
    segnalaLetturaLegami(esito, tabella, n, err);
    if (livelloPerErrore(err) !== 'info') completo = false;
  };

  const aggiungi = (alunnoId: unknown, accountId: unknown) => {
    if (typeof alunnoId !== 'string' || typeof accountId !== 'string') return;
    const arr = perAlunno.get(alunnoId);
    if (!arr) perAlunno.set(alunnoId, [accountId]);
    else if (!arr.includes(accountId)) arr.push(accountId);
  };

  const { data: runtime, error: errRuntime } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id, genitore_id')
    .in('alunno_id', unici);
  if (errRuntime) registra('genitori-runtime-non-letti', 'legame_genitori_alunni', unici.length, errRuntime);
  for (const r of runtime ?? []) aggiungi(r.alunno_id, r.genitore_id);

  const { data: sp, error: errSp } = await supabase
    .from('student_parents')
    .select('student_id, parent_id')
    .in('student_id', unici);
  if (errSp) registra('genitori-anagrafica-non-letti', 'student_parents', unici.length, errSp);
  const righe = (sp ?? []) as { student_id?: unknown; parent_id?: unknown }[];
  const parentIds = [...new Set(righe.map((r) => r.parent_id).filter((v): v is string => typeof v === 'string'))];
  if (parentIds.length > 0) {
    const { data: ponti, error: errPonti } = await supabase
      .from('parents')
      .select('id, auth_user_id')
      .in('id', parentIds);
    if (errPonti) registra('genitori-ponte-non-letto', 'parents', parentIds.length, errPonti);
    const accountPerParent = new Map<string, string>();
    for (const p of (ponti ?? []) as { id?: unknown; auth_user_id?: unknown }[]) {
      if (typeof p.id === 'string' && typeof p.auth_user_id === 'string') {
        accountPerParent.set(p.id, p.auth_user_id);
      }
    }
    for (const r of righe) {
      if (typeof r.parent_id !== 'string') continue;
      aggiungi(r.student_id, accountPerParent.get(r.parent_id));
    }
  }

  return { perAlunno, completo };
}

/**
 * Alunno → account genitore, in blocco. Wrapper storico: scarta il verdetto.
 * Chi decide un RIFIUTO usi `getGenitoriDiAlunniEsito`.
 */
export async function getGenitoriDiAlunni(
  supabase: SupabaseClient,
  alunnoIds: string[],
): Promise<Map<string, string[]>> {
  return (await getGenitoriDiAlunniEsito(supabase, alunnoIds)).perAlunno;
}

/**
 * Account genitore (`utenti.id`) collegati a UN alunno, unione runtime+anagrafica,
 * CON il verdetto sulla completezza. `completo: false` = «l'elenco può essere
 * corto»: non se ne può concludere che un adulto non sia un genitore.
 */
export async function getGenitoriDiAlunnoEsito(
  supabase: SupabaseClient,
  alunnoId: string,
): Promise<{ genitori: string[]; completo: boolean }> {
  const { perAlunno, completo } = await getGenitoriDiAlunniEsito(supabase, [alunnoId]);
  return { genitori: perAlunno.get(alunnoId) ?? [], completo };
}

/**
 * Account genitore (`utenti.id`) collegati a UN alunno, unione runtime+anagrafica.
 * Wrapper storico dei sei chiamanti che ELENCANO (solleciti, mensa, merch,
 * diario, modulistica, `determinaQuoteFatturazione` in `intestatari.ts`): il
 * verdetto non li riguarda.
 */
export async function getGenitoriDiAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
): Promise<string[]> {
  return (await getGenitoriDiAlunnoEsito(supabase, alunnoId)).genitori;
}

/**
 * Il legame account-genitore ↔ alunno, con TRE esiti e non due.
 *
 *  · `si`          — il legame c'è (runtime o anagrafica);
 *  · `no`          — il legame non c'è, e le letture che potevano dirlo hanno
 *                    risposto: è una risposta di merito, si può negare;
 *  · `non-deciso`  — una lettura è fallita davvero. NON si può concludere
 *                    niente: chi decide un accesso risponda 500, mai 403.
 *
 * È il rimedio al rilievo T13, e la ragione per cui i tre stati non possono
 * stare su un `boolean`: `false` significava insieme «non è tuo figlio» e «non
 * ho potuto leggere», e la seconda arrivava al genitore titolare come
 * «Accesso negato» — con in più una riga nel contatore degli IDOR a suo nome.
 *
 * DIFESA IN PROFONDITÀ SULL'UUID (rilievo T16): un `alunnoId` che non è un uuid
 * non è un alunno, ed è un errore del CLIENT. Mandarlo a PostgREST produce
 * `22P02` — una riga `error` in `app_log`, cioè un errore di battitura contato
 * come guasto del SERVER dentro la soglia `tasso-errore` di /api/health. La
 * guardia sta anche nel gate (`requireParentOfStudent`), che copre venti rotte;
 * qui copre gli altri sette chiamanti diretti.
 */
export type EsitoLegame = 'si' | 'no' | 'non-deciso';

const FORMA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function verificaLegameGenitore(
  supabase: SupabaseClient,
  accountId: string,
  alunnoId: string,
): Promise<EsitoLegame> {
  if (!FORMA_UUID.test(alunnoId ?? '')) return 'no';

  // Fast-path runtime (una sola query nel caso comune). `error` si destruttura:
  // era proprio questa la riga che non lo faceva.
  const { data: r, error } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id')
    .eq('genitore_id', accountId)
    .eq('alunno_id', alunnoId)
    .maybeSingle();
  if (!error && r) return 'si';
  if (error) segnalaLetturaLegami('legame-runtime-non-letto', 'legame_genitori_alunni', 1, error);
  // Un guasto sul fast-path non basta a dire `non-deciso`: l'unione qui sotto
  // rilegge la stessa tabella e le altre due, e può ancora rispondere `si`.

  // Fallback anagrafico (unione delle due sorgenti).
  const { figli, completo } = await getFigliDiGenitoreEsito(supabase, accountId);
  if (figli.includes(alunnoId)) return 'si';
  // Il fast-path fallito conta come lettura incompleta tanto quanto le altre.
  if (!completo || (error && livelloPerErrore(error) !== 'info')) return 'non-deciso';
  return 'no';
}

/**
 * True se l'account genitore è collegato all'alunno (runtime O anagrafica).
 *
 * ⚠️ APPIATTISCE `non-deciso` SU `false`, e va detto: per i chiamanti che
 * decidono un accesso è il degrado sbagliato (nega a un genitore legittimo).
 * Resta per i sette call site storici — mensa, chat, gallery, avvisi, note,
 * forms — dove chiudere in caso di dubbio è comunque la scelta prudente e dove
 * il guasto ora LASCIA UNA RIGA (`segnalaLetturaLegami`), che è ciò che prima
 * mancava. Chi scrive codice nuovo usi `verificaLegameGenitore` e distingua.
 */
export async function genitoreHasFiglio(
  supabase: SupabaseClient,
  accountId: string,
  alunnoId: string,
): Promise<boolean> {
  return (await verificaLegameGenitore(supabase, accountId, alunnoId)) === 'si';
}

// =============================================================================
// Riparazione: dall'anagrafica al runtime.
//
// L'unione qui sopra risolve le LETTURE del codice applicativo, ma non tutto
// passa da lì: le policy RLS del baseline su `pagamenti`, `incassi` e
// `note_disciplinari` interrogano direttamente `legame_genitori_alunni`, e non
// si toccano. L'unico modo corretto di renderle vere è POPOLARE la tabella.
//
// Il momento giusto è quello in cui il genitore ottiene davvero un account
// (`ensureParentIdentity` riuscita): prima non esiste un `utenti.id` da mettere
// in `genitore_id`, e inventarne uno significherebbe scrivere una FK rotta.
// Per questo un `parents` senza `auth_user_id` esce da qui senza scrivere nulla:
// in produzione sono 11, e si ripareranno da soli il giorno in cui la Segreteria
// invierà loro le credenziali.
// =============================================================================

/**
 * Codici PostgREST che significano «lo schema qui non c'è» (il DB E2E della CI
 * non è migrato): non sono guasti, sono un ambiente diverso — livello `info`.
 *  42P01 tabella assente · 42703 colonna assente (SELECT) · PGRST204 colonna
 *  assente (INSERT/UPDATE) · PGRST205 tabella non in cache.
 */
const SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);

function livelloPerErrore(err: unknown): 'info' | 'error' {
  const code = (err as { code?: string } | null | undefined)?.code;
  return code && SCHEMA_ASSENTE.has(code) ? 'info' : 'error';
}

/**
 * Allinea al runtime i legami anagrafici di UN genitore.
 *
 * Legge `parents.auth_user_id`; se è nullo non c'è nulla da fare (`{creati:0}`).
 * Altrimenti crea in `legame_genitori_alunni` le sole righe MANCANTI, con
 * `intestatario_fattura:false` e `percentuale_pagamento:0`.
 *
 * `ignoreDuplicates:true` non è un dettaglio di stile: senza, l'upsert
 * SOVRASCRIVEREBBE la quota che la Segreteria ha impostato a mano (chi è
 * intestatario della fattura, con quale percentuale) ogni volta che qualcuno
 * rigenera le credenziali. Una riparazione non deve mai disfare un dato inserito
 * da una persona.
 *
 * Best-effort in tutto: è un'operazione accessoria dentro flussi (credenziali,
 * salvataggio anagrafica) che devono riuscire comunque.
 */
export async function sincronizzaLegamiRuntime(
  supabase: SupabaseClient,
  parentId: string,
): Promise<{ creati: number }> {
  if (!parentId) return { creati: 0 };

  // 1. Ponte anagrafica → account. PostgREST NON lancia: l'errore è nel ritorno.
  const { data: parent, error: errParent } = await supabase
    .from('parents')
    .select('auth_user_id')
    .eq('id', parentId)
    .maybeSingle();
  if (errParent) {
    logEvento('anagrafica', livelloPerErrore(errParent), {
      operazione: 'anagrafiche/legami:sincronizza',
      esito: 'ponte-non-letto',
      entita_tipo: 'parents',
      error_code: (errParent as { code?: string }).code ?? null,
    }, errParent);
    return { creati: 0 };
  }
  const accountId = (parent as { auth_user_id?: unknown } | null)?.auth_user_id;
  if (typeof accountId !== 'string' || accountId === '') {
    // Caso normale, non un guasto: anagrafica senza account. Va comunque scritto,
    // altrimenti «non ha riparato niente» e «non è mai partito» si somigliano.
    logEvento('anagrafica', 'info', {
      operazione: 'anagrafiche/legami:sincronizza',
      esito: 'legami-runtime-senza-account',
      parent_id: parentId,
      creati: 0,
    });
    return { creati: 0 };
  }

  // 2. Figli in anagrafica.
  const { data: sp, error: errSp } = await supabase
    .from('student_parents')
    .select('student_id')
    .eq('parent_id', parentId);
  if (errSp) {
    logEvento('anagrafica', livelloPerErrore(errSp), {
      operazione: 'anagrafiche/legami:sincronizza',
      esito: 'anagrafica-non-letta',
      entita_tipo: 'student_parents',
      error_code: (errSp as { code?: string }).code ?? null,
    }, errSp);
    return { creati: 0 };
  }
  const alunni = [
    ...new Set(
      ((sp ?? []) as { student_id?: unknown }[])
        .map((r) => r.student_id)
        .filter((v): v is string => typeof v === 'string' && v !== ''),
    ),
  ];
  if (alunni.length === 0) return { creati: 0 };

  // 3. Cosa esiste già a runtime: serve a contare i creati per davvero (con
  //    `ignoreDuplicates` la risposta dell'upsert non lo direbbe) e a non
  //    spedire una scrittura quando non c'è niente da creare.
  const { data: gia, error: errGia } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id')
    .eq('genitore_id', accountId)
    .in('alunno_id', alunni);
  if (errGia) {
    // Non si interrompe: l'upsert è idempotente e `ignoreDuplicates` protegge
    // comunque le righe esistenti. Cambia solo l'esattezza del conteggio.
    logEvento('anagrafica', livelloPerErrore(errGia), {
      operazione: 'anagrafiche/legami:sincronizza',
      esito: 'runtime-non-letto',
      entita_tipo: 'legame_genitori_alunni',
      error_code: (errGia as { code?: string }).code ?? null,
    }, errGia);
  }
  const presenti = new Set(
    ((gia ?? []) as { alunno_id?: unknown }[])
      .map((r) => r.alunno_id)
      .filter((v): v is string => typeof v === 'string'),
  );
  const mancanti = alunni.filter((a) => !presenti.has(a));
  if (mancanti.length === 0) return { creati: 0 };

  const { error: errUp } = await supabase.from('legame_genitori_alunni').upsert(
    mancanti.map((alunnoId) => ({
      genitore_id: accountId,
      alunno_id: alunnoId,
      intestatario_fattura: false,
      percentuale_pagamento: 0,
    })),
    { onConflict: 'genitore_id,alunno_id', ignoreDuplicates: true },
  );
  if (errUp) {
    logEvento('anagrafica', livelloPerErrore(errUp), {
      operazione: 'anagrafiche/legami:sincronizza',
      esito: 'legami-runtime-non-scritti',
      entita_tipo: 'legame_genitori_alunni',
      n: mancanti.length,
      error_code: (errUp as { code?: string }).code ?? null,
    }, errUp);
    return { creati: 0 };
  }

  // Evento di riparazione: si logga il SUCCESSO, non solo l'errore.
  logEvento('anagrafica', 'info', {
    operazione: 'anagrafiche/legami:sincronizza',
    esito: 'legami-runtime-sincronizzati',
    parent_id: parentId,
    creati: mancanti.length,
  });
  return { creati: mancanti.length };
}

// =============================================================================
// I FIGLI CHE LA FAMIGLIA DEVE VEDERE — e perché è un helper ACCANTO all'altro.
//
// ─── IL DIFETTO, misurato il 2026-09-05 ─────────────────────────────────────
//
// `GET /api/parent/students` risolveva i legami e poi leggeva `alunni` con il
// solo `.in('id', ids)`: nessun filtro su `section_id`, `stato`, `archiviato_il`.
// Quella rotta alimenta `useParentIdentity` → `ChildSwitcher` → lo `studentId`
// di TUTTA l'app di famiglia, quindi un bambino senza sezione entrava dappertutto
// e poi perdeva in silenzio — moduli e avvisi di classe, news di grado, agenda di
// sezione, materiali dell'armadietto, l'intera area primaria (che ha un blocco
// duro su `section_id` in quattro rotte) e le RETTE, che `genera-rette` non
// produce mai per chi non ha classe. Presente e non funzionante: la combinazione
// peggiore, perché non lascia nemmeno un errore da cercare.
//
// Misurato sul database di produzione, non dedotto:
//   · 5 alunni non archiviati SENZA `section_id` (3 nella sede Demo, 2 veri);
//   · 5 alunni ARCHIVIATI ancora legati a un account, quindi ancora mostrati;
//   · 12 legami in tutto cadono sotto il filtro, su 684 account con figli;
//   · 4 account resterebbero senza NESSUN figlio visibile — ed è il motivo per
//     cui esiste la schermata di cortesia: nascondere a secco, per loro, è
//     un'app vuota senza spiegazione.
//
// ─── PERCHÉ NON SI STRINGE `getFigliDiGenitore` ─────────────────────────────
//
// Ha 14 chiamanti, e tre sono `api/pagamenti`, `api/pagamenti/famiglia` e
// `lib/pagamenti/sospensione`. Filtrare là dentro toglierebbe dalla vista i figli
// RITIRATI CHE HANNO ANCORA PAGAMENTI APERTI: una famiglia smetterebbe di vedere
// (e di poter saldare) il dovuto di un bambino che ha lasciato la scuola, e la
// sospensione per morosità smetterebbe di contarlo. Un filtro giusto per una
// superficie è un difetto su un'altra: si AFFIANCA, non si stringe.
// =============================================================================

/** Le colonne di un figlio che l'app di famiglia mostra davvero. */
export interface RigaFiglio {
  id: string;
  nome: string | null;
  cognome: string | null;
  classe_sezione: string | null;
  scuola_id: string | null;
}

export interface EsitoFigliAttivi {
  /** I figli da mostrare: le RIGHE, non i soli id. */
  righe: RigaFiglio[];
  /** Quanti legami figlio↔genitore esistono, PRIMA del filtro. */
  totaleLegami: number;
  /** Quanti ne ha tolti il filtro, per motivo. */
  nascosti: Record<MotivoFiglioNascosto, number>;
  /** `false` = l'elenco dei legami può essere corto (vedi `getFigliDiGenitoreEsito`). */
  completo: boolean;
  /** La lettura di `alunni` è fallita: chi risponde a un client decida (500). */
  errore: { code?: string; message?: string } | null;
}

/**
 * Le colonne lette. Le prime cinque sono il contratto dell'app di famiglia; le
 * ultime tre servono SOLO a decidere chi si mostra e non escono di qui.
 */
const COLONNE_FIGLIO = [
  'id', 'nome', 'cognome', 'classe_sezione', 'scuola_id',
  ...COLONNE_VISIBILITA,
];

function nascostiVuoti(): Record<MotivoFiglioNascosto, number> {
  return { archiviato: 0, ritirato: 0, 'senza-sezione': 0 };
}

function testo(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * I figli di un genitore che la sua app deve MOSTRARE: unione dei legami
 * (`getFigliDiGenitoreEsito`) ristretta a chi ha una classe, non è archiviato ed
 * è ancora iscritto.
 *
 * ⚠️ LO STATO NON HA UN VOCABOLARIO SUO, QUI. Il confine lo decide
 * `eAncoraIscritto` (`@/lib/alunni/stato`), che è lo stesso predicato che protegge
 * dall'anonimizzazione: `'sospeso'` è un bambino che FREQUENTA e resta visibile,
 * uno stato sconosciuto o vuoto non autorizza a nascondere niente. Riscrivere qui
 * `.neq('stato','iscritto')` sarebbe la settima copia di una regola che questo
 * repo ha già pagato per aver tenuto in sei posti.
 *
 * ⚠️ IL FILTRO SI APPLICA IN JS, NON IN SQL, ed è una scelta con due ragioni.
 * La prima: `eAncoraIscritto` è complementare a un'ALLOWLIST, e la sua traduzione
 * PostgREST (`not.in`) su una colonna che può essere NULL escluderebbe la riga
 * invece di ammetterla — l'opposto esatto del predicato. La seconda: per loggare
 * il MOTIVO bisogna aver letto la riga, e un filtro che scarta nel database non
 * sa dire di che cosa si è liberato.
 *
 * ⚠️ COLONNA ASSENTE ⇒ QUEL CRITERIO NON SI APPLICA (e si logga). Il DB E2E della
 * CI non è migrato e su `SELECT` risponde `42703`: il ciclo qui sotto toglie la
 * colonna e rilegge. Degradare APERTI è il verso giusto in cui sbagliare — chiudere
 * significherebbe svuotare l'app a 662 famiglie perché uno schema è indietro — ma
 * un degrado muto sarebbe un filtro che smette di filtrare senza dirlo, quindi la
 * riga di `warn` non è un ornamento.
 */
export async function getFigliAttiviDiGenitore(
  supabase: SupabaseClient,
  accountId: string,
): Promise<EsitoFigliAttivi> {
  const { figli: ids, completo } = await getFigliDiGenitoreEsito(supabase, accountId);
  if (ids.length === 0) {
    return { righe: [], totaleLegami: 0, nascosti: nascostiVuoti(), completo, errore: null };
  }

  let colonne = [...COLONNE_FIGLIO];
  const leggi = () => supabase.from('alunni').select(colonne.join(', ')).in('id', ids);
  let { data, error } = await leggi();
  let tentativi = 0;
  while (error && (error as { code?: string }).code === '42703' && tentativi < 5) {
    const col = /column\s+(?:\w+\.)?"?(\w+)"?\s+does not exist/i.exec(
      (error as { message?: string }).message ?? '',
    )?.[1];
    if (!col || col === 'id' || !colonne.includes(col)) break;
    logEvento('db', 'info', {
      operazione: 'anagrafiche/legami:figli-attivi',
      esito: 'colonna-assente-rimossa',
      entita_tipo: 'alunni',
      error_code: '42703',
    });
    colonne = colonne.filter((c) => c !== col);
    ({ data, error } = await leggi());
    tentativi++;
  }

  if (error) {
    // PostgREST non lancia: senza questo ramo la lettura fallita uscirebbe come
    // «questo genitore non ha figli», cioè un guasto travestito da risposta.
    segnalaLetturaLegami('figli-attivi-non-letti', 'alunni', ids.length, error);
    return {
      righe: [],
      totaleLegami: ids.length,
      nascosti: nascostiVuoti(),
      completo: false,
      errore: error as { code?: string; message?: string },
    };
  }

  const presenti = new Set(colonne);
  const nascosti = nascostiVuoti();
  const righe: RigaFiglio[] = [];

  for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
    const id = testo(r.id);
    if (!id) continue;
    // Il motivo lo decide `@/lib/alunni/attivo`, lo stesso predicato che usa il
    // gate delle venti rotte: due copie di questa regola vorrebbero dire un
    // bambino nascosto nell'elenco e visibile aprendo il link, o viceversa.
    const motivo = motivoNascosto(r, presenti);
    if (motivo) { nascosti[motivo] += 1; continue; }
    righe.push({
      id,
      nome: testo(r.nome),
      cognome: testo(r.cognome),
      classe_sezione: testo(r.classe_sezione),
      scuola_id: testo(r.scuola_id),
    });
  }

  const totale = nascosti.archiviato + nascosti.ritirato + nascosti['senza-sezione'];
  if (totale > 0) {
    // ⚠️ `warn` E NON `info`, e la ragione è misurabile: `anagrafica` sta fra le
    // `DEROGHE_INFO_NON_PERSISTITI` di `__tests__/architecture/eventi-log.test.ts`,
    // quindi un `info` su questo canale vive qualche giorno sui log di Vercel e
    // poi sparisce. Questa riga esiste per una domanda che si fa in SQL fra sei
    // mesi — «i cinque bambini invisibili sono diventati cinquanta?» — e un log
    // che non arriva in tabella non la risponde. `vaPersistito` manda in `app_log`
    // tutto ciò che è `warn` o `error`: è l'unico livello che la fa arrivare.
    //
    // SOLO UUID E NUMERI: `operazione` ed `esito` sono in lista bianca,
    // `genitore_id` passa per FORMA (uuid), il resto sono conteggi. Nessun
    // `alunno_id`, nessun nome: per contare non serve sapere di chi.
    logEvento('anagrafica', 'warn', {
      operazione: 'anagrafiche/legami:figli-attivi',
      esito: 'figli-nascosti-alla-famiglia',
      genitore_id: accountId,
      n: totale,
      n_visibili: righe.length,
      n_archiviati: nascosti.archiviato,
      n_ritirati: nascosti.ritirato,
      n_senza_sezione: nascosti['senza-sezione'],
    });
  }

  return { righe, totaleLegami: ids.length, nascosti, completo, errore: null };
}
