import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveScuoleAttive, restringiSedi } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { requireCrm } from '@/lib/crm/accesso'
import { estraiDaDomanda } from '@/lib/crm/collegamento'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { parseQuery } from '@/lib/validation/http'
import { zOpzionale, zTestoRicerca, zUuid } from '@/lib/validation/common'

/**
 * CRM della segreteria · le domande di iscrizione fra cui scegliere quella da collegare a un bambino.
 *
 * `GET /api/admin/crm/domande?scuolaId=<uuid>&q=<testo>&domandaId=<uuid>` →
 * `200 { data: [{ domandaId, figlio, nome, cognome, dataNascita, genitore, ricevutaIl, stato, giaCollegato }] }`
 *
 * Una riga per ogni FIGLIO di ogni domanda, dalla domanda più recente; al massimo le ultime 50 domande.
 *
 * ─── 🔴 DATI DI MINORI: SI RESTITUISCE IL MINIMO PER SCEGLIERE ───────────────
 * `enrollment_submissions.data` contiene codici fiscali, allergie e note mediche. Qui si legge la riga
 * perché PostgREST non sa proiettare dentro un jsonb, ma ne esce SOLO: nome, cognome e data di nascita
 * del figlio, nome e cognome del primo genitore, data di ricevimento e stato — gli stessi dati che la
 * segreteria vede già nei moduli ricevuti. Niente codice fiscale, niente testo libero, niente recapiti.
 * Nei log, nemmeno questi: la route non ne scrive.
 *
 * `q` filtra (in codice, senza badare a maiuscole) SOLO su ciò che si mostra: nome e cognome del figlio,
 * nome del genitore. Mai dentro i campi che non escono. Con `q` si guarda nelle ultime 200 domande della
 * sede, non nelle ultime 50: una ricerca deve poter trovare una domanda di qualche settimana fa.
 *
 * `domandaId` restringe a UNA domanda: è come l'avviso «è arrivata una domanda» della scheda apre la
 * ricerca già puntata su quella. Una domanda di un'altra sede dà l'elenco vuoto, mai la domanda.
 *
 * ─── LA SEDE ────────────────────────────────────────────────────────────────
 * Si DICHIARA (`scuolaId`, richiesta) e deve stare fra le sedi attive dell'utente; `.in('scuola_id', …)`
 * sta nella stessa query della lettura delle domande e di quella dei bambini collegati.
 */

const MAX_DOMANDE = 50
const FINESTRA_RICERCA = 200

const querySchema = z.object({
  scuolaId: zUuid,
  q: zTestoRicerca,
  domandaId: zOpzionale(zUuid),
})

type RigaDomanda = { id: string; scuola_id: string; status: string | null; created_at: string | null; data: unknown }

export const GET = withRoute('admin/crm/domande:GET', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const attive = await resolveScuoleAttive(request, supabase, auth.user)
  const scuole = restringiSedi(attive, q.data.scuolaId)
  if (scuole === null) {
    logEvento('multi_sede', 'warn', {
      operazione: 'admin/crm/domande:GET',
      esito: 'sede-filtro-fuori-scope',
      utente: auth.user.id,
      ruolo: auth.user.role,
      sede_id: q.data.scuolaId,
      sedi_attive: attive.length,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }

  const testo = (q.data.q ?? '').trim().toLowerCase()
  let lettura = supabase
    .from('enrollment_submissions')
    .select('id, scuola_id, status, created_at, data')
    .in('scuola_id', scuole)
  if (q.data.domandaId) lettura = lettura.eq('id', q.data.domandaId)
  const { data: domande, error } = await lettura
    .order('created_at', { ascending: false })
    .limit(testo ? FINESTRA_RICERCA : MAX_DOMANDE)
  if (error) return rispostaErroreDb(error, 'admin/crm/domande:GET')

  const righe: Array<{
    domandaId: string
    figlio: number
    nome: string | null
    cognome: string | null
    dataNascita: string | null
    genitore: string | null
    ricevutaIl: string | null
    stato: string | null
    giaCollegato: boolean
  }> = []
  let lette = 0
  for (const d of (domande ?? []) as RigaDomanda[]) {
    const { figli, genitore } = estraiDaDomanda(d.data)
    const corrisponde = (nome: string | null, cognome: string | null) =>
      testo === '' || [nome, cognome, genitore].some((v) => v !== null && v.toLowerCase().includes(testo))
    const scelti = figli.filter((f) => corrisponde(f.nome, f.cognome))
    if (scelti.length === 0) continue
    // Le domande, non i figli, sono il tetto: una famiglia con tre figli occupa un posto solo.
    if (++lette > MAX_DOMANDE) break
    for (const f of scelti) {
      righe.push({
        domandaId: d.id,
        figlio: f.indice,
        nome: f.nome,
        cognome: f.cognome,
        dataNascita: f.dataNascita,
        genitore,
        ricevutaIl: d.created_at,
        stato: d.status,
        giaCollegato: false,
      })
    }
  }

  // Quali di queste coppie (domanda, figlio) sono già prese da un bambino della sede.
  const idDomande = [...new Set(righe.map((r) => r.domandaId))]
  if (idDomande.length > 0) {
    const { data: collegati, error: errCollegati } = await supabase
      .from('crm_bambini')
      .select('domanda_id, domanda_figlio')
      .in('scuola_id', scuole)
      .in('domanda_id', idDomande)
    if (errCollegati) return rispostaErroreDb(errCollegati, 'admin/crm/domande:GET')
    const presi = new Set((collegati ?? []).map((c) => `${c.domanda_id}:${c.domanda_figlio}`))
    for (const r of righe) r.giaCollegato = presi.has(`${r.domandaId}:${r.figlio}`)
  }

  return NextResponse.json({ data: righe })
})
