import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { sediReali } from '@/lib/scuole/reali'
import { intestazioniCachePubblica } from '@/lib/security/cache-pubblica'
import { rispostaGuastoGiaRegistrato } from '@/lib/db/guasto'
import { anniOffertiPubblici } from '@/lib/anno/pubblico'
import { schemaAnnoIndietro } from '@/lib/anno/schema'

/** Un minuto in CDN, come l'elenco degli anni: se la segreteria cambia la quota, il modulo se ne accorge presto. */
const CACHE_SECONDI = 60
const CACHE_STANTIO = 60

const getQuerySchema = z.object({ scuola_id: zUuid, anno_id: zUuid })

const OPERAZIONE = 'iscrizione/info-anno:GET'

/**
 * GET /api/iscrizione/info-anno?scuola_id=&anno_id= — ciò che il modulo pubblico `/iscrizione` dice alla famiglia
 * dell'anno per cui si iscrive: la QUOTA di nuova iscrizione (listino, voce `quota_nuova`) e l'elenco dei DOCUMENTI
 * da consegnare (moduli richiesti, lista `nuova`).
 *
 * È ANONIMA (il prefisso `/api/iscrizione` è nell'allowlist), quindi:
 *  - legge e restituisce SOLO configurazione pubblica: importi e titoli dei moduli, mai una riga di bambini o famiglie;
 *  - SCELTA DICHIARATA (rilievo 2 della revisione): la sede deve essere fra quelle del deployment (`tutte` di `sediReali`, la Demo inclusa: come `anni` e come il
 *    POST, si raggiunge col link della sede) e l'anno deve essere fra quelli con le domande aperte per quella sede;
 *    Come `/anni` e il POST usa `tutte` senza il filtro `attiva`: anche una sede disattivata risponde (stessi dati pubblici);
 *  - sta dietro un rate-limit anti-abuso per IP + sede (120 ogni 10 minuti).
 *
 * Una quota assente, nulla o non positiva NON compare: nessun importo si inventa. `quote` è un elenco perché la
 * quota può essere per fascia (`fascia: null` = per tutte). Database non migrato (E2E della CI): 200 con elenchi
 * vuoti, senza cache. Nei log passano solo conteggi: né titoli né importi.
 */
export const GET = withRoute('iscrizione/info-anno:GET', async (request: NextRequest) => {
  const troppe = (retryAfterMs: number) =>
    NextResponse.json(
      { error: 'Troppe richieste. Riprova tra qualche minuto.', codice: 'TROPPE_RICHIESTE' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
    )
  // Tetto largo per solo IP, prima di ogni lettura: senza, un uuid di sede diverso a ogni richiesta aggirerebbe quello per sede.
  const rlIp = await rateLimit(`iscrizione-info-anno:${clientIp(request)}`, { limit: 600, windowMs: 10 * 60 * 1000 })
  if (!rlIp.ok) return troppe(rlIp.retryAfterMs)

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { scuola_id: scuolaId, anno_id: annoId } = q.data

  // Per IP + sede e largo: più famiglie dietro lo stesso NAT (open day, wifi della sede) non devono restare senza quota.
  const rl = await rateLimit(`iscrizione-info-anno:${clientIp(request)}:${scuolaId}`, { limit: 120, windowMs: 10 * 60 * 1000 })
  if (!rl.ok) return troppe(rl.retryAfterMs)

  const supabase = await createAdminClient()
  const { tutte, error } = await sediReali(supabase, OPERAZIONE)
  if (error) return rispostaGuastoGiaRegistrato()
  if (!tutte.some((s) => s.id === scuolaId)) {
    return NextResponse.json(
      { error: 'Specificare la sede a cui si riferisce questa operazione', codice: 'SEDE_DA_SPECIFICARE' },
      { status: 400 },
    )
  }

  const vuota = () => NextResponse.json({ success: true, data: { quote: [], moduli: [] } })

  const offerti = await anniOffertiPubblici(supabase, scuolaId)
  if ('guasto' in offerti) return rispostaGuastoGiaRegistrato()
  if ('indietro' in offerti) return vuota()
  if (!offerti.anni.some((a) => a.anno_id === annoId)) {
    return NextResponse.json(
      { error: 'Questo anno non accetta domande per la sede indicata', codice: 'ANNO_NON_OFFERTO' },
      { status: 422 },
    )
  }

  const guasto = (esito: string, err: unknown) => {
    logEvento('anno-scolastico', 'error', { tipo: 'anno-lettura-fallita', azione: OPERAZIONE, esito }, err)
    return rispostaGuastoGiaRegistrato()
  }

  const annoSede = await supabase.from('anni_sede').select('id').eq('scuola_id', scuolaId).eq('anno_id', annoId).maybeSingle()
  if (annoSede.error) return schemaAnnoIndietro(annoSede.error) ? vuota() : guasto('anni-sede', annoSede.error)
  const annoSedeId = (annoSede.data as { id?: string } | null)?.id
  if (!annoSedeId) return vuota()

  const listino = await supabase.from('listino_voci').select('fascia, importo').eq('anno_sede_id', annoSedeId).eq('voce', 'quota_nuova')
  if (listino.error) return schemaAnnoIndietro(listino.error) ? vuota() : guasto('listino', listino.error)
  const moduli = await supabase
    .from('moduli_richiesti')
    .select('codice, titolo, ordine')
    .eq('anno_sede_id', annoSedeId)
    .eq('lista', 'nuova')
    .order('ordine', { ascending: true })
    .order('codice', { ascending: true })
  if (moduli.error) return schemaAnnoIndietro(moduli.error) ? vuota() : guasto('moduli-richiesti', moduli.error)

  const quote = ((Array.isArray(listino.data) ? listino.data : []) as { fascia: string | null; importo: number | string | null }[])
    .map((r) => ({ fascia: r.fascia ?? null, importo: Number(r.importo) }))
    .filter((r) => r.importo !== null && Number.isFinite(r.importo) && r.importo > 0)
    .sort((a, b) => (a.fascia ?? '').localeCompare(b.fascia ?? ''))
  const documenti = ((Array.isArray(moduli.data) ? moduli.data : []) as { codice: string; titolo: string }[]).map((m) => ({
    codice: m.codice,
    titolo: m.titolo,
  }))

  return NextResponse.json(
    { success: true, data: { quote, moduli: documenti } },
    { headers: intestazioniCachePubblica(request, CACHE_SECONDI, CACHE_STANTIO) },
  )
})
