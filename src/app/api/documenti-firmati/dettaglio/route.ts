import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertAlunnoInScope } from '@/lib/auth/scope'
import { puoAccedereFascicolo, logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { categoriaDocumento, etichettaTipo, istanteFirma } from '@/lib/documenti/registro'
import { withRoute } from '@/lib/logging/with-route'
import CATALOGO from '../../../../../messages/it/shared.json'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * GET /api/documenti-firmati/dettaglio?fonte=&id= — apre UN documento.
 *
 * L'elenco dice che il documento esiste; questa route lo apre, ed è qui che il
 * gate deve essere più severo, non meno:
 *
 *  1. ruolo (`requireDocente`) — mai il solo ruolo, vedi punto 2;
 *  2. lo scope dell'alunno (`assertAlunnoInScope`): plesso e, per l'educator,
 *     sezione assegnata;
 *  3. per i SANITARI, il gate del fascicolo (`puoAccedereFascicolo`), che è più
 *     stretto e vale una sezione alla volta;
 *  4. audit su `fascicolo_accessi_audit` PRIMA di restituire il contenuto.
 *
 * ⚠️ Il punto 2 esiste per un incidente vero: `GET /api/parent/medical-certificates/file`
 * autorizzava il solo RUOLO, e un docente poteva scaricare il certificato medico
 * di un minore di un'altra sede conoscendo l'id del file. Un gate che guarda solo
 * chi sei, e mai di chi stai chiedendo, non è un gate.
 */

const BUCKET_FASCICOLO = 'sensitive_documents'
const BUCKET_CERTIFICATI = 'certificati-medici'
/** Durata del link firmato: il tempo di aprire il file, non di girarlo. */
const SIGNED_TTL = 60

const getQuerySchema = z.object({
  fonte: z.enum(['modulo_firmato', 'fascicolo', 'certificato_medico']),
  id: zUuid,
  finalita: z.string().trim().max(200).optional(),
})

type Fonte = z.infer<typeof getQuerySchema>['fonte']

interface Risolto {
  alunnoId: string
  tipo: string | null
  /** Path nello storage, per le fonti che hanno un file vero. */
  path?: string | null
  /** Corpo aggiuntivo restituito al client. */
  extra?: Record<string, unknown>
}

async function risolvi(
  supabase: SupabaseClient,
  fonte: Fonte,
  id: string,
): Promise<Risolto | null> {
  if (fonte === 'modulo_firmato') {
    const { data, error } = await supabase
      .from('forms_submissions')
      .select('id, student_id, form_id, answers, is_signed, signature_log, created_at, origine')
      .eq('id', id)
      .maybeSingle()
    if (error || !data || !data.student_id) return null

    let titolo: string | null = null
    if (data.form_id) {
      const { data: modello } = await supabase
        .from('forms_templates')
        .select('title')
        .eq('id', data.form_id)
        .maybeSingle()
      titolo = (modello as { title?: string | null } | null)?.title ?? null
    }

    return {
      alunnoId: data.student_id as string,
      tipo: null,
      extra: {
        titolo: titolo ?? 'Modulo senza titolo',
        risposte: data.answers ?? null,
        firmato: data.is_signed === true,
        firmatoIl: data.is_signed === true ? istanteFirma(data.signature_log) : null,
        // La traccia di firma senza il segreto: chi ha firmato, quando, con che
        // metodo. L'hash dell'OTP resta fuori — è un dato di verifica, non di
        // consultazione, e per quello c'è la ricevuta FEA.
        firma: tracciaFirma(data.signature_log),
        creatoIl: data.created_at ?? null,
        origine: data.origine ?? null,
      },
    }
  }

  if (fonte === 'fascicolo') {
    const { data, error } = await supabase
      .from('student_documents')
      .select('id, student_id, document_type, descrizione, file_name, storage_path, file_url, expiry_date, created_at')
      .eq('id', id)
      .maybeSingle()
    if (error || !data || !data.student_id) return null
    return {
      alunnoId: data.student_id as string,
      tipo: (data.document_type as string | null) ?? null,
      path: (data.storage_path as string | null) || (data.file_url as string | null),
      extra: {
        titolo: etichettaTipo(data.document_type as string | null) ?? data.file_name ?? 'Documento',
        descrizione: data.descrizione ?? null,
        fileName: data.file_name ?? null,
        scadeIl: data.expiry_date ?? null,
        creatoIl: data.created_at ?? null,
      },
    }
  }

  const { data, error } = await supabase
    .from('certificati_medici')
    .select('id, alunno_id, file_path, data_inizio, data_fine, stato, creato_il')
    .eq('id', id)
    .maybeSingle()
  if (error || !data || !data.alunno_id) return null
  return {
    alunnoId: data.alunno_id as string,
    tipo: 'certificato_medico',
    path: (data.file_path as string | null) ?? null,
    extra: {
      titolo: 'Certificato medico',
      dal: data.data_inizio ?? null,
      al: data.data_fine ?? null,
      stato: data.stato ?? null,
      creatoIl: data.creato_il ?? null,
    },
  }
}

/** Estrae dal log di firma i soli campi consultabili. */
function tracciaFirma(signatureLog: unknown): Record<string, unknown> | null {
  if (!signatureLog || typeof signatureLog !== 'object') return null
  const log = signatureLog as Record<string, unknown>
  const traccia: Record<string, unknown> = {}
  for (const chiave of ['method', 'provider', 'signed_at', 'timestamp', 'compliance'] as const) {
    if (log[chiave] !== undefined) traccia[chiave] = log[chiave]
  }
  return Object.keys(traccia).length > 0 ? traccia : null
}

export const GET = withRoute('documenti-firmati/dettaglio:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const user = auth.user

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { fonte, id, finalita } = q.data

    const supabase = await createAdminClient()
    const risolto = await risolvi(supabase, fonte, id)
    // 404 anche quando la riga esiste ma è orfana di alunno: non c'è un
    // fascicolo a cui appartenga, quindi non c'è nessuno che possa aprirla.
    if (!risolto) {
      return NextResponse.json(
        { error: CATALOGO.erroreDocumentoNonTrovato, codice: 'DOCUMENTO_NON_TROVATO' },
        { status: 404 },
      )
    }

    // Scope: plesso e, per l'educator, sezione assegnata.
    const fuoriScope = await assertAlunnoInScope(supabase, user, risolto.alunnoId)
    if (fuoriScope) return fuoriScope

    const categoria = categoriaDocumento(fonte, risolto.tipo)

    if (categoria === 'sanitario') {
      const accesso = await puoAccedereFascicolo(supabase, user.id, risolto.alunnoId)
      if (!accesso.consentito) {
        logEvento('fascicolo', 'warn', {
          operazione: 'documenti-firmati/dettaglio:GET',
          esito: 'sanitario-negato',
          motivo: accesso.motivo,
          utente: user.id,
          ruolo: user.role,
          alunno_id: risolto.alunnoId,
        })
        return NextResponse.json(
          { error: CATALOGO.erroreDocumentoSanitarioNegato, codice: 'DOCUMENTO_SANITARIO_NEGATO' },
          { status: 403 },
        )
      }
      // L'audit va scritto PRIMA di restituire il contenuto: se fallisce
      // l'inserimento, `logAccessoFascicolo` lo segnala a livello error.
      await logAccessoFascicolo(supabase, {
        alunnoId: risolto.alunnoId,
        utenteId: user.id,
        azione: 'view',
        documentoId: id,
        finalita: finalita ?? null,
        request,
      })
    }

    // Link firmato solo per le fonti che hanno un file vero nello storage.
    // I moduli firmati non ne hanno: `forms_submissions.pdf_path` è un percorso
    // SIMULATO (vedi `src/lib/forms/persist-submission.ts`), nessun byte è mai
    // stato caricato. Dirlo è meglio che servire un link che darà 404.
    let url: string | null = null
    let fileAssente = false
    if (fonte !== 'modulo_firmato') {
      const bucket = fonte === 'fascicolo' ? BUCKET_FASCICOLO : BUCKET_CERTIFICATI
      if (!risolto.path) {
        fileAssente = true
      } else {
        const { data: signed, error } = await supabase.storage
          .from(bucket)
          .createSignedUrl(risolto.path, SIGNED_TTL)
        if (error || !signed?.signedUrl) {
          fileAssente = true
          logErrore(
            { operazione: 'documenti-firmati/dettaglio:GET', evento: `signed-url:${fonte}` },
            error,
          )
        } else {
          url = signed.signedUrl
        }
      }
    }

    logEvento('fascicolo', 'info', {
      operazione: 'documenti-firmati/dettaglio:GET',
      utente: user.id,
      ruolo: user.role,
      fonte,
      categoria,
      alunno_id: risolto.alunnoId,
      file_assente: fileAssente,
    })

    return NextResponse.json({
      success: true,
      data: {
        id: `${fonte}:${id}`,
        fonte,
        categoria,
        alunnoId: risolto.alunnoId,
        tipo: risolto.tipo,
        url,
        fileAssente,
        ...(risolto.extra ?? {}),
      },
    })
  } catch (err) {
    logErrore({ operazione: 'documenti-firmati/dettaglio:GET', stato: 500 }, err)
    return NextResponse.json(
      { error: CATALOGO.erroreDocumentiElencoNonLetto, codice: 'DOCUMENTI_ELENCO_NON_LETTO' },
      { status: 500 },
    )
  }
})
