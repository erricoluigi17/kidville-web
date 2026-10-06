// LA VERIFICA DOPO IL DEPLOY — gira dal workflow `dopo-deploy.yml` a ogni rilascio in produzione.
//
// Roadmap di robustezza, fase 3 (S2-C) e «dalla fase 1»: un deploy rotto, o che ha perso la regione
// `dub1`, non deve aspettare la telefonata di un genitore. Prima di questo file nessuno guardava il
// sito DOPO un rilascio: `next build` non legge `vercel.json`, quindi eslint, tsc, vitest e build
// non si accorgono di una regione persa, e il sito continua a funzionare — solo più lento.
//
// COSA FA, in ordine:
//   1. aspetta che il dominio di produzione serva QUESTO rilascio (`versione` = lo sha del deploy),
//      fino a 10 minuti: l'evento di Vercel arriva quando il deploy è pronto, ma l'alias può metterci
//      un momento. Se nel frattempo è andato in produzione un rilascio PIÙ NUOVO, questo giro si ferma
//      (ci pensa la verifica di quello);
//   2. controlla il vivo (database + login), la regione (`dub1`, nel corpo e in `x-vercel-id`) e la
//      salute (`down` ferma; `degraded` è solo una nota: non l'ha causato il deploy);
//   3. se è tutto a posto chiude le segnalazioni `deploy:*` rimaste aperte; se no ne apre una e manda
//      l'email, poi fa fallire il giro.
//
// SI TESTA IL DOMINIO DI PRODUZIONE, NON L'URL DEL DEPLOY: gli URL `*.vercel.app` stanno dietro il
// login di Vercel (302 a `vercel.com/sso-api`, verificato il 2026-10-06) e una Preview non ha un
// dominio pubblico. Per questo il workflow gira solo sull'ambiente `Production`.

import { pathToFileURL } from 'node:url'
import { allarma, creaGitHub } from './allarme.mjs'
import { valutaDopoDeploy } from './valuta.mjs'
import { leggi } from './lettura.mjs'

const TENTATIVI_VERSIONE = 30
const ATTESA_VERSIONE_MS = 20_000

/** Quanti caratteri dello sha confronta la verifica: l'app ne dichiara 12. */
const LUNGHEZZA_SHA = 12

function breveSha(sha) {
    return String(sha ?? '').trim().toLowerCase().slice(0, LUNGHEZZA_SHA)
}

/**
 * Aspetta che il vivo dichiari `shaAtteso`. Restituisce:
 *  · `{ stato: 'allineato', vivo }`  — il sito serve questo rilascio;
 *  · `{ stato: 'superato', versione }` — serve già un rilascio PIÙ NUOVO: non è affare di questo giro;
 *  · `{ stato: 'senza-versione', vivo }` — l'app non dichiara la versione (variabile non esposta):
 *    si verifica comunque, dicendolo;
 *  · `{ stato: 'diverso', vivo, versione }` — dopo l'attesa serve ancora un'altra cosa: guasto.
 */
export async function aspettaVersione({ urlBase, shaAtteso, gh, dormi, fetchImpl, log }) {
    const atteso = breveSha(shaAtteso)
    let ultimo = { http: null, corpo: null, intestazioni: null }
    for (let i = 0; i < TENTATIVI_VERSIONE; i++) {
        ultimo = await leggi(`${urlBase}/api/health/vivo`, { fetchImpl })
        const versione = ultimo.corpo?.versione
        if (ultimo.http === 200 && versione === undefined) return { stato: 'senza-versione', vivo: ultimo }
        if (typeof versione === 'string' && versione === atteso) return { stato: 'allineato', vivo: ultimo }
        log(`tentativo ${i + 1}/${TENTATIVI_VERSIONE}: il sito serve ${versione ?? 'niente'} (HTTP ${ultimo.http ?? 'nessuna risposta'}), attendo ${atteso}`)
        if (i < TENTATIVI_VERSIONE - 1) await dormi(ATTESA_VERSIONE_MS)
    }
    const versione = ultimo.corpo?.versione
    if (typeof versione === 'string') {
        try {
            const posizione = await gh.confronta(atteso, versione)
            // `ahead` = quello servito è un discendente del nostro: è venuto DOPO.
            if (posizione === 'ahead') return { stato: 'superato', versione }
        } catch (err) {
            log(`::warning::non riesco a confrontare ${atteso} con ${versione}: ${err instanceof Error ? err.message : String(err)}`)
        }
    }
    return { stato: 'diverso', vivo: ultimo, versione }
}

export async function esegui({
    urlBase,
    shaAtteso,
    gh,
    segreti,
    linkGiro,
    adesso = () => Date.now(),
    dormi = (ms) => new Promise((r) => setTimeout(r, ms)),
    fetchImpl = fetch,
    log = (riga) => console.log(riga),
}) {
    const attesa = await aspettaVersione({ urlBase, shaAtteso, gh, dormi, fetchImpl, log })
    if (attesa.stato === 'superato') {
        log(`il sito serve già ${attesa.versione}, più nuovo di ${breveSha(shaAtteso)}: la verifica di quel rilascio vale per entrambi`)
        return { esito: 'superato', guasti: [], note: [] }
    }

    const guasti = []
    const note = []
    let vivo = attesa.vivo
    if (attesa.stato === 'diverso') {
        guasti.push(`dopo 10 minuti il sito serve ancora ${attesa.versione ?? 'nessuna versione'}, non ${breveSha(shaAtteso)}`)
    }
    if (attesa.stato === 'senza-versione') {
        note.push('l’app non dichiara la versione: non posso confermare che sia il rilascio nuovo')
    }

    const salute = await leggi(`${urlBase}/api/health`, { fetchImpl })
    const valutazione = valutaDopoDeploy({
        vivo,
        salute,
        intestazioneVercelId: vivo.intestazioni?.get?.('x-vercel-id') ?? undefined,
    })
    guasti.push(...valutazione.guasti)
    note.push(...valutazione.note)

    const chiave = `deploy:${breveSha(shaAtteso).slice(0, 7)}`
    const aperte = await gh.elencaAperte()
    const deployAperti = aperte.filter((a) => /^\[deploy:/.test(a.titolo))
    const quando = new Date(adesso()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

    for (const n of note) log(`nota: ${n}`)

    if (guasti.length === 0) {
        // Un rilascio buono chiude le segnalazioni dei rilasci rotti precedenti: il sito sta bene ora.
        for (const a of deployAperti) {
            await gh.chiudi(a.numero, `Rientrato (${quando}): il rilascio ${breveSha(shaAtteso).slice(0, 7)} è verificato e il sito sta bene. Chiudo.\n\n- giro: ${linkGiro}`)
            log(`chiusa la segnalazione #${a.numero}`)
        }
        log(`rilascio ${breveSha(shaAtteso).slice(0, 7)} verificato`)
        return { esito: 'ok', guasti, note }
    }

    for (const g of guasti) log(`::error::${g}`)
    let emailOk = true
    if (!deployAperti.some((a) => a.titolo.startsWith(`[${chiave}]`))) {
        const { numero, email } = await allarma({
            gh,
            incidente: {
                chiave,
                titolo: `Il rilascio ${breveSha(shaAtteso).slice(0, 7)} non passa la verifica`,
                dettaglio: guasti.join(' | ').slice(0, 300),
            },
            linkGiro,
            quando,
            segreti,
            fetchImpl,
        })
        log(`aperta la segnalazione #${numero}; email: ${email.ok ? 'spedita' : `NON spedita (${email.stato}) ${email.corpo}`}`)
        emailOk = email.ok
    }
    return { esito: 'guasto', guasti, note, emailOk }
}

async function main() {
    const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID, RESEND_API_KEY, SENTINELLA_DESTINATARI, SHA_ATTESO } = process.env
    const urlBase = (process.env.URL_BASE || 'https://app.kidville.it').replace(/\/+$/, '')
    if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
        console.error('::error::mancano GITHUB_TOKEN o GITHUB_REPOSITORY')
        process.exit(1)
    }
    if (!/^[0-9a-f]{7,40}$/i.test(SHA_ATTESO ?? '')) {
        console.error('::error::SHA_ATTESO assente o non è uno sha: non so quale rilascio verificare')
        process.exit(1)
    }
    const gh = creaGitHub({ repo: GITHUB_REPOSITORY, token: GITHUB_TOKEN })
    const linkGiro = `${GITHUB_SERVER_URL ?? 'https://github.com'}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID ?? ''}`
    const esito = await esegui({
        urlBase,
        shaAtteso: SHA_ATTESO,
        gh,
        segreti: { chiaveResend: RESEND_API_KEY, destinatari: SENTINELLA_DESTINATARI },
        linkGiro,
    })
    if (esito.esito === 'guasto') {
        console.error(`::error::il rilascio non passa la verifica: ${esito.guasti.join(' | ')}`)
        process.exit(1)
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error(`::error::la verifica dopo il deploy è caduta: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
        process.exit(1)
    })
}
