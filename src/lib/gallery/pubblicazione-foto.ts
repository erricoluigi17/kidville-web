import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'

/** Un solo segmento generato dal server: niente URL, encoding o traversal. */
export function percorsoUploadProprio(path: string, autore: string): boolean {
  const prefisso = `uploads/${autore}/`
  return path.startsWith(prefisso) && /^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(path.slice(prefisso.length))
}

/** Gli insiemi non hanno ordine: replay con tag/classi riordinati è lo stesso intento. */
export async function pubblicaFotoIdempotente(
  supabase: SupabaseClient,
  autore: string,
  scuolaId: string,
  uploadId: string,
  record: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; created: boolean; response?: never } | { response: NextResponse; data?: never; created?: never }> {
  const insieme = (value: unknown) => [...new Set((Array.isArray(value) ? value : []) as string[])].sort()
  const classi = insieme(record.target_classes)
  const { data, error } = await supabase.rpc('gallery_publish_photo', {
    p_owner_id: autore,
    p_scuola_id: scuolaId,
    p_upload_id: uploadId,
    p_payload: {
      file_url: record.file_url,
      file_type: 'foto',
      caption: record.caption ?? null,
      tag_students: insieme(record.tag_students),
      is_broadcast: record.is_broadcast ?? false,
      target_classes: classi.length ? classi : null,
    },
  })
  if (error) {
    const assente = ['PGRST202', 'PGRST204', '42883', '42703', '42P01'].includes(error.code ?? '')
    const status = assente ? 503 : 500
    logErrore({ operazione: 'gallery:POST', evento: 'rpc', stato: status }, error)
    if (assente) return { response: NextResponse.json({
      error: 'Caricamento temporaneamente non disponibile. Riprova.', codice: 'CARICAMENTO_NON_DISPONIBILE',
    }, { status: 503, headers: { 'Retry-After': '60' } }) }
    return { response: NextResponse.json({ error: 'Pubblicazione non riuscita. Riprova.', codice: 'ALLEGATO_NON_CARICATO' }, { status: 500 }) }
  }
  if (data?.ok !== true) {
    const eliminato = data?.code === 'UPLOAD_DELETED'
    const conflitto = data?.code === 'UPLOAD_CONFLICT'
    const status = eliminato ? 410 : conflitto ? 409 : 500
    logEvento('galleria', status === 500 ? 'error' : 'warn', {
      operazione: 'gallery:POST', esito: eliminato ? 'replay-eliminato' : conflitto ? 'upload-conflitto' : 'rpc-risposta-invalida',
      sede_id: scuolaId, stato: status,
    })
    if (eliminato) return { response: NextResponse.json({ error: 'Questa foto è stata eliminata.', codice: 'CARICAMENTO_ELIMINATO' }, { status: 410 }) }
    if (conflitto) return { response: NextResponse.json({ error: 'Questo caricamento è già associato a una foto diversa.', codice: 'CARICAMENTO_IN_CONFLITTO' }, { status: 409 }) }
    return { response: NextResponse.json({ error: 'Pubblicazione non riuscita. Riprova.', codice: 'ALLEGATO_NON_CARICATO' }, { status: 500 }) }
  }
  if (typeof data.created !== 'boolean' || typeof data.media?.id !== 'string') {
    logErrore({ operazione: 'gallery:POST', evento: 'rpc', stato: 500 }, new Error('Risposta pubblicazione foto non valida'))
    return { response: NextResponse.json({ error: 'Pubblicazione non riuscita. Riprova.', codice: 'ALLEGATO_NON_CARICATO' }, { status: 500 }) }
  }
  if (!data.created) logEvento('galleria', 'info', { operazione: 'gallery:POST', esito: 'pubblicazione-replay', sede_id: scuolaId })
  return { data: data.media, created: data.created }
}
