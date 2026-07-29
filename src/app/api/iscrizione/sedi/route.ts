import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { sediReali } from '@/lib/scuole/reali'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso

/**
 * GET /api/iscrizione/sedi — elenco PUBBLICO delle sedi per il selettore del
 * wizard `/iscrizione`.
 *
 * Esiste perché da tre sedi in su un link unico non basta più: senza questo
 * elenco il POST non saprebbe dove iscrivere il bambino e risponderebbe 400 a
 * ogni genitore. Il link resta uno solo per tutti i plessi; la sede la sceglie
 * il genitore al primo passo.
 *
 * È ANONIMA (il prefisso `/api/iscrizione` è nell'allowlist di `middleware-rules`),
 * quindi:
 *  - espone SOLO id e nome: nessun indirizzo, nessuna configurazione, nessun dato
 *    di contatto — è un elenco di plessi, non un'anagrafica;
 *  - sta dietro un rate-limit anti-abuso (è comunque una lettura, quindi il tetto
 *    è più alto di quello del POST d'iscrizione).
 */
export const GET = withRoute('iscrizione/sedi:GET', async (request: NextRequest) => {
  const rl = rateLimit(`iscrizione-sedi:${clientIp(request)}`, { limit: 30, windowMs: 10 * 60 * 1000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppe richieste. Riprova tra qualche minuto.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    )
  }

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  // `sediReali` legge, filtra le sedi di test, scarta le disattivate (fail-open) e
  // logga già l'eventuale guasto: qui resta solo la scelta dello status.
  const { reali, error } = await sediReali(supabase, 'iscrizione/sedi:GET')
  if (error) {
    // 500 e non un elenco vuoto: un elenco vuoto direbbe al wizard "una sola sede,
    // vai avanti così" — e l'iscrizione finirebbe nel posto sbagliato o in un 400 muto.
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: reali.map((s) => ({ id: s.id, nome: s.nome })),
  })
})
