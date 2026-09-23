import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { formaConfronto, scuoleDiUtente } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { codaAssente, senzaDoppioni, svegliaCoda, zCorpoAzioni, type RispostaAzioni } from '@/lib/fatture-coda/api'

/**
 * ─── «TOGLI» E «RIMETTI IN CODA» ────────────────────────────────────────────────────
 *
 * `togli`: `in_coda`/`errore` → `tolta` (RPC `fatture_coda_togli`).
 * `rimetti`: `errore` → `in_coda`, IN FONDO (RPC `fatture_coda_rimetti`), poi la sveglia.
 *
 * Le RPC filtrano lo stato da sole: una voce già emessa o in invio non si tocca, e il
 * numero restituito dice quante sono cambiate davvero.
 *
 * ─── SCOPE PER VOCE ─────────────────────────────────────────────────────────────────
 * La coda si LEGGE da tutte le sedi (decisione 6), ma si SCRIVE solo sulle proprie. Le voci
 * si rileggono per id, e basta UNA voce di un'altra sede perché l'intera richiesta sia
 * rifiutata. Gli id che non esistono non si passano alla RPC: non c'è niente da cambiare, e
 * nessuna sede da verificare.
 */

const CODICE_NON_DISPONIBILE = 'CODA_FATTURE_NON_DISPONIBILE'
const CODICE_SCRITTURA_FALLITA = 'CODA_FATTURE_SCRITTURA_FALLITA'
const CODICE_LETTURA_FALLITA = 'LETTURA_FALLITA'

const ID_PER_LETTURA = 100

export const POST = withRoute('pagamenti/fattura/coda/azioni:POST', async (request: Request) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const b = await parseBody(request, zCorpoAzioni)
  if ('response' in b) return b.response
  const { azione } = b.data
  const ids = senzaDoppioni(b.data.ids, (id) => id)
  const operazione = `coda-azioni:${azione}`

  const sb = await createAdminClient()

  // ─── Le voci, rilette per id ───────────────────────────────────────────────────
  const trovate: { id: string; scuola_id: string | null }[] = []
  for (let i = 0; i < ids.length; i += ID_PER_LETTURA) {
    const { data, error } = await sb
      .from('fatture_coda')
      .select('id, scuola_id')
      .in('id', ids.slice(i, i + ID_PER_LETTURA))
    if (error) {
      if (codaAssente(error)) {
        logEvento('fattura', 'warn', { operazione, esito: 'coda-assente' }, error)
        return NextResponse.json(
          {
            error: 'La coda delle fatture non è ancora disponibile: nessuna voce è stata modificata.',
            codice: CODICE_NON_DISPONIBILE,
            disponibile: false,
          },
          { status: 503 },
        )
      }
      logEvento('fattura', 'error', { operazione, esito: 'voci-non-lette' }, error)
      return NextResponse.json(
        { error: 'Impossibile leggere le voci della coda: nessuna voce è stata modificata.', codice: CODICE_LETTURA_FALLITA },
        { status: 500 },
      )
    }
    trovate.push(...((data ?? []) as { id: string; scuola_id: string | null }[]))
  }

  // ─── Scope di sede, voce per voce ──────────────────────────────────────────────
  const plessi = new Set((await scuoleDiUtente(sb, auth.user)).map(formaConfronto))
  const fuori = trovate.filter((v) => !v.scuola_id || !plessi.has(formaConfronto(v.scuola_id)))
  if (fuori.length > 0) {
    logEvento('auth', 'warn', {
      tipo: 'coda-fatture-fuori-sede',
      azione: operazione,
      utente: auth.user.id,
      ruolo: auth.user.role,
      n: fuori.length,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }

  if (trovate.length === 0) {
    logEvento('fattura', 'info', { operazione, esito: 'nessuna-voce-trovata', n: ids.length })
    const corpo: RispostaAzioni = { aggiornate: 0 }
    return NextResponse.json(corpo)
  }

  // ─── La scrittura ──────────────────────────────────────────────────────────────
  const { data, error } = await sb.rpc(azione === 'togli' ? 'fatture_coda_togli' : 'fatture_coda_rimetti', {
    p_ids: trovate.map((v) => v.id),
    p_attore: auth.user.id,
  })
  if (error) {
    if (codaAssente(error)) {
      logEvento('fattura', 'warn', { operazione, esito: 'coda-assente' }, error)
      return NextResponse.json(
        {
          error: 'La coda delle fatture non è ancora disponibile: nessuna voce è stata modificata.',
          codice: CODICE_NON_DISPONIBILE,
          disponibile: false,
        },
        { status: 503 },
      )
    }
    logEvento('fattura', 'error', { operazione, esito: 'azione-fallita', n: trovate.length }, error)
    return NextResponse.json(
      { error: 'Non è stato possibile aggiornare la coda: riprova fra poco.', codice: CODICE_SCRITTURA_FALLITA },
      { status: 500 },
    )
  }

  const aggiornate = typeof data === 'number' && Number.isFinite(data) ? data : Number(data) || 0
  logEvento('fattura', 'info', { operazione, esito: 'azione-eseguita', n: aggiornate, richieste: trovate.length })

  if (azione === 'rimetti' && aggiornate > 0) svegliaCoda(sb, operazione)

  const corpo: RispostaAzioni = { aggiornate }
  return NextResponse.json(corpo)
})
