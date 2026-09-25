import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveIdentity, loadAppUser } from '@/lib/auth/require-staff'
import { puoAccedereFascicolo, logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { parseData, parseMultipart } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { fascicoloNelCestino, fascicoloVivo } from '@/lib/primaria/cestino-fascicolo'
import {
  MAX_SIZE_FASCICOLO,
  MIME_FASCICOLO,
  percorsoNuovoFascicolo,
  rispostaGestioneNegata,
  rispostaNonDelFascicolo,
  togliFileFascicoloCaricato,
} from '@/lib/primaria/fascicolo-gestione'

// Il bucket privato del fascicolo. Il letterale si ripete in ogni route che lo usa, di
// proposito: vedi `__tests__/lib/gdpr-bucket-sensitive.test.ts` («un solo nome per un
// solo archivio»), che controlla che tutte le copie dicano la stessa cosa.
const BUCKET = 'sensitive_documents'

/**
 * POST /api/primaria/fascicolo/sostituisci  (multipart: id, file, finalita?)
 *
 * SOSTITUISCE il file di un documento del fascicolo (spec 2026-09-24, «Decisioni
 * aggiunte»): il file nuovo nasce in una RIGA NUOVA che copia tipo, descrizione e
 * scadenza; la riga vecchia va nel CESTINO col suo file, ripristinabile per i giorni
 * di custodia. Ripristinarla la riaggiunge ACCANTO alla nuova, non al suo posto.
 *
 * ─── L'ORDINE DEI PASSI, E PERCHÉ ───────────────────────────────────────────
 *  1. validazione del file e permessi — niente è ancora cambiato;
 *  2. upload del file nuovo a un percorso NUOVO (mai sovrascrivere: il vecchio file
 *     è ciò che il cestino promette di custodire);
 *  3. la riga vecchia va nel cestino con un UPDATE condizionato a `eliminato_il IS
 *     NULL`: è la PRESA. Di due sostituzioni simultanee dello stesso documento ne
 *     passa una; l'altra riceve 409 e il suo file appena caricato viene tolto —
 *     altrimenti nascerebbero due copie «nuove» dello stesso documento;
 *  4. insert della riga nuova. Se fallisce, si COMPENSA: la vecchia torna viva e il
 *     file nuovo esce dal bucket. Il fascicolo resta com'era, e lo si dice.
 */

const formSchema = z.object({
  id: zUuid,
  file: z.instanceof(File, { error: 'file obbligatorio' }),
  finalita: z.string().nullable(),
})

type RigaDocumento = {
  id: string
  student_id: string
  section_id: string | null
  document_type: string | null
  descrizione: string | null
  file_name: string | null
  expiry_date: string | null
  caricato_da: string | null
}

const OP = 'primaria/fascicolo/sostituisci:POST'

export const POST = withRoute('primaria/fascicolo/sostituisci:POST', async (request: NextRequest) => {
  try {
    // Il gate PRIMA del corpo (vedi `primaria/fascicolo:POST`): l'identità viene
    // dalla richiesta, mai dal multipart.
    const { userId } = await resolveIdentity(request)
    if (!userId) {
      return NextResponse.json({ error: 'Non autenticato', codice: 'FASCICOLO_NON_AUTENTICATO' }, { status: 401 })
    }

    const form = await parseMultipart(request)
    if ('response' in form) return form.response
    const parsed = parseData(formSchema, {
      id: form.data.get('id'),
      file: form.data.get('file'),
      finalita: form.data.get('finalita'),
    })
    if ('response' in parsed) return parsed.response
    const { id, file, finalita } = parsed.data

    if (!MIME_FASCICOLO.includes(file.type)) {
      return NextResponse.json({ error: 'Formato non ammesso (PDF o immagine)', codice: 'FASCICOLO_FORMATO_NON_AMMESSO' }, { status: 400 })
    }
    if (file.size > MAX_SIZE_FASCICOLO) {
      return NextResponse.json({ error: 'File oltre 15MB', codice: 'FASCICOLO_FILE_TROPPO_GRANDE' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // ── 1. Il documento da sostituire: VIVO. Nel cestino = non si sostituisce. ──
    const { data: letto, error: erroreLettura } = await fascicoloVivo(
      supabase
        .from('student_documents')
        .select('id, student_id, section_id, document_type, descrizione, file_name, expiry_date, caricato_da')
        .eq('id', id),
    ).maybeSingle()
    if (erroreLettura) {
      logErrore({ operazione: OP, stato: 500, evento: `student_documents:${erroreLettura.code ?? 'ignoto'}` }, erroreLettura)
      return NextResponse.json({ error: 'Lettura del documento non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }
    const vecchio = letto as RigaDocumento | null
    if (!vecchio || !vecchio.student_id) {
      return NextResponse.json({ error: 'Documento non trovato', codice: 'DOCUMENTO_NON_TROVATO' }, { status: 404 })
    }
    const alunnoId = vecchio.student_id

    const accesso = await puoAccedereFascicolo(supabase, userId, alunnoId)
    const negato = rispostaGestioneNegata(accesso, vecchio.caricato_da, alunnoId, userId, OP)
    if (negato) return negato
    // Un prestampato firmato o protocollato NON si sostituisce dal fascicolo: la riga nuova
    // avrebbe lo slug del modulo, un file scelto dallo staff e `created_at` di adesso —
    // `documenti-firmati` la mostrerebbe come firma del genitore e `teacher/uscite` la
    // conterebbe come autorizzazione per le uscite create DOPO la firma vera. 409 prima
    // dell'upload: niente è ancora cambiato.
    const nonDelFascicolo = rispostaNonDelFascicolo(vecchio.document_type, alunnoId, OP)
    if (nonDelFascicolo) return nonDelFascicolo

    // La sezione di OGGI dell'alunno, come nel caricamento; se la lettura fallisce si
    // tiene quella del documento vecchio, che è comunque una sezione dell'alunno.
    const { data: alunno, error: erroreAlunno } = await supabase
      .from('alunni')
      .select('section_id')
      .eq('id', alunnoId)
      .maybeSingle()
    if (erroreAlunno) {
      logEvento('fascicolo', 'warn', { operazione: OP, esito: 'sezione-alunno-non-letta', alunno_id: alunnoId }, erroreAlunno)
    }
    const sectionId = (alunno?.section_id as string | null | undefined) ?? vecchio.section_id

    // ── 2. Il file nuovo, a un percorso nuovo ───────────────────────────────
    const percorso = percorsoNuovoFascicolo(alunnoId, file.type)
    const { error: erroreUpload } = await supabase.storage
      .from(BUCKET)
      .upload(percorso, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false })
    if (erroreUpload) {
      logEvento('fascicolo', 'error', { operazione: OP, esito: 'upload-fallito', alunno_id: alunnoId }, erroreUpload)
      return NextResponse.json(
        { error: 'Caricamento del file non riuscito', codice: 'FASCICOLO_FILE_NON_CARICATO' },
        { status: 500 },
      )
    }

    // ── 3. La PRESA: la riga vecchia nel cestino, solo se è ancora viva ─────
    const adesso = new Date().toISOString()
    const { data: presa, error: errorePresa } = await fascicoloVivo(
      supabase
        .from('student_documents')
        .update({ eliminato_il: adesso, eliminato_da: userId })
        .eq('id', id),
    ).select('id').maybeSingle()
    if (errorePresa || !presa) {
      await togliFileFascicoloCaricato(supabase, BUCKET, percorso, alunnoId, OP)
      if (errorePresa) {
        logErrore({ operazione: OP, stato: 500, evento: `student_documents:${errorePresa.code ?? 'ignoto'}` }, errorePresa)
        return NextResponse.json({ error: 'Sostituzione non riuscita', codice: 'FASCICOLO_SCRITTURA_FALLITA' }, { status: 500 })
      }
      return NextResponse.json(
        { error: 'Il documento è stato eliminato o sostituito nel frattempo', codice: 'FASCICOLO_DOCUMENTO_CAMBIATO' },
        { status: 409 },
      )
    }

    // ── 4. La riga nuova: tipo, descrizione e scadenza COPIATI dalla vecchia ─
    const { data: nuovo, error: erroreInsert } = await supabase
      .from('student_documents')
      .insert({
        student_id: alunnoId,
        section_id: sectionId,
        document_type: vecchio.document_type,
        descrizione: vecchio.descrizione,
        file_name: file.name,
        storage_path: percorso,
        file_url: percorso, // path privato; il download avviene via signed URL
        expiry_date: vecchio.expiry_date,
        caricato_da: userId,
      })
      .select('id, document_type, descrizione, file_name, expiry_date, created_at, caricato_da')
      .single()
    if (erroreInsert || !nuovo) {
      logErrore(
        { operazione: OP, stato: 500, evento: `student_documents:${erroreInsert?.code ?? 'ignoto'}` },
        erroreInsert ?? new Error('insert senza riga'),
      )
      // COMPENSAZIONE: la vecchia torna viva (solo se è ancora la NOSTRA presa) e il file
      // nuovo esce dal bucket. Se anche questo fallisce il documento resta nel cestino,
      // ripristinabile a mano: lo si dice a livello `error`, perché qualcuno deve saperlo.
      const { data: tornata, error: erroreRitorno } = await fascicoloNelCestino(
        supabase
          .from('student_documents')
          .update({ eliminato_il: null, eliminato_da: null })
          .eq('id', id)
          .eq('eliminato_il', adesso),
      ).select('id').maybeSingle()
      if (erroreRitorno || !tornata) {
        logEvento(
          'fascicolo',
          'error',
          { operazione: OP, esito: 'compensazione-fallita-documento-nel-cestino', alunno_id: alunnoId },
          erroreRitorno ?? undefined,
        )
      }
      await togliFileFascicoloCaricato(supabase, BUCKET, percorso, alunnoId, OP)
      return NextResponse.json({ error: 'Sostituzione non riuscita', codice: 'FASCICOLO_SCRITTURA_FALLITA' }, { status: 500 })
    }
    const nuovoId = (nuovo as { id: string }).id

    // Gli accessi, come il resto del fascicolo: un caricamento e un'eliminazione.
    await logAccessoFascicolo(supabase, { alunnoId, utenteId: userId, azione: 'upload', documentoId: nuovoId, finalita, request })
    await logAccessoFascicolo(supabase, { alunnoId, utenteId: userId, azione: 'delete', documentoId: id, finalita, request })

    const attore = await loadAppUser(userId)
    if (attore) {
      await logScrittura(supabase, {
        attore,
        entitaTipo: 'fascicolo',
        entitaId: nuovoId,
        azione: 'insert',
        sectionId,
        valoreDopo: { id: nuovoId, document_type: vecchio.document_type, file_name: file.name, sostituisce: id },
      })
      await logScrittura(supabase, {
        attore,
        entitaTipo: 'fascicolo',
        entitaId: id,
        azione: 'delete',
        sectionId: vecchio.section_id,
        valorePrima: { id, document_type: vecchio.document_type, file_name: vecchio.file_name },
        valoreDopo: { id, cestino: true, eliminato_il: adesso, sostituito_da: nuovoId },
      })
      // Come nel caricamento: se sostituisce la segreteria, i titolari lo sanno.
      if (sectionId) {
        await notificaTitolariScrittura(supabase, { attore, sectionId, area: 'fascicolo' })
      }
    }

    logEvento('fascicolo', 'info', { operazione: OP, esito: 'documento-sostituito', alunno_id: alunnoId })

    return NextResponse.json(
      { success: true, data: nuovo, sostituito: { id, eliminatoIl: adesso } },
      { status: 201 },
    )
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'FASCICOLO_SCRITTURA_FALLITA' }, { status: 500 })
  }
})
