import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveIdentity, loadAppUser } from '@/lib/auth/require-staff'
import { puoAccedereFascicolo, logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { parseBody, parseData, parseMultipart, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { fascicoloVivo } from '@/lib/primaria/cestino-fascicolo'
import { scadenzaCestino } from '@/lib/primaria/cestino-registro'
import {
  MAX_SIZE_FASCICOLO as MAX_SIZE,
  MIME_FASCICOLO as ALLOWED,
  TIPI_FASCICOLO as TIPI,
  percorsoNuovoFascicolo,
  rispostaGestioneNegata,
  rispostaNonDelFascicolo,
  togliFileFascicoloCaricato,
} from '@/lib/primaria/fascicolo-gestione'

// Il letterale resta QUI (vedi `fascicolo-gestione.ts`): le guardie dell'oblio lo cercano
// nei file che il bucket lo usano davvero.
const BUCKET = 'sensitive_documents'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  alunnoId: zUuid,
  finalita: z.string().optional(),
})

// Campi multipart: il file si valida come istanza (mime/size restano check manuali
// dedicati); documentType default 'diagnosi' come nel comportamento storico.
const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'file e alunnoId obbligatori' }),
  alunnoId: zUuid,
  documentType: z.enum(TIPI).default('diagnosi'),
  descrizione: z.string().nullable(),
  expiryDate: z.string().nullable(),
  finalita: z.string().nullable(),
})

// PATCH: i tre campi modificabili (spec «Fascicolo»: tipo, descrizione, scadenza).
// Ciascuno è facoltativo; `null` su descrizione/scadenza SVUOTA il campo, l'assenza
// lo lascia com'è. Il file non si cambia qui: la sostituzione è `…/sostituisci`,
// perché crea una riga NUOVA e mette la vecchia nel cestino.
const patchBodySchema = z.object({
  id: zUuid,
  documentType: z.enum(TIPI).optional(),
  descrizione: z.string().trim().max(2000).nullable().optional(),
  expiryDate: zDataYMD.nullable().optional(),
})

const deleteQuerySchema = z.object({
  id: zUuid,
  finalita: z.string().optional(),
})

/** Le colonne di un documento che servono a decidere chi può toccarlo, e a rispondere. */
const COLONNE_DOCUMENTO = 'id, student_id, section_id, document_type, descrizione, file_name, expiry_date, created_at, caricato_da'

type RigaDocumento = {
  id: string
  student_id: string
  section_id: string | null
  document_type: string | null
  descrizione: string | null
  file_name: string | null
  expiry_date: string | null
  created_at: string | null
  caricato_da: string | null
}

// GET /api/primaria/fascicolo?alunnoId=&userId=
// Lista dei documenti del fascicolo (RBAC ristretto + audit). I documenti nel cestino
// NON compaiono: si elencano da `…/cestino`.
export const GET = withRoute('primaria/fascicolo:GET', async (request: NextRequest) => {
  try {
    const { userId } = await resolveIdentity(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { alunnoId, finalita } = q.data

    const supabase = await createAdminClient()
    const access = await puoAccedereFascicolo(supabase, userId, alunnoId)
    if (!access.consentito) {
      return NextResponse.json({ error: 'Accesso al fascicolo non consentito' }, { status: 403 })
    }

    const { data, error } = await fascicoloVivo(
      supabase
        .from('student_documents')
        .select('id, document_type, descrizione, file_name, expiry_date, created_at, caricato_da')
        .eq('student_id', alunnoId),
    ).order('created_at', { ascending: false })
    if (error) {
      // Il messaggio di PostgREST resta nel log: nomina tabelle e colonne.
      logErrore({ operazione: 'primaria/fascicolo:GET', stato: 500, evento: `student_documents:${error.code ?? 'ignoto'}` }, error)
      return NextResponse.json({ error: 'Lettura del fascicolo non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }

    await logAccessoFascicolo(supabase, { alunnoId, utenteId: userId, azione: 'list', finalita, request })

    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    // Il messaggio interno resta nel LOG e non torna al chiamante. Su una rotta che
    // custodisce diagnosi e verbali della 104, il testo di un'eccezione può nominare
    // tabelle, colonne e vincoli: al client basta sapere che il guasto è nostro.
    logErrore({ operazione: 'primaria/fascicolo:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})

// POST /api/primaria/fascicolo  (multipart: file, alunnoId, documentType, descrizione?, expiryDate?, userId)
export const POST = withRoute('primaria/fascicolo:POST', async (request: NextRequest) => {
  try {
    // ── IL GATE PRIMA DEL CORPO ────────────────────────────────────────────
    // Queste due righe stavano SOTTO `await request.formData()`, ed erano tre righe di
    // distanza che valevano un 500 a un anonimo (collaudo del 2026-08-02, F1):
    //   curl -X POST -H 'content-type: application/json' -d '{"x":1}' …/api/primaria/fascicolo
    //   → 500 {"error":"Content-Type was not one of \"multipart/form-data\" or …"}
    // `formData()` LANCIA su un Content-Type non multipart: l'eccezione scavalcava il gate,
    // finiva nel `catch` qui sotto — tarato sui guasti NOSTRI — e tornava indietro col
    // messaggio interno del runtime. Su questa rotta, che custodisce diagnosi, PEI, PDP e
    // verbali della 104.
    //
    // Identità dalla richiesta (sessione o header/query legacy), MAI dal formData: il campo
    // multipart 'userId' permetterebbe di impersonare chiunque — ed è anche il motivo per
    // cui il gate non ha mai avuto bisogno del corpo per funzionare.
    const { userId } = await resolveIdentity(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    // Content-Type sbagliato = errore del CLIENT: 400, e non l'eccezione al `catch`.
    const form = await parseMultipart(request)
    if ('response' in form) return form.response
    const formData = form.data

    const parsed = parseData(postFormSchema, {
      file: formData.get('file'),
      alunnoId: formData.get('alunnoId'),
      documentType: formData.get('documentType') ?? undefined,
      descrizione: formData.get('descrizione'),
      expiryDate: formData.get('expiryDate'),
      finalita: formData.get('finalita'),
    })
    if ('response' in parsed) return parsed.response
    const { file, alunnoId, documentType, descrizione, expiryDate, finalita } = parsed.data

    if (!ALLOWED.includes(file.type)) return NextResponse.json({ error: 'Formato non ammesso (PDF o immagine)' }, { status: 400 })
    if (file.size > MAX_SIZE) return NextResponse.json({ error: 'File oltre 15MB' }, { status: 400 })

    const supabase = await createAdminClient()
    const access = await puoAccedereFascicolo(supabase, userId, alunnoId)
    if (!access.consentito) {
      return NextResponse.json({ error: 'Caricamento nel fascicolo non consentito' }, { status: 403 })
    }

    // Sezione corrente dell'alunno (per RBAC contitolari futuri).
    const { data: alunno } = await supabase.from('alunni').select('section_id').eq('id', alunnoId).maybeSingle()

    // Bucket privato (no URL pubblico). Lo crea se assente.
    try {
      const { data: buckets } = await supabase.storage.listBuckets()
      if (!buckets?.some((b) => b.name === BUCKET)) {
        await supabase.storage.createBucket(BUCKET, { public: false, allowedMimeTypes: ALLOWED, fileSizeLimit: MAX_SIZE })
      }
    } catch (e) {
      // Come in `primaria/allegati`: garanzia idempotente, l'upload ha il suo errore.
      logEvento('storage', 'warn', {
        operazione: 'primaria/fascicolo:POST',
        bucket: BUCKET,
        esito: 'bucket_non_verificato',
      }, e)
    }

    // Lo stesso percorso della sostituzione: un solo costruttore, perché non divergano.
    const path = percorsoNuovoFascicolo(alunnoId, file.type)
    const buf = await file.arrayBuffer()
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, Buffer.from(buf), {
      contentType: file.type,
      upsert: true,
    })
    if (upErr) {
      // Il messaggio dello Storage resta nel log, non torna al client (come nella sostituzione).
      logEvento('fascicolo', 'error', { operazione: 'primaria/fascicolo:POST', esito: 'upload-fallito', alunno_id: alunnoId }, upErr)
      return NextResponse.json({ error: 'Caricamento del file non riuscito', codice: 'FASCICOLO_FILE_NON_CARICATO' }, { status: 500 })
    }

    const { data, error } = await supabase
      .from('student_documents')
      .insert({
        student_id: alunnoId,
        section_id: alunno?.section_id ?? null,
        document_type: documentType,
        descrizione,
        file_name: file.name,
        storage_path: path,
        file_url: path, // path privato; il download avviene via signed URL
        expiry_date: expiryDate,
        caricato_da: userId,
      })
      .select()
      .single()
    if (error) {
      // Il messaggio di PostgREST nomina tabella e vincoli: resta nel log. Il file appena
      // caricato esce dal bucket — nessuna riga lo cita, quindi non lo toglierebbe nemmeno
      // la purga del cestino.
      logErrore({ operazione: 'primaria/fascicolo:POST', stato: 500, evento: `student_documents:${error.code ?? 'ignoto'}` }, error)
      await togliFileFascicoloCaricato(supabase, BUCKET, path, alunnoId, 'primaria/fascicolo:POST')
      return NextResponse.json({ error: 'Caricamento non salvato', codice: 'FASCICOLO_SCRITTURA_FALLITA' }, { status: 500 })
    }

    await logAccessoFascicolo(supabase, { alunnoId, utenteId: userId, azione: 'upload', documentoId: data.id, finalita, request })

    // Audit unificato delle scritture + notifica al titolare se carica la segreteria.
    const attore = await loadAppUser(userId)
    if (attore) {
      await logScrittura(supabase, {
        attore,
        entitaTipo: 'fascicolo',
        entitaId: data.id,
        azione: 'insert',
        sectionId: alunno?.section_id ?? null,
        valoreDopo: { id: data.id, document_type: documentType, file_name: file.name },
      })
      if (alunno?.section_id) {
        await notificaTitolariScrittura(supabase, { attore, sectionId: alunno.section_id, area: 'fascicolo' })
      }
    }

    logEvento('fascicolo', 'info', { operazione: 'primaria/fascicolo:POST', esito: 'documento-caricato', alunno_id: alunnoId })

    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    // Come nel GET: il testo dell'eccezione vive nel log, non nella risposta.
    logErrore({ operazione: 'primaria/fascicolo:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})

// PATCH /api/primaria/fascicolo  { id, documentType?, descrizione?, expiryDate? }
// Modifica tipo, descrizione e scadenza. Nessun termine (spec: «Il fascicolo non ha termine»).
export const PATCH = withRoute('primaria/fascicolo:PATCH', async (request: NextRequest) => {
  const OP = 'primaria/fascicolo:PATCH'
  try {
    const { userId } = await resolveIdentity(request)
    if (!userId) {
      return NextResponse.json({ error: 'Non autenticato', codice: 'FASCICOLO_NON_AUTENTICATO' }, { status: 401 })
    }

    const body = await parseBody(request, patchBodySchema)
    if ('response' in body) return body.response
    const { id, documentType, descrizione, expiryDate } = body.data

    // Solo i campi PRESENTI: `undefined` = non toccare, `null` = svuotare.
    const modifica: Record<string, string | null> = {}
    if (documentType !== undefined) modifica.document_type = documentType
    if (descrizione !== undefined) modifica.descrizione = descrizione === '' ? null : descrizione
    if (expiryDate !== undefined) modifica.expiry_date = expiryDate
    if (Object.keys(modifica).length === 0) {
      return NextResponse.json(
        { error: 'Niente da modificare', codice: 'FASCICOLO_NIENTE_DA_MODIFICARE' },
        { status: 400 },
      )
    }

    const supabase = await createAdminClient()
    // Il documento, VIVO: uno nel cestino risponde 404 come uno che non esiste — da qui
    // non si modifica né si rielimina ciò che è già eliminato. La lettura sta qui e non
    // in un helper di modulo perché il lock `isolamento-sede-coverage` vuole vedere, nello
    // STESSO handler, la query e il gate (`puoAccedereFascicolo`) che la segue.
    const { data: letto, error: erroreLettura } = await fascicoloVivo(
      supabase.from('student_documents').select(COLONNE_DOCUMENTO).eq('id', id),
    ).maybeSingle()
    if (erroreLettura) {
      logErrore({ operazione: OP, stato: 500, evento: `student_documents:${erroreLettura.code ?? 'ignoto'}` }, erroreLettura)
      return NextResponse.json({ error: 'Lettura del documento non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }
    const prima = letto as RigaDocumento | null
    if (!prima || !prima.student_id) {
      return NextResponse.json({ error: 'Documento non trovato', codice: 'DOCUMENTO_NON_TROVATO' }, { status: 404 })
    }
    const accesso = await puoAccedereFascicolo(supabase, userId, prima.student_id)
    const negato = rispostaGestioneNegata(accesso, prima.caricato_da, prima.student_id, userId, OP)
    if (negato) return negato
    const nonDelFascicolo = rispostaNonDelFascicolo(prima.document_type, prima.student_id, OP)
    if (nonDelFascicolo) return nonDelFascicolo

    // `fascicoloVivo` anche sulla scrittura: se fra la lettura e qui qualcuno l'ha
    // messo nel cestino, la modifica NON deve toccare una riga eliminata.
    const { data, error } = await fascicoloVivo(
      supabase.from('student_documents').update(modifica).eq('id', id),
    ).select(COLONNE_DOCUMENTO).maybeSingle()
    if (error) {
      logErrore({ operazione: OP, stato: 500, evento: `student_documents:${error.code ?? 'ignoto'}` }, error)
      return NextResponse.json({ error: 'Modifica non salvata', codice: 'FASCICOLO_SCRITTURA_FALLITA' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'Il documento è stato eliminato o sostituito nel frattempo', codice: 'FASCICOLO_DOCUMENTO_CAMBIATO' },
        { status: 409 },
      )
    }
    const dopo = data as RigaDocumento

    const attore = await loadAppUser(userId)
    if (attore) {
      // La descrizione è testo libero su un documento sanitario: nell'audit va il FATTO
      // che sia cambiata, non la frase. Tipo e scadenza passano (il tipo lo riduce
      // comunque `riduciValoreAudit`, che lo tratta da dato personale).
      await logScrittura(supabase, {
        attore,
        entitaTipo: 'fascicolo',
        entitaId: id,
        azione: 'update',
        sectionId: prima.section_id,
        valorePrima: { id, document_type: prima.document_type, expiry_date: prima.expiry_date },
        valoreDopo: {
          id,
          document_type: dopo.document_type,
          expiry_date: dopo.expiry_date,
          descrizione_modificata: 'descrizione' in modifica && modifica.descrizione !== prima.descrizione,
        },
      })
    }

    logEvento('fascicolo', 'info', {
      operazione: OP,
      esito: 'documento-modificato',
      alunno_id: prima.student_id,
      campi: Object.keys(modifica).length,
    })

    return NextResponse.json({ success: true, data: dopo })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'FASCICOLO_SCRITTURA_FALLITA' }, { status: 500 })
  }
})

// DELETE /api/primaria/fascicolo?id=&finalita=
// Mette il documento nel CESTINO (`eliminato_il`, `eliminato_da`): riga e file restano
// ripristinabili per `GIORNI_CESTINO_REGISTRO` giorni, poi li toglie la purga.
export const DELETE = withRoute('primaria/fascicolo:DELETE', async (request: NextRequest) => {
  const OP = 'primaria/fascicolo:DELETE'
  try {
    const { userId } = await resolveIdentity(request)
    if (!userId) {
      return NextResponse.json({ error: 'Non autenticato', codice: 'FASCICOLO_NON_AUTENTICATO' }, { status: 401 })
    }

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { id, finalita } = q.data

    const supabase = await createAdminClient()
    // Il documento, VIVO: uno nel cestino risponde 404 come uno che non esiste — da qui
    // non si modifica né si rielimina ciò che è già eliminato. La lettura sta qui e non
    // in un helper di modulo perché il lock `isolamento-sede-coverage` vuole vedere, nello
    // STESSO handler, la query e il gate (`puoAccedereFascicolo`) che la segue.
    const { data: letto, error: erroreLettura } = await fascicoloVivo(
      supabase.from('student_documents').select(COLONNE_DOCUMENTO).eq('id', id),
    ).maybeSingle()
    if (erroreLettura) {
      logErrore({ operazione: OP, stato: 500, evento: `student_documents:${erroreLettura.code ?? 'ignoto'}` }, erroreLettura)
      return NextResponse.json({ error: 'Lettura del documento non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }
    const doc = letto as RigaDocumento | null
    if (!doc || !doc.student_id) {
      return NextResponse.json({ error: 'Documento non trovato', codice: 'DOCUMENTO_NON_TROVATO' }, { status: 404 })
    }
    const accesso = await puoAccedereFascicolo(supabase, userId, doc.student_id)
    const negato = rispostaGestioneNegata(accesso, doc.caricato_da, doc.student_id, userId, OP)
    if (negato) return negato

    const adesso = new Date().toISOString()
    const { data, error } = await fascicoloVivo(
      supabase
        .from('student_documents')
        .update({ eliminato_il: adesso, eliminato_da: userId })
        .eq('id', id),
    ).select('id, eliminato_il').maybeSingle()
    if (error) {
      logErrore({ operazione: OP, stato: 500, evento: `student_documents:${error.code ?? 'ignoto'}` }, error)
      return NextResponse.json({ error: 'Eliminazione non riuscita', codice: 'FASCICOLO_SCRITTURA_FALLITA' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'Il documento è stato eliminato o sostituito nel frattempo', codice: 'FASCICOLO_DOCUMENTO_CAMBIATO' },
        { status: 409 },
      )
    }
    const eliminatoIl = (data as { eliminato_il: string | null }).eliminato_il ?? adesso

    await logAccessoFascicolo(supabase, { alunnoId: doc.student_id, utenteId: userId, azione: 'delete', documentoId: id, finalita, request })

    const attore = await loadAppUser(userId)
    if (attore) {
      await logScrittura(supabase, {
        attore,
        entitaTipo: 'fascicolo',
        entitaId: id,
        azione: 'delete',
        sectionId: doc.section_id,
        valorePrima: { id, document_type: doc.document_type, file_name: doc.file_name },
        valoreDopo: { id, cestino: true, eliminato_il: eliminatoIl },
      })
    }

    logEvento('fascicolo', 'info', {
      operazione: OP,
      esito: 'documento-nel-cestino',
      alunno_id: doc.student_id,
    })

    return NextResponse.json({
      success: true,
      data: { id, eliminatoIl, ripristinabileFinoAl: scadenzaCestino(eliminatoIl)?.toISOString() ?? null },
    })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'FASCICOLO_SCRITTURA_FALLITA' }, { status: 500 })
  }
})
