import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { registraProtocollo, slugNomeFile } from '@/lib/protocolli/store'
import {
  denominazioneScuola,
  firmaDownload,
  pareUnPdf,
  rispostaErroreProtocollo,
  scaricaDaBucket,
} from '@/lib/protocolli/server'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// «Protocolla» sui documenti già prodotti dall'app (decisione #21):
// certificati competenze → USCITA; moduli firmati (modulistica) → INGRESSO.
// Il PDF viene pescato dal bucket dov'è archiviato e passa nella stessa
// pipeline di registrazione (numero, fascia, conservazione doppia).

const BUCKET_CERTIFICATI = 'certificati-competenze' // src/lib/competenze/certificato-store.ts
const BUCKET_MODULI = 'form_attachments' // src/app/api/teacher/modulistica/route.ts

const postBodySchema = z.object({
  sorgente: z.enum(['certificato_competenze', 'modulo_firmato']),
  id: zUuid,
})

type Alunno = { nome: string; cognome: string } | null

async function caricaAlunno(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  alunnoId: string | null
): Promise<Alunno> {
  if (!alunnoId) return null
  const { data } = await supabase
    .from('alunni')
    .select('nome, cognome')
    .eq('id', alunnoId)
    .maybeSingle()
  return (data as Alunno) ?? null
}

export const POST = withRoute('admin/protocolli/da-documento:POST', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request, ['admin', 'segreteria'])
      if (auth.response) return auth.response
      const b = await parseBody(request, postBodySchema)
      if ('response' in b) return b.response

      const supabase = await createAdminClient()
      const sedi = await resolveScuoleAttive(request, supabase, auth.user)
      if (sedi.length === 0) {
        return NextResponse.json({ error: 'Nessuna sede accessibile' }, { status: 403 })
      }

      let scuolaId: string
      let bytes: Uint8Array
      let nomeFile: string
      let tipo: 'ingresso' | 'uscita'
      let oggetto: string
      let mittente: string | null = null
      let destinatario: string | null = null

      if (b.data.sorgente === 'certificato_competenze') {
        const { data, error } = await supabase
          .from('certificati_competenze')
          .select('id, scuola_id, alunno_id, stato, file_url')
          .eq('id', b.data.id)
          .maybeSingle()
        if (error) return rispostaErroreProtocollo(error)
        const cert = data as {
          scuola_id: string
          alunno_id: string | null
          stato: string
          file_url: string | null
        } | null
        if (!cert || !sedi.includes(cert.scuola_id)) {
          return NextResponse.json({ error: 'Certificato non trovato' }, { status: 404 })
        }
        if (!cert.file_url) {
          return NextResponse.json(
            { error: 'Il certificato non ha ancora un PDF generato' },
            { status: 400 }
          )
        }
        const alunno = await caricaAlunno(supabase, cert.alunno_id)
        const intestato = alunno ? `${alunno.cognome} ${alunno.nome}` : 'alunno/a'
        scuolaId = cert.scuola_id
        bytes = await scaricaDaBucket(supabase, BUCKET_CERTIFICATI, cert.file_url)
        nomeFile = `certificato-competenze-${slugNomeFile(intestato)}.pdf`
        tipo = 'uscita'
        oggetto = `Certificato delle competenze — ${intestato}`
        destinatario = `Famiglia dell'alunno/a ${intestato}`
      } else {
        const { data, error } = await supabase
          .from('forms_submissions')
          .select('id, form_id, student_id, is_signed, pdf_path')
          .eq('id', b.data.id)
          .maybeSingle()
        if (error) return rispostaErroreProtocollo(error)
        const sub = data as {
          form_id: string
          student_id: string | null
          is_signed: boolean
          pdf_path: string | null
        } | null
        if (!sub) {
          return NextResponse.json({ error: 'Modulo non trovato' }, { status: 404 })
        }
        if (!sub.is_signed || !sub.pdf_path) {
          return NextResponse.json(
            { error: 'Il modulo non ha un PDF firmato da protocollare' },
            { status: 400 }
          )
        }
        const { data: form } = await supabase
          .from('forms_templates')
          .select('title, scuola_id')
          .eq('id', sub.form_id)
          .maybeSingle()
        const f = form as { title: string | null; scuola_id: string | null } | null
        if (!f?.scuola_id || !sedi.includes(f.scuola_id)) {
          return NextResponse.json({ error: 'Modulo non trovato' }, { status: 404 })
        }
        const alunno = await caricaAlunno(supabase, sub.student_id)
        const intestato = alunno ? ` — ${alunno.cognome} ${alunno.nome}` : ''
        scuolaId = f.scuola_id
        bytes = await scaricaDaBucket(supabase, BUCKET_MODULI, sub.pdf_path)
        nomeFile = `${slugNomeFile(f.title ?? 'modulo-firmato')}.pdf`
        tipo = 'ingresso'
        oggetto = `Modulo firmato: ${f.title ?? 'modulistica'}${intestato}`
        mittente = alunno ? `Famiglia dell'alunno/a ${alunno.cognome} ${alunno.nome}` : 'Famiglia'
      }

      if (!pareUnPdf(bytes)) {
        return NextResponse.json(
          { error: 'Il documento archiviato non è un PDF valido' },
          { status: 400 }
        )
      }

      const esito = await registraProtocollo(supabase, {
        scuolaId,
        denominazione: await denominazioneScuola(supabase, scuolaId),
        tipo,
        oggetto,
        mittente,
        destinatario,
        mezzo: 'Documento interno app',
        createdBy: auth.user.id,
        originale: { bytes, nomeFile, mime: 'application/pdf' },
        pdfDaTimbrare: bytes,
        allegati: [],
      })

      const nomeDownload = `Prot-${String(esito.numero).padStart(7, '0')}-${esito.anno}.pdf`
      const downloadTimbrato = await firmaDownload(supabase, esito.pathTimbrato, nomeDownload).catch(
        () => null
      )

      return NextResponse.json(
        {
          success: true,
          data: {
            record: esito.record,
            numeroFormattato: esito.numeroFormattato,
            downloadTimbrato,
          },
        },
        { status: 201 }
      )
    } catch (err) {
      logErrore({ operazione: 'admin/protocolli/da-documento:POST', stato: 500 }, err)
      return rispostaErroreProtocollo(err)
    }
})
