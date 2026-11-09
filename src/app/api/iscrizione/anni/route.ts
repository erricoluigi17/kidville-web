import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { sediReali } from '@/lib/scuole/reali'
import { intestazioniCachePubblica } from '@/lib/security/cache-pubblica'
import { rispostaGuastoGiaRegistrato } from '@/lib/db/guasto'
import { anniOffertiPubblici } from '@/lib/anno/pubblico'

/**
 * Un minuto in CDN, più corto delle sedi (dieci): quando la segreteria apre le iscrizioni dell'anno
 * prossimo, o le sospende, il modulo deve accorgersene presto. Solo sulla risposta buona.
 */
const CACHE_SECONDI = 60
const CACHE_STANTIO = 60

const getQuerySchema = z.object({ scuola_id: zUuid })

/**
 * GET /api/iscrizione/anni?scuola_id= — gli anni scolastici che accettano domande, per il passo «anno»
 * del wizard `/iscrizione`.
 *
 * È ANONIMA (il prefisso `/api/iscrizione` è nell'allowlist di `middleware-rules`), quindi:
 *  - espone SOLO `anno_id`, `etichetta_breve` e `ingresso` (`durante` = il bambino entra subito, `inizio` =
 *    entra a inizio anno): nessuna data della sede, nessuno stato, nessun uuid di sede;
 *  - la sede deve essere fra quelle del deployment (`tutte` di `sediReali`, E2E incluse: il POST accetta lo
 *    stesso predicato e il link targato dell'E2E entra da lì). Una sede sconosciuta è 400 `SEDE_DA_SPECIFICARE`, e non dice nulla degli anni;
 *  - sta dietro un rate-limit anti-abuso come `sedi`.
 *
 * `scelta` è vero solo con almeno due anni: con uno il wizard non fa una domanda in più. `chiuso` è vero
 * quando lo schema c'è e nessun anno accetta domande.
 *
 * Database non migrato (E2E della CI): risponde 200 con `anni: []`, `scelta: false` e `chiuso: false` — il
 * modulo si comporta come oggi — e senza cache, perché è la fotografia di un database in ritardo. Un guasto vero è 500 (il log
 * lo ha già scritto `guastoAnno`): il wizard lo tratta come «nessuna scelta» e lo dice nel suo log.
 */
export const GET = withRoute('iscrizione/anni:GET', async (request: NextRequest) => {
  const rl = await rateLimit(`iscrizione-anni:${clientIp(request)}`, { limit: 30, windowMs: 10 * 60 * 1000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppe richieste. Riprova tra qualche minuto.', codice: 'TROPPE_RICHIESTE' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    )
  }

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const { tutte, error } = await sediReali(supabase, 'iscrizione/anni:GET')
  if (error) return rispostaGuastoGiaRegistrato()
  if (!tutte.some((s) => s.id === q.data.scuola_id)) {
    // Lo stesso rifiuto del POST per una sede che non c'è: la sede va indicata (di nuovo). Non dice nulla degli anni.
    return NextResponse.json(
      { error: 'Specificare la sede a cui si riferisce questa operazione', codice: 'SEDE_DA_SPECIFICARE' },
      { status: 400 },
    )
  }

  const esito = await anniOffertiPubblici(supabase, q.data.scuola_id)
  if ('guasto' in esito) return rispostaGuastoGiaRegistrato()
  if ('indietro' in esito) {
    return NextResponse.json({ success: true, data: { anni: [], scelta: false, chiuso: false } })
  }
  // `chiuso`: lo schema c'è e nessun anno accetta domande. È l'unico modo per il wizard di distinguerlo da
  // «database in ritardo» (anni vuoti, non chiuso) e dirlo PRIMA di far compilare quattro passi.
  return NextResponse.json(
    { success: true, data: { anni: esito.anni, scelta: esito.scelta, chiuso: esito.chiuso } },
    { headers: intestazioniCachePubblica(request, CACHE_SECONDI, CACHE_STANTIO) },
  )
})
