import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseData, parseMultipart } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { LIMITE_UPLOAD_BYTE, LIMITE_UPLOAD_MB } from '@/lib/upload/limite-piattaforma'
import { rispostaAllegatoNonCaricato } from '@/lib/allegati/risposte'
import {
  FINESTRA_UPLOAD_PUBBLICO_MS,
  TETTO_UPLOAD_PUBBLICO,
  rispostaTroppiCaricamenti,
  verificaAllegatoPubblico,
} from '@/lib/upload/allegati-pubblici'

const BUCKET = 'form_attachments'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Il file si valida come presenza/istanza; dimensione e contenuto restano
// controlli manuali (non materia di zod). `folder` assente/null/'' ricade sul
// default 'generico' nel codice, come oggi.
const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'Nessun file ricevuto' }),
  folder: z.string().nullish(),
})

// POST multipart: carica un documento nel bucket form_attachments (service-role).
// Usato dal form pubblico di iscrizione (utente non autenticato).
//
// ─────────────────────────────────────────────────────────────────────────────
// LA PORTA RESTA APERTA, MA HA UNA SOGLIA (collaudo del 2026-08-02, sicurezza F1)
//
// Fino a oggi questa rotta accettava caricamenti ANONIMI nel bucket che custodisce i
// documenti d'iscrizione dei minori senza NESSUN tetto per IP e senza NESSUNA allowlist di
// tipo o estensione — mentre le tre rotte sorelle dello stesso wizard pubblico ce l'avevano
// tutte. Misurato sul server, da anonimo e senza cookie: dieci POST di fila, dieci risposte
// dell'handler, mai un 429; la stessa prova su `/api/iscrizione` si ferma al quinto
// tentativo. Il bucket, dal canto suo, ha `allowed_mime_types = NULL`: nessun freno neanche
// là sotto.
//
// Non si chiude con un gate di sessione: da qui arrivano circa nove domande l'ora da
// famiglie vere, e chi compila il modulo un account non ce l'ha. Si chiude con le tre cose
// che valgono per una porta che deve restare aperta — tetto per IP, tipi ammessi, limite di
// dimensione — e vivono in `@/lib/upload/allegati-pubblici`, non qui dentro: la stessa
// regola vale per `public/forms/[token]/upload`, che scrive nello stesso bucket.
// ─────────────────────────────────────────────────────────────────────────────
export const POST = withRoute('iscrizione/upload:POST', async (request: NextRequest) => {
  // IL TETTO PRIMA DI TUTTO, anche prima di leggere il corpo: un allegato costa molto più
  // di un JSON, e la difesa che si paga dopo aver letto 4 MB non ha difeso niente.
  const rl = await rateLimit(`iscrizione-upload:${clientIp(request)}`, {
    limit: TETTO_UPLOAD_PUBBLICO,
    windowMs: FINESTRA_UPLOAD_PUBBLICO_MS,
  })
  if (!rl.ok) {
    // `warn` e non `error`: è un uso sbagliato, non un guasto nostro. Ma la riga ci vuole —
    // senza, un abuso in corso su una porta anonima non lascerebbe alcuna traccia.
    logEvento('storage', 'warn', {
      operazione: 'iscrizione/upload:POST',
      esito: 'tetto-ip-raggiunto',
      bucket: BUCKET,
    })
    return rispostaTroppiCaricamenti(rl.retryAfterMs)
  }

  try {
    // Content-Type sbagliato = errore del CLIENT: 400, non il 500 di prima (backend F2).
    const form = await parseMultipart(request)
    if ('response' in form) return form.response

    const parsed = parseData(postFormSchema, {
      file: form.data.get('file'),
      folder: form.data.get('folder'),
    })
    if ('response' in parsed) return parsed.response
    const { file } = parsed.data
    const folder = parsed.data.folder || 'generico'

    // Limite dimensione: quello VERO, che è della piattaforma e non nostro.
    // Il vecchio «8 MB» era una promessa che questo codice non poteva mantenere: sopra i
    // ~4,5 MB il corpo lo rifiuta Vercel (413 `FUNCTION_PAYLOAD_TOO_LARGE`, corpo di
    // testo) e questo handler non viene mai eseguito. Il 31/07/2026 sono state 41
    // occorrenze in un giorno sul modulo pubblico. Vedi `@/lib/upload/limite-piattaforma`.
    //
    // 413 e non 400: è lo stesso codice che darebbe la piattaforma — così il client ha una
    // sola cosa da riconoscere — e a differenza di quello ha un corpo JSON leggibile.
    if (file.size > LIMITE_UPLOAD_BYTE) {
      return NextResponse.json(
        { error: `File troppo grande (max ${LIMITE_UPLOAD_MB} MB)` },
        { status: 413 },
      )
    }

    // IL TIPO DICHIARATO DAL CLIENT NON È UNA PROVA, e qui il client è chiunque. Il gate sta
    // PRIMA dello Storage: un eseguibile o un finto `.html` non devono nemmeno entrare nel
    // bucket dei documenti dei minori — dove, per giunta, resterebbero senza che nessuna
    // difesa a valle li fermi.
    const gate = verificaAllegatoPubblico(file, { operazione: 'iscrizione/upload:POST', bucket: BUCKET })
    if (!gate.ok) return gate.risposta

    const safeFolder = folder.replace(/[^a-zA-Z0-9._-]/g, '_')
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `iscrizioni/${safeFolder}/${crypto.randomUUID()}-${safeName}`

    const supabase = await createAdminClient()
    const arrayBuffer = await file.arrayBuffer()
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, arrayBuffer, {
        cacheControl: '3600',
        upsert: false,
        // Il tipo NORMALIZZATO dal gate, mai `application/octet-stream`: quando il bucket
        // dichiarerà i suoi tipi ammessi, un file valido non deve essere respinto DOPO
        // essere stato caricato.
        contentType: gate.contentType,
      })

    if (error) {
      // Il corpo dell'errore del fornitore resta nel LOG e non torna al client (AGENTS §3):
      // porta fuori il nome del bucket, i vincoli e le policy — e qui il destinatario
      // sarebbe un anonimo. Al client un codice traducibile.
      logErrore({ operazione: 'iscrizione/upload:POST', stato: 500, evento: 'storage' }, error)
      return rispostaAllegatoNonCaricato()
    }

    // IL CARICAMENTO RIUSCITO LASCIA UNA RIGA (AGENTS §5). Con i soli errori, «nessun log di
    // upload» non distingue «nessuna famiglia ha allegato niente» da «gli allegati non
    // partono più» — ed è l'ambiguità che ha tenuto invisibile per mesi il guasto delle
    // email di credenziali. Solo metadati: il NOME del file non si logga MAI, perché su
    // questa porta si chiama «carta-identita-<cognome>.pdf».
    logEvento('storage', 'info', {
      operazione: 'iscrizione/upload:POST',
      esito: 'allegato-caricato',
      bucket: BUCKET,
      mime: gate.contentType,
      byte: file.size,
    })

    return NextResponse.json({ path })
  } catch (err) {
    // `withRoute` non vede le eccezioni CATTURATE: il log lo fa questo ramo, di suo.
    // E al client va un messaggio fisso: fino al 2026-08-02 usciva `err.message`, cioè il
    // testo interno del runtime, verso un chiamante anonimo.
    logErrore({ operazione: 'iscrizione/upload:POST', stato: 500 }, err)
    return rispostaAllegatoNonCaricato()
  }
})
