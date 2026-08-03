import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { parseData, parseMultipart } from '@/lib/validation/http'
import { rispostaAllegatoNonCaricato } from '@/lib/allegati/risposte'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { analizzaContenutoVideo, MESSAGGIO_VIDEO_NON_CONVERTIBILE } from '@/lib/media/codec-sniff'
import { NEWS_BUCKET } from '@/lib/news/tipi'
import { NEWS_BUCKET_BOZZE, SCADENZA_ANTEPRIMA_SECONDI } from '@/lib/news/media-bozza'

// =============================================================================
// POST /api/news/upload — carica un media (immagine/video) nel bucket «news».
// Pattern ESATTO di gallery/upload: requireDocente, sniff video sui primi 64KB
// → 415 se non riproducibile, MAI il nome file nei log (può contenere PII),
// path namespaced sull'utente del gate.
//
// IL BUCKET NON SI CREA DA QUI (2026-07-31). Fino a oggi questa route creava
// «news» al volo — e PUBBLICO — al primo caricamento: limite di dimensione,
// tipi ammessi e visibilità di uno spazio destinato all'esterno vivevano dentro
// un `try` di una route, cioè in un posto che nessuno ispeziona e che nessuna
// migrazione versiona. Ora il bucket è dichiarato in
// `supabase/migrations/20260731192048_bucket_news.sql` e qui si carica soltanto.
// Conseguenza diretta: l'elenco dei tipi ammessi non è più fatto rispettare
// dallo Storage «per effetto collaterale», quindi il gate sta QUI sotto.
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

    // Content-Type sbagliato = errore del CLIENT: 400, non 500 (collaudo 2026-08-02, F2).
    const formData = await parseMultipart(request)
    if ('response' in formData) return formData.response
    const f = parseData(postFormSchema, { file: formData.data.get('file') })
    if ('response' in f) return f.response
    const { file } = f.data
    // Il path è namespaced sull'utente del gate, non su un campo client.
    const userId = auth.user.id

    // Il tipo del File può portare un suffisso codec (`video/webm;codecs=vp9`).
    const contentType = (file.type || 'application/octet-stream').split(';')[0].trim()

    // GATE APPLICATIVO sui tipi. Il bucket ha la stessa lista (dichiarata in
    // migrazione) e resta l'ultima difesa, ma se il rifiuto arrivasse solo da lì
    // l'utente vedrebbe un 500 generico invece di «questo formato non si carica».
    if (!MIME_AMMESSI.includes(contentType)) {
      // MAI il nome del file nei log (PII). Solo il mime e la dimensione.
      logEvento('news', 'warn', {
        operazione: 'news/upload:POST',
        esito: 'mime-non-ammesso',
        mime: contentType,
        size: file.size,
      })
      return NextResponse.json({ error: 'Formato del file non ammesso' }, { status: 415 })
    }

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
        // `codice` accanto alla prosa (gemello di `gallery/upload`): il testo nasce
        // italiano in una libreria condivisa, il codice lo fa tradurre nel client.
        return NextResponse.json(
          { error: MESSAGGIO_VIDEO_NON_CONVERTIBILE, codice: 'VIDEO_NON_CONVERTIBILE' },
          { status: 415 },
        )
      }
    }

    const supabase = await createAdminClient()

    const fileExtension = file.name.split('.').pop() || ''
    const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${fileExtension}`
    const filePath = `uploads/${userId}/${uniqueFileName}`

    // ─── IL FILE NASCE IN UN'AREA NON PUBBLICA (privacy F4, 2026-08-01) ──────
    // Fino a oggi si caricava dritto nel bucket `news`, che è pubblico: la foto
    // era leggibile da chiunque, senza login, PRIMA che qualcuno verificasse il
    // consenso — e ci restava anche se il gate poi rifiutava la pubblicazione.
    // Ora sosta in `news_bozze` (privato) e viene spostata nel bucket pubblico
    // solo dopo il gate, da `promuoviMediaBozza`.
    const corpo = Buffer.from(fileBuffer)
    let bucketUsato: string = NEWS_BUCKET_BOZZE
    let { error } = await supabase.storage.from(NEWS_BUCKET_BOZZE).upload(filePath, corpo, {
      contentType,
      upsert: true,
    })
    if (error && /bucket not found/i.test(error.message ?? '')) {
      // La migrazione che dichiara il bucket privato non è ancora applicata su
      // questo progetto. Si ricade sul comportamento di prima — la funzione deve
      // continuare a funzionare — ma è configurazione mancante in produzione,
      // cioè un incidente: livello `error`, e col nome del bucket.
      logEvento('storage', 'error', {
        operazione: 'news/upload:POST',
        esito: 'bucket-bozze-mancante',
        bucket: NEWS_BUCKET_BOZZE,
      }, error)
      bucketUsato = NEWS_BUCKET
      ;({ error } = await supabase.storage.from(NEWS_BUCKET).upload(filePath, corpo, {
        contentType,
        upsert: true,
      }))
    }
    if (error) {
      // Il bucket è dichiarato in migrazione: se lo Storage dice che non c'è,
      // la migrazione non è arrivata su questo progetto. È configurazione
      // mancante in produzione, cioè un incidente — livello `error`, e col nome
      // del bucket, altrimenti resterebbe sepolto nel messaggio grezzo.
      if (/bucket not found/i.test(error.message ?? '')) {
        logEvento('storage', 'error', {
          operazione: 'news/upload:POST',
          esito: 'bucket-mancante',
          bucket: bucketUsato,
        }, error)
      }
      logErrore({ operazione: 'news/upload:POST', stato: 500, evento: 'storage' }, error)
      // Il messaggio del fornitore resta nel LOG (dove sopra si legge anche `bucket-mancante`)
      // e non torna al client: al client il codice che il catalogo sa tradurre, come già fa
      // il ramo dell'anteprima qui sotto.
      return rispostaAllegatoNonCaricato()
    }

    if (bucketUsato === NEWS_BUCKET_BOZZE) {
      // All'editor serve un'anteprima: un indirizzo FIRMATO e temporaneo, che
      // non sopravvive fuori dalla sessione di lavoro. Non finisce mai in
      // `news_posts`: la promozione lo sostituisce con quello definitivo.
      const { data: firmato, error: errFirma } = await supabase.storage
        .from(NEWS_BUCKET_BOZZE)
        .createSignedUrl(filePath, SCADENZA_ANTEPRIMA_SECONDI)
      if (errFirma || !firmato?.signedUrl) {
        logErrore({ operazione: 'news/upload:POST', stato: 500, evento: 'storage' }, errFirma)
        // Il file è nell'area di sosta ma non se ne può dare l'anteprima: per chi sta
        // scrivendo il post è indistinguibile da un caricamento fallito, e il codice
        // dice esattamente quello (invece di una prosa italiana non traducibile).
        return NextResponse.json(
          { error: 'Anteprima del file non disponibile', codice: 'ALLEGATO_NON_CARICATO' },
          { status: 500 },
        )
      }
      logEvento('news', 'info', {
        operazione: 'news/upload:POST',
        esito: 'caricato-in-sosta',
        bucket: NEWS_BUCKET_BOZZE,
        mime: contentType,
        size: file.size,
      })
      return NextResponse.json({ fileUrl: firmato.signedUrl })
    }

    const { data: publicUrlData } = supabase.storage.from(NEWS_BUCKET).getPublicUrl(filePath)
    return NextResponse.json({ fileUrl: publicUrlData.publicUrl })
  } catch (error) {
    logErrore({ operazione: 'news/upload:POST', stato: 500 }, error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
