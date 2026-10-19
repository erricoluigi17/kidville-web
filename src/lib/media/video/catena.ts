// =============================================================================
// LA CATENA DI CONVERSIONE È VIVA? — la domanda che la conservazione non faceva.
//
// Roadmap di robustezza, fase 4, problema D6-a. `retention-video` dichiara
// «incagliato» un video rimasto in coda o in conversione per 7 giorni, gli dà una
// scadenza di altri 7 e poi ne distrugge l'ORIGINALE, cioè l'unica copia del
// video girato a scuola. È giusto quando il guasto è di QUEL video. È sbagliato
// quando a essere ferma è la catena intera (il runner che non parte, un deploy
// senza FFmpeg): allora ogni video si incaglia per la stessa ragione, e la pulizia
// cancella proprio ciò che servirebbe per rifare la conversione appena la catena
// riparte.
//
// La prova di vita è il battito di `video-runner-tick` in `app_log`, la stessa
// riga che `/api/health` usa per dire «runner fermo» (`controlli.ts`, finestra di
// 20 minuti). Qui la finestra è più larga di proposito: un'ora. La conservazione
// non deve fermarsi per un giro saltato, solo per una catena davvero ferma.
//
// «Non so» (la lettura fallisce) vale come «ferma»: davanti al dubbio, un
// originale in più conservato per dieci minuti costa niente; uno cancellato non
// torna. Il giro dopo rilegge.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { valeComeBattito } from '@/lib/health/controlli'
import { ambienteCorrente } from '@/lib/logging/ambiente'

/** Il lavoro che fa avanzare la catena, con il nome con cui scrive il suo battito. */
export const OPERAZIONE_RUNNER_VIDEO = 'video-runner-tick'

/** Senza un battito del runner da più di questi minuti la catena si considera ferma. */
export const MINUTI_CATENA_FERMA = 60

export type StatoCatenaVideo =
    | { stato: 'viva'; minutiDallUltimo: number }
    | { stato: 'ferma'; motivo: 'nessun-battito' }
    | { stato: 'ferma'; motivo: 'lettura-fallita'; codice: string }

type RigaBattito = { visto_l_ultima: string | null; contesto: { campi?: { esito?: unknown } } | null }

/**
 * Legge l'ultimo battito valido del runner nell'ultima ora. Non lancia mai: un
 * errore di lettura torna come `ferma` con il codice, e chi chiama lo logga.
 */
export async function statoCatenaVideo(supabase: SupabaseClient, adesso: Date): Promise<StatoCatenaVideo> {
    const da = new Date(adesso.getTime() - MINUTI_CATENA_FERMA * 60_000).toISOString()
    try {
        const { data, error } = await supabase
            .from('app_log')
            .select('visto_l_ultima, contesto')
            .eq('evento', 'cron')
            .in('livello', ['info', 'warn'])
            .eq('ambiente', ambienteCorrente())
            .eq('contesto->campi->>operazione', OPERAZIONE_RUNNER_VIDEO)
            .gte('visto_l_ultima', da)
            .order('visto_l_ultima', { ascending: false })
            .limit(50)
        if (error) {
            const codice = typeof error.code === 'string' && error.code !== '' ? error.code : 'sconosciuto'
            return { stato: 'ferma', motivo: 'lettura-fallita', codice }
        }
        let ultimo = -Infinity
        const soglia = Date.parse(da)
        for (const riga of (data ?? []) as RigaBattito[]) {
            const esito = riga.contesto?.campi?.esito
            if (typeof esito !== 'string' || !valeComeBattito(OPERAZIONE_RUNNER_VIDEO, esito)) continue
            const t = Date.parse(String(riga.visto_l_ultima ?? ''))
            // La finestra si ricontrolla anche qui: la decisione non deve dipendere dal solo filtro
            // della query, che un giorno qualcuno può allargare per un'altra ragione.
            if (!Number.isNaN(t) && t >= soglia && t > ultimo) ultimo = t
        }
        if (ultimo === -Infinity) return { stato: 'ferma', motivo: 'nessun-battito' }
        return { stato: 'viva', minutiDallUltimo: Math.max(0, Math.round((adesso.getTime() - ultimo) / 60_000)) }
    } catch (err) {
        const codice = err instanceof Error && err.name ? err.name : 'eccezione'
        return { stato: 'ferma', motivo: 'lettura-fallita', codice }
    }
}
