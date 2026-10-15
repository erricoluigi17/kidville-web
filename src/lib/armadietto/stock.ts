import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore } from '@/lib/logging/logger'

/**
 * Lo stock per materiale di un alunno.
 *
 * `armadietto` è un LIBRO GIORNALE, non un saldo: ogni riga è un movimento
 * (`portato: true` carico, `false` consumo) e lo stock si ottiene sommando.
 * Stessa formula di `api/locker/inventory/route.ts:119-128`, da cui è presa —
 * qui perché la usano in tre (la route, il motore delle richieste, il cron).
 *
 * Ritorna `null` se la lettura fallisce. Non `{}`: «nessun materiale» e «non ho
 * potuto guardare» si leggono uguali e significano l'opposto, e chi chiama deve
 * poter decidere (il motore non chiude una richiesta su un dato che non ha letto).
 */
export async function stockDiAlunno(
    admin: SupabaseClient,
    alunnoId: string,
    sede?: { scuolaId: string; includiSenzaSede?: boolean },
): Promise<Record<string, number> | null> {
    let query = admin
        .from('armadietto')
        .select('materiale, quantita, portato')
        .eq('alunno_id', alunnoId)
    if (sede) query = sede.includiSenzaSede ? query.or(`scuola_id.is.null,scuola_id.eq.${sede.scuolaId}`) : query.eq('scuola_id', sede.scuolaId)
    const { data, error } = await query

    if (error) {
        logErrore({ operazione: 'armadietto/stock', evento: 'db' }, error)
        return null
    }

    const stock: Record<string, number> = {}
    for (const r of (data ?? []) as Array<{ materiale: string; quantita: number; portato: boolean }>) {
        stock[r.materiale] = (stock[r.materiale] ?? 0) + (r.portato ? r.quantita : -r.quantita)
    }
    for (const m of Object.keys(stock)) stock[m] = Math.max(0, stock[m])
    return stock
}
