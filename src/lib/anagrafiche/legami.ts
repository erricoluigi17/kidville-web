import type { SupabaseClient } from '@supabase/supabase-js';
import { logEvento } from '@/lib/logging/logger';

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

/** Alunni (id) collegati a un ACCOUNT genitore (utenti.id), unione runtime+anagrafica. */
export async function getFigliDiGenitore(
  supabase: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  const ids = new Set<string>();

  const { data: runtime, error: errRuntime } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id')
    .eq('genitore_id', accountId);
  if (errRuntime) segnalaLetturaLegami('figli-runtime-non-letti', 'legame_genitori_alunni', 1, errRuntime);
  for (const r of runtime ?? []) if (r.alunno_id) ids.add(r.alunno_id as string);

  // Ponte anagrafico: parents di questo account → student_parents.
  const { data: parentRows, error: errParents } = await supabase
    .from('parents')
    .select('id')
    .eq('auth_user_id', accountId);
  if (errParents) segnalaLetturaLegami('figli-ponte-non-letto', 'parents', 1, errParents);
  const parentIds = (parentRows ?? []).map((p) => p.id as string);
  if (parentIds.length > 0) {
    const { data: sp, error: errSp } = await supabase
      .from('student_parents')
      .select('student_id')
      .in('parent_id', parentIds);
    if (errSp) segnalaLetturaLegami('figli-anagrafica-non-letti', 'student_parents', parentIds.length, errSp);
    for (const r of sp ?? []) if (r.student_id) ids.add(r.student_id as string);
  }

  return [...ids];
}

/**
 * Verso INVERSO dell'unione: alunno → ACCOUNT genitore (`utenti.id`).
 * Serve a chi elenca i tutori di un bambino (diario, chat lato docente,
 * destinatari). Stessa semantica di `getFigliDiGenitore`, stessa doppia
 * sorgente; qui il ponte si percorre al contrario (`student_parents.parent_id`
 * → `parents.auth_user_id`).
 *
 * Un `parents` SENZA account (`auth_user_id` nullo) non produce nulla: non
 * esiste un `utenti.id` da restituire, e inventarne uno romperebbe ogni
 * chiamante (che con quell'id legge `utenti`, manda notifiche, apre chat).
 *
 * In BLOCCO (3 query fisse, mai N+1): i chiamanti hanno tipicamente in mano
 * un'intera classe.
 */
export async function getGenitoriDiAlunni(
  supabase: SupabaseClient,
  alunnoIds: string[],
): Promise<Map<string, string[]>> {
  const perAlunno = new Map<string, string[]>();
  const unici = [...new Set((alunnoIds ?? []).filter(Boolean))];
  if (unici.length === 0) return perAlunno;

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
  if (errRuntime) segnalaLetturaLegami('genitori-runtime-non-letti', 'legame_genitori_alunni', unici.length, errRuntime);
  for (const r of runtime ?? []) aggiungi(r.alunno_id, r.genitore_id);

  const { data: sp, error: errSp } = await supabase
    .from('student_parents')
    .select('student_id, parent_id')
    .in('student_id', unici);
  if (errSp) segnalaLetturaLegami('genitori-anagrafica-non-letti', 'student_parents', unici.length, errSp);
  const righe = (sp ?? []) as { student_id?: unknown; parent_id?: unknown }[];
  const parentIds = [...new Set(righe.map((r) => r.parent_id).filter((v): v is string => typeof v === 'string'))];
  if (parentIds.length > 0) {
    const { data: ponti, error: errPonti } = await supabase
      .from('parents')
      .select('id, auth_user_id')
      .in('id', parentIds);
    if (errPonti) segnalaLetturaLegami('genitori-ponte-non-letto', 'parents', parentIds.length, errPonti);
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

  return perAlunno;
}

/** Account genitore (`utenti.id`) collegati a UN alunno, unione runtime+anagrafica. */
export async function getGenitoriDiAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
): Promise<string[]> {
  const mappa = await getGenitoriDiAlunni(supabase, [alunnoId]);
  return mappa.get(alunnoId) ?? [];
}

/** True se l'account genitore è collegato all'alunno (runtime O anagrafica). */
export async function genitoreHasFiglio(
  supabase: SupabaseClient,
  accountId: string,
  alunnoId: string,
): Promise<boolean> {
  // Fast-path runtime (una sola query nel caso comune).
  const { data: r } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id')
    .eq('genitore_id', accountId)
    .eq('alunno_id', alunnoId)
    .maybeSingle();
  if (r) return true;
  // Fallback anagrafico.
  const figli = await getFigliDiGenitore(supabase, accountId);
  return figli.includes(alunnoId);
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
