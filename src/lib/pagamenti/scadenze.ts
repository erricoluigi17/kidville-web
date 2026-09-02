import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

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
    } catch (e) {
        // Best-effort NON vuol dire muto (AGENTS.md §6): un riallineamento saltato
        // lascia le scadenze all'accordo vecchio, e senza questa riga la cosa non
        // esisterebbe da nessuna parte.
        logEvento('pagamento', 'warn', {
            operazione: 'riallineaScadenzeRetteFuture',
            esito: 'riallineo-scadenze-fallito',
            alunno_id: alunnoId,
        }, e)
        return 0
    }
}

/**
 * La RETTA cambiata in anagrafica scende sui pagamenti già generati e ancora
 * intatti. Best-effort come la gemella qui sopra.
 *
 * ─── PERCHÉ ESISTE: UN GUASTO MISURATO, NON UN'IDEA ──────────────────────────
 * Il 2026-09-02, a Kidville Aversa, alle 14:46:53 sono state generate 98 rette.
 * Fra le 14:53 e le 15:19 la Direzione ne ha corrette dodici in anagrafica
 * (330→300, 170→150 sette volte, 380→370, 330→250…). I pagamenti già creati sono
 * rimasti al valore vecchio, in silenzio, e il primo a farlo notare è stato un
 * tentativo di fatturare 330 € a una famiglia che ne doveva 300. Nessun errore,
 * nessun avviso: la correzione sembrava fatta e non lo era.
 * (Controprova che non era la generazione a sbagliare: Giugliano, generata lo
 * stesso giorno e mai corretta dopo, aveva 0 divergenze su 227.)
 *
 * ─── LE TRE CONDIZIONI, E PERCHÉ SONO STRETTE ────────────────────────────────
 * Si tocca solo ciò su cui nessuno ha ancora fatto nulla di irreversibile:
 *
 *  1. PERIODO CORRENTE O FUTURO — mai i mesi passati. Un importo di un mese
 *     chiuso è già stato comunicato alla famiglia, e riscriverlo farebbe
 *     riemergere morosità o crediti che nessuno sta cercando.
 *  2. NON FATTURATO — dopo la fattura l'importo è un documento fiscale: si
 *     corregge con una nota di credito, non con un UPDATE.
 *  3. NON PAGATO, NEMMENO IN PARTE — se dei soldi sono entrati, cambiare la
 *     cifra dovuta sposta un saldo che qualcuno ha già conteggiato.
 *
 * ⚠️ Conseguenza da conoscere, perché è il caso che ha fatto scoprire il difetto:
 * il pagamento del 2026-09-02 era marcato «pagato» (300 su 330) e quindi NON
 * sarebbe rientrato qui. La regola più prudente è quella scelta dal titolare, e va
 * saputo che lascia fuori quel caso: si corregge a mano.
 */
export async function riallineaImportoRetteFuture(
    supabase: SupabaseClient,
    alunnoId: string,
    importo: number | null | undefined,
): Promise<number> {
    try {
        // Zero e negativi non si propagano: sulla colonna dell'alunno lo zero
        // significa «usa il default di sede», e su un pagamento significherebbe
        // «non deve niente». Sono due frasi diverse, e tradurre l'una nell'altra
        // è precisamente il modo di regalare (o addebitare) una retta.
        if (typeof importo !== 'number' || !(importo > 0)) return 0

        const { data: cat } = await supabase
            .from('payment_categories')
            .select('id')
            .eq('slug', 'retta')
            .is('scuola_id', null)
            .maybeSingle()
        if (!cat) return 0

        const primoMeseCorrente = `${new Date().toISOString().slice(0, 8)}01`
        const { data: rette, error } = await supabase
            .from('pagamenti')
            .select('id, importo, importo_pagato, fattura_aruba_id, fattura_stato')
            .eq('alunno_id', alunnoId)
            .eq('categoria_id', (cat as { id: string }).id)
            .gte('periodo_competenza', primoMeseCorrente)
            .in('stato', ['da_pagare', 'scaduto'])
        // PostgREST non lancia: senza questo controllo un errore di lettura
        // sarebbe indistinguibile da «non c'era niente da riallineare».
        if (error) {
            logEvento('pagamento', 'warn', {
                operazione: 'riallineaImportoRetteFuture',
                esito: 'rette-non-lette',
                alunno_id: alunnoId,
            }, error)
            return 0
        }

        let aggiornate = 0
        for (const r of (rette || []) as {
            id: string
            importo: number | string
            importo_pagato?: number | null
            fattura_aruba_id?: string | null
            fattura_stato?: string | null
        }[]) {
            if (r.fattura_aruba_id) continue
            // `non_richiesta` e `scartata` sono i due stati in cui NON esiste un
            // documento fiscale valido: tutto il resto (in attesa, inviata,
            // consegnata) è una fattura in volo o arrivata, e non si tocca.
            if (r.fattura_stato && !['non_richiesta', 'scartata'].includes(r.fattura_stato)) continue
            if (Number(r.importo_pagato || 0) > 0) continue
            if (Number(r.importo) === importo) continue

            const { error: upErr } = await supabase.from('pagamenti').update({ importo }).eq('id', r.id)
            if (upErr) {
                logEvento('pagamento', 'warn', {
                    operazione: 'riallineaImportoRetteFuture',
                    esito: 'importo-non-riallineato',
                    alunno_id: alunnoId,
                    pagamento_id: r.id,
                }, upErr)
                continue
            }
            aggiornate++
        }

        // Il SUCCESSO si logga (AGENTS.md §5). Un aggiornamento automatico che
        // cambia importi senza lasciare traccia è la stessa malattia di prima —
        // «nessuno se n'è accorto» — girata al contrario.
        if (aggiornate > 0) {
            logEvento('pagamento', 'info', {
                operazione: 'riallineaImportoRetteFuture',
                esito: 'importi-riallineati',
                alunno_id: alunnoId,
                pagamenti_allineati: aggiornate,
                importo,
            })
        }
        return aggiornate
    } catch (e) {
        logEvento('pagamento', 'warn', {
            operazione: 'riallineaImportoRetteFuture',
            esito: 'riallineo-importi-fallito',
            alunno_id: alunnoId,
        }, e)
        return 0
    }
}
