import { NextResponse } from 'next/server'

// GET /api/push/vapid-public-key — chiave pubblica VAPID per il client
export async function GET() {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  if (!key) return NextResponse.json({ error: 'VAPID non configurato' }, { status: 500 })
  return NextResponse.json({ success: true, data: { publicKey: key } })
}
