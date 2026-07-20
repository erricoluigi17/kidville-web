import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { parseData } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { analizzaContenutoVideo, MESSAGGIO_VIDEO_NON_CONVERTIBILE } from '@/lib/media/codec-sniff'
import { NEWS_BUCKET } from '@/lib/news/tipi'

// =============================================================================
// POST /api/news/upload — carica un media (immagine/video) nel bucket «news».
// Pattern ESATTO di gallery/upload: requireDocente, sniff video sui primi 64KB
// → 415 se non riproducibile, bucket garantito a runtime, MAI il nome file nei
// log (può contenere PII), path namespaced sull'utente del gate.
// =============================================================================

const MIME_AMMESSI = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
  // niente QuickTime (.mov) né Matroska (.mkv): HEVC/.mov si convertono (o si
  // rifiutano con 415), il bucket accetta solo formati riproducibili in WebView.
  'video/mp4', 'video/webm',
]

const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'Nessun file fornito' }),
})

export const POST = withRoute('news/upload:POST', async (request: Request) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const formData = await request.formData()
    const f = parseData(postFormSchema, { file: formData.get('file') })
    if ('response' in f) return f.response
    const { file } = f.data
    // Il path è namespaced sull'utente del gate, non su un campo client.
    const userId = auth.user.id

    // Il tipo del File può portare un suffisso codec (`video/webm;codecs=vp9`).
    const contentType = (file.type || 'application/octet-stream').split(';')[0].trim()
    const fileBuffer = await file.arrayBuffer()

    // DIFESA IN PROFONDITÀ: un client vecchio (o una POST diretta) potrebbe spedire
    // un video non riproducibile da Chrome/Android. Lo sniff sui primi 64KB lo rifiuta.
    if (contentType.startsWith('video/')) {
      const testa = new Uint8Array(fileBuffer.slice(0, 65536))
      const analisi = analizzaContenutoVideo(testa, contentType)
      if (analisi.daConvertire) {
        // MAI il nome del file nei log (PII). Solo mime, size e motivo.
        logEvento('news', 'warn', {
          operazione: 'news/upload:POST',
          esito: 'video-non-riproducibile',
          mime: contentType,
          size: file.size,
          motivo: analisi.motivo,
        })
        return NextResponse.json({ error: MESSAGGIO_VIDEO_NON_CONVERTIBILE }, { status: 415 })
      }
    }

    const supabase = await createAdminClient()

    // Assicura il bucket «news» (public, limite 200MB, mime riproducibili).
    try {
      const { data: buckets, error: listError } = await supabase.storage.listBuckets()
      if (listError) {
        // listBuckets non lancia — ritorna { error }: il log va QUI, non sul catch che non scatta.
        logEvento('storage', 'warn', { operazione: 'news/upload:POST', esito: 'bucket-non-verificato', bucket: NEWS_BUCKET }, listError)
      } else {
        const exists = buckets?.some((b) => b.name === NEWS_BUCKET)
        const opts = { public: true, allowedMimeTypes: MIME_AMMESSI, fileSizeLimit: 209715200 }
        if (!exists) await supabase.storage.createBucket(NEWS_BUCKET, opts)
        else await supabase.storage.updateBucket(NEWS_BUCKET, opts)
      }
    } catch (bucketErr) {
      logEvento('storage', 'warn', { operazione: 'news/upload:POST', esito: 'bucket-non-verificato', bucket: NEWS_BUCKET }, bucketErr)
    }

    const fileExtension = file.name.split('.').pop() || ''
    const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${fileExtension}`
    const filePath = `uploads/${userId}/${uniqueFileName}`

    const { error } = await supabase.storage.from(NEWS_BUCKET).upload(filePath, Buffer.from(fileBuffer), {
      contentType,
      upsert: true,
    })
    if (error) {
      logErrore({ operazione: 'news/upload:POST', stato: 500, evento: 'storage' }, error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const { data: publicUrlData } = supabase.storage.from(NEWS_BUCKET).getPublicUrl(filePath)
    return NextResponse.json({ fileUrl: publicUrlData.publicUrl })
  } catch (error) {
    logErrore({ operazione: 'news/upload:POST', stato: 500 }, error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
