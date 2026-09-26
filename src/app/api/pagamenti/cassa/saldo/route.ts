import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { RUOLI_DIREZIONE } from '@/lib/auth/predicati-ruolo'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { getModuleConfig } from '@/lib/settings/module-config'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { caricaSaldoCassa } from '@/lib/cassa/saldo'
import { verificaSogliaCassa } from '@/lib/cassa/notifiche'
import { sediLetturaCassa, nomiSediCassa } from '@/lib/cassa/lettura-multisede'
import type { SaldoCassa, CassaNonDisponibile, EntratoOggiVoce } from '@/lib/cassa/tipi'

const getQuerySchema = z.object({
  scuola_id: z.preprocess((v) => v || undefined, zUuid.optional()),
})

const round2 = (n: number) => Math.round(n * 100) / 100

type SaldoDiSede = { scuola_id: string; scuola_nome: string | null } & (SaldoCassa | CassaNonDisponibile)

// GET /api/pagamenti/cassa/saldo?scuola_id=  — SOLO DIREZIONE (KPI economico).
// «Saldo atteso in cassa» = quanto contante deve esserci nel cassetto + «entrato oggi»
// per metodo. Il fondo viene da cassa_config; caricaSaldoCassa degrada da solo a
// { disponibile:false } sul DB E2E CI non migrato (mai 500).
//
// Dal 2026-09-26 (K3) la lettura è UNITA: senza scuola_id si calcolano tutte le
// sedi attive, OGNUNA COL SUO FONDO (ogni sede ha il suo cassetto), e in cima si
// restituisce la somma; `per_sede` porta il dettaglio. Con scuola_id la forma di
// sempre + `per_sede` di lunghezza 1. Sede non propria → 403.
// Contratto: docs/superpowers/specs/2026-09-26-orario-appello-contabilita-cf/contratti/K3.md.
export const GET = withRoute('pagamenti/cassa/saldo:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, RUOLI_DIREZIONE)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const scope = await sediLetturaCassa(request, supabase, auth.user, q.data.scuola_id, 'pagamenti/cassa/saldo:GET')
    if (scope.response) return scope.response
    const sedi = scope.sedi

    const nomi = await nomiSediCassa(supabase, sedi, 'pagamenti/cassa/saldo:GET')

    // Un cassetto per sede: fondo, saldo e soglia sono della SEDE, mai sommati prima.
    const per_sede: SaldoDiSede[] = await Promise.all(
      sedi.map(async (scuolaId) => {
        // Type-literal inline (non `CassaConfig`): un'interface non soddisfa il vincolo
        // `Record<string,unknown>` di getModuleConfig; qui serve solo il fondo.
        const config = await getModuleConfig<{ fondo?: number }>(supabase, 'cassa_config', scuolaId)
        const fondo = config.fondo ?? 0
        // caricaSaldoCassa popola già `entrato_oggi` (stessa passata sugli incassi).
        const saldo = await caricaSaldoCassa(supabase, scuolaId, fondo)
        // Best-effort a valle (transizione sotto→sopra soglia): non blocca la risposta.
        await verificaSogliaCassa(supabase, scuolaId)
        return { scuola_id: scuolaId, scuola_nome: nomi.get(scuolaId) ?? null, ...saldo }
      }),
    )

    // Una somma che salta un cassetto è un numero sbagliato, non un numero parziale:
    // se anche una sola sede non è disponibile, il totale non si dà (il dettaglio sì).
    const nonDisponibili = per_sede.filter((s) => !s.disponibile).length
    if (nonDisponibili > 0) {
      logEvento('cassa', 'info', { operazione: 'pagamenti/cassa/saldo:GET', esito: 'saldo-non-disponibile', quantita: nonDisponibili, sedi: sedi.length })
      return NextResponse.json({ disponibile: false, per_sede })
    }

    const disponibili = per_sede as ({ scuola_id: string; scuola_nome: string | null } & SaldoCassa)[]
    const somma = (k: 'fondo' | 'saldo_atteso' | 'entrate_contanti' | 'uscite_contanti' | 'prelievi' | 'rettifiche') =>
      round2(disponibili.reduce((t, s) => t + s[k], 0))
    const perMetodo = new Map<string, number>()
    for (const s of disponibili) {
      for (const v of s.entrato_oggi) perMetodo.set(v.metodo, round2((perMetodo.get(v.metodo) ?? 0) + v.totale))
    }
    const entrato_oggi: EntratoOggiVoce[] = [...perMetodo.entries()].map(([metodo, totale]) => ({ metodo, totale }))

    return NextResponse.json({
      disponibile: true,
      fondo: somma('fondo'),
      saldo_atteso: somma('saldo_atteso'),
      entrate_contanti: somma('entrate_contanti'),
      uscite_contanti: somma('uscite_contanti'),
      prelievi: somma('prelievi'),
      rettifiche: somma('rettifiche'),
      entrato_oggi,
      per_sede,
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/saldo:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
