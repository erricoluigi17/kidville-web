import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { NextResponse } from 'next/server'
import { logEvento } from '@/lib/logging/logger'
import { colonnaNuovaAssente } from '@/lib/db/colonna-assente'
import { oggiRoma, puoCorreggereStorico } from '@/lib/storici/retroattivita'

export const eRettificaStorica = (attore: AppUser, giorno: string, giornoOriginale = giorno) => puoCorreggereStorico(attore) && (giorno < oggiRoma() || giornoOriginale < oggiRoma())
export const conflittoStorico = () => NextResponse.json({ error: 'La registrazione è cambiata. Ricarica la pagina prima di correggerla.', codice: 'STORICO_VERSIONE_CAMBIATA' }, { status: 409 })
export const storicoIndisponibile = () => NextResponse.json({ error: 'Archivio storico non disponibile. Nessuna modifica applicata.', codice: 'STORICO_NON_DISPONIBILE' }, { status: 503 })
export type AttesaStorica = { tabella: string; filtro: Record<string, unknown>; versione: number | string | null | undefined }
export type AzioneStorica = { tabella: string; operazione: 'insert' | 'update' | 'delete'; filtro?: Record<string, unknown>; valori?: Record<string, unknown> }

/**
 * Il server sceglie fonti e mutazioni; il client fornisce solo la versione che ha letto.
 *
 * `ripiegoSchema` (facoltativo, spento per tutti i chiamanti che non lo passano): il chiamante ha messo nelle
 * azioni una colonna NUOVA e sa ripetere la rettifica senza, perché il codice può arrivare prima della
 * migrazione (il database E2E della CI non è migrato: la RPC torna `42703`). Con il flag, un errore di schema
 * non è un guasto: l'helper NON scrive il log `error` `rettifica-non-applicata`, e restituisce la risposta 503 di
 * sempre più `schemaIndietro` (l'errore, da citare nel log `info` del ripiego). Decide il chiamante, che ripete
 * UNA volta senza il flag: se anche la seconda prova fallisce, risposta e log sono quelli di oggi.
 */
export async function applicaRettificaStorica(db: SupabaseClient, input: {
  attore: AppUser; scuolaId: string; alunnoId?: string | null; sectionId?: string | null
  modulo: string; giorno: string; attese: AttesaStorica[]; azioni: AzioneStorica[]
  ripiegoSchema?: boolean
}): Promise<{ righe: Record<string, unknown>[][] } | { response: NextResponse; schemaIndietro?: { code?: string; message?: string } }> {
  if (input.attese.some(a => a.versione === undefined)) return { response: conflittoStorico() }
  const { data, error } = await db.rpc('storici_applica_rettifica', {
    contesto: { attore_id: input.attore.id, scuola_id: input.scuolaId, alunno_id: input.alunnoId ?? null, section_id: input.sectionId ?? null, modulo: input.modulo, giorno_competenza: input.giorno },
    attese: input.attese, azioni: input.azioni,
  })
  if (error) {
    if (input.ripiegoSchema && colonnaNuovaAssente(error)) return { response: storicoIndisponibile(), schemaIndietro: error }
    logEvento('registro', 'error', { operazione: 'storici/applica-rettifica', esito: 'rettifica-non-applicata', modulo: input.modulo, data: input.giorno }, error)
    return { response: ['40001', '23505', '40P01'].includes(error.code) ? conflittoStorico() : storicoIndisponibile() }
  }
  logEvento('registro', 'info', { operazione: 'storici/applica-rettifica', esito: 'rettifica-applicata', modulo: input.modulo, data: input.giorno, n: input.azioni.length })
  return { righe: ((data ?? []) as Array<{ righe: Record<string, unknown>[] }>).map(r => r.righe) }
}

/** Compatibilità lettura con schema precedente: il form resta consultabile, ma non può rettificare senza token. */
export async function versioniStoriche(db: SupabaseClient, tabella: string, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map()
  const { data, error } = await db.from(tabella).select('id, storico_versione').in('id', ids)
  if (error) {
    logEvento('registro', ['42703','PGRST204'].includes(error.code) ? 'info' : 'error', { operazione: 'storici/leggi-versioni', esito: 'versioni-non-disponibili' }, error)
    return new Map()
  }
  return new Map((data ?? []).filter(r => r.storico_versione !== undefined).map(r => [String(r.id), Number(r.storico_versione)]))
}
export function proiettaRiga(riga: Record<string, unknown>, colonne: string): Record<string, unknown> {
  return Object.fromEntries(colonne.split(',').map(c => c.trim()).map(c => [c, riga[c]]))
}
