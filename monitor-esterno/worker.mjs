// IL MONITOR ESTERNO — un Worker di Cloudflare che guarda il sito DA FUORI ogni 5 minuti.
//
// Roadmap di robustezza, fase 3 (S2-A). Il campanello di GitHub (`campanello.yml`) sa già guardare il
// sito, la salute e il backup, aprire una segnalazione e mandare l'email. Quello che non sa fare è
// PARTIRE in orario: misurato il 09/10, i giri programmati arrivano ogni 3,5–7,5 ore invece che ogni
// 15 minuti (GitHub ritarda e salta i `cron`). Un sito fermo poteva restare senza allarme per ore.
//
// Questo Worker non duplica l'allarme: lo fa SUONARE in tempo. Ogni 5 minuti (cron di Cloudflare,
// puntuale):
//   1. legge `/api/health/vivo` (due tentativi a 20 secondi: uno scatto di rete non sveglia nessuno);
//   2. se il vivo NON risponde 200, fa partire subito il campanello (`workflow_dispatch`), che
//      ricontrolla con i suoi tre tentativi, apre la segnalazione e manda l'email;
//   3. ogni quarto d'ora (:00, :15, :30, :45) lo fa partire comunque: è il «battito» che dà al
//      campanello il ritmo che il suo `cron` non rispetta, e che il campanello stesso sorveglia
//      (`monitor-esterno-muto`: se il battito manca da troppo, l'allarme parte da GitHub).
//
// COSA NON FA MAI: non ha un indirizzo pubblico (`workers_dev = false`), non legge dati delle famiglie
// (il vivo dice solo «DB e login rispondono»), non scrive nel log il token.
//
// IL SEGRETO è uno solo, `GITHUB_TOKEN_CAMPANELLO`: un token GitHub a grana fine, limitato a QUESTO
// repository e al solo permesso «Actions: read and write». Scade: la data sta in `docs/cicd.md`, e se
// scade il battito si ferma e il campanello lo dice da solo.
//
// Si prova con `__tests__/lib/monitor-esterno.test.ts` (numeri letterali, fetch finto). Si pubblica
// con `npx wrangler@4.148.0 deploy` da questa cartella; si spegne con `npx wrangler@4.148.0 delete`.

export const URL_VIVO = 'https://app.kidville.it/api/health/vivo'
export const REPO = 'erricoluigi17/kidville-web'
export const WORKFLOW = 'campanello.yml'
/** L'input che il campanello usa per riconoscere i giri partiti da qui (vedi `campanello.yml`). */
export const ORIGINE = 'cloudflare'

const TENTATIVI_VIVO = 2
const ATTESA_TRA_TENTATIVI_MS = 20_000
const TEMPO_MAX_RICHIESTA_MS = 10_000
/** Il battito: un giro del campanello ogni `MINUTI_BATTITO` minuti anche se il vivo è sano. */
export const MINUTI_BATTITO = 15

/** Una lettura del vivo: `{ ok, http, motivo }`. Non lancia mai. */
export async function leggiVivo({ fetchImpl = fetch, dormi = attendi } = {}) {
    let ultimo = { ok: false, http: null, motivo: 'nessun tentativo' }
    for (let i = 0; i < TENTATIVI_VIVO; i++) {
        if (i > 0) await dormi(ATTESA_TRA_TENTATIVI_MS)
        try {
            const res = await fetchImpl(URL_VIVO, {
                headers: { 'User-Agent': 'kidville-monitor-esterno', 'Cache-Control': 'no-cache' },
                signal: AbortSignal.timeout(TEMPO_MAX_RICHIESTA_MS),
            })
            // Il corpo si legge comunque: tiene viva la connessione onesta e serve al log se non è 200.
            const corpo = (await res.text()).slice(0, 200)
            if (res.status === 200) return { ok: true, http: 200, motivo: 'ok' }
            ultimo = { ok: false, http: res.status, motivo: corpo.replace(/\s+/g, ' ') }
        } catch (err) {
            ultimo = { ok: false, http: null, motivo: err instanceof Error ? err.name + ': ' + err.message : String(err) }
        }
    }
    return ultimo
}

/**
 * Fa partire il campanello. Restituisce `{ ok, http, corpo }`; non lancia sul rifiuto di GitHub.
 * Se GitHub rifiuta l'input `origine` (un `campanello.yml` che non lo dichiara ancora), riprova senza:
 * meglio un giro non riconoscibile che nessun giro.
 */
export async function suonaCampanello({ token, fetchImpl = fetch }) {
    if (!token) return { ok: false, http: 0, corpo: 'manca GITHUB_TOKEN_CAMPANELLO: il campanello NON parte' }
    const chiama = async (inputs) => {
        const res = await fetchImpl(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'kidville-monitor-esterno',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ref: 'main', ...(inputs ? { inputs } : {}) }),
            signal: AbortSignal.timeout(TEMPO_MAX_RICHIESTA_MS),
        })
        // 204 = partito. Il corpo di un rifiuto si tiene sempre: «Bad credentials» dice che il token è scaduto.
        return { ok: res.status === 204, http: res.status, corpo: (await res.text()).slice(0, 300) }
    }
    try {
        const primo = await chiama({ origine: ORIGINE })
        if (primo.ok || primo.http !== 422 || !/unexpected inputs/i.test(primo.corpo)) return primo
        return await chiama(null)
    } catch (err) {
        return { ok: false, http: null, corpo: err instanceof Error ? err.name + ': ' + err.message : String(err) }
    }
}

/**
 * Un giro. `quando` = l'ora PROGRAMMATA del cron (non quella effettiva): il battito cade sui quarti
 * d'ora anche se Cloudflare parte con qualche secondo di ritardo.
 * Restituisce `{ vivo, battito, suonato, esito }` e scrive UNA riga di log.
 */
export async function giro({ quando, token, fetchImpl = fetch, dormi = attendi, log = (r) => console.log(r) }) {
    const vivo = await leggiVivo({ fetchImpl, dormi })
    const battito = quando.getUTCMinutes() % MINUTI_BATTITO === 0
    if (vivo.ok && !battito) {
        log(`monitor: vivo ok, nessun giro del campanello`)
        return { vivo, battito, suonato: false, esito: null }
    }
    const esito = await suonaCampanello({ token, fetchImpl })
    const perche = vivo.ok ? 'battito' : `vivo NON ok (HTTP ${vivo.http ?? 'nessuna risposta'}: ${vivo.motivo})`
    if (esito.ok) {
        log(`monitor: ${perche} → campanello partito`)
    } else {
        // Il corpo del rifiuto va nel log intero (senza il token, che non è nel corpo): è il «perché».
        console.error(`monitor: ${perche} → campanello NON partito: HTTP ${esito.http ?? '-'} ${esito.corpo}`)
    }
    return { vivo, battito, suonato: esito.ok, esito }
}

function attendi(ms) {
    return new Promise((r) => setTimeout(r, ms))
}

const worker = {
    async scheduled(controller, env, ctx) {
        ctx.waitUntil(giro({ quando: new Date(controller.scheduledTime), token: env.GITHUB_TOKEN_CAMPANELLO }))
    },
}

export default worker
