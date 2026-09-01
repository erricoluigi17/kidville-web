import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { MATERIALI_DEFAULT } from '@/lib/armadietto/materiali-default'

export interface Soglia { allerta: number; emergenza: number }

const DEFAULT: Record<string, Soglia> = Object.fromEntries(
    MATERIALI_DEFAULT.map((m) => [m.nome, { allerta: m.livello_allerta, emergenza: m.livello_emergenza }]),
)

/**
 * Le soglie di allarme per materiale, per una sezione.
 *
 * `locker_config` popolata → vincono le sue righe, e SOLO quelle: se la segreteria
 * ha tolto «Cambio» da quella sezione, non deve rientrare dalla finestra dei
 * default, altrimenti togliere un materiale non lo toglierebbe davvero.
 *
 * `locker_config` vuota o illeggibile → i default. Non è un ripiego d'emergenza:
 * al 2026-09-01 la tabella ha ZERO righe per decisione del titolare, quindi questo
 * è il caso NORMALE. Stessa regola che applica già `api/locker/materials/route.ts`,
 * ed è il motivo per cui vive qui e non là: due percorsi di lettura per la stessa
 * soglia sono due schermate che un giorno mostrano numeri diversi.
 */
export async function soglieMateriali(
    admin: SupabaseClient,
    sectionId: string | null,
): Promise<Record<string, Soglia>> {
    if (!sectionId) return { ...DEFAULT }

    const { data, error } = await admin
        .from('locker_config')
        .select('nome, livello_allerta, livello_emergenza')
        .eq('attivo', true)
        .eq('section_id', sectionId)

    if (error) {
        // `warn` e non `error`: il ripiego è previsto e il risultato è salvo. Resta
        // un warn perché se la tabella C'È ed è la QUERY a fallire, questa riga è
        // l'unico indizio che le richieste stanno nascendo sulle soglie sbagliate.
        logEvento('db', 'warn', {
            operazione: 'armadietto/soglie',
            esito: 'locker-config-non-letta-uso-default',
        }, error)
        return { ...DEFAULT }
    }

    if (!data || data.length === 0) return { ...DEFAULT }

    return Object.fromEntries(
        (data as Array<{ nome: string; livello_allerta: number; livello_emergenza: number }>)
            .map((r) => [r.nome, { allerta: r.livello_allerta, emergenza: r.livello_emergenza }]),
    )
}
