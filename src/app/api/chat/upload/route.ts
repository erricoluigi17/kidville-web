import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseData, parseMultipart } from '@/lib/validation/http'
import { rispostaAllegatoNonCaricato } from '@/lib/allegati/risposte'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { BUCKET_CHAT_ALLEGATI, TTL_FIRMA_CHAT_S } from '@/lib/chat/allegati'

// Upload allegato chat (M5.5): bucket privato `chat-allegati`, scritture solo
// via service-role (come le altre route chat — nessuna policy storage).
//
// RISPONDE COL PERCORSO (2026-08-01, S32). Prima rispondeva con un URL firmato a
// **365 giorni** che il client salvava così com'era in
// `chat_messages.attachment_url`: un link permanente travestito da link a
// scadenza, e per giunta archiviato in chiaro. Ora in tabella va il percorso, e
// il link lo genera la LETTURA, a tempo, dietro al suo gate
// (`src/lib/chat/allegati.ts`).

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'Nessun file ricevuto' }),
})

const BUCKET = BUCKET_CHAT_ALLEGATI
const MAX_MB = 10

const ALLOWED_EXT = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'gif'])
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/gif',
])
// contentType per i file con MIME vuoto dal browser (es. .heic su Chrome):
// il bucket ha allowed_mime_types, octet-stream verrebbe rifiutato dallo storage.
const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  gif: 'image/gif',
}

export const POST = withRoute('chat/upload:POST', async (request: Request) => {
  // Autenticazione (qualsiasi ruolo): impedisce upload anonimi sul bucket privato.
  const auth = await requireUser(request)
  if (auth.response) return auth.response

  // Anti-abuso: upload ripetuti per IP.
  const rl = await rateLimit(`chat-upload:${clientIp(request)}`, { limit: 30, windowMs: 10 * 60 * 1000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppi caricamenti. Riprova tra qualche minuto.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
    )
  }

  try {
    // Content-Type sbagliato = errore del CLIENT: 400, non 500 (collaudo 2026-08-02, F2).
    // `request.formData()` LANCIA su un Content-Type non multipart, e finiva quindi nel
    // `catch` qui sotto — che è tarato sui guasti del server e rimandava indietro il testo
    // interno del runtime.
    const form = await parseMultipart(request)
    if ('response' in form) return form.response
    const parsed = parseData(postFormSchema, { file: form.data.get('file') })
    if ('response' in parsed) return parsed.response
    const { file } = parsed.data

    if (file.size > MAX_MB * 1024 * 1024) {
      return NextResponse.json({ error: `File troppo grande (max ${MAX_MB}MB)` }, { status: 400 })
    }

    const ext = (file.name.split('.').pop() || '').toLowerCase()
    const mimeOk = !file.type || ALLOWED_MIME.has(file.type)
    if (!ALLOWED_EXT.has(ext) || !mimeOk) {
      return NextResponse.json(
        { error: 'Tipo di file non ammesso (PDF o immagini)' },
        { status: 400 }
      )
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `${auth.user.id}/${crypto.randomUUID()}-${safeName}`

    const supabase = await createAdminClient()
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, await file.arrayBuffer(), {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || EXT_MIME[ext],
      })
    if (error) {
      // Il corpo dell'errore del provider non si butta via (AGENTS §3): «500» non
      // dice niente, «mime type … is not supported» dice tutto. Prima qui non
      // c'era nessuna riga: un allegato che non parte era invisibile.
      logErrore({ operazione: 'chat/upload:POST', stato: 500, evento: 'storage' }, error)
      // …e non torna al CLIENT: quel testo porta fuori il nome del bucket, i vincoli e le
      // policy. Al client un codice traducibile, come sui gemelli `avvisi`/`tasks` (S31).
      return rispostaAllegatoNonCaricato()
    }

    // IL CARICAMENTO RIUSCITO LASCIA UNA RIGA (AGENTS §5). Senza, «nessun log di
    // upload» non distingue «nessuno ha mandato allegati» da «gli allegati non
    // partono più» — la stessa ambiguità che ha tenuto invisibile per mesi il
    // guasto delle email di credenziali.
    //
    // Solo metadati. Il NOME del file non si logga MAI: in chat un allegato si
    // chiama «referto-<cognome>.pdf», ed è il dato sanitario di un minore.
    logEvento('storage', 'info', {
      operazione: 'chat/upload:POST',
      esito: 'allegato-caricato',
      bucket: BUCKET,
      mime: file.type || EXT_MIME[ext],
      byte: file.size,
    })

    // `path` è ciò che va ARCHIVIATO in `chat_messages.attachment_url`.
    //
    // `url` resta SOLO per i client già installati (una WebView può servire un
    // chunk vecchio dalla cache del service worker e leggere ancora `data.url`):
    // è un link a TTL BREVE, e `chat/messages:POST` lo riporta comunque a
    // percorso prima di scrivere. Nessuna delle due strade lascia più un token
    // valido un anno dentro il database.
    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, TTL_FIRMA_CHAT_S)
    if (signErr) {
      // Il file È salvato: non si butta via un caricamento per un'anteprima.
      // Ma il guasto va detto, col corpo dell'errore del provider.
      logEvento('storage', 'error', {
        operazione: 'chat/upload:POST',
        esito: 'anteprima-non-firmata',
        bucket: BUCKET,
      }, signErr)
    }

    return NextResponse.json({
      path,
      url: signed?.signedUrl ?? null,
      attachment_type: file.type.startsWith('image/') ? 'image' : 'document',
      name: file.name,
    })
  } catch (err) {
    // `withRoute` non vede le eccezioni CATTURATE: il log lo fa questo ramo, di suo.
    // Al client un messaggio fisso: `err.message` è il testo interno del runtime, e oggi ne
    // esce una stringa di Next — domani ne uscirebbe quello che ci finisce dentro.
    logErrore({ operazione: 'chat/upload:POST', stato: 500 }, err)
    return rispostaAllegatoNonCaricato()
  }
})
