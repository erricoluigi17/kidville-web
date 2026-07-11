import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { sincronizzaTestata } from '@/lib/merch/stati'

// POST /api/admin/merch/cambio-taglia — cambia la taglia di una riga: crea una
// NUOVA riga (nuova taglia, stessa quantità, prezzo 0 = nessun addebito
// aggiuntivo, stato da_ordinare) sullo stesso ordine. Con reso_a_stock, il capo
// restituito rientra a magazzino (rettifica +qty sulla taglia originale).

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'])
const CAMPI_RIGA_NUOVI = ['stato', 'origine'] as const
const uno = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

const bodySchema = z.object({
  riga_id: zUuid,
  nuova_taglia: z.string().trim().max(40),
  reso_a_stock: z.boolean().optional(),
})

export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, bodySchema)
    if ('response' in b) return b.response
    const { riga_id, nuova_taglia, reso_a_stock } = b.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)

    type R = {
      id: string; stato: string; articolo_id: string | null; articolo_nome: string; taglia: string | null; quantita: number; ordine_id: string
      ordine: { scuola_id?: string | null } | { scuola_id?: string | null }[] | null
    }
    const { data: rigaRaw, error } = await supabase
      .from('divise_ordini_righe')
      .select('id, stato, articolo_id, articolo_nome, taglia, quantita, ordine_id, ordine:ordine_id ( scuola_id )')
      .eq('id', riga_id)
      .maybeSingle()
    if (error && SCHEMA_MANCANTE.has(error.code ?? '')) {
      return NextResponse.json({ error: 'Funzione non disponibile su questo ambiente' }, { status: 503 })
    }
    const riga = rigaRaw as unknown as R | null
    if (!riga) return NextResponse.json({ error: 'Riga non trovata' }, { status: 404 })
    const scuolaId = uno(riga.ordine)?.scuola_id
    if (!scuolaId || !plessi.includes(scuolaId)) return NextResponse.json({ error: 'Riga fuori dal tuo plesso' }, { status: 403 })
    // Una riga annullata è terminale: non deve "resuscitare" in una riga attiva.
    if (riga.stato === 'annullato') {
      return NextResponse.json({ error: 'La riga è annullata: non è possibile cambiarne la taglia' }, { status: 409 })
    }

    // Valida la nuova taglia contro il catalogo (se l'articolo ha taglie).
    if (riga.articolo_id) {
      const { data: art } = await supabase.from('divise_articoli').select('taglie').eq('id', riga.articolo_id).maybeSingle()
      const taglie = (art?.taglie as string[] | undefined) ?? []
      if (taglie.length > 0 && !taglie.includes(nuova_taglia)) {
        return NextResponse.json({ error: `Taglia "${nuova_taglia || '—'}" non valida per l'articolo` }, { status: 400 })
      }
    }
    if ((riga.taglia ?? '') === nuova_taglia) {
      return NextResponse.json({ error: 'La nuova taglia coincide con quella attuale' }, { status: 400 })
    }

    // Nuova riga (prezzo 0, da_ordinare) — degrade PGRST204 → senza stato/origine.
    const nuova: Record<string, unknown> = {
      ordine_id: riga.ordine_id,
      articolo_id: riga.articolo_id,
      articolo_nome: riga.articolo_nome,
      taglia: nuova_taglia,
      quantita: riga.quantita,
      prezzo_unitario: 0,
      stato: 'da_ordinare',
      origine: 'fornitore',
    }
    let ins = await supabase.from('divise_ordini_righe').insert(nuova).select('id').single()
    if (ins.error && SCHEMA_MANCANTE.has(ins.error.code ?? '')) {
      const legacy: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(nuova)) if (!(CAMPI_RIGA_NUOVI as readonly string[]).includes(k)) legacy[k] = v
      ins = await supabase.from('divise_ordini_righe').insert(legacy).select('id').single()
    }
    if (ins.error || !ins.data) return NextResponse.json({ error: ins.error?.message ?? 'Creazione riga fallita' }, { status: 500 })

    // Semantica del cambio taglia (evita doppioni e stock fantasma):
    //  • PRE-consegna (da_ordinare/ordinato/arrivato) = correzione: la riga
    //    sbagliata va ANNULLATA (l'annullo rilascia da solo l'eventuale
    //    allocazione da magazzino, per la formula giacenze). Nessuna rettifica.
    //  • POST-consegna (consegnato) = scambio: la riga resta a storico; con
    //    reso_a_stock il capo fisico restituito rientra a magazzino (+qty).
    const consegnato = riga.stato === 'consegnato'
    let resoApplicato = false
    if (!consegnato) {
      await supabase.from('divise_ordini_righe').update({ stato: 'annullato' }).eq('id', riga_id)
    } else if (reso_a_stock) {
      await supabase.from('merch_rettifiche').insert({
        scuola_id: scuolaId,
        articolo_id: riga.articolo_id,
        articolo_nome: riga.articolo_nome,
        taglia: riga.taglia ?? '',
        quantita_delta: riga.quantita,
        motivo: 'reso',
        nota: `Cambio taglia ${riga.taglia || '—'} → ${nuova_taglia}`,
        creato_da: auth.user.id,
      })
      resoApplicato = true
    }

    await sincronizzaTestata(supabase, riga.ordine_id)

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_riga',
      entitaId: ins.data.id as string,
      azione: 'insert',
      scuolaId,
      valoreDopo: { cambio_taglia: { da: riga.taglia, a: nuova_taglia, stato_originale: riga.stato, annullata_originale: !consegnato, reso_a_stock: resoApplicato } },
    })

    return NextResponse.json({ success: true, data: { nuova_riga_id: ins.data.id, reso: resoApplicato, annullata_originale: !consegnato } }, { status: 201 })
  } catch (err) {
    console.error('Errore API POST merch/cambio-taglia:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
