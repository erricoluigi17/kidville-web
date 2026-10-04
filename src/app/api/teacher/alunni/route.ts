import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireEnv } from '@/lib/security/require-env'
import { requireDocente } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { STATO_ISCRITTO } from '@/lib/alunni/stato'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { selectResiliente } from '@/lib/supabase/select-resiliente'
import { sezioniAnagraficaVisibili } from '@/lib/anagrafiche/docente/visibilita'
import { COLONNE_ELENCO } from '@/lib/anagrafiche/docente/colonne'
import { proiettaSezione, proiettaVoceElenco, type RigaDb } from '@/lib/anagrafiche/docente/proiezione'
import type { ElencoAlunniRisposta } from '@/lib/anagrafiche/docente/tipi'

/**
 * GET /api/teacher/alunni — l'elenco dei bambini di cui l'utente vede l'anagrafica.
 *
 * SOLA LETTURA: questo modulo esporta solo `GET`, e un test lo verifica. Educator →
 * gli iscritti delle sezioni assegnate direttamente o per materia; direzione,
 * coordinamento e segreteria → gli iscritti della propria sede. L'elenco porta solo
 * ciò che serve a riconoscere e filtrare (nessun testo sanitario, nessun codice
 * fiscale): la scheda completa sta in `[id]`, che scrive nel registro degli accessi.
 */

/** Nessun parametro: lo schema vuoto lo dichiara, e `parseQuery` scarta il resto. */
const getQuerySchema = z.object({})

const OPERAZIONE = 'teacher/alunni:GET'
const SENZA_CACHE = { 'Cache-Control': 'no-store' }
const VUOTO: ElencoAlunniRisposta = { sezioni: [], alunni: [] }

const erroreLettura = () =>
  NextResponse.json(
    { error: 'Elenco degli alunni non letto', codice: 'ANAGRAFICA_ELENCO_NON_LETTO' },
    { status: 500, headers: SENZA_CACHE },
  )

// Il nome si ripete per esteso: il lock `logging-coverage` lo legge solo letterale.
export const GET = withRoute('teacher/alunni:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const user = auth.user

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const configurazione = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
    if (configurazione) return configurazione
    const supabase = await createAdminClient()

    const plessi = await resolveScuoleAttive(request, supabase, user)
    if (plessi.length === 0) return NextResponse.json(VUOTO, { headers: SENZA_CACHE })

    // Le sezioni PRIMA della query: un educator senza assegnazioni esce di qui senza
    // aver chiesto niente agli alunni, e un guasto non diventa un elenco vuoto.
    const visibili = await sezioniAnagraficaVisibili(supabase, user)
    if (visibili.esito === 'errore') return erroreLettura()
    if (visibili.esito === 'sezioni' && visibili.sezioni.length === 0) {
      return NextResponse.json(VUOTO, { headers: SENZA_CACHE })
    }

    const { data: righe, error: erroreAlunni } = await selectResiliente(
      COLONNE_ELENCO,
      (colonne) => {
        let query = supabase
          .from('alunni')
          .select(colonne.join(', '))
          .in('scuola_id', plessi)
          .eq('stato', STATO_ISCRITTO)
          .is('anonimizzato_il', null)
        if (visibili.esito === 'sezioni') query = query.in('section_id', visibili.sezioni)
        return query.order('cognome', { ascending: true }).order('nome', { ascending: true }).limit(1000)
      },
      OPERAZIONE,
      { livello: 'warn' },
    )
    if (erroreAlunni) {
      logErrore({ operazione: OPERAZIONE, stato: 500 }, erroreAlunni)
      return erroreLettura()
    }
    const alunni = (righe ?? []) as unknown as RigaDb[]

    const idSezioni = [...new Set(alunni.map((a) => a.section_id).filter((s): s is string => typeof s === 'string'))]
    let sezioni: ElencoAlunniRisposta['sezioni'] = []
    if (idSezioni.length > 0) {
      const { data: righeSezioni, error: erroreSezioni } = await supabase
        .from('sections')
        .select('id, name, school_type')
        .in('id', idSezioni)
        .in('scuola_id', plessi)
        .order('name', { ascending: true })
      if (erroreSezioni) {
        logErrore({ operazione: OPERAZIONE, stato: 500 }, erroreSezioni)
        return erroreLettura()
      }
      sezioni = ((righeSezioni ?? []) as RigaDb[]).map(proiettaSezione)
    }
    const gradoDi = new Map(sezioni.map((s) => [s.id, s.grado]))

    const risposta: ElencoAlunniRisposta = {
      sezioni,
      alunni: alunni.map((a) => proiettaVoceElenco(a, gradoDi.get(String(a.section_id)) ?? null)),
    }
    return NextResponse.json(risposta, { headers: SENZA_CACHE })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
    return erroreLettura()
  }
})
