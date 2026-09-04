import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { destinazioniDiTrasferimento } from '@/lib/sedi/trasferimento'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/admin/sedi/destinazioni — verso QUALI sedi si può spostare qualcuno.
//
// ─── NON È `GET /api/admin/sedi`, ed è la ragione per cui esiste ─────────────
//
// `admin/sedi` risponde «le sedi in cui LAVORI»: è la fonte del `SedeSelector`,
// e per la Direzione coincide con `utenti_scuole`. Qui la domanda è un'altra —
// «dove posso PORTARE questo bambino» — e per la Direzione la risposta è più
// larga delle proprie sedi: il trasferimento fra plessi è esattamente il caso
// in cui la destinazione NON è ancora fra le tue. Chiamare `admin/sedi` per
// riempire il selettore del trasferimento darebbe a un direttore due sedi su
// tre, senza nessun errore da nessuna parte.
//
// La regola vera sta in `src/lib/sedi/trasferimento.ts`, con le sue ragioni:
// Direzione → tutte le sedi reali, Segreteria → solo le proprie, chiunque altro
// → nessuna. Qui si espone, non si decide.
//
// ─── TRE ESITI, E IL TERZO NON DEVE SOMIGLIARE AL SECONDO ───────────────────
//
//   · 200 `{ data: [...], motivo: 'ok' }`
//   · 200 `{ data: [],    motivo: 'nessuna-destinazione' }` — il ruolo o il
//     perimetro non ne danno nessuna. È una risposta, non un guasto.
//   · 500 `{ codice: 'LETTURA_FALLITA' }` — l'elenco delle sedi non si è potuto
//     leggere. **Senza questo terzo caso il client scriverebbe «non ci sono
//     sedi disponibili» davanti a un permesso negato dal database**: una bugia
//     con l'aria di un fatto, e il motivo per cui `destinazioniDiTrasferimento`
//     restituisce `error` accanto a `sedi` invece di un array e basta.
//
// `motivo` non è ridondante rispetto a `data.length`: è ciò che permette al
// client di scrivere la frase giusta senza dedurla da un array vuoto, che è
// precisamente la deduzione che qui si vuole rendere impossibile.
// ═════════════════════════════════════════════════════════════════════════════

/** ⚠️ Il nome della route compare sia qui sia dentro `withRoute`, e non è una svista:
 *  `logging-coverage` verifica quell'argomento come LETTERALE — una costante può
 *  essere giusta a vedersi e riferirsi a un'altra route, e una colonna `operazione`
 *  che mente è peggio di una che manca. Questa costante serve alle DUE chiamate del
 *  corpo (`destinazioniDiTrasferimento` e il log del rifiuto), che devono portare lo
 *  stesso nome del wrapper o la query «quale route ha fallito» si spezza in silenzio. */
const OPERAZIONE = 'admin/sedi/destinazioni:GET'

// Nessun parametro in ingresso: le destinazioni dipendono da CHI chiede, mai da
// ciò che chiede. Uno schema vuoto e non «niente schema» — il lock `zod-coverage`
// pretende che ogni route del gruppo `admin` validi il proprio ingresso, e un
// giorno in cui questa route accettasse un filtro lo farebbe passando da qui.
const getQuerySchema = z.object({})

export const GET = withRoute('admin/sedi/destinazioni:GET', async (request: NextRequest) => {
  // `requireStaff` di default ammette Direzione e Segreteria: gli stessi che
  // possono spostare. Il ruolo che DECIDE le destinazioni lo ricava comunque
  // `destinazioniDiTrasferimento` dai ruoli reali, non dalla veste indossata.
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const { sedi, error } = await destinazioniDiTrasferimento(supabase, auth.user, OPERAZIONE)

  if (error) {
    // `sediReali` ha già registrato il `{ error }` di PostgREST; questa riga dice
    // l'altra metà, che lì non si sa: la richiesta è stata RIFIUTATA, e a chi.
    logEvento('multi_sede', 'error', {
      operazione: OPERAZIONE,
      esito: 'destinazioni-non-lette',
      utente: auth.user.id,
      error_code: error.code,
    })
    return NextResponse.json(
      {
        error: 'Non è stato possibile leggere le sedi di destinazione. Riprova fra poco.',
        codice: 'LETTURA_FALLITA',
      },
      { status: 500 },
    )
  }

  // Il successo NON si logga qui: lo fa già `destinazioniDiTrasferimento`
  // (`destinazioni-risolte`, con il ruolo che ha deciso e il conteggio). Una
  // seconda riga per lo stesso fatto raddoppierebbe il conteggio di «chi ha
  // risolto delle destinazioni», che è un segnale di sicurezza da contare.
  return NextResponse.json({
    success: true,
    data: sedi,
    motivo: sedi.length > 0 ? 'ok' : 'nessuna-destinazione',
  })
})
