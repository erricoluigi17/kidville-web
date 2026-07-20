import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { annoFiscale } from '@/lib/format/fiscal-date'

// =============================================================================
// MODULO CASSA · storage dei giustificativi (contratto §3.4).
//
// Bucket PRIVATO `cassa-giustificativi` (public: false): scontrini/ricevute.
// Download esclusivamente via signed URL nelle route (mai getPublicUrl).
// Pattern clonato da src/lib/protocolli/store.ts.
// =============================================================================

export const CASSA_BUCKET = 'cassa-giustificativi'
export const CASSA_MIME_AMMESSI = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const
export const CASSA_MAX_MB = 10
export const CASSA_MAX_BYTES = CASSA_MAX_MB * 1024 * 1024

/** Crea il bucket PRIVATO se manca. Non lancia mai (corsa fra richieste parallele ok). */
export async function ensureCassaBucket(supabase: SupabaseClient): Promise<void> {
  try {
    const { data } = await supabase.storage.listBuckets()
    if (data?.some((b) => b.name === CASSA_BUCKET)) return
    await supabase.storage.createBucket(CASSA_BUCKET, {
      public: false,
      allowedMimeTypes: [...CASSA_MIME_AMMESSI],
      fileSizeLimit: CASSA_MAX_BYTES,
    })
  } catch {
    // bucket già esistente o corsa fra richieste: ignorato
  }
}

/** Nome file sicuro per lo storage: minuscolo, senza accenti/speciali, ≤80 char. */
function slugNomeFile(nome: string): string {
  const punto = nome.lastIndexOf('.')
  const base = punto > 0 ? nome.slice(0, punto) : nome
  const ext =
    punto > 0
      ? nome
          .slice(punto + 1)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
      : ''
  const slug =
    base
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'file'
  return ext ? `${slug}.${ext}` : slug
}

/** Path del giustificativo: `${scuolaId}/${anno}/${uuid}-${slug(nome)}`. */
export function pathGiustificativo(scuolaId: string, nomeFile: string): string {
  return `${scuolaId}/${annoFiscale()}/${randomUUID()}-${slugNomeFile(nomeFile)}`
}
