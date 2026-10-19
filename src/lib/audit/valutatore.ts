import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
// ⚠️ Da `predicati-ruolo` e NON da `require-staff`: 296 file di test sostituiscono
// `require-staff` per intero, e importare di là un PREDICATO (non un tipo, che
// viene cancellato in compilazione) lo farebbe arrivare qui `undefined` — anzi,
// farebbe lanciare vitest. Il perché per esteso sta nella testata di
// `predicati-ruolo.ts`; `require-staff` lo ri-esporta, quindi le due strade
// portano alla stessa funzione, ma una sola sopravvive al mock.
import { haRuolo, type AppUser } from '@/lib/auth/predicati-ruolo'
import { rispostaGuastoDb } from '@/lib/db/guasto'

// =============================================================================
// Preservazione del VALUTATORE (firma FEA / "vero valutatore").
//
// I campi che rappresentano l'autore della valutazione/firma (valutazioni.maestra_id,
// note_disciplinari.maestra_id, firme_docenti.maestra_id, scrutinio_giudizi.proposto_da)
// NON devono MAI assumere l'identità della Segreteria/Direzione. Per l'educator
// l'autore è sé stesso; per staff/segreteria l'autore deve essere un docente
// TITOLARE selezionato esplicitamente (docenteId), validato sulla sezione/materia.
// =============================================================================

/**
 * La titolarità letta dal database, col guasto DISTINTO dal «no». PostgREST non lancia: un
 * `{ data: null, error }` letto come «nessuna riga» diventava un 422 «il docente non è
 * titolare» per un docente che lo è, e nessuna riga nei log diceva che il database non aveva
 * risposto.
 */
async function leggiTitolarita(
  supabase: SupabaseClient,
  utenteId: string,
  sectionId: string,
  materiaId?: string | null,
): Promise<{ titolare: boolean; error: null } | { titolare: null; error: unknown }> {
  if (materiaId) {
    const { data, error } = await supabase
      .from('utenti_sezioni_materie')
      .select('utente_id')
      .eq('utente_id', utenteId)
      .eq('section_id', sectionId)
      .eq('materia_id', materiaId)
      .limit(1)
    if (error) return { titolare: null, error }
    if (data && data.length) return { titolare: true, error: null }
  }
  const { data: us, error } = await supabase
    .from('utenti_sezioni')
    .select('utente_id')
    .eq('utente_id', utenteId)
    .eq('section_id', sectionId)
    .limit(1)
  if (error) return { titolare: null, error }
  return { titolare: !!(us && us.length), error: null }
}

/**
 * True se l'utente è titolare/contitolare della sezione (eventualmente per materia).
 * Un guasto del database LANCIA (errore con `cause`, che `logErrore` del chiamante registra col
 * codice Postgres): non è né un sì né un no.
 */
export async function isTitolareSezione(
  supabase: SupabaseClient,
  utenteId: string,
  sectionId: string,
  materiaId?: string | null,
): Promise<boolean> {
  const r = await leggiTitolarita(supabase, utenteId, sectionId, materiaId)
  // Il discriminante è `titolare`: `error` è `unknown`, e `unknown` comprende anche `null`.
  if (r.titolare === null) {
    throw new Error('Verifica della titolarità del docente non riuscita', { cause: r.error })
  }
  return r.titolare
}

/**
 * Primo titolare (docente) di una materia in una sezione, o null se non ce n'è.
 * Un guasto del database LANCIA: un `null` qui farebbe salvare un giudizio senza proponente
 * (`proposto_da`, vincolo FEA) come se la materia non avesse titolare.
 */
export async function titolareDiMateria(
  supabase: SupabaseClient,
  sectionId: string,
  materiaId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('utenti_sezioni_materie')
    .select('utente_id')
    .eq('section_id', sectionId)
    .eq('materia_id', materiaId)
    .limit(1)
  if (error) {
    throw new Error('Lettura del titolare della materia non riuscita', { cause: error })
  }
  return data && data.length ? (data[0].utente_id as string) : null
}

/**
 * Determina l'identità del valutatore (firma/autore) da scrivere su una entità
 * valutativa. educator → sé stesso. staff/segreteria → docente TITOLARE indicato
 * in `docenteId`, validato su sezione (ed eventualmente materia); 422 se mancante
 * o non valido (mai forgiare la firma sulla Segreteria).
 */
export async function risolviValutatore(
  supabase: SupabaseClient,
  attore: AppUser,
  sectionId: string,
  opts: { docenteId?: string | null; materiaId?: string | null } = {},
): Promise<{ valutatoreId: string; response?: undefined } | { valutatoreId?: undefined; response: NextResponse }> {
  // RUOLO REALE, non la veste indossata adesso. `require-staff.ts:341-348`
  // (`conRuoloAttivo`) scrive il cookie `kv-active-role` SOPRA `user.role` prima
  // che la route veda l'utente: con `attore.role === 'educator'` la maestra che è
  // anche mamma, mentre guardava l'app come genitore, superava `requireDocente`
  // (che i ruoli reali li guarda) e poi si sentiva chiedere di indicare «il
  // docente titolare» — essendo lei. «È un docente?» è AUTORIZZAZIONE, e
  // l'autorizzazione non passa mai dal cookie: `haRuolo`, non `role`.
  //
  // E nell'altro verso: `ruoli` porta SOLO i ruoli del database (`utenti.ruolo`
  // + `genitore` se esiste il ponte `parents`), quindi un cookie forgiato non
  // può farci entrare nessuno — prima invece bastava un `role` a 'educator'.
  if (haRuolo(attore, 'educator')) {
    return { valutatoreId: attore.id }
  }
  const docenteId = opts.docenteId
  if (!docenteId) {
    return {
      response: NextResponse.json(
        { error: 'Seleziona il docente titolare: la firma/valutazione deve restare del docente, non della Segreteria.' },
        { status: 422 },
      ),
    }
  }
  const titolarita = await leggiTitolarita(supabase, docenteId, sectionId, opts.materiaId)
  // Un guasto non è «non titolare»: 500 con codice, mai il 422 che accusa il docente scelto.
  if (titolarita.titolare === null) {
    return { response: rispostaGuastoDb('audit/valutatore:risolviValutatore', 'db:utenti_sezioni', titolarita.error) }
  }
  if (!titolarita.titolare) {
    return {
      response: NextResponse.json(
        { error: 'Il docente selezionato non è titolare/contitolare di questa classe.' },
        { status: 422 },
      ),
    }
  }
  return { valutatoreId: docenteId }
}
