/**
 * Glue server-side condiviso dalle route del registro protocolli:
 * denominazione scuola per la fascia, download bytes dai bucket, firma dei
 * download, mappatura errori (inclusa la degradazione su schema non migrato).
 * Solo wrapper I/O sottili: la logica testata vive in lib/protocolli/*.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PROTOCOLLO_BUCKET, SCHEMA_MANCANTE } from '@/lib/protocolli/store'

/** Path di staging generato da pathStaging(): unico formato accettato dalle route. */
export const zStagingPath = z
  .string()
  .min(12)
  .max(300)
  .regex(/^staging\/[a-z0-9][\w.\-]*$/i, 'Percorso di staging non valido')

/** Denominazione della scuola per la segnatura (art. 55). */
export async function denominazioneScuola(
  supabase: SupabaseClient,
  scuolaId: string
): Promise<string> {
  const { data } = await supabase.from('schools').select('nome').eq('id', scuolaId).maybeSingle()
  const nome = (data as { nome?: string } | null)?.nome
  return nome?.trim() || 'Kidville'
}

/** Scarica un file da un bucket come Uint8Array; 404 se assente. */
export async function scaricaDaBucket(
  supabase: SupabaseClient,
  bucket: string,
  path: string
): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(bucket).download(path)
  if (error || !data) {
    throw Object.assign(new Error(`File non trovato nello storage: ${error?.message ?? path}`), {
      status: 404,
    })
  }
  return new Uint8Array(await data.arrayBuffer())
}

export function scaricaProtocolloBytes(supabase: SupabaseClient, path: string) {
  return scaricaDaBucket(supabase, PROTOCOLLO_BUCKET, path)
}

/** URL firmato a 300s (download col nome file indicato). */
export async function firmaDownload(
  supabase: SupabaseClient,
  path: string,
  nomeFile?: string
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(PROTOCOLLO_BUCKET)
    .createSignedUrl(path, 300, nomeFile ? { download: nomeFile } : undefined)
  if (error || !data?.signedUrl) {
    throw Object.assign(new Error(`Firma URL non riuscita: ${error?.message ?? path}`), {
      status: 500,
    })
  }
  return data.signedUrl
}

/** Magic bytes %PDF- (mai fidarsi del MIME dichiarato dal client). */
export function pareUnPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  )
}

/** Pulizia best-effort dei file di staging dopo la registrazione. */
export async function eliminaStagingBestEffort(
  supabase: SupabaseClient,
  paths: string[]
): Promise<void> {
  if (paths.length === 0) return
  await supabase.storage
    .from(PROTOCOLLO_BUCKET)
    .remove(paths)
    .then(
      () => undefined,
      () => undefined
    )
}

/** Mappa un errore in risposta JSON; schema non migrato → 503 esplicito. */
export function rispostaErroreProtocollo(err: unknown): NextResponse {
  const e = err as { message?: string; code?: string; status?: number } | null
  if (e?.code && SCHEMA_MANCANTE.has(e.code)) {
    return NextResponse.json(
      { error: 'Registro protocolli non disponibile: schema del database non migrato' },
      { status: 503 }
    )
  }
  const status = typeof e?.status === 'number' ? e.status : 500
  return NextResponse.json({ error: e?.message ?? 'Errore interno' }, { status })
}
