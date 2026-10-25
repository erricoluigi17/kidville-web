// LA GUARDIA DELLE 20 ORE del backup notturno. La chiama il job `guardia` di
// `.github/workflows/backup-notturno.yml`, SOLO sui giri dello `schedule` di GitHub.
//
// Robustezza, seconda serie, sessione 4 (S4). Il backup lo lancia alle 02:23 UTC il monitor esterno
// (Worker di Cloudflare, `origine=cloudflare`). Lo `schedule` di GitHub resta come riserva, ma arriva
// fra le 07:00 e le 09:35 UTC (8 notti misurate, rapporto del 20/10): senza guardia farebbe un secondo
// backup completo nella stessa mattina, nella punta delle scuole.
//
// Regola: se un backup COMPLETO è riuscito nelle ultime 20 ore, questo giro si annulla (lo annulla il
// passo dopo del workflow, con `gh run cancel`). 20 ore stanno sopra il ritardo peggiore dello schedule
// (7 h 12 min) e sotto la distanza fra due notti (24 h): la notte dopo non viene mai saltata.
//
// FAIL-OPEN: se non riesce a leggere i giri (rete, token, risposta strana) il backup PARTE. Due copie in
// una notte costano qualche centesimo; nessuna copia costa i dati.
//
// Nessun segreto: usa il token che GitHub dà a ogni giro. Non stampa nomi né dati: solo numeri di giro,
// ore e l'esito.

import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const WORKFLOW = 'backup-notturno.yml'
export const ORE_GUARDIA = 20
/** Il titolo (`run-name`) di un giro completo: «Backup notturno completo», con o senza « (da Cloudflare)». */
export const TITOLO_COMPLETO = 'Backup notturno completo'
const ORA_MS = 3_600_000
const TEMPO_MAX_MS = 15_000

/**
 * Vale come «backup completo riuscito» un giro riuscito, che non è QUESTO giro, ed è completo: un giro
 * dello `schedule` (sempre completo) o un giro il cui titolo dice «completo» (il Worker, o il titolare
 * a mano). Un giro di `prova` non vale: scrive solo sotto `prove/`.
 */
export function eCompletoRiuscito(g, idCorrente) {
    if (!g || g.conclusion !== 'success') return false
    if (String(g.id) === String(idCorrente)) return false
    if (g.event === 'schedule') return true
    return typeof g.display_title === 'string' && g.display_title.startsWith(TITOLO_COMPLETO)
}

/** La decisione, pura: `{ salta, perche }`. `adesso` in millisecondi. */
export function decidi({ giri, adesso, idCorrente }) {
    for (const g of giri ?? []) {
        if (!eCompletoRiuscito(g, idCorrente)) continue
        const fine = Date.parse(g.updated_at)
        if (!Number.isFinite(fine) || fine > adesso) continue
        const ore = (adesso - fine) / ORA_MS
        if (ore <= ORE_GUARDIA) {
            return { salta: true, perche: `backup completo già riuscito ${ore.toFixed(1)} ore fa (giro ${g.id}): questo giro dello schedule si annulla` }
        }
    }
    return { salta: false, perche: `nessun backup completo riuscito nelle ultime ${ORE_GUARDIA} ore: il backup parte` }
}

/** Legge i giri riusciti e decide. Non lancia mai: un guasto qui = il backup parte. */
export async function esegui({ repo, token, idCorrente, adesso = Date.now(), fetchImpl = fetch, log = (r) => console.log(r) }) {
    try {
        if (!repo || !token) throw new Error('mancano GITHUB_REPOSITORY o GH_TOKEN')
        const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs?status=success&per_page=30`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'kidville-guardia-backup',
            },
            signal: AbortSignal.timeout(TEMPO_MAX_MS),
        })
        const testo = await res.text()
        if (res.status !== 200) throw new Error(`GitHub ha risposto HTTP ${res.status}: ${testo.slice(0, 300)}`)
        const giri = JSON.parse(testo)?.workflow_runs
        if (!Array.isArray(giri)) throw new Error('risposta senza workflow_runs')
        const d = decidi({ giri, adesso, idCorrente })
        log(`guardia: esito=${d.salta ? 'salta' : 'parte'} giri_letti=${giri.length} · ${d.perche}`)
        return d
    } catch (err) {
        const motivo = err instanceof Error ? err.message : String(err)
        log(`::warning::guardia: esito=non-verificabile, il backup parte comunque: ${motivo}`)
        return { salta: false, perche: `non verificabile: ${motivo}` }
    }
}

async function main() {
    const d = await esegui({ repo: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN, idCorrente: process.env.GITHUB_RUN_ID })
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `salta=${d.salta ? 'true' : 'false'}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.log(`::warning::guardia caduta, il backup parte comunque: ${err instanceof Error ? err.message : String(err)}`)
    })
}
