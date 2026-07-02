import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `gruppo` e `alunno_ids` (CSV di id, split nel codice) sono entrambi opzionali
// ma almeno uno dei due deve essere valorizzato: il check incrociato resta nel
// codice con il suo 400 dedicato. Niente zUuid: gli id sono usati solo in .in().
const getQuerySchema = z.object({
  gruppo: z.string().optional(),
  alunno_ids: z.string().optional(),
})

// GET /api/teacher/uscite?userId=&alunno_ids=a,b,c  (oppure &gruppo=)
//   Semaforo gite/uscite per l'insegnante. Ritorna SOLO { alunno_id, autorizzato, quota_ok }.
//   MAI dati economici (nessun importo). Accesso: educator/coordinator/admin (NO genitore).
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    if (user.role === 'genitore') {
      return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { gruppo, alunno_ids: alunnoIdsParam } = q.data
    const alunnoIds = alunnoIdsParam ? alunnoIdsParam.split(',').map((x) => x.trim()).filter(Boolean) : []

    if (!gruppo && alunnoIds.length === 0) {
      return NextResponse.json({ error: 'Specificare gruppo o alunno_ids' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const { data: cat } = await supabase
      .from('payment_categories').select('id').eq('slug', 'gita').is('scuola_id', null).single()

    // pagamenti gita rilevanti (NON selezioniamo l'importo)
    let pagQuery = supabase.from('pagamenti').select('alunno_id, stato').eq('categoria_id', cat?.id)
    if (gruppo) pagQuery = pagQuery.eq('gruppo', gruppo)
    if (alunnoIds.length > 0) pagQuery = pagQuery.in('alunno_id', alunnoIds)
    const { data: pagamenti } = await pagQuery

    // quota_ok = esiste un pagamento gita 'pagato' per quell'alunno
    const quotaOk = new Map<string, boolean>()
    const targetAlunni = new Set<string>(alunnoIds)
    for (const p of pagamenti || []) {
      targetAlunni.add(p.alunno_id)
      quotaOk.set(p.alunno_id, (quotaOk.get(p.alunno_id) ?? false) || p.stato === 'pagato')
    }

    const alunniList = [...targetAlunni]
    if (alunniList.length === 0) return NextResponse.json({ success: true, data: [] })

    // autorizzazione firmata: un genitore collegato ha una form_submission firmata
    const { data: legami } = await supabase
      .from('legame_genitori_alunni').select('alunno_id, genitore_id').in('alunno_id', alunniList)
    const genitoriByAlunno = new Map<string, string[]>()
    const allGenitori = new Set<string>()
    for (const l of legami || []) {
      const arr = genitoriByAlunno.get(l.alunno_id) || []
      arr.push(l.genitore_id); genitoriByAlunno.set(l.alunno_id, arr); allGenitori.add(l.genitore_id)
    }
    const firmatari = new Set<string>()
    if (allGenitori.size > 0) {
      const { data: subs } = await supabase
        .from('form_submissions').select('user_id, signed_at').in('user_id', [...allGenitori]).not('signed_at', 'is', null)
      for (const sub of subs || []) firmatari.add(sub.user_id)
    }

    const data = alunniList.map((alunno_id) => ({
      alunno_id,
      autorizzato: (genitoriByAlunno.get(alunno_id) || []).some((g) => firmatari.has(g)),
      quota_ok: quotaOk.get(alunno_id) ?? false,
    }))

    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('Errore API GET teacher/uscite:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
