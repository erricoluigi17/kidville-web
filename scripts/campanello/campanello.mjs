// IL CAMPANELLO — gira ogni ~15 minuti dal workflow `campanello.yml`.
//
// Roadmap di robustezza, fase 3 (S2-D). Guarda tre cose e, se una non va, apre una segnalazione nel
// repository e manda un'email; quando rientra, la chiude da sola:
//
//   1. IL VIVO     `/api/health/vivo` — database e login. Tre tentativi a 15 secondi l'uno dall'altro:
//                  un singolo scatto di rete non sveglia nessuno.
//   2. LA SALUTE   `/api/health` — cron, errori del server, configurazione, coda fatture, regione.
//                  Si conta solo ciò che c'è in DUE letture a 45 secondi: un `degraded` che dura un
//                  minuto è rumore, uno che dura è un guasto.
//   3. IL BACKUP   l'ultimo giro AUTOMATICO riuscito di `backup-notturno.yml`. È l'unico modo di
//                  accorgersi che il backup NON È PARTITO: GitHub avvisa solo di un giro che parte e
//                  fallisce, e il primo giro programmato (2026-10-06) è partito con 6 h 45 min di
//                  ritardo. Qui GitHub è l'unica fonte che sa la verità, ed ha già un token: chiederlo
//                  dall'app, da indirizzi condivisi di Vercel, sarebbe a 60 richieste l'ora.
//
// È un RINFORZO, non il campanello definitivo: i cron di GitHub ritardano di 10-30 minuti e a volte
// saltano un giro. Il campanello vero è un monitor esterno sul `/api/health/vivo` (vedi
// `docs/cicd.md`); questo copre il tempo finché non c'è, senza nessun account nuovo.
//
// Il giro NON fallisce quando trova un incidente: l'allarme è la segnalazione + l'email. Fallisce solo
// se l'allarme non riesce a partire (email rifiutata o impossibile), perché un campanello che non sa
// suonare deve dirlo ad alta voce — e «workflow fallito» è un'email che arriva da GitHub per conto suo.

import { pathToFileURL } from 'node:url'
import { allarma, creaGitHub } from './allarme.mjs'
import { leggi, leggiConTentativi } from './lettura.mjs'
import { riconcilia, valutaBackup, valutaSalute, valutaVivo } from './valuta.mjs'

const ATTESA_TRA_TENTATIVI_VIVO_MS = 15_000
const ATTESA_TRA_LETTURE_SALUTE_MS = 45_000

/**
 * Un giro del campanello. Tutte le dipendenze sono iniettabili: `adesso`, `dormi`, `fetchImpl`, `gh`.
 * Restituisce `{ incidenti, esiti, errori }`; `errori` non vuoto = il giro deve fallire.
 */
export async function esegui({
    urlBase,
    gh,
    segreti,
    linkGiro,
    simulaGuasto = false,
    adesso = () => Date.now(),
    dormi = (ms) => new Promise((r) => setTimeout(r, ms)),
    fetchImpl = fetch,
    log = (riga) => console.log(riga),
}) {
    const incidenti = []
    const errori = []
    // Le chiavi che questo giro ha davvero misurato (vedi `riconcilia`): una segnalazione si chiude solo
    // se la sua chiave è fra queste. `prova` è sempre verificata, così un giro normale chiude la prova.
    const verificate = new Set(['prova'])
    const eVerificata = (chiave) => verificate.has(chiave) || [...verificate].some((p) => p.endsWith(':') && chiave.startsWith(p))

    if (simulaGuasto) {
        // Un allarme mai visto suonare non è un allarme. Non si controlla niente: si fabbrica l'incidente
        // e lo si porta fino all'email. La segnalazione resta aperta e il giro SUCCESSIVO, che non lo
        // trova fra gli incidenti veri, la chiude da sola — il che prova anche il percorso della chiusura.
        incidenti.push({
            chiave: 'prova',
            titolo: 'PROVA dell’allarme (nessun guasto vero)',
            dettaglio: 'Guasto simulato su richiesta.',
        })
    } else {
        const vivo = await leggiConTentativi(`${urlBase}/api/health/vivo`, {
            tentativi: 3,
            attesaMs: ATTESA_TRA_TENTATIVI_VIVO_MS,
            dormi,
            fetchImpl,
        })
        const incVivo = valutaVivo(vivo)
        log(`vivo: HTTP ${vivo.http ?? 'nessuna risposta'} → ${incVivo ? 'INCIDENTE' : 'ok'}`)
        verificate.add('app-giu')
        if (incVivo) {
            incidenti.push(incVivo)
        } else {
            verificate.add('salute:')
            // Se il sito è giù il dettaglio sta già nell'incidente del vivo: non si duplica con la salute.
            const prima = valutaSalute(await leggi(`${urlBase}/api/health`, { fetchImpl }))
            let persistenti = []
            if (prima.length > 0) {
                await dormi(ATTESA_TRA_LETTURE_SALUTE_MS)
                const seconda = valutaSalute(await leggi(`${urlBase}/api/health`, { fetchImpl }))
                const chiavi = new Set(seconda.map((i) => i.chiave))
                persistenti = prima.filter((i) => chiavi.has(i.chiave))
            }
            log(`salute: ${prima.length} da guardare, ${persistenti.length} persistenti`)
            incidenti.push(...persistenti)
        }

        try {
            const giri = await gh.giriBackupRiusciti()
            const incBackup = valutaBackup({ giri, adesso: adesso() })
            log(`backup: ${giri.length} giri automatici riusciti letti → ${incBackup ? 'INCIDENTE' : 'ok'}`)
            verificate.add('backup-vecchio')
            if (incBackup) incidenti.push(incBackup)
        } catch (err) {
            // Non si apre un incidente su una lettura mancata: si dice, e il giro dopo riprova.
            log(`::warning::età del backup non verificabile in questo giro: ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    const aperte = await gh.elencaAperte()
    const { apri, ricorda, chiudi } = riconcilia({ aperte, attuali: incidenti, adesso: adesso(), verificate: eVerificata })
    const quando = new Date(adesso()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

    for (const incidente of apri) {
        const { numero, email } = await allarma({
            gh,
            incidente,
            linkGiro,
            quando,
            prova: incidente.chiave === 'prova',
            segreti,
            fetchImpl,
        })
        log(`aperta la segnalazione #${numero} [${incidente.chiave}]; email: ${email.ok ? 'spedita' : `NON spedita (${email.stato}) ${email.corpo}`}`)
        if (!email.ok) errori.push(`email di allarme per [${incidente.chiave}] non partita: ${email.stato} ${email.corpo}`)
    }
    for (const { incidente, numero } of ricorda) {
        await gh.commenta(
            numero,
            `Promemoria: l'incidente è ancora presente (${quando}).\n\n${incidente.dettaglio}\n\n- giro: ${linkGiro}`,
        )
        log(`promemoria sulla segnalazione #${numero} [${incidente.chiave}]`)
    }
    for (const { chiave, numero } of chiudi) {
        await gh.chiudi(numero, `Rientrato (${quando}): il campanello non vede più [${chiave}]. Chiudo.\n\n- giro: ${linkGiro}`)
        log(`chiusa la segnalazione #${numero} [${chiave}]`)
    }

    return { incidenti, esiti: { aperte: apri.length, ricordate: ricorda.length, chiuse: chiudi.length }, errori }
}

async function main() {
    const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID, RESEND_API_KEY, SENTINELLA_DESTINATARI } = process.env
    const urlBase = (process.env.URL_BASE || 'https://app.kidville.it').replace(/\/+$/, '')
    if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
        console.error('::error::mancano GITHUB_TOKEN o GITHUB_REPOSITORY: il campanello non può aprire segnalazioni')
        process.exit(1)
    }
    const gh = creaGitHub({ repo: GITHUB_REPOSITORY, token: GITHUB_TOKEN })
    const linkGiro = `${GITHUB_SERVER_URL ?? 'https://github.com'}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID ?? ''}`
    const esito = await esegui({
        urlBase,
        gh,
        segreti: { chiaveResend: RESEND_API_KEY, destinatari: SENTINELLA_DESTINATARI },
        linkGiro,
        simulaGuasto: process.env.SIMULA_GUASTO === 'true',
    })
    console.log(`fine: ${esito.incidenti.length} incidenti, ${JSON.stringify(esito.esiti)}`)
    if (esito.errori.length > 0) {
        for (const e of esito.errori) console.error(`::error::${e}`)
        process.exit(1)
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error(`::error::il campanello è caduto: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
        process.exit(1)
    })
}
