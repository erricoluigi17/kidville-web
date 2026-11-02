import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { withRoute } from '@/lib/logging/with-route'
import { parseQuery } from '@/lib/validation/http'
import { requireVotazioni } from '@/lib/votazioni/accesso'
import { genitoriDellaSede } from '@/lib/votazioni/aventi-diritto'
import { rispostaErroreDbVotazioni } from '@/lib/votazioni/errori'
import { genitoriQuerySchema } from '@/lib/votazioni/schemi'
import type { GenitoriSedeRisposta } from '@/lib/votazioni/tipi'

/**
 * VOTAZIONI DEI RAPPRESENTANTI · I GENITORI DELLA SEDE (segreteria).
 *
 * ── GET /api/admin/votazioni/genitori?scuolaId?&q? ───────────────────────────────────────────────────────
 * `GenitoriSedeRisposta`: i genitori con un account attivo e un figlio a scuola nella sede, fra cui scegliere i
 * candidati del rappresentante d'istituto (`genitoriDellaSede`, la stessa lettura con cui il POST li convalida).
 *
 * LA SEDE È UNA SOLA E SI DICHIARA: con più sedi e nessuna indicata la risposta è 400 (`resolveScuolaScrittura`),
 * e una sede che non è dell'utente è 403. Un elenco «di tutte le sedi» mescolerebbe i candidati di plessi diversi.
 *
 * `q` filtra per nome senza distinguere maiuscole e accenti («perez» trova «Pérez José»): ogni parola scritta deve
 * comparire nel «Cognome Nome», in qualunque ordine. Sono testo, non espressioni: «(.*)» non trova niente. Al
 * massimo 50 risultati, i primi per cognome e nome.
 *
 * Se la lettura dei genitori è incompleta la risposta è 500, mai un elenco corto: la segreteria potrebbe
 * concludere che un genitore «non ha l'account» e lasciarlo fuori dalle candidature.
 */

/** Quanti genitori al massimo: il campo di ricerca serve a restringere, non a scorrere una sede intera. */
const RISULTATI_MASSIMI = 50

/** Minuscolo, senza accenti e con un solo tipo di apostrofo: «Pérez» e «perez», «D’Angelo» e «D'Angelo», uguali. */
function normalizza(testo: string): string {
  return testo
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`´]/g, "'")
    .toLowerCase()
}

export const GET = withRoute('admin/votazioni/genitori:GET', async (request: NextRequest) => {
  const auth = await requireVotazioni(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, genitoriQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const sede = await resolveScuolaScrittura(request, supabase, auth.user, q.data.scuolaId)
  if (sede.response) return sede.response
  const scuolaId = sede.scuolaId as string

  const genitori = await genitoriDellaSede(supabase, scuolaId)
  if (!genitori.completo) {
    return rispostaErroreDbVotazioni(
      genitori.errore as { code?: string; message?: string },
      'admin/votazioni/genitori:GET',
    )
  }

  const parole = normalizza(q.data.q ?? '')
    .split(/\s+/)
    .filter(Boolean)
  const trovati =
    parole.length === 0
      ? genitori.valore
      : genitori.valore.filter((g) => {
          const nome = normalizza(g.nome)
          return parole.every((parola) => nome.includes(parola))
        })

  const corpo: GenitoriSedeRisposta = { genitori: trovati.slice(0, RISULTATI_MASSIMI) }
  return NextResponse.json(corpo)
})
