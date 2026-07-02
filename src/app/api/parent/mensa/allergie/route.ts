import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import { loadResolveOptions, DEFAULT_SCUOLA } from '@/lib/mensa/server'
import { resolveMenuGiorno } from '@/lib/mensa/resolveMenu'
import { allergeniAlunno, conflittiAllergie, allergeneLabel } from '@/lib/mensa/allergeni'

const getQuerySchema = z.object({
  alunno_id: zUuid,
  date: zDataYMD.optional(), // default dinamico: oggi (calcolato nell'handler)
})

// GET /api/parent/mensa/allergie?alunno_id=&date= — icona pericolo allergeni
// lato genitore (DL-043): incrocia gli allergeni del figlio col menu del giorno.
// Riusa gli helper puri già usati dal job cuoca/segreteria.
export async function GET(request: Request) {
  const auth = await requireUser(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const alunnoId = q.data.alunno_id
  const date = q.data.date ?? new Date().toISOString().slice(0, 10)

  const supabase = await createAdminClient()
  const { data: al } = await supabase
    .from('alunni')
    .select('id, nome, scuola_id, allergies, allergeni')
    .eq('id', alunnoId)
    .maybeSingle()

  if (!al) return NextResponse.json({ conflitti: [], pericolo: false, allergeni: [] })

  const scuolaId = (al.scuola_id as string) ?? DEFAULT_SCUOLA
  const opts = await loadResolveOptions(supabase, scuolaId)
  const menu = resolveMenuGiorno(date, opts)

  const allergeni = allergeniAlunno({ allergeni: al.allergeni as string[] | null, allergies: al.allergies as string | null })
  const dettaglio =
    menu.attivo && !menu.chiuso && menu.allergeni ? conflittiAllergie(allergeni, menu.allergeni) : []
  const conflitti = dettaglio.map((c) => c.allergene)

  return NextResponse.json({
    conflitti,
    conflitti_label: dettaglio.map((c) => allergeneLabel(c.allergene)),
    dettaglio,
    pericolo: conflitti.length > 0,
    allergeni,
    menu_attivo: menu.attivo && !menu.chiuso,
  })
}
