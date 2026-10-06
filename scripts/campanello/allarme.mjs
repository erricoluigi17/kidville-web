// L'I/O DEL CAMPANELLO: la segnalazione nel repository (GitHub) e l'email (Resend).
//
// Stessa forma dell'allarme del backup notturno e della sentinella Play, che questo file non
// sostituisce: PRIMA la segnalazione, che non usa nessun segreto (il token che GitHub regala a ogni
// giro) e quindi non può fallire per configurazione mancante; POI l'email. Se l'email non può partire,
// il giro FALLISCE rumorosamente: un allarme che non sa a chi scrivere è peggio di nessun allarme,
// perché sembra che ci sia.
//
// Il corpo dell'errore di un provider esterno non si butta MAI via (AGENTS.md, regola 3): quando
// Resend o GitHub rifiutano, il testo della risposta va nell'eccezione e quindi nel log del giro.
//
// Niente `fetch` globale cablato: ogni funzione riceve `fetchImpl`, così i test girano senza rete.

const API = 'https://api.github.com'
const ETICHETTA = 'campanello'
const TEMPO_MAX_MS = 15_000
const MITTENTE = 'Kidville <noreply@mail.kidville.it>'

/** Escape minimo per l'HTML dell'email: i testi vengono dalla nostra app, ma non si fida di nessuno. */
export function escapeHtml(testo) {
    return String(testo)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

/**
 * Un client GitHub minimo, sul solo perimetro che serve: segnalazioni con l'etichetta `campanello` e
 * l'elenco dei giri del backup. `repo` = `proprietario/nome`.
 */
export function creaGitHub({ repo, token, fetchImpl = fetch }) {
    async function chiama(metodo, percorso, corpo) {
        const res = await fetchImpl(`${API}${percorso}`, {
            method: metodo,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                ...(corpo ? { 'Content-Type': 'application/json' } : {}),
            },
            body: corpo ? JSON.stringify(corpo) : undefined,
            signal: AbortSignal.timeout(TEMPO_MAX_MS),
        })
        const testo = await res.text()
        if (!res.ok) {
            // Il corpo si tiene: «Resource not accessible by integration» dice che manca un permesso.
            throw new Error(`GitHub ${metodo} ${percorso} → ${res.status}: ${testo.slice(0, 500)}`)
        }
        return testo === '' ? null : JSON.parse(testo)
    }

    return {
        /** Le segnalazioni APERTE del campanello (le pull request non contano: hanno `pull_request`). */
        async elencaAperte() {
            const righe = await chiama('GET', `/repos/${repo}/issues?state=open&labels=${ETICHETTA}&per_page=100`)
            return (righe ?? [])
                .filter((r) => !r.pull_request)
                .map((r) => ({ numero: r.number, titolo: r.title, ultimoAggiornamento: r.updated_at }))
        },

        async apri(incidente, corpoMarkdown) {
            // L'etichetta si crea se manca; 422 = esiste già, ed è la risposta normale.
            try {
                await chiama('POST', `/repos/${repo}/labels`, {
                    name: ETICHETTA,
                    color: 'B60205',
                    description: 'Allarme automatico del campanello (sito e backup)',
                })
            } catch (err) {
                if (!String(err.message).includes('→ 422')) throw err
            }
            const creata = await chiama('POST', `/repos/${repo}/issues`, {
                title: `[${incidente.chiave}] ${incidente.titolo}`,
                body: corpoMarkdown,
                labels: [ETICHETTA],
            })
            return creata.number
        },

        async commenta(numero, corpoMarkdown) {
            await chiama('POST', `/repos/${repo}/issues/${numero}/comments`, { body: corpoMarkdown })
        },

        async chiudi(numero, corpoMarkdown) {
            await chiama('POST', `/repos/${repo}/issues/${numero}/comments`, { body: corpoMarkdown })
            await chiama('PATCH', `/repos/${repo}/issues/${numero}`, { state: 'closed', state_reason: 'completed' })
        },

        /** I giri RIUSCITI e AUTOMATICI del backup, dal più recente. Vedi `ORE_ALLARME_BACKUP`. */
        async giriBackupRiusciti() {
            const r = await chiama(
                'GET',
                `/repos/${repo}/actions/workflows/backup-notturno.yml/runs?event=schedule&status=success&per_page=5`,
            )
            return r?.workflow_runs ?? []
        },

        /** `identical` / `ahead` / `behind` / `diverged`: la posizione di `a` rispetto a `b`. */
        async confronta(base, testa) {
            const r = await chiama('GET', `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(testa)}`)
            return r?.status ?? 'sconosciuto'
        },
    }
}

/**
 * L'email di allarme via Resend. NON lancia sul rifiuto del provider: restituisce `{ ok, stato, corpo }`
 * perché chi chiama deve poter far fallire il giro DOPO aver aperto la segnalazione, non prima.
 * Configurazione mancante = `ok: false` con la ragione (mai una nota a piè di pagina).
 */
export async function mandaEmail({ chiaveResend, destinatari, oggetto, introHtml, link, quando, fetchImpl = fetch }) {
    if (!chiaveResend || !destinatari) {
        return { ok: false, stato: 0, corpo: 'mancano RESEND_API_KEY o SENTINELLA_DESTINATARI: l\'email di allarme NON parte' }
    }
    const a = destinatari.split(',').map((d) => d.trim()).filter((d) => d !== '')
    const html =
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;color:#1a1a1a">' +
        `<h2 style="color:#006A5F;margin-bottom:4px">${escapeHtml(oggetto)}</h2>` +
        `<p>${introHtml}</p>` +
        `<p>Dettagli: <a href="${escapeHtml(link)}" style="color:#006A5F">${escapeHtml(link)}</a><br>Quando: ${escapeHtml(quando)}.</p>` +
        '<p style="font-size:12px;color:#55615C">Campanello &middot; repository kidville-web</p>' +
        '</div>'
    try {
        const res = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${chiaveResend}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: MITTENTE, to: a, subject: oggetto, html }),
            signal: AbortSignal.timeout(TEMPO_MAX_MS),
        })
        const corpo = await res.text()
        return { ok: res.status === 200, stato: res.status, corpo }
    } catch (err) {
        return { ok: false, stato: 0, corpo: `Resend irraggiungibile: ${err instanceof Error ? err.message : String(err)}` }
    }
}

/** Il testo markdown di una segnalazione (PUBBLICA): solo ciò che arriva dagli endpoint di salute. */
export function corpoSegnalazione({ incidente, linkGiro, quando, prova }) {
    return [
        prova
            ? 'Questo è un guasto SIMULATO, lanciato a mano per vedere arrivare l’allarme. Non è successo niente.'
            : incidente.dettaglio,
        '',
        `- giro: ${linkGiro}`,
        `- quando: ${quando}`,
        '- cosa fare: `docs/cicd.md`, sezione «Campanello e verifica dopo il deploy»',
        '',
        'Si chiude da sola quando il campanello vede il problema rientrato.',
    ].join('\n')
}

/** Apre la segnalazione e poi manda l'email. Restituisce `{ numero, email }`. */
export async function allarma({ gh, incidente, linkGiro, quando, prova = false, segreti, fetchImpl = fetch }) {
    const numero = await gh.apri(incidente, corpoSegnalazione({ incidente, linkGiro, quando, prova }))
    const oggetto = prova
        ? 'PROVA dell’allarme Kidville (nessun guasto vero)'
        : `Kidville: ${incidente.titolo}`
    const intro = prova
        ? '<strong>Questa è una prova.</strong> Il guasto è simulato: non è successo niente. Serve a vedere che l’allarme arrivi.'
        : escapeHtml(incidente.dettaglio)
    const email = await mandaEmail({
        chiaveResend: segreti.chiaveResend,
        destinatari: segreti.destinatari,
        oggetto,
        introHtml: intro,
        link: linkGiro,
        quando,
        fetchImpl,
    })
    return { numero, email }
}
