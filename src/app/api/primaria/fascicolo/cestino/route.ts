import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveIdentity, loadAppUser } from '@/lib/auth/require-staff'
import { puoAccedereFascicolo, logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { fascicoloNelCestino } from '@/lib/primaria/cestino-fascicolo'
import {
  cestinoScaduto,
  giorniResiduiCestino,
  scadenzaCestino,
  sogliaPurgaCestinoRegistro,
} from '@/lib/primaria/cestino-registro'
import { eGestoreFascicolo, rispostaGestioneNegata } from '@/lib/primaria/fascicolo-gestione'

/**
 * IL CESTINO DEL FASCICOLO (spec 2026-09-24, F1).
 *
 *   GET  /api/primaria/fascicolo/cestino?alunnoId=&finalita=   — i documenti eliminati
 *        (o sostituiti) dell'alunno che si possono ANCORA ripristinare;
 *   POST /api/primaria/fascicolo/cestino  { id }               — RIPRISTINA un documento.
 *
 * Chi vede e chi ripristina è la stessa regola della modifica: l'autore del
 * documento, oppure Segreteria e Direzione della sede. Un'insegnante contitolare
 * vede nel cestino i SOLI documenti che ha caricato lei: sono gli unici che può
 * riportare indietro, e un elenco di voci su cui ogni pulsante risponde 403 non
 * è un elenco, è un inganno.
 *
 * I giorni di custodia vengono da `GIORNI_CESTINO_REGISTRO` (`cestino-registro.ts`),
 * la stessa costante che applica la purga: la voce che la purga può già aver tolto
 * non si elenca e non si ripristina.
 */

const getQuerySchema = z.object({
  alunnoId: zUuid,
  finalita: z.string().optional(),
})

const postBodySchema = z.object({
  id: zUuid,
})

const COLONNE_CESTINO =
  'id, student_id, section_id, document_type, descrizione, file_name, expiry_date, created_at, caricato_da, eliminato_il, eliminato_da'

type RigaCestino = {
  id: string
  student_id: string
  section_id: string | null
  document_type: string | null
  descrizione: string | null
  file_name: string | null
  expiry_date: string | null
  created_at: string | null
  caricato_da: string | null
  eliminato_il: string
  eliminato_da: string | null
}

export const GET = withRoute('primaria/fascicolo/cestino:GET', async (request: NextRequest) => {
  const OP = 'primaria/fascicolo/cestino:GET'
  try {
    const { userId } = await resolveIdentity(request)
    if (!userId) {
      return NextResponse.json({ error: 'Non autenticato', codice: 'FASCICOLO_NON_AUTENTICATO' }, { status: 401 })
    }

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { alunnoId, finalita } = q.data

    const supabase = await createAdminClient()
    const accesso = await puoAccedereFascicolo(supabase, userId, alunnoId)
    if (!accesso.consentito) {
      return NextResponse.json({ error: 'Accesso al fascicolo non consentito', codice: 'DOCUMENTO_SANITARIO_NEGATO' }, { status: 403 })
    }
    // Lo STESSO predicato della gestione (`puoGestireDocumentoFascicolo`): chi non è
    // gestore vede soltanto le voci che ha caricato, cioè le sole che può ripristinare.
    const staff = eGestoreFascicolo(accesso)

    let query = fascicoloNelCestino(
      supabase
        .from('student_documents')
        .select(COLONNE_CESTINO)
        .eq('student_id', alunnoId)
        .gte('eliminato_il', sogliaPurgaCestinoRegistro()),
    )
    if (!staff) query = query.eq('caricato_da', userId)
    const { data, error } = await query.order('eliminato_il', { ascending: false })
    if (error) {
      logErrore({ operazione: OP, stato: 500, evento: `student_documents:${error.code ?? 'ignoto'}` }, error)
      return NextResponse.json({ error: 'Lettura del cestino non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }

    const adesso = new Date()
    const voci = ((data ?? []) as RigaCestino[]).map((r) => ({
      id: r.id,
      document_type: r.document_type,
      descrizione: r.descrizione,
      file_name: r.file_name,
      expiry_date: r.expiry_date,
      created_at: r.created_at,
      caricato_da: r.caricato_da,
      eliminato_il: r.eliminato_il,
      eliminato_da: r.eliminato_da,
      ripristinabileFinoAl: scadenzaCestino(r.eliminato_il)?.toISOString() ?? null,
      giorniResidui: giorniResiduiCestino(r.eliminato_il, adesso),
    }))

    await logAccessoFascicolo(supabase, { alunnoId, utenteId: userId, azione: 'list', finalita, request })

    logEvento('fascicolo', 'info', { operazione: OP, esito: 'cestino-elencato', alunno_id: alunnoId, n: voci.length })

    return NextResponse.json({ success: true, data: voci })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'LETTURA_FALLITA' }, { status: 500 })
  }
})

export const POST = withRoute('primaria/fascicolo/cestino:POST', async (request: NextRequest) => {
  const OP = 'primaria/fascicolo/cestino:POST'
  try {
    const { userId } = await resolveIdentity(request)
    if (!userId) {
      return NextResponse.json({ error: 'Non autenticato', codice: 'FASCICOLO_NON_AUTENTICATO' }, { status: 401 })
    }

    const body = await parseBody(request, postBodySchema)
    if ('response' in body) return body.response
    const { id } = body.data

    const supabase = await createAdminClient()

    const { data: letto, error: erroreLettura } = await fascicoloNelCestino(
      supabase.from('student_documents').select(COLONNE_CESTINO).eq('id', id),
    ).maybeSingle()
    if (erroreLettura) {
      logErrore({ operazione: OP, stato: 500, evento: `student_documents:${erroreLettura.code ?? 'ignoto'}` }, erroreLettura)
      return NextResponse.json({ error: 'Lettura del cestino non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }
    const doc = letto as RigaCestino | null
    if (!doc || !doc.student_id) {
      return NextResponse.json({ error: 'Il documento non è nel cestino', codice: 'FASCICOLO_NON_NEL_CESTINO' }, { status: 409 })
    }

    const accesso = await puoAccedereFascicolo(supabase, userId, doc.student_id)
    const negato = rispostaGestioneNegata(accesso, doc.caricato_da, doc.student_id, userId, OP)
    if (negato) return negato

    if (cestinoScaduto(doc.eliminato_il)) {
      return NextResponse.json(
        { error: 'Il tempo per ripristinare il documento è scaduto', codice: 'FASCICOLO_CESTINO_SCADUTO' },
        { status: 409 },
      )
    }

    // Il ripristino è condizionato: ancora nel cestino E ancora entro la custodia. Fra
    // la lettura e qui può essere passata la purga, o un secondo «Ripristina».
    const { data: tornato, error: erroreRipristino } = await fascicoloNelCestino(
      supabase
        .from('student_documents')
        .update({ eliminato_il: null, eliminato_da: null })
        .eq('id', id)
        .gte('eliminato_il', sogliaPurgaCestinoRegistro()),
    ).select('id, document_type, descrizione, file_name, expiry_date, created_at, caricato_da').maybeSingle()
    if (erroreRipristino) {
      logErrore({ operazione: OP, stato: 500, evento: `student_documents:${erroreRipristino.code ?? 'ignoto'}` }, erroreRipristino)
      return NextResponse.json({ error: 'Ripristino non riuscito', codice: 'FASCICOLO_SCRITTURA_FALLITA' }, { status: 500 })
    }
    if (!tornato) {
      return NextResponse.json({ error: 'Il documento non è nel cestino', codice: 'FASCICOLO_NON_NEL_CESTINO' }, { status: 409 })
    }

    const attore = await loadAppUser(userId)
    if (attore) {
      await logScrittura(supabase, {
        attore,
        entitaTipo: 'fascicolo',
        entitaId: id,
        azione: 'update',
        sectionId: doc.section_id,
        valorePrima: { id, cestino: true, eliminato_il: doc.eliminato_il, eliminato_da: doc.eliminato_da },
        valoreDopo: { id, cestino: false, ripristinato: true },
      })
    }

    logEvento('fascicolo', 'info', { operazione: OP, esito: 'documento-ripristinato', alunno_id: doc.student_id })

    return NextResponse.json({ success: true, data: tornato })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'FASCICOLO_SCRITTURA_FALLITA' }, { status: 500 })
  }
})
