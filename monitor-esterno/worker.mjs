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
// IL BACKUP NOTTURNO (robustezza, seconda serie, sessione 4). Alle 02:23 UTC un secondo cron fa partire
// `backup-notturno.yml` con `modalita=completo` e `origine=cloudflare`: lo `schedule` di GitHub
// arrivava fra le 07:04 e le 09:35, sopra la punta delle scuole. Se il lancio non riesce, il Worker
// manda un'email (Resend). È il SECONDO CANALE: quando è GitHub a rifiutare, l'allarme del campanello
// non può partire. Vale anche quando il sito è giù e il campanello non parte.
//
// I SEGRETI sono tre, nei segreti del Worker e mai in `wrangler.toml` (il repository è pubblico):
//   · `GITHUB_TOKEN_CAMPANELLO`: token GitHub a grana fine, limitato a QUESTO repository e al solo
//     permesso «Actions: read and write». Scade (la data sta in `docs/cicd.md`): se scade, il battito
//     si ferma (il campanello lo dice da solo) e il backup delle 02:23 non parte (lo dice l'email);
//   · `RESEND_API_KEY` e `SENTINELLA_DESTINATARI`: gli stessi del campanello. Se mancano, il Worker lo
//     scrive in `console.error` e va avanti: il lancio del backup non dipende dall'email.
//
// Si prova con `__tests__/lib/monitor-esterno.test.ts` (numeri letterali, fetch finto). Si pubblica
// con `npx wrangler@4.148.0 deploy` da questa cartella; si spegne con `npx wrangler@4.148.0 delete`.
// Importa `scripts/campanello/allarme.mjs` (la stessa email del campanello): `wrangler` lo impacchetta.

import { escapeHtml, mandaEmail } from '../scripts/campanello/allarme.mjs'

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
/** Il backup notturno, che alle 02:23 UTC lancia questo Worker (lo `schedule` di GitHub arrivava fra le 07:04 e le 09:35). */
export const WORKFLOW_BACKUP = 'backup-notturno.yml'
/** Il cron di Cloudflare del backup: IDENTICO alla seconda voce di `crons` in `wrangler.toml` (un test li lega). */
export const CRON_BACKUP = '23 2 * * *'
/** Dove portano le email del Worker: l'elenco dei giri, non un giro (quello, appunto, non è partito). */
export const LINK_GIRI_BACKUP = `https://github.com/${REPO}/actions/workflows/${WORKFLOW_BACKUP}`
export const LINK_GIRI_CAMPANELLO = `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`

/** Le intestazioni di ogni chiamata a GitHub. Il token sta solo qui: non finisce mai in un log. */
function intestazioniGitHub(token) {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'kidville-monitor-esterno',
        'Content-Type': 'application/json',
    }
}

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
            headers: intestazioniGitHub(token),
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
 * Restituisce `{ vivo, battito, suonato, esito, email }` e scrive UNA riga di log (due se parte
 * l'email del secondo canale).
 */
export async function giro({ quando, token, segreti = {}, fetchImpl = fetch, dormi = attendi, log = (r) => console.log(r) }) {
    const vivo = await leggiVivo({ fetchImpl, dormi })
    const battito = quando.getUTCMinutes() % MINUTI_BATTITO === 0
    if (vivo.ok && !battito) {
        log(`monitor: vivo ok, nessun giro del campanello`)
        return { vivo, battito, suonato: false, esito: null, email: null }
    }
    const esito = await suonaCampanello({ token, fetchImpl })
    const perche = vivo.ok ? 'battito' : `vivo NON ok (HTTP ${vivo.http ?? 'nessuna risposta'}: ${vivo.motivo})`
    if (esito.ok) {
        log(`monitor: ${perche} → campanello partito`)
        return { vivo, battito, suonato: true, esito, email: null }
    }
    // Il corpo del rifiuto va nel log intero (senza il token, che non è nel corpo): è il «perché».
    console.error(`monitor: ${perche} → campanello NON partito: HTTP ${esito.http ?? '-'} ${esito.corpo}`)
    // Un battito rifiutato col sito sano NON manda email: lo vede il campanello stesso
    // (`monitor-esterno-muto`), e un token scaduto lo dice comunque l'email del backup delle 02:23.
    if (vivo.ok) return { vivo, battito, suonato: false, esito, email: null }
    // IL SECONDO CANALE (T12): sito giù E campanello fermo = l'allarme normale non arriverà.
    // Un'email per ora (la chiave di Resend), con un testo che dentro l'ora NON cambia: a una stessa
    // chiave con un messaggio diverso Resend risponde 409. Il guasto preciso è nella riga qui sopra.
    const iso = quando.toISOString()
    const email = await avvisaPerEmail({
        segreti,
        chiave: chiaveIdempotenza('vivo', quando),
        oggetto: 'Sito giù e campanello NON partito',
        introHtml:
            'Il monitor esterno vede il sito giù e non riesce a far partire il campanello di GitHub: la ' +
            'segnalazione e l’email normali NON arriveranno. Il motivo esatto è nei log del Worker ' +
            '<code>kidville-monitor-esterno</code> (pannello Cloudflare → Workers → Logs).',
        link: LINK_GIRI_CAMPANELLO,
        quando: `dalle ${iso.slice(11, 13)}:00 UTC del ${iso.slice(0, 10)}`,
        fetchImpl,
        log,
    })
    return { vivo, battito, suonato: false, esito, email }
}

/**
 * Un testo che va in un log o in un'email, senza il segreto che il Worker ha appena usato. GitHub e
 * Resend non rimandano indietro l'intestazione `Authorization`, ma un proxy o una pagina d'errore
 * potrebbero: il corpo di un rifiuto si tiene (è il «perché»), il segreto no. Si toglie PRIMA di
 * tagliare il testo: un segreto spezzato dal taglio non si riconoscerebbe più.
 */
function senzaSegreto(testo, segreto) {
    const t = String(testo).replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [nascosto]')
    return segreto ? t.split(segreto).join('[nascosto]') : t
}

/**
 * Fa partire il backup notturno con `modalita=completo` e `origine=cloudflare`. Il `run-name` del
 * workflow lo traduce nel titolo «Backup notturno completo (da Cloudflare)», che il campanello e la
 * guardia delle 20 ore riconoscono. Restituisce `{ ok, esito, http, corpo }` e non lancia mai.
 *   esito = 'partito' | 'riattivato-e-partito' | 'spento-a-mano' | 'fallito'
 *
 * Se GitHub rifiuta, si chiede lo STATO del workflow invece di indovinarlo dal testo dell'errore:
 *   · `disabled_inactivity` (GitHub spegne da solo i workflow programmati di un repository fermo da
 *     60 giorni) → lo riattiva e riprova UNA volta;
 *   · `disabled_manually` → NON lo riaccende: è l'interruttore del titolare, scritto in testa al
 *     workflow (`gh workflow disable backup-notturno.yml`).
 * NIENTE ripiego «senza input» come per il campanello: senza `modalita=completo` il workflow farebbe
 * un giro di PROVA, cioè un backup finto con l'aria di quello vero.
 */
export async function lanciaBackup({ token, fetchImpl = fetch }) {
    if (!token) return { ok: false, esito: 'fallito', http: 0, corpo: 'manca GITHUB_TOKEN_CAMPANELLO: il backup NON parte' }
    const base = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_BACKUP}`
    const chiama = async (url, verbo, corpo) => {
        const res = await fetchImpl(url, {
            method: verbo,
            headers: intestazioniGitHub(token),
            ...(corpo ? { body: JSON.stringify(corpo) } : {}),
            signal: AbortSignal.timeout(TEMPO_MAX_RICHIESTA_MS),
        })
        return { http: res.status, testo: await res.text() }
    }
    const lancia = () => chiama(`${base}/dispatches`, 'POST', { ref: 'main', inputs: { modalita: 'completo', origine: ORIGINE } })
    const pulito = (testo) => senzaSegreto(testo, token)
    try {
        const primo = await lancia()
        if (primo.http === 204) return { ok: true, esito: 'partito', http: 204, corpo: '' }
        // Il corpo del rifiuto si tiene sempre: «Bad credentials» dice che il token è scaduto.
        const corpo = pulito(primo.testo).slice(0, 300)
        const stato = await chiama(base, 'GET')
        const statoWorkflow = stato.http === 200 ? (/"state"\s*:\s*"([a-z_]+)"/.exec(stato.testo)?.[1] ?? '') : ''
        if (statoWorkflow === 'disabled_manually') return { ok: false, esito: 'spento-a-mano', http: primo.http, corpo }
        if (statoWorkflow !== 'disabled_inactivity') return { ok: false, esito: 'fallito', http: primo.http, corpo }
        const riattiva = await chiama(`${base}/enable`, 'PUT')
        if (riattiva.http !== 204) {
            return {
                ok: false,
                esito: 'fallito',
                http: riattiva.http,
                corpo: `workflow spento per inattività e riattivazione rifiutata: ${pulito(riattiva.testo).slice(0, 250)}`,
            }
        }
        const secondo = await lancia()
        return secondo.http === 204
            ? { ok: true, esito: 'riattivato-e-partito', http: 204, corpo: '' }
            : { ok: false, esito: 'fallito', http: secondo.http, corpo: `riattivato, ma il lancio è stato rifiutato: ${pulito(secondo.testo).slice(0, 250)}` }
    } catch (err) {
        return { ok: false, esito: 'fallito', http: null, corpo: pulito(err instanceof Error ? err.name + ': ' + err.message : String(err)) }
    }
}

/**
 * La chiave d'idempotenza di Resend per un'email del Worker: SOLO codici e date, mai un indirizzo.
 *   · 'backup' → una per notte (`kidville-backup-non-partito-AAAA-MM-GG`);
 *   · 'vivo'   → una per ora (`kidville-vivo-giu-AAAA-MM-GGTHH`): il cron gira ogni 5 minuti, e un
 *     sito giù per un'ora deve fare UNA email, non dodici.
 */
export function chiaveIdempotenza(tipo, quando) {
    const iso = quando.toISOString()
    return tipo === 'backup' ? `kidville-backup-non-partito-${iso.slice(0, 10)}` : `kidville-vivo-giu-${iso.slice(0, 13)}`
}

/**
 * IL SECONDO CANALE (T12): un'email via Resend quando il Worker non riesce a far partire un workflow.
 * È il caso in cui il primo canale tace per definizione: è GitHub che rifiuta o non risponde, e la
 * segnalazione e l'email del campanello partono proprio da GitHub. Stesso mittente e stessa
 * impaginazione del campanello: è la sua `mandaEmail`. Non lancia mai; scrive sempre UNA riga:
 *   · `esito=accettata` — Resend ha l'email con questa chiave: spedita adesso, o già spedita dentro la
 *     finestra della chiave (in quel caso l'id nella risposta è lo stesso della prima volta);
 *   · `esito=non-spedita` — con lo stato e il corpo del rifiuto, oppure con «mancano RESEND_API_KEY o
 *     SENTINELLA_DESTINATARI» se i segreti del Worker non ci sono. Livello error: è un incidente.
 */
export async function avvisaPerEmail({ segreti = {}, chiave, oggetto, introHtml, link, quando, fetchImpl = fetch, log = (r) => console.log(r) }) {
    const esito = await mandaEmail({
        chiaveResend: segreti.chiaveResend,
        destinatari: segreti.destinatari,
        oggetto,
        introHtml,
        link,
        quando,
        chiaveIdempotenza: chiave,
        fetchImpl,
    })
    const motivo = senzaSegreto(esito.corpo, segreti.chiaveResend)
    if (esito.ok) {
        log(`monitor-email: esito=accettata chiave=${chiave} HTTP ${esito.stato} ${motivo.slice(0, 120)}`)
    } else {
        console.error(`monitor-email: esito=non-spedita chiave=${chiave} HTTP ${esito.stato} ${motivo.slice(0, 300)}`)
    }
    return esito
}

/**
 * Il giro delle 02:23 UTC: lancia il backup; se non parte (e non è spento a mano) lo scrive in
 * `console.error` col corpo di GitHub e manda l'email. `quando` = l'ora PROGRAMMATA del cron.
 * Restituisce `{ lancio, email }`; `email` = null quando non serve.
 */
export async function giroBackup({ quando, token, segreti = {}, fetchImpl = fetch, log = (r) => console.log(r) }) {
    const lancio = await lanciaBackup({ token, fetchImpl })
    if (lancio.ok) {
        log(`monitor-backup: esito=${lancio.esito} workflow=${WORKFLOW_BACKUP} HTTP ${lancio.http}`)
        return { lancio, email: null }
    }
    if (lancio.esito === 'spento-a-mano') {
        // L'interruttore del titolare si rispetta e si dice, senza un'email ogni notte. Se nessuno lo
        // riaccende, dopo 30 ore il campanello apre `[backup-vecchio]`, ed è giusto.
        log(`monitor-backup: esito=spento-a-mano workflow=${WORKFLOW_BACKUP}: spento con «gh workflow disable», il Worker non lo riaccende`)
        return { lancio, email: null }
    }
    // Il corpo del rifiuto va nel log intero (senza il token: lo toglie `lanciaBackup`): è il «perché».
    console.error(`monitor-backup: esito=fallito workflow=${WORKFLOW_BACKUP} HTTP ${lancio.http ?? '-'} ${lancio.corpo}`)
    const iso = quando.toISOString()
    const email = await avvisaPerEmail({
        segreti,
        chiave: chiaveIdempotenza('backup', quando),
        oggetto: 'Backup notturno NON partito',
        introHtml:
            'Il monitor esterno non è riuscito a far partire il backup notturno di database e file. ' +
            `GitHub ha risposto: <code>HTTP ${escapeHtml(String(lancio.http ?? '-'))} ${escapeHtml(lancio.corpo)}</code>. ` +
            'Finché un giro non riesce, l’ultima copia buona è quella di ieri o più vecchia; lo schedule di ' +
            'GitHub può ancora farlo partire in mattinata. Cosa fare: <code>docs/runbook-ripristino.md</code>, scenario B.',
        link: LINK_GIRI_BACKUP,
        quando: `${iso.slice(0, 10)} alle ${iso.slice(11, 16)} UTC`,
        fetchImpl,
        log,
    })
    return { lancio, email }
}

function attendi(ms) {
    return new Promise((r) => setTimeout(r, ms))
}

/** Quale lavoro fa un cron di Cloudflare: il backup alle 02:23, il monitor tutti gli altri. */
export function lavoroDelCron(cron) {
    return cron === CRON_BACKUP ? 'backup' : 'monitor'
}

const worker = {
    async scheduled(controller, env, ctx) {
        const quando = new Date(controller.scheduledTime)
        const token = env.GITHUB_TOKEN_CAMPANELLO
        const segreti = { chiaveResend: env.RESEND_API_KEY, destinatari: env.SENTINELLA_DESTINATARI }
        if (lavoroDelCron(controller.cron) === 'backup') {
            ctx.waitUntil(giroBackup({ quando, token, segreti }))
        } else {
            ctx.waitUntil(giro({ quando, token, segreti }))
        }
    },
}

export default worker
