import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireDocente } from '@/lib/auth/require-staff'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { externalFetch, type EsitoEsterno } from '@/lib/logging/external'
import { parseInstagramUrl, buildEmbedUrl, esitoHealthCheck } from '@/lib/news/instagram'

// =============================================================================
// POST /api/news/instagram/valida — valida un URL Instagram e ne verifica la
// raggiungibilità dell'embed. parseInstagramUrl → 400 se invalido (nessun fetch);
// altrimenti health-check via externalFetch('instagram', …) → esitoHealthCheck.
// =============================================================================

const bodySchema = z.object({ url: z.string() })

/** Corpo per l'health-check: su !ok c'è già in `corpo`; su ok lo si legge dalla Response. */
async function corpoDaFetch(r: EsitoEsterno): Promise<string> {
  if (r.corpo) return r.corpo
  const res = r.res as { text?: () => Promise<string> } | undefined
  if (res && typeof res.text === 'function') {
    try {
      return await res.text()
    } catch {
      return ''
    }
  }
  return ''
}

export const POST = withRoute('news/instagram/valida:POST', async (request: Request) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, bodySchema)
    if ('response' in b) return b.response

    const shortcode = parseInstagramUrl(b.data.url)
    if (!shortcode) {
      return NextResponse.json({ error: 'URL Instagram non valido' }, { status: 400 })
    }

    const embedUrl = buildEmbedUrl(shortcode)
    // 429/403 lato IG → 'indeterminato' (non è un guasto del post): externalFetch
    // declassa questi status a warn per non avvelenare il canale errori.
    const r = await externalFetch(
      'instagram',
      embedUrl,
      { method: 'GET' },
      { evento: 'news', campi: { operazione: 'instagram-valida' }, gravita: () => 'info' },
    )
    const corpo = await corpoDaFetch(r)
    const esito = esitoHealthCheck(corpo, r.stato)

    return NextResponse.json({
      valido: true,
      shortcode,
      embed_url: embedUrl,
      raggiungibile: r.ok,
      esito,
    })
  } catch (err) {
    logErrore({ operazione: 'news/instagram/valida:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
