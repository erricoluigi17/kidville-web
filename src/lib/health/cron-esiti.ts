import type { Valutazione } from './valutazione'

/**
 * GLI ESITI DEI CRON, LETTI DA `pg_cron` E NON DAL BATTITO (sessione 7 della seconda serie).
 *
 * `cron-battito` guarda il battito che una route o una funzione scrive in `app_log`: vede solo i
 * job che lo scrivono, e non può guardare i mensili (`app_log` conserva 30 giorni, vedi
 * `JOB_CRON_NON_SORVEGLIATI`). La sessione 6 ha dato a ogni job una riga che non scade,
 * `cron_ultimo_esito`, aggiornata ogni 10 minuti dalla funzione `cron_esiti`; la RPC
 * `salute_cron_esiti` la porta qui con il nome e la cadenza di ogni job ATTIVO di `cron.job`.
 * Questo modulo decide, e non fa I/O.
 *
 * LA REGOLA. Un job è un allarme quando non ha avuto un esito BUONO dentro la finestra della sua
 * cadenza. Un fallimento solo, con un esito buono recente, si dice e non suona: un allarme che
 * suona per un giro andato storto viene spento. Un timeout del client di pg_net vale come vivo (la
 * route può aver finito lo stesso: è la riga `cron-http-timeout:<job>` della sessione 6). Per un job
 * HTTP vive la CHIAMATA: la sua esecuzione SQL riuscita conta solo finché il job non ha nessuna
 * chiamata chiusa, e solo se nessuna sua chiamata è aperta da più di 30 minuti (pg_net fermo). Dopo
 * la prima chiamata chiusa un giro SQL riuscito non vale più (un giro che non ha chiamato riesce lo
 * stesso), e non sono mai vive le chiamate respinte (errore-http, errore-rete) né quelle a esito
 * ignoto. Lo decide la RPC, che lo mette in `vivo_il`; dalla sessione 8 la RPC porta anche l'elenco
 * dichiarato dei job che chiamano solo quando hanno lavoro (`storici-stampe`): per loro l'esecuzione
 * SQL riuscita vale anche dopo la prima chiamata chiusa, purché l'ultima chiamata non sia stata
 * respinta. Un'ultima chiamata a esito ignoto fuori finestra si dice
 * a parte: vuol dire che il lettore è rimasto fermo oltre 6 ore attorno al giro. Un job
 * che non è mai partito è «in attesa»: `cron.job` non dice quando un job è nato, quindi non si può
 * distinguere un job di ieri da uno che non parte da un mese — si scrive, non si indovina.
 *
 * LA FINESTRA. Per un job frequente: la cadenza più il triplo, con un margine fra 30 minuti e 2 ore
 * (`finestraDaIntervallo`). Per un giornaliero 24 ore + 2, per un settimanale 7 giorni + 2 ore, per
 * un mensile 31 giorni + 2 ore. Una cadenza che non si sa leggere non ha finestra e finisce nel
 * dettaglio («cadenza non letta»): il lock `__tests__/architecture/cadenze-cron-leggibili.test.ts`
 * pretende che ogni `cron.schedule` del repo ne abbia una.
 */

const MIN = 60_000
const ORA = 60 * MIN
const GIORNO = 24 * ORA

/** `ignoto`: l'ultima chiamata chiusa di un job HTTP ha esito ignoto (nessuna risposta letta entro
 *  6 ore). */
export type EsitoCron = 'ok' | 'fallito' | 'timeout' | 'ignoto'

export interface RigaCronEsito {
    job: string
    cadenza: string
    /** L'esito dell'ultimo giro; `null` = nessun giro registrato, o nessuna chiamata ancora chiusa. */
    esito: EsitoCron | null
    /** Quando è avvenuto l'ultimo giro (ms). */
    vistoIl: number | null
    /** L'ultima volta che il job era VIVO (ms): ultimo successo; per un job HTTP anche l'ultimo timeout
     *  del client e, solo finché non ha nessuna chiamata chiusa, l'ultima esecuzione SQL riuscita, se
     *  nessuna chiamata è aperta da più di 30 minuti. Mai una chiamata respinta o a esito ignoto. */
    vivoIl: number | null
}

/** Oltre quanti minuti senza nessuna data nuova `cron-esiti` (il job della sessione 6) è fermo:
 *  tre giri da 10 minuti. Con un job che gira ogni minuto, una data più vecchia vuol dire che
 *  nessuno aggiorna più `cron_ultimo_esito`. */
export const MINUTI_CRON_ESITI_FERMO = 30

const ESITI_CRON: ReadonlySet<string> = new Set(['ok', 'fallito', 'timeout', 'ignoto'])
const RE_PARTE = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/

/** La finestra di un job che gira ogni `minuti`: la cadenza più il triplo, margine fra 30 e 120. */
export function finestraDaIntervallo(minuti: number): number {
    return (minuti + Math.min(120, Math.max(30, 3 * minuti))) * MIN
}

/** I valori di un campo della cadenza (`*`, `5`, `1-5`, `*\/10`, `3-59/10`, separati da virgole). */
function espandi(campo: string, minimo: number, massimo: number): number[] | null {
    const valori = new Set<number>()
    for (const parte of campo.split(',')) {
        const m = RE_PARTE.exec(parte)
        if (!m) return null
        let da = minimo
        let a = massimo
        if (m[1] !== '*') {
            const estremi = m[1].split('-').map(Number)
            da = estremi[0]
            if (estremi.length === 2) a = estremi[1]
            else if (m[2] === undefined) a = estremi[0]
        }
        const passo = m[2] === undefined ? 1 : Number(m[2])
        if (passo < 1 || da < minimo || a > massimo || da > a) return null
        for (let v = da; v <= a; v += passo) valori.add(v)
    }
    return [...valori]
}

/** La finestra di una cadenza di `pg_cron` in millisecondi, o `null` se non si sa leggere. */
export function finestraDaCadenza(cadenza: string): number | null {
    const testo = cadenza.trim()
    const secondi = /^(\d+) seconds$/.exec(testo)
    if (secondi) {
        const n = Number(secondi[1])
        return n >= 1 && n <= 59 ? finestraDaIntervallo(n / 60) : null
    }
    const campi = testo.split(/\s+/)
    if (campi.length !== 5) return null
    const [minuti, ore, giornoMese, mese, giornoSettimana] = campi
    if (mese !== '*') return null
    if (giornoMese !== '*' && giornoSettimana !== '*') return null
    const valoriMinuti = espandi(minuti, 0, 59)
    const valoriOre = espandi(ore, 0, 23)
    if (valoriMinuti === null || valoriOre === null) return null
    if (giornoSettimana !== '*') return /^[0-7]$/.test(giornoSettimana) ? 7 * GIORNO + 2 * ORA : null
    if (giornoMese !== '*') {
        const giorno = /^\d+$/.test(giornoMese) ? Number(giornoMese) : 0
        return giorno >= 1 && giorno <= 28 ? 31 * GIORNO + 2 * ORA : null
    }
    // Ogni giorno: il salto più lungo fra due istanti consecutivi, giro della mezzanotte compreso.
    const istanti = [...new Set(valoriOre.flatMap((h) => valoriMinuti.map((m) => h * 60 + m)))].sort((x, y) => x - y)
    let salto = 0
    istanti.forEach((t, i) => {
        const prossimo = i + 1 < istanti.length ? istanti[i + 1] : istanti[0] + 24 * 60
        salto = Math.max(salto, prossimo - t)
    })
    return finestraDaIntervallo(salto)
}

/** Un istante ISO in millisecondi; `null` se assente; `undefined` se c'è ma non si legge. */
function istante(valore: unknown): number | null | undefined {
    if (valore === null || valore === undefined) return null
    if (typeof valore !== 'string') return undefined
    const t = Date.parse(valore)
    return Number.isNaN(t) ? undefined : t
}

/** Le righe di `salute_cron_esiti`, o `null` se una sola non ha la forma attesa. */
export function leggiRigheCronEsiti(data: unknown): RigaCronEsito[] | null {
    if (!Array.isArray(data)) return null
    const righe: RigaCronEsito[] = []
    for (const grezza of data) {
        if (grezza === null || typeof grezza !== 'object') return null
        const r = grezza as Record<string, unknown>
        if (typeof r.job !== 'string' || r.job === '') return null
        if (typeof r.cadenza !== 'string') return null
        const esito = r.esito ?? null
        if (esito !== null && (typeof esito !== 'string' || !ESITI_CRON.has(esito))) return null
        const vistoIl = istante(r.visto_il)
        const vivoIl = istante(r.vivo_il)
        if (vistoIl === undefined || vivoIl === undefined) return null
        righe.push({ job: r.job, cadenza: r.cadenza, esito: esito as EsitoCron | null, vistoIl, vivoIl })
    }
    return righe
}

/** La decisione. Il dettaglio porta solo nomi di job e numeri. */
export function valutaCronEsiti(righe: readonly RigaCronEsito[], adesso: number): Valutazione {
    const n = righe.length
    if (n === 0) return { esito: 'degradato', dettaglio: 'nessun job attivo letto da cron.job' }

    const date = righe.flatMap((r) => [r.vistoIl, r.vivoIl]).filter((t): t is number => t !== null)
    if (date.length === 0) {
        return { esito: 'degradato', dettaglio: `${n} job attivi; nessun esito registrato: cron-esiti non ha mai scritto` }
    }
    const silenzio = adesso - Math.max(...date)
    if (silenzio > MINUTI_CRON_ESITI_FERMO * MIN) {
        return { esito: 'degradato', dettaglio: `${n} job attivi; cron-esiti fermo da ${Math.floor(silenzio / MIN)} min` }
    }

    const senzaEsitoBuono: string[] = []
    const ignoti: string[] = []
    const falliti: string[] = []
    const timeout: string[] = []
    const inAttesa: string[] = []
    const senzaCadenza: string[] = []
    for (const r of righe) {
        const finestra = finestraDaCadenza(r.cadenza)
        if (finestra === null) {
            senzaCadenza.push(r.job)
            continue
        }
        // «In attesa» solo se il job non è MAI stato visto girare: uno già visto, senza esito buono
        // (esito ignoto, esecuzioni fallite) è un allarme, non un'attesa che non finisce.
        if (r.vivoIl === null && r.esito === null && r.vistoIl === null) {
            inAttesa.push(r.job)
            continue
        }
        if (r.vivoIl === null || adesso - r.vivoIl > finestra) {
            senzaEsitoBuono.push(r.job)
            // Il perché, quando lo si sa: la risposta non è stata letta. Dentro la finestra non si dice.
            if (r.esito === 'ignoto') ignoti.push(r.job)
            continue
        }
        if (r.esito === 'fallito') falliti.push(r.job)
        else if (r.esito === 'timeout') timeout.push(r.job)
    }

    const parti = [`${n} job attivi`]
    if (senzaEsitoBuono.length > 0) parti.push(`senza un esito buono entro la finestra: ${senzaEsitoBuono.join(',')}`)
    if (ignoti.length > 0) {
        parti.push(`di questi, ultima chiamata a esito ignoto (lettore fermo oltre 6 ore attorno al giro): ${ignoti.join(',')}`)
    }
    if (falliti.length > 0) parti.push(`ultimo esito fallito, ancora nella finestra: ${falliti.join(',')}`)
    if (timeout.length > 0) parti.push(`timeout del client, vivi: ${timeout.join(',')}`)
    if (inAttesa.length > 0) parti.push(`in attesa del primo esito: ${inAttesa.join(',')}`)
    if (senzaCadenza.length > 0) parti.push(`cadenza non letta: ${senzaCadenza.join(',')}`)
    return { esito: senzaEsitoBuono.length > 0 ? 'degradato' : 'ok', dettaglio: parti.join('; ') }
}
