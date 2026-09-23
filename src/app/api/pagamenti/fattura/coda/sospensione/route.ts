import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { codaAssente, svegliaCoda, zCorpoSospensione, type RispostaSospensione } from '@/lib/fatture-coda/api'

/**
 * ─── «SOSPENDI CODA» / «RIPRENDI» — SOLO ADMIN ──────────────────────────────────────
 *
 * La sospensione ferma il lavoratore per TUTTE le sedi (l'utenza Aruba è una sola): per
 * questo la decide solo la Direzione (`admin`), e non la segreteria di un plesso. Alla
 * ripresa parte subito un giro, senza aspettare il cron.
 *
 * Nessuno scope di sede qui: non si tocca nessuna voce, solo la riga unica di stato.
 */

const CODICE_NON_DISPONIBILE = 'CODA_FATTURE_NON_DISPONIBILE'
const CODICE_SCRITTURA_FALLITA = 'CODA_FATTURE_SCRITTURA_FALLITA'

export const POST = withRoute('pagamenti/fattura/coda/sospensione:POST', async (request: Request) => {
  const auth = await requireStaff(request, ['admin'])
  if (auth.response) return auth.response

  const b = await parseBody(request, zCorpoSospensione)
  if ('response' in b) return b.response
  const { sospesa } = b.data
  const operazione = sospesa ? 'coda-sospensione:sospendi' : 'coda-sospensione:riprendi'

  const sb = await createAdminClient()
  const { error } = await sb.rpc('fatture_coda_sospendi', { p_attore: auth.user.id, p_sospesa: sospesa })
  if (error) {
    if (codaAssente(error)) {
      logEvento('fattura', 'warn', { operazione, esito: 'coda-assente' }, error)
      return NextResponse.json(
        {
          error: 'La coda delle fatture non è ancora disponibile: lo stato non è stato cambiato.',
          codice: CODICE_NON_DISPONIBILE,
          disponibile: false,
        },
        { status: 503 },
      )
    }
    logEvento('fattura', 'error', { operazione, esito: 'sospensione-fallita' }, error)
    return NextResponse.json(
      { error: 'Non è stato possibile cambiare lo stato della coda: riprova fra poco.', codice: CODICE_SCRITTURA_FALLITA },
      { status: 500 },
    )
  }

  // Evento raro e di peso (ferma le fatture di tre sedi): a `warn` quando si sospende, così
  // una coda ferma da giorni ha la sua riga di partenza.
  logEvento('fattura', sospesa ? 'warn' : 'info', {
    operazione,
    esito: sospesa ? 'coda-sospesa' : 'coda-ripresa',
    utente: auth.user.id,
  })

  if (!sospesa) svegliaCoda(sb, operazione)

  const corpo: RispostaSospensione = { sospesa }
  return NextResponse.json(corpo)
})
