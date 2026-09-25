import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { logEvento } from '@/lib/logging/logger'
import { verificaPermessoVoce, rispostaPermessoNegato } from '@/lib/primaria/permesso-voce'
import { allegatiRegistroVivi } from '@/lib/primaria/cestino-allegati-registro'

/**
 * GLI ALLEGATI DEL REGISTRO DELLA PRIMARIA — le regole che condividono le route
 * `primaria/allegati` (caricamento, elenco, rinomina, eliminazione),
 * `primaria/allegati/sostituisci` e `primaria/allegati/cestino`.
 *
 * Spec 2026-09-24 («2 Primaria» + «Decisioni aggiunte» + «Convenzioni»):
 *  · «Elimina» mette l'allegato nel CESTINO (`eliminato_il`, `eliminato_da`, slot
 *    d'origine dalla lezione): il file resta nello Storage finché la purga non lo toglie;
 *  · «Modifica» = RINOMINARE (il nome mostrato, `file_name`) e SOSTITUIRE il file:
 *    riga nuova col file nuovo sulla stessa lezione, riga vecchia nel cestino;
 *  · chi: l'autore (`caricato_da`) più Segreteria e Direzione; fino a quando: il
 *    termine sulla DATA DELLA LEZIONE (`registro_orario.data`), oltre il quale serve lo
 *    sblocco della Direzione. Lo decide `permesso-voce` (tipo `allegato`).
 *
 * ⚠️ `allegati_registro` NON ha `scuola_id`: la sede è quella della lezione. Ogni
 * operazione risale alla lezione (o allo slot d'origine, nel cestino) e verifica la
 * classe con `assertSezioneInScope` PRIMA del permesso sulla voce.
 */

/** Il contenitore Storage degli allegati (lo stesso di `primaria/allegati:POST` e della purga). */
export const BUCKET_ALLEGATI_REGISTRO = 'registro-allegati'
export const MAX_PDF_ALLEGATO = 10 * 1024 * 1024 // 10 MB
export const MAX_IMG_ALLEGATO = 3 * 1024 * 1024 // 3 MB
export const IMG_TYPES_ALLEGATO: readonly string[] = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']

/** Le colonne di una riga di `allegati_registro` che le route di gestione leggono. */
export const COLONNE_ALLEGATO =
  'id, registro_id, ambito, tipo, file_url, file_name, dimensione_byte, caricato_da, creato_il, ' +
  'eliminato_il, eliminato_da, slot_section_id, slot_data, slot_ora_lezione'

export type AllegatoRegistro = {
  id: string
  registro_id: string | null
  ambito: string | null
  tipo: string | null
  file_url: string | null
  file_name: string | null
  dimensione_byte: number | null
  caricato_da: string | null
  creato_il: string | null
  eliminato_il: string | null
  eliminato_da: string | null
  slot_section_id: string | null
  slot_data: string | null
  slot_ora_lezione: number | null
}

export const COLONNE_LEZIONE_ALLEGATO = 'id, scuola_id, section_id, data, ora_lezione'

export type LezioneAllegato = {
  id: string
  scuola_id: string | null
  section_id: string
  data: string
  ora_lezione: number
}

/** La data della lezione come `YYYY-MM-DD`: è la «data dell'evento» del termine. */
export function dataLezione(l: { data: string }): string {
  return String(l.data).slice(0, 10)
}

/**
 * Il file è ammesso? PDF fino a 10 MB, immagini (JPG, PNG, WEBP, GIF) fino a 3 MB —
 * gli stessi limiti del caricamento di sempre. Risposta pronta, col suo codice.
 */
export function validaFileAllegato(
  file: File,
): { ok: true; tipo: 'pdf' | 'immagine' } | { ok: false; risposta: NextResponse } {
  const isPdf = file.type === 'application/pdf'
  const isImg = IMG_TYPES_ALLEGATO.includes(file.type)
  if (!isPdf && !isImg) {
    return {
      ok: false,
      risposta: NextResponse.json(
        { error: 'Formato non ammesso (PDF o immagine)', codice: 'ALLEGATO_REGISTRO_FORMATO_NON_AMMESSO' },
        { status: 400 },
      ),
    }
  }
  if ((isPdf && file.size > MAX_PDF_ALLEGATO) || (isImg && file.size > MAX_IMG_ALLEGATO)) {
    return {
      ok: false,
      risposta: NextResponse.json(
        { error: isPdf ? 'PDF oltre 10MB' : 'Immagine oltre 3MB', codice: 'ALLEGATO_REGISTRO_TROPPO_GRANDE' },
        { status: 400 },
      ),
    }
  }
  return { ok: true, tipo: isPdf ? 'pdf' : 'immagine' }
}

/**
 * Un percorso NUOVO nello Storage: mai sovrascrivere. Nella sostituzione il vecchio
 * file è ciò che il cestino promette di custodire per sette giorni.
 */
export function percorsoAllegato(registroId: string, nomeFile: string): string {
  const ext = nomeFile.includes('.') ? nomeFile.split('.').pop() || '' : ''
  return `registro/${registroId}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`
}

/** Le risposte d'errore condivise, col loro codice (mai il messaggio grezzo di PostgREST). */
export const risposte = {
  letturaFallita: () =>
    NextResponse.json({ error: 'Lettura degli allegati non riuscita. Riprova.', codice: 'LETTURA_FALLITA' }, { status: 500 }),
  allegatoNonTrovato: () =>
    NextResponse.json({ error: 'Allegato non trovato', codice: 'ALLEGATO_REGISTRO_NON_TROVATO' }, { status: 404 }),
  lezioneNonTrovata: () =>
    NextResponse.json({ error: 'Lezione non trovata', codice: 'LEZIONE_NON_TROVATA' }, { status: 404 }),
  cambiato: () =>
    NextResponse.json(
      { error: "L'allegato è stato eliminato o sostituito nel frattempo", codice: 'ALLEGATO_REGISTRO_CAMBIATO' },
      { status: 409 },
    ),
  scritturaFallita: () =>
    NextResponse.json(
      { error: 'Operazione sull’allegato non riuscita. Ricarica e controlla.', codice: 'ALLEGATO_REGISTRO_SCRITTURA_FALLITA' },
      { status: 500 },
    ),
  cestinoNonDisponibile: () =>
    NextResponse.json(
      { error: 'Il cestino degli allegati non è ancora disponibile.', codice: 'ALLEGATO_REGISTRO_CESTINO_NON_DISPONIBILE' },
      { status: 503 },
    ),
}

/** Le colonne del cestino che il database E2E della CI (non migrato) può non avere. */
export const CESTINO_ASSENTE = new Set(['42703', 'PGRST204'])

export function codiceErrore(err: unknown): string {
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : ''
}

/**
 * La lezione di un allegato, letta per id. `null` se non c'è; lancia mai: un guasto
 * di lettura torna come `{ errore }`.
 */
export async function leggiLezione(
  supabase: SupabaseClient,
  registroId: string,
): Promise<{ lezione: LezioneAllegato | null; errore: unknown }> {
  const { data, error } = await supabase
    .from('registro_orario')
    .select(COLONNE_LEZIONE_ALLEGATO)
    .eq('id', registroId)
    .maybeSingle()
  if (error) return { lezione: null, errore: error }
  const l = data as LezioneAllegato | null
  return { lezione: l && l.section_id ? l : null, errore: null }
}

export type AllegatoGestibile =
  | { ok: true; allegato: AllegatoRegistro; lezione: LezioneAllegato }
  | { ok: false; risposta: NextResponse }

/**
 * Tutto quello che precede una MODIFICA di un allegato VIVO (rinomina, eliminazione,
 * sostituzione), nell'ordine che conta:
 *   1. la riga, VIVA (nel cestino = per il resto dell'app non esiste: 404);
 *   2. la sua lezione;
 *   3. la classe nello scope dell'utente (sede, e per il docente l'assegnazione);
 *   4. il permesso sulla voce: autore o staff (403), entro il termine sulla data
 *      della lezione o con uno sblocco (423).
 * Un guasto di lettura è un 500 `LETTURA_FALLITA`, mai un 404 travestito.
 */
export async function allegatoDaGestire(
  supabase: SupabaseClient,
  utente: AppUser,
  id: string,
  operazione: string,
): Promise<AllegatoGestibile> {
  const { data, error } = await allegatiRegistroVivi(
    supabase.from('allegati_registro').select(COLONNE_ALLEGATO).eq('id', id),
  ).maybeSingle()
  if (error) {
    if (CESTINO_ASSENTE.has(codiceErrore(error))) {
      // DB NON MIGRATO (l'E2E della CI): le colonne del cestino non esistono, quindi
      // non esiste un cestino in cui mettere l'allegato. Niente si tocca, e lo si dice.
      logEvento('registro', 'warn', { operazione, esito: 'cestino-allegati-non-disponibile-schema', allegato_id: id }, error)
      return { ok: false, risposta: risposte.cestinoNonDisponibile() }
    }
    logEvento('registro', 'error', { operazione, esito: 'allegato-non-letto', allegato_id: id }, error)
    return { ok: false, risposta: risposte.letturaFallita() }
  }
  const allegato = data as AllegatoRegistro | null
  // Un allegato vivo ha sempre la sua lezione (vincolo
  // `allegati_registro_senza_lezione_nel_cestino_check`): senza, non è gestibile da qui.
  if (!allegato || !allegato.registro_id) return { ok: false, risposta: risposte.allegatoNonTrovato() }

  const { lezione, errore } = await leggiLezione(supabase, allegato.registro_id)
  if (errore) {
    logEvento('registro', 'error', { operazione, esito: 'lezione-non-letta', registro_id: allegato.registro_id }, errore)
    return { ok: false, risposta: risposte.letturaFallita() }
  }
  if (!lezione) return { ok: false, risposta: risposte.lezioneNonTrovata() }

  const scopeErr = await assertSezioneInScope(supabase, utente, lezione.section_id)
  if (scopeErr) return { ok: false, risposta: scopeErr }

  const permesso = await verificaPermessoVoce(supabase, utente, {
    tipo: 'allegato',
    id: allegato.id,
    autoreId: allegato.caricato_da,
    sectionId: lezione.section_id,
    scuolaId: lezione.scuola_id,
    dataEvento: dataLezione(lezione),
  })
  if (!permesso.ok) return { ok: false, risposta: rispostaPermessoNegato(permesso) }

  return { ok: true, allegato, lezione }
}
