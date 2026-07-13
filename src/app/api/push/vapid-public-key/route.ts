import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'

const getQuerySchema = z.object({}) // nessun parametro in ingresso

// GET /api/push/vapid-public-key — chiave pubblica VAPID per il client
export const GET = withRoute('push/vapid-public-key:GET', async (request: Request) => {
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  if (!key) return NextResponse.json({ error: 'configurazione mancante: VAPID' }, { status: 503 })
  return NextResponse.json({ success: true, data: { publicKey: key } })
})
