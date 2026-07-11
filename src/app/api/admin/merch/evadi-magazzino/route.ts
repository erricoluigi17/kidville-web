import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { sincronizzaTestata } from '@/lib/merch/stati'
import { caricaGiacenze, disponibileDi } from '@/lib/merch/giacenze'
import { notificaMerchArrivato } from '@/lib/merch/notify'

// POST /api/admin/merch/evadi-magazzino — evade una riga da_ordinare dallo STOCK:
// da_ordinare → arrivato con origine='magazzino'. Scala subito la disponibilità
// (impegno all'allocazione, niente doppia assegnazione). 409 se stock < quantità.

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])
const bodySchema = z.object({ riga_id: zUuid })
const uno = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, bodySchema)
    if ('response' in b) return b.response
    const { riga_id } = b.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)

    type R = {
      id: string; stato: string; ordine_id: string; articolo_id: string | null; articolo_nome: string; taglia: string | null; quantita: number
      ordine: { scuola_id?: string | null; alunno_id?: string | null } | { scuola_id?: string | null; alunno_id?: string | null }[] | null
    }
    const { data: rigaRaw, error } = await supabase
      .from('divise_ordini_righe')
      .select('id, stato, ordine_id, articolo_id, articolo_nome, taglia, quantita, ordine:ordine_id ( scuola_id, alunno_id )')
      .eq('id', riga_id)
      .maybeSingle()
    if (error && SCHEMA_MANCANTE.has(error.code ?? '')) {
      return NextResponse.json({ error: 'Magazzino non disponibile su questo ambiente' }, { status: 503 })
    }
    const riga = rigaRaw as unknown as R | null
    if (!riga) return NextResponse.json({ error: 'Riga non trovata' }, { status: 404 })
    const sc = uno(riga.ordine)?.scuola_id
    if (!sc || !plessi.includes(sc)) return NextResponse.json({ error: 'Riga fuori dal tuo plesso' }, { status: 403 })
    if (riga.stato !== 'da_ordinare') {
      return NextResponse.json({ error: 'Solo le righe da ordinare possono essere evase da magazzino' }, { status: 409 })
    }

    // Disponibilità corrente per articolo/taglia.
    const giacenze = await caricaGiacenze(supabase, plessi)
    const disp = disponibileDi(giacenze, riga.articolo_id, riga.taglia ?? '')
    if (disp < riga.quantita) {
      return NextResponse.json(
        { error: `Disponibilità insufficiente a magazzino (${disp} disponibili, richiesti ${riga.quantita})`, disponibile: disp },
        { status: 409 }
      )
    }

    const now = new Date().toISOString()
    const { error: updErr } = await supabase
      .from('divise_ordini_righe')
      .update({ stato: 'arrivato', origine: 'magazzino', arrivato_il: now, ordine_fornitore_id: null })
      .eq('id', riga_id)
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

    await sincronizzaTestata(supabase, riga.ordine_id)
    const alunnoId = uno(riga.ordine)?.alunno_id
    if (alunnoId) await notificaMerchArrivato(supabase, { alunnoId, articoli: [riga.articolo_nome], ordineId: riga.ordine_id })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_riga',
      entitaId: riga_id,
      azione: 'update',
      scuolaId: sc,
      valoreDopo: { stato: 'arrivato', origine: 'magazzino' },
    })

    return NextResponse.json({ success: true, data: { riga_id, disponibile_residuo: disp - riga.quantita } })
  } catch (err) {
    console.error('Errore API POST merch/evadi-magazzino:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
