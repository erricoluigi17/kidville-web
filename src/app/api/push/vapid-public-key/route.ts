import { NextResponse } from 'next/server'

// GET /api/push/vapid-public-key — chiave pubblica VAPID per il client
export async function GET() {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  if (!key) return NextResponse.json({ error: 'configurazione mancante: VAPID' }, { status: 503 })
  return NextResponse.json({ success: true, data: { publicKey: key } })
}
