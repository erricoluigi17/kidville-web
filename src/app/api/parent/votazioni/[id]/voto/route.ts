import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import it from '../../../../../../../messages/it/shared.json'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import { figliAttiviConClasse, nomiGenitori } from '@/lib/votazioni/aventi-diritto'
import {
  ammessoAllIstituto,
  candidatiDellaClasse,
  formaId,
  leggiAmmissione,
  ammessoInClasse,
} from '@/lib/votazioni/ammissione-genitore'
import { rispostaErroreDbVotazioni } from '@/lib/votazioni/errori'
import { votoSchema } from '@/lib/votazioni/schemi'
import { statoVotazione } from '@/lib/votazioni/stato'
import type { VotoRisposta } from '@/lib/votazioni/tipi'

/**
 * POST /api/parent/votazioni/[id]/voto · IL VOTO DI UN GENITORE SU UNA SCHEDA.
 *
 * Body: `{ ambito: 'classe', sectionId, candidatoId }` oppure `{ ambito: 'istituto', candidatoId }`
 * (`sectionId` assente o `null`). Risposta: `{ ok: true, sceltaAttuale, cambiato }`. Si può cambiare idea fino
 * alla scadenza: vale l'ultimo voto, e la riga è una sola per (votazione, scheda, elettore).
 *
 * ── L'ELETTORE È LA SESSIONE ─────────────────────────────────────────────────
 *
 * `votoSchema` non ha un campo per chi vota e `z.object` scarta ciò che non conosce: `elettore_id`,
 * `scuola_id` e simili nel body non arrivano mai qui. L'elettore è `auth.user.id`, la sede è quella della
 * votazione. Nessun controllo di morosità (decisione del titolare).
 *
 * ── UNA REGOLA SOLA ──────────────────────────────────────────────────────────
 *
 * Chi può votare in una scheda lo decide `@/lib/votazioni/ammissione-genitore`, la STESSA regola con cui il
 * GET (`/api/parent/votazioni`) decide quali schede mostrare: il genitore non vede una scheda per poi
 * sentirsi rifiutare il voto, né vota in una che non ha mai visto.
 *
 * ── LE RISPOSTE, NELL'ORDINE IN CUI SI DECIDONO ──────────────────────────────
 *
 *  · 401 senza sessione · 400 se l'id o il body non hanno la forma giusta;
 *  · 403 `VOTO_ELETTORE_NON_AMMESSO` se l'elettore non ha nessun figlio ancora a scuola;
 *  · 404 `VOTAZIONE_NON_TROVATA` se la votazione non esiste o è di una sede in cui non ha figli (come se
 *    non esistesse: non si rivela che c'è);
 *  · 409 `VOTAZIONE_CHIUSA` se è chiusa a mano o scaduta (`statoVotazione`, la stessa funzione del GET);
 *  · 403 `VOTO_ELETTORE_NON_AMMESSO` se la scheda non fa parte della votazione o l'elettore non ha diritto;
 *  · 400 `VOTAZIONE_CANDIDATO_NON_VALIDO` se il candidato non è un genitore della scheda — per l'istituto,
 *    uno dei candidati di QUESTA votazione (quindi di questa sede: un candidato della sede A sulla scheda
 *    della sede B è un 400);
 *  · 503 `VOTAZIONI_NON_DISPONIBILI` se lo schema delle votazioni manca; 500 per qualunque altro guasto.
 *
 * Un GUASTO non è un diniego: una lettura caduta (figli, genitori, nomi) risponde 500, mai 403 o 400. Dire a
 * un genitore «non puoi votare» perché il database ha fatto un errore è un torto che nessuno rileva.
 *
 * ── LA SCRITTURA, SENZA `upsert` ─────────────────────────────────────────────
 *
 * Si legge il voto già dato (per l'istituto `section_id IS NULL`: il NULL non si confronta con `=`):
 *  · stessa scelta → nessuna scrittura, `cambiato: false`;
 *  · scelta diversa → `update` della sola scelta e dell'ora della modifica, filtrato per id e sede;
 *  · nessun voto → `insert`. Se due richieste dello stesso elettore arrivano insieme la seconda trova la riga
 *    dell'altra e il database risponde `23505` (UNIQUE NULLS NOT DISTINCT): si rilegge e si aggiorna.
 */

const CATALOGO_IT = it as Record<string, string>

const OPERAZIONE = 'parent/votazioni/[id]/voto:POST'

/** Le risposte di rifiuto: una funzione per codice, col `codice` scritto per esteso (lock `errori-con-codice`). */
const votazioneNonTrovata = () =>
  NextResponse.json({ error: CATALOGO_IT[CODICI_ERRORE.VOTAZIONE_NON_TROVATA], codice: 'VOTAZIONE_NON_TROVATA' }, { status: 404 })
const votazioneChiusa = () =>
  NextResponse.json({ error: CATALOGO_IT[CODICI_ERRORE.VOTAZIONE_CHIUSA], codice: 'VOTAZIONE_CHIUSA' }, { status: 409 })
const elettoreNonAmmesso = () =>
  NextResponse.json({ error: CATALOGO_IT[CODICI_ERRORE.VOTO_ELETTORE_NON_AMMESSO], codice: 'VOTO_ELETTORE_NON_AMMESSO' }, { status: 403 })
const candidatoNonValido = () =>
  NextResponse.json(
    { error: CATALOGO_IT[CODICI_ERRORE.VOTAZIONE_CANDIDATO_NON_VALIDO], codice: 'VOTAZIONE_CANDIDATO_NON_VALIDO' },
    { status: 400 },
  )

/**
 * Un guasto di una tabella che NON è delle votazioni (figli, genitori, nomi): sempre 500, anche se il suo codice
 * è fra quelli di «schema assente» (`42703` su `utenti` non vuol dire che il modulo manca).
 */
function guastoAltraLettura(errore: unknown): NextResponse {
  return rispostaErroreDbVotazioni(Object.assign(new Error('lettura-non-riuscita'), { cause: errore }), OPERAZIONE)
}

interface VotoEsistente {
  id: string
  candidato_id: string
}

interface ScuolaEVotazione {
  id: string
  scuola_id: string
}

/**
 * Il voto già dato dall'elettore in QUESTA scheda, o `null`. `section_id` è NULL per l'istituto: si filtra con
 * `IS NULL`, perché `= NULL` non trova mai niente.
 */
async function leggiVotoEsistente(
  supabase: SupabaseClient,
  votazione: ScuolaEVotazione,
  elettoreId: string,
  ambito: 'classe' | 'istituto',
  sectionId: string | null,
): Promise<{ voto: VotoEsistente | null; errore: { code?: string; message?: string } | null }> {
  const base = supabase
    .from('votazioni_voti')
    .select('id, candidato_id')
    .eq('votazione_id', votazione.id)
    .eq('scuola_id', votazione.scuola_id)
    .eq('ambito', ambito)
    .eq('elettore_id', elettoreId)
  const { data, error } = await (sectionId === null ? base.is('section_id', null) : base.eq('section_id', sectionId))
  if (error) return { voto: null, errore: error }
  const riga = ((data ?? []) as unknown as VotoEsistente[])[0]
  return { voto: riga ?? null, errore: null }
}

export const POST = withRoute(
  'parent/votazioni/[id]/voto:POST',
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    // L'elettore è la sessione, mai il body.
    const elettoreId = auth.user.id

    const { id } = await params
    const idParsed = parseData(zUuid, id)
    if ('response' in idParsed) return idParsed.response
    const body = await parseBody(request, votoSchema)
    if ('response' in body) return body.response
    const { ambito } = body.data
    const candidatoId = formaId(body.data.candidatoId)
    const sectionId = body.data.sectionId === null ? null : formaId(body.data.sectionId)

    const supabase = await createAdminClient()

    // 1. I figli ancora a scuola: da qui le sedi in cui questo elettore può votare. Senza figli non vota da
    //    nessuna parte (403), e una lettura caduta non è un «non puoi».
    const figli = await figliAttiviConClasse(supabase, elettoreId)
    if (!figli.completo) return guastoAltraLettura(figli.errore)
    const sedi = [...new Set(figli.valore.map((f) => formaId(f.scuolaId)))]
    if (sedi.length === 0) return elettoreNonAmmesso()

    // 2. La votazione, ma solo se è di una sede in cui ha figli: per le altre «non esiste».
    const { data: righeVotazione, error: erroreVotazione } = await supabase
      .from('votazioni')
      .select('id, scuola_id, scadenza, chiusa_il, rappresentante_istituto')
      .eq('id', formaId(idParsed.data))
      .in('scuola_id', sedi)
    if (erroreVotazione) return rispostaErroreDbVotazioni(erroreVotazione, OPERAZIONE)
    const votazione = ((righeVotazione ?? []) as unknown as {
      id: string
      scuola_id: string
      scadenza: string
      chiusa_il: string | null
      rappresentante_istituto: boolean
    }[])[0]
    if (!votazione) return votazioneNonTrovata()

    // 3. Aperta? La stessa funzione con cui il GET decide se mostrare la scheda.
    if (statoVotazione({ scadenza: votazione.scadenza, chiusaIl: votazione.chiusa_il }) !== 'aperta') {
      return votazioneChiusa()
    }

    const sede = formaId(votazione.scuola_id)

    // 4. La scheda esiste, l'elettore ha diritto di votarla, il candidato è valido.
    if (ambito === 'classe') {
      const classe = sectionId as string // votoSchema: la classe c'è se e solo se l'ambito è `classe`.

      const { data: righeClasse, error: erroreClasse } = await supabase
        .from('votazioni_classi')
        .select('section_id')
        .eq('votazione_id', votazione.id)
        .eq('scuola_id', votazione.scuola_id)
        .eq('section_id', classe)
      if (erroreClasse) return rispostaErroreDbVotazioni(erroreClasse, OPERAZIONE)
      if ((righeClasse ?? []).length === 0) return elettoreNonAmmesso()

      const ammissione = await leggiAmmissione(supabase, elettoreId, { figli: figli.valore, sedi: [sede], classi: [classe] })
      if (!ammessoInClasse(ammissione.valore, sede, classe)) {
        // Una fotografia a metà direbbe «non ammesso» a chi lo è: lì è un guasto, non un diniego.
        return ammissione.completo ? elettoreNonAmmesso() : guastoAltraLettura(ammissione.errore)
      }
      const eUnCandidato = candidatiDellaClasse(ammissione.valore, sede, classe).some((g) => formaId(g.utenteId) === candidatoId)
      if (!eUnCandidato) return ammissione.completo ? candidatoNonValido() : guastoAltraLettura(ammissione.errore)
    } else {
      if (!votazione.rappresentante_istituto) return elettoreNonAmmesso()

      const ammissione = await leggiAmmissione(supabase, elettoreId, { figli: figli.valore, sedi: [sede] })
      if (!ammessoAllIstituto(ammissione.valore, sede)) {
        return ammissione.completo ? elettoreNonAmmesso() : guastoAltraLettura(ammissione.errore)
      }

      // Il candidato deve essere fra quelli che la segreteria ha indicato PER QUESTA votazione (e quindi per
      // questa sede), e avere ancora un account attivo.
      const { data: righeCandidato, error: erroreCandidato } = await supabase
        .from('votazioni_candidati')
        .select('utente_id')
        .eq('votazione_id', votazione.id)
        .eq('scuola_id', votazione.scuola_id)
        .eq('utente_id', candidatoId)
      if (erroreCandidato) return rispostaErroreDbVotazioni(erroreCandidato, OPERAZIONE)
      if ((righeCandidato ?? []).length === 0) return candidatoNonValido()

      const attivo = await nomiGenitori(supabase, [candidatoId])
      if (!attivo.completo) return guastoAltraLettura(attivo.errore)
      if (!attivo.valore.some((g) => formaId(g.utenteId) === candidatoId)) return candidatoNonValido()
    }

    // 5. Il voto già dato, se c'è.
    const lettura = await leggiVotoEsistente(supabase, votazione, elettoreId, ambito, sectionId)
    if (lettura.errore) return rispostaErroreDbVotazioni(lettura.errore, OPERAZIONE)
    let esistente = lettura.voto

    // 6. Registrare, cambiare o confermare.
    if (!esistente) {
      const { error: erroreInsert } = await supabase.from('votazioni_voti').insert({
        votazione_id: votazione.id,
        scuola_id: votazione.scuola_id,
        ambito,
        section_id: sectionId,
        elettore_id: elettoreId,
        candidato_id: candidatoId,
      })
      if (!erroreInsert) {
        return risposta(votazione.id, ambito, 'registrato', candidatoId)
      }
      // Una UNIQUE violata è la corsa con un'altra richiesta dello stesso elettore: la sua riga c'è, la si rilegge.
      if (erroreInsert.code !== '23505') return rispostaErroreDbVotazioni(erroreInsert, OPERAZIONE)
      const riletto = await leggiVotoEsistente(supabase, votazione, elettoreId, ambito, sectionId)
      if (riletto.errore) return rispostaErroreDbVotazioni(riletto.errore, OPERAZIONE)
      if (!riletto.voto) {
        // La UNIQUE dice che la riga c'è e la lettura dice di no: non si inventa un esito.
        return rispostaErroreDbVotazioni(Object.assign(new Error('voto-in-conflitto-non-trovato'), { cause: erroreInsert }), OPERAZIONE)
      }
      esistente = riletto.voto
    }

    if (formaId(esistente.candidato_id) === candidatoId) {
      return risposta(votazione.id, ambito, 'confermato', candidatoId)
    }

    // Cambio: solo la scelta e l'ora della modifica. Elettore, scheda e sede restano quelli del primo voto.
    const { data: aggiornate, error: erroreUpdate } = await supabase
      .from('votazioni_voti')
      .update({ candidato_id: candidatoId, aggiornato_il: new Date().toISOString() })
      .eq('id', esistente.id)
      .eq('scuola_id', votazione.scuola_id)
      .select('id')
    if (erroreUpdate) return rispostaErroreDbVotazioni(erroreUpdate, OPERAZIONE)
    if ((aggiornate ?? []).length !== 1) {
      // Nessuna riga aggiornata: il voto non è cambiato, e dire 200 sarebbe mentire.
      return rispostaErroreDbVotazioni(new Error('voto-non-aggiornato'), OPERAZIONE)
    }
    return risposta(votazione.id, ambito, 'cambiato', candidatoId)
  },
)

/**
 * Il successo: UNA riga di log (senza nomi, senza una chiave che contenga «voto») e la risposta.
 * `cambiato` è vero solo se la scelta è diversa da quella di prima.
 */
function risposta(
  votazioneId: string,
  ambito: 'classe' | 'istituto',
  esito: 'registrato' | 'cambiato' | 'confermato',
  candidatoId: string,
): NextResponse {
  logEvento('votazioni', 'info', { operazione: 'scheda', esito, tipo: ambito, votazione_id: votazioneId })
  const corpo: VotoRisposta = { ok: true, sceltaAttuale: candidatoId, cambiato: esito === 'cambiato' }
  return NextResponse.json(corpo)
}
