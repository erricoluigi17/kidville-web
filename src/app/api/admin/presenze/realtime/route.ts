import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { aggregaPresenze, TOTALE_VUOTO, type AlunnoRow, type PresenzaRow } from '@/lib/presenze/aggregate'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { descriviTetto, leggiABlocchi, type EsitoABlocchi } from '@/lib/db/leggi-a-blocchi'

/**
 * GET /api/admin/presenze/realtime — aggregato presenze di OGGI per il
 * monitoraggio multi-sede del cockpit (M7.4). Riservato allo staff e scoped
 * ai plessi di scuoleDiUtente(): iscritti per scuola/classe, presenze
 * raggruppate, appelli_mancanti = classi con 0 righe. Il client fa poll 60s
 * (niente canali realtime). L'aggregazione è nella funzione pura
 * aggregaPresenze (src/lib/presenze/aggregate.ts).
 */

const getQuerySchema = z.object({}) // nessun parametro in ingresso

/**
 * L'esito di `leggiABlocchi` nella forma `{ data, error }` che il ciclo di log della route già
 * conosce. Il tetto diventa un errore che lo dice (`descriviTetto`): il cruscotto degrada come per
 * un guasto, e la riga `cockpit-lettura-parziale` porta i conteggi invece di un numero sbagliato.
 */
function comeRisposta<T>(esito: EsitoABlocchi<T>, tipo: string): { data: T[] | null; error: unknown } {
  if (esito.ok) return { data: esito.righe, error: null }
  if (esito.motivo === 'tetto') return { data: null, error: new Error(descriviTetto(tipo, esito)) }
  return { data: null, error: esito.error }
}

export const GET = withRoute('admin/presenze/realtime:GET', async (request: Request) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const plessi = await scuoleDiUtente(supabase, auth.user)
  if (plessi.length === 0) {
    return NextResponse.json({ success: true, data: { totale: TOTALE_VUOTO, sedi: [] } })
  }

  // «OGGI» È QUELLO ITALIANO, non quello del processo (rilievo T27).
  //
  // `new Date().toISOString()` è UTC, e il runtime gira in UTC: fra le 00:00 e le
  // 02:00 italiane (ora legale) restituisce ancora la data di IERI. Misurato alle
  // 01:05: con due alunni segnati assenti per il giorno corrente il cruscotto
  // rispondeva «assenti: 0» e «appelli_mancanti: 2» — un 200 formalmente valido
  // che dice «nessuno è assente» invece di «sto guardando ieri». Ed è la
  // superficie su cui un'assenza comunicata dal genitore per «oggi» dovrebbe
  // comparire per prima, visto che il modulo del genitore la data la preseleziona
  // proprio con `oggiFiscaleISO()`.
  const today = oggiFiscaleISO()

  // ── A BLOCCHI (robustezza 2, sessione 11) ───────────────────────────────────
  // Con «Tutte le sedi» gli iscritti e le presenze di un giorno si avvicinano a 1000: oltre,
  // PostgREST consegnava le prime 1000 righe in silenzio, e il cruscotto contava meno presenti e
  // più «appelli mancanti» del vero. `.limit(5000)` non serviva a niente: `max_rows` vince su
  // qualunque `limit`. Sezioni e sedi dei plessi restano letture semplici (decine di righe).
  const [alunniLetti, presenzeLette, sectionsRes, schoolsRes] = await Promise.all([
    leggiABlocchi<AlunnoRow>(() =>
      supabase
        .from('alunni')
        .select('id, section_id, scuola_id')
        .in('scuola_id', plessi)
        .eq('stato', 'iscritto'),
    ),
    // Scope in query via join sull'alunno; l'aggregazione ignora comunque
    // le righe di alunni fuori elenco (doppia cintura).
    leggiABlocchi<PresenzaRow>(() =>
      supabase
        .from('presenze')
        .select('alunno_id, stato, alunni!inner ( scuola_id )')
        .eq('data', today)
        .in('alunni.scuola_id', plessi),
    ),
    supabase.from('sections').select('id, name, scuola_id').in('scuola_id', plessi),
    supabase.from('schools').select('id, nome').in('id', plessi),
  ])
  const alunniRes = comeRisposta(alunniLetti, 'presenze-realtime-alunni')
  const presenzeRes = comeRisposta(presenzeLette, 'presenze-realtime-presenze')

  // PostgREST non lancia: un guasto qui usciva come «zero iscritti, zero
  // presenti, tutti gli appelli mancanti» dentro un 200 — cioè il cruscotto del
  // monitoraggio che dichiara un'emergenza (o la sua assenza) leggendo il nulla.
  // Il degrado resta — meglio un cruscotto parziale che nessun cruscotto — ma si
  // conta.
  for (const [nome, res] of [
    ['alunni', alunniRes], ['presenze', presenzeRes], ['sezioni', sectionsRes], ['sedi', schoolsRes],
  ] as const) {
    if (res.error) {
      logEvento('registro', 'error', {
        operazione: 'admin/presenze/realtime:GET',
        esito: 'cockpit-lettura-parziale',
        entita_tipo: nome,
      }, res.error)
    }
  }

  const data = aggregaPresenze(
    alunniRes.data ?? [],
    presenzeRes.data ?? [],
    sectionsRes.data ?? [],
    schoolsRes.data ?? []
  )

  return NextResponse.json({ success: true, data })
})
