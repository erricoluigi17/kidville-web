import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireKitchenRead } from '@/lib/auth/require-staff'
import { DEFAULT_SCUOLA, loadResolveOptions } from '@/lib/mensa/server'
import { resolveMenuGiorno } from '@/lib/mensa/resolveMenu'
import { allergeniAlunno, conflittiAllergie, type ConflittoAllergia } from '@/lib/mensa/allergeni'

interface AlunnoRow {
  id: string
  nome: string
  cognome: string
  classe_sezione: string | null
  allergies: string | null
  allergeni: string[] | null
}

interface AlunnoReport {
  id: string
  nome: string
  classe: string
  allergeni: string[]            // allergeni effettivi dell'alunno
  conflitti: ConflittoAllergia[] // allergeni in conflitto col menu del giorno
}

// GET /api/mensa/report?userId=&data=&sezione=&scuola_id=
//   Pasti prenotati per classe CON i nomi dei bambini + allergie e conflitti
//   col menu del giorno.
//   - admin/coordinator/cuoca: tutte le classi (filtro sezione opzionale)
//   - educator: SOLO la propria sezione (parametro `sezione` obbligatorio)
export async function GET(request: Request) {
  try {
    const auth = await requireKitchenRead(request)
    if (auth.response) return auth.response
    const { user } = auth

    const { searchParams } = new URL(request.url)
    const data = searchParams.get('data') ?? new Date().toISOString().slice(0, 10)
    const scuolaId = searchParams.get('scuola_id') || user.scuola_id || DEFAULT_SCUOLA
    const sezione = searchParams.get('sezione')

    if (user.role === 'educator' && !sezione) {
      return NextResponse.json({ error: 'Parametro sezione obbligatorio per il ruolo insegnante' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // prenotazioni attive per la data
    const { data: pren } = await supabase
      .from('mensa_prenotazioni')
      .select('alunno_id')
      .eq('data', data)
      .eq('stato', 'prenotato')
    const ids = (pren ?? []).map(p => p.alunno_id as string)
    if (ids.length === 0) {
      return NextResponse.json({ success: true, data: { data, totale: 0, perClasse: [], allergie: [] } })
    }

    // anagrafica alunni prenotati (con allergie) + menu del giorno (per conflitti)
    let q = supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, allergies, allergeni')
      .in('id', ids)
      .eq('scuola_id', scuolaId)
    if (sezione) q = q.eq('classe_sezione', sezione)

    const [{ data: alunni }, options] = await Promise.all([q, loadResolveOptions(supabase, scuolaId)])
    const menu = resolveMenuGiorno(data, options)
    const rows = (alunni ?? []) as AlunnoRow[]

    // costruzione report per alunno
    const perClasseMap = new Map<string, AlunnoReport[]>()
    const allergie: { nome: string; classe: string; allergie: string; conflitto: boolean }[] = []

    for (const a of rows) {
      const classe = a.classe_sezione ?? '—'
      const eff = allergeniAlunno({ allergeni: a.allergeni, allergies: a.allergies })
      const conflitti = (menu.attivo && !menu.chiuso) ? conflittiAllergie(eff, menu.allergeni) : []

      const rep: AlunnoReport = { id: a.id, nome: `${a.nome} ${a.cognome}`.trim(), classe, allergeni: eff, conflitti }
      const arr = perClasseMap.get(classe) ?? []
      arr.push(rep)
      perClasseMap.set(classe, arr)

      if ((a.allergies ?? '').trim().length > 0 || eff.length > 0) {
        allergie.push({
          nome: rep.nome, classe,
          allergie: (a.allergies ?? '').trim() || eff.join(', '),
          conflitto: conflitti.length > 0,
        })
      }
    }

    const perClasse = Array.from(perClasseMap.entries())
      .map(([classe, alunni]) => ({
        classe,
        conteggio: alunni.length,
        alunni: alunni.sort((x, y) => x.nome.localeCompare(y.nome)),
      }))
      .sort((x, y) => x.classe.localeCompare(y.classe))

    return NextResponse.json({
      success: true,
      data: { data, totale: rows.length, perClasse, allergie },
    })
  } catch (err) {
    console.error('Errore API GET mensa/report:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
