/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LA SEMANTICA POSIZIONALE DEGLI EMBED DI POSTGREST, IN UN POSTO SOLO     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Dal 2026-08-19 il cockpit delle candidature interroga `candidature_insegnanti`
 * con DUE embed sulla STESSA tabella:
 *
 *     .select(`${colonne}, ${EMBED_FILTRO_SCHEDA}, ${EMBED_TUTTE}`)
 *     .in('candidature_sedi.scuola_id', scuole)
 *
 * uno che RESTRINGE (`candidature_sedi!inner(...)`) e uno che DESCRIVE
 * (`sedi:candidature_sedi(...)`). PostgREST lega il filtro `candidature_sedi.…`
 * al PRIMO embed di quella tabella nella stringa — per POSIZIONE, non perché ha
 * `!inner`. Scambiare le due costanti sposta il filtro sull'embed descrittivo,
 * l'`!inner` smette di restringere, e l'elenco mostra candidature di plessi che
 * chi guarda non ha. Nessun errore, nessun avviso: solo dati di più.
 *
 * Misurato sulla produzione il 2026-08-20 con una candidatura rivolta a due sedi.
 *
 * ─── PERCHÉ IN UN FILE CONDIVISO ────────────────────────────────────────────
 * Perché la regola era ricopiata in QUATTRO finti (`-gate`, `-approva`,
 * `-rifiuta`, `-scope-sede`), e in tutti e quattro era la stessa
 * approssimazione: filtro applicato come predicato esistenziale sulla riga
 * madre, embed popolati a mano o buttati via. Un finto così non distingue i due
 * ordini — qualunque cosa faccia il sorgente, resta verde — ed è il motivo per
 * cui il difetto è arrivato fino alla verifica avversariale senza guardiani.
 *
 * Una regola valida per quattro strade deve vivere in un posto solo. Se cambia
 * la semantica di PostgREST, cambia qui.
 *
 * ─── LE TRE REGOLE, COME LE APPLICA IL DATABASE VERO ────────────────────────
 *
 *  1. IL FILTRO VA AL PRIMO. `.in('candidature_sedi.scuola_id', …)` restringe
 *     l'array del PRIMO embed su quella tabella, e solo quello. Gli altri
 *     portano tutte le righe, sempre.
 *
 *  2. LA RIGA MADRE SPARISCE SOLO CON `!inner`. Senza, un filtro su un embed
 *     svuota l'array e lascia la madre in elenco. È esattamente la differenza
 *     fra «isolamento di sede» e «decorazione»: `!inner` è ciò che rende la
 *     query DI sede invece di limitarsi ad arricchirla.
 *
 *  3. UN EMBED CONSEGNA SOLO LE COLONNE CHE HA CHIESTO. Ovvio nel database e
 *     invisibile nei finti di prima, che popolavano l'array con la riga intera:
 *     è così che `candidature_sedi!inner(scuola_id)` — senza `stato` — è potuto
 *     restare in produzione mentre il componente leggeva `[…].stato`, prendeva
 *     `undefined` e ripiegava sull'aggregato.
 *
 * ⚠️ LIMITE NOTO: la regex degli embed non regge le parentesi ANNIDATE
 * (`candidature_sedi(scuola_id, altra(x))`). Oggi non ce ne sono, e se un
 * giorno servissero questo file va riscritto con un parser vero invece di
 * essere aggirato caso per caso.
 */

export type Riga = Record<string, unknown>
export interface FiltroFinto {
    col: string
    vals: unknown[]
}

/** La tabella su cui vive tutta questa storia. */
export const TABELLA_SEDI = 'candidature_sedi'

/** Un embed su `candidature_sedi` letto dalla stringa `select`, con il suo posto. */
export interface EmbedSede {
    /** Il nome con cui l'array arriva nel JSON: l'alias, o il nome della tabella. */
    alias: string
    /** `!inner`: se il filtro lo colpisce e non resta niente, la madre sparisce. */
    inner: boolean
    /** Le colonne chieste. Sono le uniche che l'embed consegna. */
    colonne: string[]
}

const RE_EMBED = /(?:(\w+):)?candidature_sedi(!inner)?\s*\(([^)]*)\)/g

/** Gli embed su `candidature_sedi`, NELL'ORDINE in cui compaiono nella `select`. */
export function embedSedeDi(cols: string): EmbedSede[] {
    return [...cols.matchAll(RE_EMBED)].map((m) => ({
        alias: m[1] ?? TABELLA_SEDI,
        inner: m[2] === '!inner',
        colonne: m[3]
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean),
    }))
}

/** La `select` senza gli embed: ciò che resta sono le colonne della tabella madre. */
export function togliGliEmbed(cols: string): string {
    return cols.replace(RE_EMBED, '')
}

/** I filtri che parlano di `candidature_sedi.<colonna>`, cioè quelli sull'embed. */
function filtriSullEmbed(filtri: FiltroFinto[]): { colonna: string; vals: unknown[] }[] {
    const fuori: { colonna: string; vals: unknown[] }[] = []
    for (const f of filtri) {
        const punto = f.col.indexOf('.')
        if (punto <= 0) continue
        if (f.col.slice(0, punto) !== TABELLA_SEDI) continue
        fuori.push({ colonna: f.col.slice(punto + 1), vals: f.vals })
    }
    return fuori
}

/** Una riga di sede passa i filtri sull'embed? */
function rigaDiSedePassa(riga: Riga, sull: { colonna: string; vals: unknown[] }[]): boolean {
    return sull.every((f) => f.vals.some((v) => riga[f.colonna] === v))
}

/** Solo le colonne che l'embed ha chiesto — come fa il database. */
function proiettaSede(riga: Riga, colonne: string[]): Riga {
    if (colonne.length === 0) return { ...riga }
    const fuori: Riga = {}
    for (const c of colonne) if (c in riga) fuori[c] = riga[c]
    return fuori
}

/**
 * La riga madre sopravvive al filtro sull'embed?
 *
 * Solo se il PRIMO embed è `!inner` e il filtro non lascia niente, la madre
 * sparisce. Senza `!inner` resta, con l'array vuoto — ed è la differenza che
 * questo file esiste per rendere visibile.
 *
 * Senza nessun embed su `candidature_sedi` nella `select` (per esempio una
 * `update` che non proietta niente) il filtro resta esistenziale sulla madre,
 * come si comporta PostgREST quando il filtro nomina una relazione che la
 * proiezione non porta.
 */
export function madreSopravvive(cols: string, sueSedi: Riga[], filtri: FiltroFinto[]): boolean {
    const sull = filtriSullEmbed(filtri)
    if (sull.length === 0) return true
    const embed = embedSedeDi(cols)
    const passano = sueSedi.filter((s) => rigaDiSedePassa(s, sull))
    if (embed.length === 0) return passano.length > 0
    return embed[0].inner ? passano.length > 0 : true
}

/**
 * Gli array incorporati, con il loro alias: il PRIMO filtrato, gli altri interi,
 * ognuno con le sole colonne che ha chiesto.
 */
export function materializzaEmbedSede(
    cols: string,
    sueSedi: Riga[],
    filtri: FiltroFinto[],
): Record<string, Riga[]> {
    const sull = filtriSullEmbed(filtri)
    const fuori: Record<string, Riga[]> = {}
    embedSedeDi(cols).forEach((e, i) => {
        const righe = i === 0 && sull.length > 0 ? sueSedi.filter((s) => rigaDiSedePassa(s, sull)) : sueSedi
        fuori[e.alias] = righe.map((s) => proiettaSede(s, e.colonne))
    })
    return fuori
}
