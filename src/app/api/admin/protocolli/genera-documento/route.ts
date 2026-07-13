import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { annoScolasticoCorrente } from '@/lib/anno-scolastico'
import { parseAnagraficaSede } from '@/lib/scuole/anagrafica'
import { buildIntestazioneSede, rigaLuogoData } from '@/lib/certificati/self-service'
import {
  buildDocumentoRichiesta,
  oggettoDocumento,
  type TipoDocumentoRichiesta,
} from '@/lib/protocolli/documenti'
import { buildDocumentoRichiestaPdf } from '@/lib/protocolli/documento-pdf'
import { dataOraItaliana } from '@/lib/protocolli/segnatura'
import { registraProtocollo, slugNomeFile } from '@/lib/protocolli/store'
import {
  denominazioneScuola,
  firmaDownload,
  rispostaErroreProtocollo,
} from '@/lib/protocolli/server'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// «Genera documento» su richiesta (decisione #22): certificato di
// frequenza/iscrizione, nulla osta o testo libero su carta intestata, generato
// server-side e protocollato in USCITA col timbro, in un click.

const postBodySchema = z
  .object({
    tipoDocumento: z.enum(['frequenza', 'iscrizione', 'nulla_osta', 'libero']),
    alunnoId: zUuid,
    titolo: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().max(120).optional()),
    corpo: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().max(4000).optional()),
  })
  .superRefine((v, ctx) => {
    if (v.tipoDocumento === 'libero') {
      if (!v.titolo?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['titolo'], message: 'Titolo obbligatorio per il documento libero' })
      }
      if (!v.corpo?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['corpo'], message: 'Testo obbligatorio per il documento libero' })
      }
    }
  })

export const POST = withRoute('admin/protocolli/genera-documento:POST', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request, ['admin', 'segreteria'])
      if (auth.response) return auth.response
      const b = await parseBody(request, postBodySchema)
      if ('response' in b) return b.response

      const supabase = await createAdminClient()
      const { data: alunnoRow, error: eAlunno } = await supabase
        .from('alunni')
        .select('id, nome, cognome, classe_sezione, scuola_id')
        .eq('id', b.data.alunnoId)
        .maybeSingle()
      if (eAlunno) return rispostaErroreProtocollo(eAlunno)
      const alunno = alunnoRow as {
        nome: string
        cognome: string
        classe_sezione: string | null
        scuola_id: string
      } | null
      if (!alunno) {
        return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
      }

      const sedi = await resolveScuoleAttive(request, supabase, auth.user)
      if (!sedi.includes(alunno.scuola_id)) {
        return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
      }
      const scuolaId = alunno.scuola_id

      // Carta intestata: anagrafica reale della sede (scuole.config.anagrafica),
      // con fallback su schools per nome/città/indirizzo. Righe mai inventate.
      const { data: sedeRow } = await supabase
        .from('scuole')
        .select('nome, citta, indirizzo, config')
        .eq('id', scuolaId)
        .maybeSingle()
      let sede = sedeRow as {
        nome: string | null
        citta: string | null
        indirizzo: string | null
        config: unknown
      } | null
      if (!sede) {
        const { data: schoolRow } = await supabase
          .from('schools')
          .select('nome, citta, indirizzo')
          .eq('id', scuolaId)
          .maybeSingle()
        const s = schoolRow as { nome: string | null; citta: string | null; indirizzo: string | null } | null
        sede = s ? { ...s, config: null } : null
      }
      const anagrafica = parseAnagraficaSede(sede?.config)
      const intestazione = buildIntestazioneSede({
        scuola_nome: anagrafica.denominazione ?? sede?.nome,
        scuola_indirizzo: sede?.indirizzo,
        scuola_cap: anagrafica.cap,
        scuola_citta: sede?.citta,
        scuola_provincia: anagrafica.provincia,
        scuola_codice_meccanografico: anagrafica.codice_meccanografico,
      })

      let testi: { titolo: string; corpo: string }
      try {
        testi = buildDocumentoRichiesta(
          b.data.tipoDocumento as TipoDocumentoRichiesta,
          alunno,
          annoScolasticoCorrente(),
          { titolo: b.data.titolo, corpo: b.data.corpo }
        )
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : 'Dati documento non validi' },
          { status: 400 }
        )
      }

      const pdf = buildDocumentoRichiestaPdf({
        intestazione,
        titolo: testi.titolo,
        corpo: testi.corpo,
        luogoData: rigaLuogoData(sede?.citta, dataOraItaliana(new Date()).data),
      })

      const intestato = `${alunno.cognome} ${alunno.nome}`
      const esito = await registraProtocollo(supabase, {
        scuolaId,
        denominazione: await denominazioneScuola(supabase, scuolaId),
        tipo: 'uscita',
        oggetto: oggettoDocumento(b.data.tipoDocumento as TipoDocumentoRichiesta, alunno, {
          titolo: b.data.titolo,
          corpo: b.data.corpo,
        }),
        destinatario: `Famiglia dell'alunno/a ${intestato}`,
        mezzo: 'Consegna a mano',
        createdBy: auth.user.id,
        originale: {
          bytes: pdf,
          nomeFile: `${slugNomeFile(testi.titolo)}.pdf`,
          mime: 'application/pdf',
        },
        pdfDaTimbrare: pdf,
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
      logErrore({ operazione: 'admin/protocolli/genera-documento:POST', stato: 500 }, err)
      return rispostaErroreProtocollo(err)
    }
})
