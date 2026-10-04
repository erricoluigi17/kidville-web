import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireEnv } from '@/lib/security/require-env'
import { requireDocente } from '@/lib/auth/require-staff'
import { STATO_ISCRITTO } from '@/lib/alunni/stato'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { selectResiliente } from '@/lib/supabase/select-resiliente'
import { logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { assertAlunnoAnagraficaInScope } from '@/lib/anagrafiche/docente/visibilita'
import { COLONNE_DELEGATI, COLONNE_LEGAMI, COLONNE_SCHEDA } from '@/lib/anagrafiche/docente/colonne'
import {
  proiettaDelegati,
  proiettaGenitori,
  proiettaScheda,
  proiettaSezione,
  type RigaDb,
} from '@/lib/anagrafiche/docente/proiezione'

/**
 * GET /api/teacher/alunni/[id] — la scheda anagrafica di un bambino, in sola lettura.
 *
 * Questo modulo esporta solo `GET`: un'insegnante può guardare, non modificare.
 * Ordine vincolante: ruolo → id valido → controllo di scope (sede e sezione, con le
 * assegnazioni per materia) → lettura → audit. Nessun dato anagrafico si legge prima
 * che il controllo sia passato.
 *
 * L'AUDIT è dovuto: la scheda porta codice fiscale, salute e recapiti di un minore.
 * Si scrive DOPO una lettura riuscita — una riga sopra un 403 racconterebbe un accesso
 * mai avvenuto — ed è lo stesso registro che si mostra a un genitore che chiede chi
 * ha aperto il fascicolo di suo figlio (`app_log` ha trenta giorni, non basta). Se la
 * scrittura fallisce la scheda si mostra comunque e il guasto va in log `error`:
 * negare a un'insegnante le allergie di un bambino per un guasto del registro sarebbe
 * peggio del registro mancante.
 */

const OPERAZIONE = 'teacher/alunni/[id]:GET'
const FINALITA_AUDIT = 'anagrafica-docente'
const SENZA_CACHE = { 'Cache-Control': 'no-store' }

const erroreLettura = () =>
  NextResponse.json(
    { error: 'Scheda dell’alunno non letta', codice: 'ANAGRAFICA_NON_LETTA' },
    { status: 500, headers: SENZA_CACHE },
  )

// Il nome si ripete per esteso: il lock `logging-coverage` lo legge solo letterale.
export const GET = withRoute(
  'teacher/alunni/[id]:GET',
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    try {
      const auth = await requireDocente(request)
      if (auth.response) return auth.response
      const user = auth.user

      const { id } = await context.params
      const parsed = parseData(zUuid, id)
      if ('response' in parsed) return parsed.response
      const alunnoId = parsed.data

      const configurazione = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
      if (configurazione) return configurazione
      const supabase = await createAdminClient()

      const scope = await assertAlunnoAnagraficaInScope(supabase, user, alunnoId)
      if (!scope.ok) return scope.response
      const { alunno } = scope

      // La lettura della scheda RIFÀ i filtri del controllo (sede, iscritto, non
      // anonimizzato): archiviare e dimenticare non cancellano la riga, la aggiornano.
      // Senza i filtri un bambino archiviato fra il controllo e questa lettura uscirebbe
      // con 200 e una riga di audit.
      const [anagrafica, legami, delegati, sezione] = await Promise.all([
        selectResiliente(
          COLONNE_SCHEDA,
          (colonne) =>
            supabase
              .from('alunni')
              .select(colonne.join(', '))
              .eq('id', alunnoId)
              .eq('scuola_id', alunno.scuolaId)
              .eq('stato', STATO_ISCRITTO)
              .is('anonimizzato_il', null)
              .maybeSingle(),
          OPERAZIONE,
          { livello: 'warn' },
        ),
        supabase.from('student_parents').select(COLONNE_LEGAMI).eq('student_id', alunnoId),
        supabase
          .from('delegates')
          .select(COLONNE_DELEGATI)
          .eq('student_id', alunnoId)
          .order('created_at', { ascending: true }),
        alunno.sectionId
          ? supabase
              .from('sections')
              .select('id, name, school_type')
              .eq('id', alunno.sectionId)
              .eq('scuola_id', alunno.scuolaId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ])

      const guasto = anagrafica.error ?? legami.error ?? delegati.error ?? sezione.error
      if (guasto) {
        logErrore({ operazione: OPERAZIONE, stato: 500 }, guasto)
        return erroreLettura()
      }
      // Nessuna riga: fra il controllo e la lettura il bambino è stato ritirato o
      // anonimizzato (la riga resta, ma i filtri qui sopra la escludono) oppure la riga
      // è stata cancellata davvero. In tutti e tre i casi la scheda non esiste più.
      if (!anagrafica.data) {
        return NextResponse.json(
          { error: 'Alunno non trovato', codice: 'ANAGRAFICA_NON_TROVATA' },
          { status: 404, headers: SENZA_CACHE },
        )
      }

      const scheda = proiettaScheda(anagrafica.data as unknown as RigaDb, {
        sezione: sezione.data ? proiettaSezione(sezione.data as RigaDb) : null,
        genitori: proiettaGenitori((legami.data ?? []) as unknown as RigaDb[]),
        delegati: proiettaDelegati((delegati.data ?? []) as unknown as RigaDb[]),
      })

      await logAccessoFascicolo(supabase, {
        alunnoId,
        utenteId: user.id,
        azione: 'view',
        finalita: FINALITA_AUDIT,
        request,
      })

      return NextResponse.json(scheda, { headers: SENZA_CACHE })
    } catch (err) {
      logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
      return erroreLettura()
    }
  },
)
