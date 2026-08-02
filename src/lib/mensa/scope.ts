import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'

/**
 * Le tabelle di CONFIGURAZIONE della mensa che si mutano per solo `id`.
 * Tutte e tre hanno la colonna `scuola_id`: è quella che dice di chi è la riga.
 */
export type TabellaConfigMensa =
  | 'mensa_menu_config'
  | 'mensa_class_menu_assignment'
  | 'mensa_menu_override'

const ETICHETTA: Record<TabellaConfigMensa, string> = {
  mensa_menu_config: 'Menu',
  mensa_class_menu_assignment: 'Assegnazione',
  mensa_menu_override: 'Variazione di menu',
}

/**
 * Carica una riga di configurazione mensa per `id` e ne verifica lo SCOPE DI SEDE
 * prima di ogni mutazione (PATCH/DELETE).
 *
 * PERCHÉ ESISTE (R44). `requireStaff` verifica il RUOLO, non il TENANT, e queste
 * route girano in service-role — che scavalca la RLS. Fino al 2026-07-31 quattro
 * mutazioni del modulo mensa filtravano SOLO per `id`: con l'uuid in mano si
 * rinominava il menu di un altro plesso, si cancellava l'assegnazione classe→menu
 * di un'altra sede e si rimuoveva la variazione del giorno — cioè la riga che
 * porta gli ALLERGENI di quella data. I POST/PUT erano già corretti
 * (`resolveScuolaScrittura`): la sede si dichiarava alla creazione e si dimenticava
 * alla modifica.
 *
 * Fail-closed, in tutti e tre i modi in cui può andare storta:
 *  · errore di lettura ⇒ 500 con riga d'errore (PostgREST NON lancia: senza il
 *    controllo su `error` un guasto di lettura diventerebbe «riga non trovata»);
 *  · riga assente ⇒ 404;
 *  · `scuola_id` NULL o fuori da `resolveScuoleAttive` ⇒ 403. Il NULL si nega come
 *    in `assertPagamentoInScope`: una riga senza plesso non è attribuibile a
 *    nessuno, quindi non è di nessuno.
 *
 * Lo scope VUOTO (cookie `sedi_attive` che non interseca nulla) nega da sé:
 * `[].includes(...)` è falso. Mai un `if (sedi.length > 0)` — quello è fail-open.
 */
export async function assertConfigMensaInScope(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  tabella: TabellaConfigMensa,
  id: string,
): Promise<{ sede?: string; response?: NextResponse }> {
  const { data, error } = await supabase
    .from(tabella)
    .select('id, scuola_id')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    logErrore({ operazione: `mensa/${tabella}:scope`, stato: 500, evento: 'db' }, error)
    return { response: NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 }) }
  }
  if (!data) {
    return { response: NextResponse.json({ error: `${ETICHETTA[tabella]} non trovato` }, { status: 404 }) }
  }
  const sede = (data.scuola_id as string | null) ?? null
  const sedi = await resolveScuoleAttive(request, supabase, user)
  if (!sede || !sedi.includes(sede)) {
    // `warn` → persistito: «qualcuno ha chiesto di mutare la configurazione mensa
    // di un plesso che non è suo» è un segnale di sicurezza, non rumore. Solo
    // uuid utente, ruolo e nome tabella: nessun dato di minori, nessuna sede.
    logEvento('auth', 'warn', {
      tipo: 'config-mensa-fuori-sede', azione: 'assertConfigMensaInScope',
      utente: user.id, ruolo: user.role, tabella,
    })
    return { response: rifiutoSede('SEDE_NON_ACCESSIBILE') }
  }
  return { sede }
}

/**
 * `23505` = unique_violation. Serve da quando la configurazione mensa ha i vincoli
 * di unicità PER SEDE (migrazione `mensa_unique_per_sede`): senza questo ramo un
 * nome di menu ripetuto uscirebbe come 500 anonimo, e chi lo legge non saprebbe che
 * la richiesta era semplicemente un duplicato.
 */
export function vincoloDuplicato(err: unknown): boolean {
  return (err as { code?: string } | null | undefined)?.code === '23505'
}
