import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { sendEmailDetailed } from '@/lib/email/send'
import { risolviContestoSede } from '@/lib/email/contesto'
import { messaggioCredenziali } from '@/lib/email/messaggi/credenziali'
import { rigeneraPasswordPerInvito } from '@/lib/auth/password-invito'
import { pausaFraEmail } from '@/lib/email/ritmo'
import { logScrittura } from '@/lib/audit/scrittura'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'

// =============================================================================
// RIMANDARE LE CREDENZIALI A CHI NON È MAI ENTRATO — e le tre cose da non sbagliare.
//
// ─── IL FATTO, MISURATO ─────────────────────────────────────────────────────
// Il 2026-08-22 il cron ha spedito 67 credenziali a famiglie vere. 37 sono entrate
// (metodo `password`, letto da `auth.mfa_amr_claims`), 30 no, e alcune hanno
// telefonato in segreteria. Nessuna password era stata ruotata dopo l'invio: quelle
// che le 30 famiglie avevano in mano erano ancora quelle giuste. Il difetto stava
// nel VIAGGIO — 28 caratteri `base64url` con `l`/`I`/`1` e `O`/`0` indistinguibili,
// da trascrivere a mano su un telefono — ed è chiuso dal formato nuovo.
//
// Questa route rimanda le credenziali, nel formato nuovo, a chi non è mai entrato.
//
// ─── 1. CHI: SOLO `last_sign_in_at IS NULL`, MAI `updated_at` ───────────────
// In fase di analisi era stato scritto che «16 dei 37 avevano già scelto una
// password propria», dedotto da `updated_at > last_sign_in_at`. Alla verifica
// `parents.onboarded_at` era NULL per tutti e 67: `updated_at` si muove anche per
// ragioni che non sono un cambio password. Non sapendo chi abbia una password sua,
// **non se ne tocca nessuna**: si guarda l'unico dato che non ammette
// interpretazioni, cioè se quell'account abbia mai aperto una sessione.
//
// ─── 2. IL RICONTROLLO IMMEDIATAMENTE PRIMA ─────────────────────────────────
// Fra il momento in cui si sceglie la lista e il momento in cui si tocca la
// password possono passare minuti. In quei minuti un genitore può entrare — e si
// ritroverebbe la password strappata di mano mentre la sta usando. Per questo
// l'ultima parola non ce l'ha la lista: ce l'ha `getUserById`, chiamata per ogni
// account **subito prima** di rigenerare. È anche la ragione per cui questa route
// esiste invece di una `UPDATE` a mano sul registro: una SQL non può ricontrollare.
//
// ─── 3. LA PROVA DEL PRIMO RECAPITO NON SI CANCELLA ─────────────────────────
// `inviato_il` e `resend_message_id` restano intatti: sono la sola risposta possibile
// alla frase «non mi è mai arrivato niente». La seconda consegna scrive su colonne
// sue (`rigenerato_il`, `rigenerazioni`, `rigenerazione_message_id`).
//
// ⚠️ RESTA UN RISCHIO CHE NON SI PUÒ ELIMINARE, e va detto invece che nascosto:
// la password si invalida PRIMA di sapere se l'email parte, perché non esiste un
// ordine in cui l'invalidazione segua la consegna. Se l'invio fallisce, quella
// persona resta con una password che nessuno conosce. Non si può evitare, si può
// solo rendere RIMEDIABILE: sul fallimento la password finisce nella risposta
// all'operatore, che ha la famiglia al telefono in quel momento.
// =============================================================================

const OPERAZIONE = 'admin/iscrizioni/rinvia-credenziali:POST'

/**
 * Quante volte al massimo si rimanda. Oltre, il problema non è la password: è che
 * quell'indirizzo non riceve, e continuare a spedirci sopra nasconde il guasto vero.
 */
const MAX_RIGENERAZIONI = 3

const bodySchema = z.object({
    /** Prova a vuoto: conta e basta. Nessun claim, nessuna password, nessuna email. */
    dry_run: z.boolean().optional(),
    scuola_id: zUuid.optional(),
    max: z.number().int().min(1).max(100).optional(),
})

interface Esito {
    rimandate: number
    entratiNelFrattempo: number
    saltatiNonGenitore: number
    giaInCorso: number
    falliti: number
    /** Solo per gli invii falliti: la password è viva e nessuno la conosce. */
    daConsegnareAMano: Array<{ email: string; password: string }>
}

export const POST = withRoute('admin/iscrizioni/rinvia-credenziali:POST', async (request: Request) => {
    // Le credenziali in blocco sono un gesto della Direzione: `regenerate-credentials`
    // quella riserva la conosce già per lo staff, e qui si riscrivono password di
    // decine di famiglie in una volta sola.
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    if (auth.user.role !== 'admin' && auth.user.role !== 'coordinator') {
        return NextResponse.json(
            { error: 'Rinvio credenziali in blocco: operazione riservata alla Direzione', codice: 'RINVIO_CREDENZIALI_RISERVATO' },
            { status: 403 },
        )
    }

    const b = await parseBody(request, bodySchema)
    if ('response' in b) return b.response
    const dryRun = b.data.dry_run === true
    const massimo = b.data.max ?? 50

    const admin = await createAdminClient()

    // Le righe candidate: invito già spedito, e non ancora rimandato troppe volte.
    let query = admin
        .from('iscrizioni_inviti_credenziali')
        .select('auth_user_id, email, parent_id, inviato_il, rigenerazioni')
        .eq('stato', 'inviata')
        .lt('rigenerazioni', MAX_RIGENERAZIONI)
        .order('inviato_il', { ascending: true })
    if (b.data.scuola_id) {
        // La sede si legge dai genitori: il registro non la porta.
        const { data: dellaSede, error: erroreSede } = await admin
            .from('parents')
            .select('id')
            .eq('scuola_id', b.data.scuola_id)
        if (erroreSede) {
            logEvento('iscrizione', 'error', { operazione: OPERAZIONE, esito: 'sede-non-risolta' }, erroreSede)
            return NextResponse.json({ error: 'Sede non risolta', codice: 'RINVIO_SEDE_NON_RISOLTA' }, { status: 500 })
        }
        query = query.in('parent_id', (dellaSede ?? []).map((r) => String(r.id)))
    }

    const { data: righe, error } = await query
    if (error) {
        // PostgREST non lancia: ritorna `{ error }` (regola 7 di AGENTS.md).
        logEvento('iscrizione', 'error', { operazione: OPERAZIONE, esito: 'registro-non-letto' }, error)
        return NextResponse.json({ error: 'Registro inviti non letto', codice: 'REGISTRO_INVITI_NON_LETTO' }, { status: 500 })
    }

    const esito: Esito = {
        rimandate: 0,
        entratiNelFrattempo: 0,
        saltatiNonGenitore: 0,
        giaInCorso: 0,
        falliti: 0,
        daConsegnareAMano: [],
    }
    /** Chi risulta mai entrato: è il numero che la prova a vuoto deve restituire. */
    let candidati = 0

    for (const riga of righe ?? []) {
        if (esito.rimandate >= massimo) break

        const authUserId = String(riga.auth_user_id)
        const email = String(riga.email)

        // ── Il ricontrollo che una UPDATE non potrebbe fare ──────────────────
        const { data: utenteAuth, error: erroreAuth } = await admin.auth.admin.getUserById(authUserId)
        if (erroreAuth || !utenteAuth?.user) {
            logEvento('iscrizione', 'error', {
                operazione: OPERAZIONE, esito: 'account-non-letto', entita_id: authUserId,
            }, erroreAuth)
            esito.falliti++
            continue
        }
        if (utenteAuth.user.last_sign_in_at) {
            // È entrato fra la lista e adesso: la sua password sta funzionando, e
            // toccarla lo chiuderebbe fuori mentre la usa.
            esito.entratiNelFrattempo++
            continue
        }

        // ── Anti-lockout: solo genitori ──────────────────────────────────────
        // Copiata da `regenerate-credentials`, che quella lezione l'ha già pagata:
        // un'email che coincide con un account di staff non deve poter essere
        // resettata da questa strada.
        const { data: profilo } = await admin.from('utenti').select('ruolo').eq('id', authUserId).maybeSingle()
        if (!profilo || String(profilo.ruolo) !== 'genitore') {
            esito.saltatiNonGenitore++
            continue
        }

        candidati++
        if (dryRun) continue

        // ── Il claim: compare-and-swap su `rigenerazioni` ────────────────────
        // Due richieste concorrenti — un doppio clic, due operatrici sulla stessa
        // sede — consegnerebbero due password alla stessa famiglia, e la seconda
        // invaliderebbe la prima. Zero righe aggiornate = qualcun altro l'ha presa.
        const letto = Number(riga.rigenerazioni ?? 0)
        const { data: preso, error: erroreClaim } = await admin
            .from('iscrizioni_inviti_credenziali')
            .update({ rigenerazioni: letto + 1, rigenerato_il: new Date().toISOString() })
            .eq('auth_user_id', authUserId)
            .eq('rigenerazioni', letto)
            .select('auth_user_id')
        if (erroreClaim) {
            logEvento('iscrizione', 'error', {
                operazione: OPERAZIONE, esito: 'claim-non-scritto', entita_id: authUserId,
            }, erroreClaim)
            esito.falliti++
            continue
        }
        if (!preso || preso.length === 0) {
            esito.giaInCorso++
            continue
        }

        // ── Da qui in poi la password vecchia è morta ────────────────────────
        const nuova = await rigeneraPasswordPerInvito(admin, authUserId, OPERAZIONE)
        if (!nuova.ok) {
            logEvento('iscrizione', 'error', {
                operazione: OPERAZIONE, esito: 'password-non-rigenerata', entita_id: authUserId,
            })
            esito.falliti++
            continue
        }

        const sede = await risolviContestoSede(admin, null, OPERAZIONE)
        const messaggio = messaggioCredenziali(
            { nome: null, email, password: nuova.password, occasione: 'password-rigenerata' },
            sede,
        )
        const invio = await sendEmailDetailed({
            to: email,
            subject: messaggio.oggetto,
            text: messaggio.testo,
            html: messaggio.html,
        })

        if (!invio.ok) {
            // La password è viva e nessuno la conosce. Non si può tornare indietro:
            // la si consegna all'operatore, che ha la famiglia al telefono adesso.
            logEvento('iscrizione', 'error', {
                operazione: OPERAZIONE, esito: 'rinvio-non-spedito', entita_id: authUserId,
            })
            await admin
                .from('iscrizioni_inviti_credenziali')
                .update({ ultimo_errore: invio.error ?? 'invio non riuscito' })
                .eq('auth_user_id', authUserId)
            esito.falliti++
            esito.daConsegnareAMano.push({ email, password: nuova.password })
            await pausaFraEmail()
            continue
        }

        const { error: erroreRegistro } = await admin
            .from('iscrizioni_inviti_credenziali')
            .update({ rigenerazione_message_id: invio.messageId ?? null, ultimo_errore: null })
            .eq('auth_user_id', authUserId)
        if (erroreRegistro) {
            // Si grida, ma NON si conta come fallita: l'email è partita davvero, e
            // rispedire una password sarebbe peggio del registro disallineato.
            logEvento('iscrizione', 'error', {
                operazione: OPERAZIONE, esito: 'registro-rinvio-non-aggiornato', entita_id: authUserId,
            }, erroreRegistro)
        }

        // Il successo si logga (regola 5 di AGENTS.md): con i soli errori, «nessun
        // log» non distingue «tutto ok» da «non è mai partito niente».
        logEvento('iscrizione', 'info', {
            operazione: OPERAZIONE, esito: 'credenziali-rimandate', entita_id: authUserId,
        })
        await logScrittura(admin, {
            attore: auth.user,
            entitaTipo: 'credenziali',
            entitaId: authUserId,
            azione: 'update',
        })
        esito.rimandate++
        await pausaFraEmail()
    }

    logEvento('iscrizione', 'info', {
        operazione: OPERAZIONE,
        esito: dryRun ? 'rinvio-prova-a-vuoto' : 'rinvio-concluso',
        n: dryRun ? candidati : esito.rimandate,
    })

    return NextResponse.json({
        ok: true,
        dryRun,
        // In prova a vuoto è l'unico numero che conta: quanti riceverebbero.
        candidati,
        ...esito,
    })
})
