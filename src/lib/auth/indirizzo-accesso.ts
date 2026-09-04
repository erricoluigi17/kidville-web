/**
 * ═══════════════════════════════════════════════════════════════════════════
 * L'indirizzo che si SCRIVE in anagrafica e l'indirizzo con cui si ENTRA erano
 * due cose diverse, e nessuno le confrontava mai.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MISURATO IN PRODUZIONE (2026-09-04): **4 anagrafiche genitore** hanno
 * `parents.emails[1]` diverso da `auth.users.email`. Tutte e quattro con
 * `last_sign_in_at` mai valorizzato: nessuna di quelle famiglie è mai entrata,
 * e una ha ricevuto **13 rigenerazioni di credenziali in un solo giorno**.
 *
 * IL MECCANISMO, per intero, perché non è ovvio e sembra un problema di password:
 *
 *   1. `POST /api/admin/regenerate-credentials` prende l'indirizzo da
 *      `parents.emails` — cioè quello dell'ANAGRAFICA, che la Segreteria tiene
 *      aggiornato — e lì manda l'email. **L'email quindi arriva davvero**, ed è
 *      per questo che le famiglie insistono: hanno la password in mano.
 *   2. Dentro, l'email dice «Email di accesso: <indirizzo dell'anagrafica>».
 *   3. La password però viene scritta sull'account risolto da
 *      `parents.auth_user_id`, che vive su un indirizzo DIVERSO.
 *   4. La famiglia digita quello che ha letto. GoTrue non lo conosce.
 *      «Credenziali non valide».
 *   5. Si rigenera. Cambia la password, non l'indirizzo. Si rigenera ancora.
 *      **Nessun numero di rigenerazioni potrà mai ripararlo.**
 *
 * La causa sta in `parent-identity.ts`: `if (!authUserId) { …risolvi per email… }`.
 * Quando il ponte esiste già — cioè sempre, dopo la prima volta — quel blocco
 * viene saltato per intero, e in tutto il repo non esisteva un solo punto in cui
 * i due indirizzi venissero confrontati. Non esisteva nemmeno un
 * `updateUserById({ email })`: `PATCH /api/admin/parents` correggeva l'anagrafica
 * e non propagava niente a nessuno.
 *
 * ─── PERCHÉ VINCE L'ANAGRAFICA ──────────────────────────────────────────────
 *
 * Decisione del titolare, 2026-09-04. Due dei quattro casi la confermano da soli:
 * i domini degli ACCOUNT sono `gmali.com` e `gmailm.com` — refusi di domini che
 * non esistono — mentre le anagrafiche portano l'indirizzo giusto. L'anagrafica è
 * la cosa che qualcuno mantiene; l'account è il posto dove il refuso si è
 * fossilizzato il giorno in cui è nato, e dove nessuno poteva più vederlo.
 *
 * ⚠️ IL ROVESCIO, detto una volta: se il refuso sta nell'anagrafica, l'accesso si
 * sposta su un indirizzo sbagliato. Non è un rischio che si possa togliere con
 * del codice — nessun programma può sapere quale dei due indirizzi la famiglia
 * usi davvero. Si può però toglierne il silenzio: ogni spostamento lascia una
 * riga di log e viene DICHIARATO al chiamante, che lo mostra a chi ha premuto il
 * pulsante. Visibile e rifacibile, invece che invisibile e definitivo.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

/**
 * Esito dell'allineamento. `sconosciuto` e `non-riuscito` sono due cose diverse:
 * il primo dice che non si è potuto nemmeno guardare, il secondo che si è provato
 * a scrivere e non è andata. Confonderli nasconderebbe un guasto del provider
 * dentro un «non lo so».
 */
export type EsitoAllineamento =
    | { stato: 'gia-allineato' }
    | { stato: 'allineato'; da: string; a: string; copiaApplicativaIndietro: boolean }
    | { stato: 'in-uso-da-altri' }
    | { stato: 'non-riuscito'; dettaglio: string }
    | { stato: 'sconosciuto' }

/**
 * Un indirizzo, ridotto alla forma con cui si confronta: senza spazi ai bordi e
 * tutto minuscolo — che è come GoTrue lo tratta.
 *
 * Restituisce `null` per tutto ciò che non ha la forma di un indirizzo: senza la
 * chiocciola non è un'email, ed è meglio un «non lo so» di un confronto fra due
 * stringhe che non sono indirizzi.
 */
export function normalizzaIndirizzo(grezzo: unknown): string | null {
    if (typeof grezzo !== 'string') return null
    const pulito = grezzo.trim().toLowerCase()
    return pulito.includes('@') ? pulito : null
}

/** GoTrue dice così quando l'indirizzo è già di qualcun altro. */
const CODICE_GIA_IN_USO = 'email_exists'

function codiceErrore(errore: unknown): string | undefined {
    if (typeof errore !== 'object' || errore === null) return undefined
    const e = errore as { code?: unknown; error_code?: unknown }
    if (typeof e.code === 'string') return e.code
    if (typeof e.error_code === 'string') return e.error_code
    return undefined
}

/**
 * Porta l'indirizzo dell'ACCOUNT su quello dell'ANAGRAFICA, se divergono.
 *
 * Non lancia mai — è chiamata da percorsi best-effort, compreso il salvataggio di
 * un'anagrafica: un guasto qui non deve poter far fallire un salvataggio che con
 * l'accesso non c'entra.
 *
 * L'ordine delle due scritture non è indifferente: prima `auth.users`, che è la
 * fonte del login, e solo dopo la copia in `utenti`. Al contrario, un guasto a
 * metà lascerebbe `utenti` che promette un accesso che GoTrue non onora.
 */
export async function allineaIndirizzoAccesso(
    admin: SupabaseClient,
    authUserId: string,
    emailAnagrafica: unknown,
): Promise<EsitoAllineamento> {
    const voluto = normalizzaIndirizzo(emailAnagrafica)
    if (!voluto) return { stato: 'sconosciuto' }

    try {
        const letto = await admin.auth.admin.getUserById(authUserId)
        if (letto.error || !letto.data?.user) {
            // Un errore di lettura NON è «gli indirizzi sono diversi». Scrivere qui
            // vorrebbe dire riscrivere il login di qualcuno sulla base di un'ipotesi.
            logEvento('auth', 'warn', {
                operazione: 'auth/indirizzo-accesso:allinea',
                esito: 'indirizzo-account-non-letto',
                entita_id: authUserId,
            }, letto.error ?? new Error('getUserById: nessun utente'))
            return { stato: 'sconosciuto' }
        }

        const attuale = normalizzaIndirizzo(letto.data.user.email)
        // Un account senza indirizzo leggibile non è «diverso»: è ignoto.
        if (!attuale) return { stato: 'sconosciuto' }
        if (attuale === voluto) return { stato: 'gia-allineato' }

        // Controllo preventivo: se quell'indirizzo è già di un altro account, non
        // si tocca niente. Due anagrafiche per la stessa persona, o due persone
        // sulla stessa casella: il codice non può scegliere, e sceglierne una
        // chiuderebbe fuori l'altra.
        const { data: occupante } = await admin
            .from('utenti')
            .select('id')
            .eq('email', voluto)
            .maybeSingle()
        const idOccupante = (occupante as { id?: string } | null)?.id
        if (idOccupante && idOccupante !== authUserId) {
            logEvento('auth', 'warn', {
                operazione: 'auth/indirizzo-accesso:allinea',
                esito: 'indirizzo-gia-di-un-altro-account',
                entita_id: authUserId,
            })
            return { stato: 'in-uso-da-altri' }
        }

        // `email_confirm: true` insieme all'indirizzo, e non è un dettaglio: senza,
        // GoTrue mette il nuovo indirizzo in attesa di conferma e il login resta
        // chiuso — cioè si sposterebbe il muro invece di toglierlo.
        const scritto = await admin.auth.admin.updateUserById(authUserId, {
            email: voluto,
            email_confirm: true,
        })
        if (scritto.error) {
            // La verità finale sulla collisione ce l'ha GoTrue: `utenti` può non
            // avere la riga dell'altro account. Il suo rifiuto non è un guasto.
            if (codiceErrore(scritto.error) === CODICE_GIA_IN_USO) {
                logEvento('auth', 'warn', {
                    operazione: 'auth/indirizzo-accesso:allinea',
                    esito: 'indirizzo-gia-di-un-altro-account',
                    entita_id: authUserId,
                })
                return { stato: 'in-uso-da-altri' }
            }
            logEvento('auth', 'error', {
                operazione: 'auth/indirizzo-accesso:allinea',
                esito: 'indirizzo-accesso-non-riscritto',
                entita_id: authUserId,
            }, scritto.error)
            return { stato: 'non-riuscito', dettaglio: 'la scrittura sull’account non è riuscita' }
        }

        // La copia applicativa. L'accesso ORA funziona già: se questa fallisce non
        // si torna indietro, ma non si tace — `utenti.email` disallineato spegne la
        // strada veloce di `findAuthUserIdByEmail`, e un difetto taciuto resta
        // invisibile finché non serve.
        const { error: erroreCopia } = await admin
            .from('utenti')
            .update({ email: voluto })
            .eq('id', authUserId)
        if (erroreCopia) {
            logEvento('auth', 'error', {
                operazione: 'auth/indirizzo-accesso:allinea',
                esito: 'copia-applicativa-indirizzo-indietro',
                entita_id: authUserId,
            }, erroreCopia)
        }

        // Regola 5 di AGENTS.md: gli eventi critici loggano anche il SUCCESSO.
        // Senza questa riga, «nessun log» non distingue «nessuno era divergente»
        // da «il riallineamento non parte più».
        //
        // ⚠️ NESSUN INDIRIZZO QUI DENTRO. `email` uscirebbe hashato, ma
        // `email_account` non è in lista bianca e cadrebbe nel ramo generico
        // `[redatto:str/N]`, che regala la LUNGHEZZA dell'indirizzo. Sono dati di
        // famiglie: si registra il fatto, non il dato. Chi deve vedere i due
        // indirizzi li ha davanti nel fascicolo.
        logEvento('auth', 'info', {
            operazione: 'auth/indirizzo-accesso:allinea',
            esito: 'indirizzo-accesso-allineato-all-anagrafica',
            entita_id: authUserId,
            copia_applicativa_indietro: Boolean(erroreCopia),
        })

        return { stato: 'allineato', da: attuale, a: voluto, copiaApplicativaIndietro: Boolean(erroreCopia) }
    } catch (errore) {
        // Fail-open: questa funzione vive dentro percorsi che non le appartengono.
        logEvento('auth', 'error', {
            operazione: 'auth/indirizzo-accesso:allinea',
            esito: 'allineamento-indirizzo-eccezione',
            entita_id: authUserId,
        }, errore)
        return { stato: 'sconosciuto' }
    }
}
