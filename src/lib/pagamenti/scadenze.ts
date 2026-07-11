import type { SupabaseClient } from '@supabase/supabase-js'

// "Giorno di paga" per alunno: quando cambia, le rette APERTE future già
// generate vanno riallineate al nuovo giorno, altrimenti l'accordo col
// genitore varrebbe solo dalla prossima generazione. Best-effort: un errore
// qui non deve far fallire il salvataggio anagrafico.

export async function riallineaScadenzeRetteFuture(
    supabase: SupabaseClient,
    alunnoId: string,
    giorno: number | null | undefined,
): Promise<number> {
    try {
        const { data: cat } = await supabase
            .from('payment_categories')
            .select('id')
            .eq('slug', 'retta')
            .is('scuola_id', null)
            .maybeSingle()
        if (!cat) return 0

        // giorno effettivo: override alunno, altrimenti default di scuola (5)
        let g = giorno ?? null
        if (g == null) {
            const { data: al } = await supabase.from('alunni').select('scuola_id').eq('id', alunnoId).maybeSingle()
            const { data: sett } = await supabase
                .from('admin_settings')
                .select('retta_giorno_scadenza')
                .eq('scuola_id', (al as { scuola_id?: string } | null)?.scuola_id)
                .maybeSingle()
            g = Number((sett as { retta_giorno_scadenza?: number } | null)?.retta_giorno_scadenza ?? 5)
        }
        if (!(g >= 1 && g <= 28)) return 0

        const oggi = new Date().toISOString().slice(0, 10)
        const primoMeseCorrente = `${oggi.slice(0, 8)}01`
        const { data: rette } = await supabase
            .from('pagamenti')
            .select('id, periodo_competenza, stato, importo_pagato')
            .eq('alunno_id', alunnoId)
            .eq('categoria_id', (cat as { id: string }).id)
            .gte('periodo_competenza', primoMeseCorrente)
            .in('stato', ['da_pagare', 'parziale', 'scaduto'])

        let aggiornate = 0
        for (const r of (rette || []) as { id: string; periodo_competenza: string; stato: string; importo_pagato?: number | null }[]) {
            const scadenza = `${String(r.periodo_competenza).slice(0, 8)}${String(g).padStart(2, '0')}`
            const patch: Record<string, unknown> = { scadenza }
            // la nuova scadenza è nel futuro: uno "scaduto" torna aperto
            if (r.stato === 'scaduto' && scadenza >= oggi) {
                patch.stato = Number(r.importo_pagato || 0) > 0 ? 'parziale' : 'da_pagare'
            }
            const { error } = await supabase.from('pagamenti').update(patch).eq('id', r.id)
            if (!error) aggiornate++
        }
        return aggiornate
    } catch {
        return 0
    }
}
