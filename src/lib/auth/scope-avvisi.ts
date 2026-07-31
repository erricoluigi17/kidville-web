import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from './require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logEvento } from '@/lib/logging/logger'

// =============================================================================
// Scope di sede per AVVISI e PROMEMORIA (`task_interni`) — le due entità che si
// governano per uuid dalle route gemelle `avvisi/[id]` e `tasks/[id]`.
//
// ⚠️ Perché esiste questo file, e non è un dettaglio di organizzazione.
//
// Fino al 2026-07-31 `avvisi/[id]` aveva la sua copia locale del controllo di
// sede, e quella copia non guardava il valore di ritorno di PostgREST — che non
// lancia, ritorna `{ error }` (AGENTS.md §7). Misurato in produzione:
//
//   GET /api/avvisi/<uuid inesistente>  →  403 «avviso fuori dal tuo plesso»
//                                       →  in `app_log`: niente.
//
// Cioè TRE fatti diversi — «non ho potuto leggere», «non esiste», «non è tuo» —
// uscivano con la stessa risposta e senza lasciare una riga. Due danni:
//
//  · chi riceve il diniego non sa se ha sbagliato lui o se il database è giù;
//  · il contatore `*-fuori-sede`, nato come SEGNALE DI SICUREZZA, per gli avvisi
//    non esisteva affatto — e se esistesse ma si riempisse anche di guasti e di
//    id sbagliati, il giorno del tentativo vero non si distinguerebbe dal rumore.
//
// La lezione era già scritta accanto, in `scope.ts` (`scopeNonRisolto` e la
// separazione «non è tuo»/«non esiste» di `assertParentInScope`): una copia
// locale è una regola che resta indietro. Da qui in avanti la regola sta in un
// posto solo, e le due route la importano.
//
// Il contratto, uguale per entrambe le entità:
//   guasto di lettura  → 500 + `error|auth|scope-<entità>-non-risolto`
//   riga inesistente   → 404, e NESSUN warn di sicurezza
//   sede non tua       → 403 + `warn|auth|<entità>-fuori-sede` (persistito)
// =============================================================================

/**
 * Le due entità governate qui. Tenere `tipo` dei log e messaggi al client in UNA
 * tabella serve a che non divergano: i `tipo` sono nomi di contatore, e un
 * contatore rinominato a metà è un contatore perso.
 */
const ENTITA = {
    avviso: {
        tabella: 'avvisi',
        tipoNonRisolto: 'scope-avviso-non-risolto',
        tipoFuoriSede: 'avviso-fuori-sede',
        nonTrovato: 'Avviso non trovato',
        fuoriSede: 'Accesso negato: avviso fuori dal tuo plesso',
    },
    task: {
        tabella: 'task_interni',
        tipoNonRisolto: 'scope-task-non-risolto',
        tipoFuoriSede: 'task-fuori-sede',
        nonTrovato: 'Task non trovato',
        fuoriSede: 'Accesso negato: task fuori dal tuo plesso',
    },
} as const

export type EntitaScope = keyof typeof ENTITA

/**
 * Diniego per GUASTO, non per scope: 500 + una riga `error` che dice quale
 * verifica non è stata fatta.
 *
 * Gemella di `scopeNonRisolto` (`src/lib/auth/scope.ts`), che è privata a quel
 * modulo: stesso livello, stesso corpo al client. Al chiamante non serve sapere
 * QUALE tabella non si è letta, e non deve saperlo — il `tipo` lo dice al log.
 * Le due funzioni sono candidate all'unificazione dentro `scope.ts`; finché
 * restano due, il contratto da tenere allineato è esattamente questo: **500 e
 * «Verifica di scope non riuscita»**, mai un 403 e mai un 404.
 */
export function scopeRigaNonRisolta(
    entita: EntitaScope,
    err: unknown,
    campi: Record<string, string | number | null | undefined> = {},
): NextResponse {
    logEvento('auth', 'error', { tipo: ENTITA[entita].tipoNonRisolto, ...campi }, err)
    return NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 })
}

/**
 * «Non esiste» — 404 asciutto. Nessun log di sicurezza: un id sbagliato è la
 * cosa più banale che possa succedere, e se finisse nel contatore dei tentativi
 * cross-sede lo renderebbe inutile.
 */
export function rigaNonTrovata(entita: EntitaScope): NextResponse {
    return NextResponse.json({ error: ENTITA[entita].nonTrovato }, { status: 404 })
}

/**
 * «Non è tuo» — 403 con la riga `warn` persistita, come già fanno
 * `pagamento-fuori-sede`, `genitore-fuori-sede`, `utente-fuori-sede`,
 * `classe-fuori-sede`. Questo è l'unico dei tre casi che è un segnale.
 *
 * Sede assente sulla riga ⇒ si nega comunque: un avviso o un promemoria senza
 * plesso non è attribuibile a nessuno.
 *
 * Nel log vanno solo uuid dell'attore, ruolo e azione: mai il titolo, mai il
 * contenuto, mai la sede in chiaro — la stessa regola delle altre `assert*`.
 *
 * @param azione  chi sta chiedendo (nome della funzione o della rotta): serve a
 *                leggere il contatore senza risalire alla richiesta.
 */
export async function assertSedeRigaInScope(
    supabase: SupabaseClient,
    user: AppUser,
    entita: EntitaScope,
    sede: string | null | undefined,
    azione: string,
): Promise<NextResponse | null> {
    const plessi = await scuoleDiUtente(supabase, user)
    if (sede && plessi.includes(sede)) return null
    logEvento('auth', 'warn', {
        tipo: ENTITA[entita].tipoFuoriSede, azione,
        utente: user.id, ruolo: user.role,
    })
    return NextResponse.json({ error: ENTITA[entita].fuoriSede }, { status: 403 })
}

/**
 * Legge la sola `scuola_id` della riga e applica il contratto completo, per i
 * chiamanti che la riga non ce l'hanno già (le tre rotte degli avvisi).
 *
 * Chi la riga l'ha già letta — `tasks/[id]`, che legge il promemoria comunque —
 * compone da sé i tre pezzi qui sopra e non paga una seconda query: sono gli
 * stessi tre, nello stesso ordine, e il `tipo` dei log viene dalla stessa
 * tabella `ENTITA`.
 */
async function assertRigaInScope(
    supabase: SupabaseClient,
    user: AppUser,
    entita: EntitaScope,
    id: string,
    azione: string,
): Promise<NextResponse | null> {
    const { data: riga, error } = await supabase
        .from(ENTITA[entita].tabella)
        .select('scuola_id')
        .eq('id', id)
        .maybeSingle()
    // PostgREST non lancia: senza questo controllo un guasto di lettura
    // diventerebbe un 403 muto, indistinguibile da un tentativo cross-sede.
    if (error) return scopeRigaNonRisolta(entita, error, { utente: user.id })
    if (!riga) return rigaNonTrovata(entita)
    return await assertSedeRigaInScope(supabase, user, entita, riga.scuola_id as string | null, azione)
}

/** L'avviso deve stare in un plesso dell'attore. 500/404/403, mai confusi. */
export async function assertAvvisoInScope(
    supabase: SupabaseClient,
    user: AppUser,
    id: string,
): Promise<NextResponse | null> {
    return await assertRigaInScope(supabase, user, 'avviso', id, 'assertAvvisoInScope')
}
