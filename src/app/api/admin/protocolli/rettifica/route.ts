import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import {
  MIME_AMMESSI,
  PROTOCOLLO_BUCKET,
  PROTOCOLLO_MAX_BYTES,
  PROTOCOLLO_MAX_MB,
  estensioneDaMime,
  pathDefinitivi,
  sha256Impronta,
} from '@/lib/protocolli/store'
import { righeSegnatura, type TipoProtocollo } from '@/lib/protocolli/segnatura'
import { applicaSegnatura, immagineInPdf } from '@/lib/protocolli/timbro'
import { logoLightBytes } from '@/lib/protocolli/assets'
import {
  denominazioneScuola,
  eliminaStagingBestEffort,
  firmaDownload,
  pareUnPdf,
  rispostaErroreProtocollo,
  scaricaProtocolloBytes,
  zStagingPath,
} from '@/lib/protocolli/server'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// RETTIFICA (decisioni #25-26 dello spec): potere riservato all'ADMIN.
// Sostituisce il documento (originale rimpiazzato, timbrato RIGENERATO con lo
// stesso numero/anno/tipo e la stessa data/ora, impronta ricalcolata) e/o
// corregge i dati descrittivi (oggetto, mittente/destinatario, mezzo,
// riferimenti del mittente, descrizione allegati, nome file). L'identità del
// protocollo (numero, anno, data di registrazione, tipo) resta intoccabile —
// lo garantisce anche il trigger WORM. NESSUNA traccia: niente logScrittura.
// L'UPDATE passa SOLO dalla funzione SECURITY DEFINER protocollo_rettifica
// (GUC transaction-locale), come l'eliminazione.

const zOpzionale = <S extends z.ZodType>(schema: S) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional())

const postBodySchema = z
  .object({
    id: zUuid,
    // Sostituzione del documento (facoltativa)
    stagingPath: zOpzionale(zStagingPath),
    nomeFile: zOpzionale(z.string().min(1).max(200)),
    mime: zOpzionale(z.enum(MIME_AMMESSI)),
    // Dati descrittivi (facoltativi; null = svuota il campo)
    oggetto: zOpzionale(z.string().trim().min(1).max(500)),
    mittente: z.string().max(300).nullable().optional(),
    destinatario: z.string().max(300).nullable().optional(),
    mezzo: z.string().max(100).nullable().optional(),
    rifProtMittente: z.string().max(60).nullable().optional(),
    rifDataMittente: z.union([zDataYMD, z.null()]).optional(),
    allegatiDescrizione: z.string().max(500).nullable().optional(),
    // Solo rinomina del file, senza sostituirlo
    fileNomeOriginale: zOpzionale(z.string().min(1).max(200)),
  })
  .superRefine((v, ctx) => {
    const campi = [
      v.stagingPath,
      v.oggetto,
      v.mittente,
      v.destinatario,
      v.mezzo,
      v.rifProtMittente,
      v.rifDataMittente,
      v.allegatiDescrizione,
      v.fileNomeOriginale,
    ]
    if (campi.every((c) => c === undefined)) {
      ctx.addIssue({ code: 'custom', path: [], message: 'Indicare almeno un campo da rettificare' })
    }
    if (v.stagingPath && (!v.nomeFile || !v.mime)) {
      ctx.addIssue({
        code: 'custom',
        path: ['nomeFile'],
        message: 'nomeFile e mime sono obbligatori quando si sostituisce il documento',
      })
    }
  })

type RecordProtocollo = {
  id: string
  scuola_id: string
  anno: number
  numero: number
  tipo: TipoProtocollo
  data_registrazione: string
  annullata_at: string | null
  file_originale: string
  file_timbrato: string
}

export const POST = withRoute('admin/protocolli/rettifica:POST', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request, ['admin'])
      if (auth.response) return auth.response
      const b = await parseBody(request, postBodySchema)
      if ('response' in b) return b.response
      const body = b.data

      const supabase = await createAdminClient()
      const sedi = await resolveScuoleAttive(request, supabase, auth.user)
      const { data, error } = await supabase
        .from('protocolli')
        .select('id, scuola_id, anno, numero, tipo, data_registrazione, annullata_at, file_originale, file_timbrato')
        .eq('id', body.id)
        .in('scuola_id', sedi)
        .maybeSingle()
      if (error) return rispostaErroreProtocollo(error)
      const record = data as RecordProtocollo | null
      if (!record) {
        return NextResponse.json({ error: 'Registrazione non trovata' }, { status: 404 })
      }
      if (record.annullata_at) {
        return NextResponse.json(
          { error: 'La registrazione è annullata: la rettifica non è consentita' },
          { status: 409 }
        )
      }

      // Patch per la rpc: chiave presente con '' → campo svuotato; assente → intatto.
      const patch: Record<string, string | number> = {}
      const testo = (chiave: string, valore: string | null | undefined) => {
        if (valore !== undefined) patch[chiave] = valore === null ? '' : valore
      }
      testo('oggetto', body.oggetto)
      testo('mittente', body.mittente)
      testo('destinatario', body.destinatario)
      testo('mezzo', body.mezzo)
      testo('rif_prot_mittente', body.rifProtMittente)
      testo('rif_data_mittente', body.rifDataMittente)
      testo('allegati_descrizione', body.allegatiDescrizione)
      if (body.fileNomeOriginale !== undefined && !body.stagingPath) {
        patch.file_nome_originale = body.fileNomeOriginale
      }

      // Sostituzione del documento: nuovo originale + timbrato rigenerato con la
      // STESSA segnatura (numero/anno/tipo e data/ora di registrazione originali).
      let vecchioOriginale: string | null = null
      if (body.stagingPath) {
        const bytes = await scaricaProtocolloBytes(supabase, body.stagingPath)
        if (bytes.byteLength > PROTOCOLLO_MAX_BYTES) {
          return NextResponse.json(
            { error: `File troppo grande (max ${PROTOCOLLO_MAX_MB} MB)` },
            { status: 400 }
          )
        }
        const mime = body.mime as (typeof MIME_AMMESSI)[number]
        let pdfDaTimbrare: Uint8Array
        if (mime === 'application/pdf') {
          if (!pareUnPdf(bytes)) {
            return NextResponse.json({ error: 'Il file non è un PDF valido' }, { status: 400 })
          }
          pdfDaTimbrare = bytes
        } else {
          pdfDaTimbrare = await immagineInPdf(bytes, mime)
        }

        const denominazione = await denominazioneScuola(supabase, record.scuola_id)
        const righe = righeSegnatura({
          denominazione,
          numero: record.numero,
          anno: record.anno,
          tipo: record.tipo,
          quando: new Date(record.data_registrazione),
        })
        const timbrato = await applicaSegnatura(pdfDaTimbrare, { righe, logoPng: logoLightBytes() })

        const percorsi = pathDefinitivi(record.scuola_id, record.anno, record.numero)
        const nuovoOriginale = percorsi.originale(estensioneDaMime(mime))
        const storage = supabase.storage.from(PROTOCOLLO_BUCKET)
        const upOrig = await storage.upload(nuovoOriginale, bytes, { contentType: mime, upsert: true })
        if (upOrig.error) {
          return NextResponse.json(
            { error: `Archiviazione file non riuscita: ${upOrig.error.message}` },
            { status: 500 }
          )
        }
        const upTimb = await storage.upload(percorsi.timbrato, timbrato, {
          contentType: 'application/pdf',
          upsert: true,
        })
        if (upTimb.error) {
          return NextResponse.json(
            { error: `Archiviazione timbrato non riuscita: ${upTimb.error.message}` },
            { status: 500 }
          )
        }

        patch.impronta_sha256 = sha256Impronta(bytes)
        patch.file_originale = nuovoOriginale
        patch.file_timbrato = percorsi.timbrato
        patch.file_nome_originale = body.nomeFile as string
        patch.file_mime = mime
        patch.file_size = bytes.byteLength
        if (record.file_originale !== nuovoOriginale) vecchioOriginale = record.file_originale
      }

      const { data: aggiornata, error: eRettifica } = await supabase.rpc('protocollo_rettifica', {
        p_id: body.id,
        p_patch: patch,
      })
      if (eRettifica) return rispostaErroreProtocollo(eRettifica)

      // Pulizia best-effort: vecchio originale con estensione diversa + staging.
      if (vecchioOriginale) {
        await supabase.storage
          .from(PROTOCOLLO_BUCKET)
          .remove([vecchioOriginale])
          .then(
            () => undefined,
            () => undefined
          )
      }
      if (body.stagingPath) await eliminaStagingBestEffort(supabase, [body.stagingPath])

      const downloadTimbrato = body.stagingPath
        ? await firmaDownload(
            supabase,
            (aggiornata as { file_timbrato: string }).file_timbrato,
            `Prot-${String(record.numero).padStart(7, '0')}-${record.anno}.pdf`
          ).catch(() => null)
        : undefined

      // Decisione #26: nessuna traccia (niente logScrittura).
      return NextResponse.json({ success: true, data: { record: aggiornata, downloadTimbrato } })
    } catch (err) {
      logErrore({ operazione: 'admin/protocolli/rettifica:POST', stato: 500 }, err)
      return rispostaErroreProtocollo(err)
    }
})
