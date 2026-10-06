// LA LETTURA DEGLI ENDPOINT DI SALUTE, condivisa dal campanello e dalla verifica dopo il deploy.
// Non lancia mai: la rete che cade è un risultato (`http: null`), non un'eccezione.

const TEMPO_MAX_RICHIESTA_MS = 12_000

/** Un GET all'endpoint di salute. Non lancia mai: `http: null` = rete caduta o tempo scaduto. */
export async function leggi(url, { fetchImpl = fetch } = {}) {
    try {
        const res = await fetchImpl(url, {
            headers: { 'User-Agent': 'kidville-campanello', 'Cache-Control': 'no-cache' },
            signal: AbortSignal.timeout(TEMPO_MAX_RICHIESTA_MS),
        })
        const testo = await res.text()
        let corpo = null
        try {
            corpo = JSON.parse(testo)
        } catch {
            // Un corpo non JSON (la pagina d'errore di Vercel, ad esempio) è già un'informazione: `http`.
        }
        return { http: res.status, corpo, intestazioni: res.headers }
    } catch {
        return { http: null, corpo: null, intestazioni: null }
    }
}

/** Ripete la lettura finché non ottiene 200, fino a `tentativi`. Restituisce l'ultima. */
export async function leggiConTentativi(url, { tentativi, attesaMs, dormi, fetchImpl }) {
    let ultima = { http: null, corpo: null, intestazioni: null }
    for (let i = 0; i < tentativi; i++) {
        ultima = await leggi(url, { fetchImpl })
        if (ultima.http === 200) return ultima
        if (i < tentativi - 1) await dormi(attesaMs)
    }
    return ultima
}
