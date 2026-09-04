import { createHash } from 'crypto'
import { interpretaFogli, tabellaDaTesto } from './estratto-conto/tabella'

// Riconciliazione bancaria: parser CSV (formati export banca italiani) e
// matcher sui pagamenti aperti. Funzioni PURE: l'I/O vive nelle route.
// Contano solo gli ACCREDITI (importo > 0); il match non si auto-conferma mai.

export interface MovimentoCsv {
    data_operazione: string // YYYY-MM-DD
    importo: number
    causale: string
    controparte: string
}

export interface MappingCsv {
    data?: string
    importo?: string
    causale?: string
    controparte?: string
}

export interface PagamentoAperto {
    id: string
    descrizione?: string | null
    importo: number | string
    importo_pagato?: number | string | null
    periodo_competenza?: string | null
    alunno_nome?: string | null
    intestatario_nome?: string | null
    /** CF dell'alunno (Riconciliazione v2): se compare nel movimento è l'aggancio più forte. */
    codice_fiscale?: string | null
    /** Serve all'elenco `cf_match` per l'«Incasso unico» multi-alunno. */
    alunno_id?: string | null
}

export interface Suggerimento {
    pagamento_id: string
    score: number
    motivi: string[]
    label?: string
    /** True se il candidato è agganciato per codice fiscale (aggancio dominante). */
    cf_match?: boolean
    /** Alunno del pagamento: serve alla UI per raggruppare i CF e aprire l'«Incasso unico». */
    alunno_id?: string | null
}

/**
 * ⚠️ `norm()` NON SI TOCCA. È dentro `hashMovimento`, cioè dentro l'impronta che impedisce
 * il doppio import: cambiarla cambierebbe TUTTE le impronte già scritte, e ogni movimento
 * già in registro tornerebbe importabile. Per confrontare le INTESTAZIONI di un foglio
 * esiste una funzione separata, `normIntestazione` — sono due mestieri diversi che si
 * assomigliano, ed è esattamente per questo che stanno in due posti.
 */
const norm = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()

/**
 * L'esito di una lettura: i movimenti e i CONTATORI, tenuti separati.
 *
 * I tre campi in coda sono opzionali perché la firma di `parseCsv` non doveva cambiare per
 * i chiamanti di ieri — ma il guscio li valorizza sempre. `uscite` e `scartate` insieme
 * sarebbero un numero solo che non dice niente: sull'estratto annuale vero le uscite sono
 * 2.225 righe capite benissimo e non importabili, e leggerle come «scartate» vuol dire
 * leggere un allarme su un import riuscito.
 */
export interface EsitoParseCsv {
    movimenti: MovimentoCsv[]
    /** Righe dopo l'intestazione senza data o senza importo leggibile. */
    scartate: number
    /** Le intestazioni come sono state risolte (già unite, se erano su due righe). */
    intestazioni: string[]
    /** Righe leggibilissime con importo ≤ 0: sono addebiti, non si importano. */
    uscite?: number
    /** Righe oltre il tetto: il troncamento non è più silenzioso. */
    troncate?: number
    /** Movimenti rimasti senza controparte: il campanello se la banca cambia forma. */
    senzaOrdinante?: number
}

/**
 * IL TESTO DI UN CSV → I MOVIMENTI. Oggi è un GUSCIO, e il motivo vale la pena dirlo.
 *
 * Fino a ieri qui viveva un secondo interprete, scritto solo per il CSV: sinonimi propri,
 * separatore dedotto dalla prima riga, intestazione su una riga sola. Sul file vero della
 * banca dava **zero movimenti su 65** — e la copia CSV di ogni regola divergeva da quella
 * Excel al primo ritocco. L'interprete è uno solo (`estratto-conto/tabella.ts`): un CSV è
 * una matrice di celle di stringhe, un foglio Excel una matrice di celle di numeri, e la
 * differenza finisce lì.
 *
 * La firma resta identica: chi passava di qui non se ne accorge.
 */
export function parseCsv(contenuto: string, mapping?: MappingCsv): EsitoParseCsv {
    const { movimenti, scartate, uscite, troncate, senzaOrdinante, intestazioni } = interpretaFogli(
        [{ nome: 'csv', righe: tabellaDaTesto(contenuto) }],
        { mapping },
    )
    return { movimenti, scartate, intestazioni, uscite, troncate, senzaOrdinante }
}

/** Impronta anti re-import: stesso movimento (data+importo+causale) = stesso hash. */
export function hashMovimento(m: MovimentoCsv): string {
    return createHash('sha256')
        .update(`${m.data_operazione}|${m.importo.toFixed(2)}|${norm(m.causale)}`)
        .digest('hex')
}

const MESI_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre']

/**
 * Regex del codice fiscale italiano: 6 lettere + LLLLLLDDLDDLDDDL.
 * `\b` àncora davanti/dietro: senza, "…RSSMRA85T10A562SXX" o un run di lettere più
 * lungo passerebbe come match. Solo forma ESATTA a 16 caratteri, nessun fuzzy.
 */
const CF_REGEX = /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/g

/**
 * Variante OMOCODIA: quando due persone collidono, l'Agenzia sostituisce le cifre (da destra)
 * con lettere secondo la mappa fissa 0→L 1→M 2→N 3→P 4→Q 5→R 6→S 7→T 8→U 9→V. Le posizioni
 * "numeriche" del CF accettano allora anche quelle lettere. È comunque un match ESATTO di forma,
 * non un fuzzy: senza questo ramo un CF omocodico non verrebbe MAI riconosciuto.
 */
const CF_OMOCODE_REGEX = /\b[A-Z]{6}[\dLMNPQRSTUV]{2}[A-Z][\dLMNPQRSTUV]{2}[A-Z][\dLMNPQRSTUV]{3}[A-Z]\b/g

/**
 * Estrae i codici fiscali DISTINTI presenti nel testo (causale+controparte).
 * Porta a MAIUSCOLO e applica sia la regex esatta sia quella omocodica. Prova anche una
 * variante SENZA SPAZI: alcuni export bancari spezzano il CF ("RSSMRA 85T10A562S") e, quando
 * è delimitato da punteggiatura, ricomporlo lo rende di nuovo agganciabile. Nessun match
 * cross-token spurio: i `\b` restano ancorati ai delimitatori non-parola superstiti.
 */
export function estraiCodiciFiscali(testo: string): string[] {
    if (!testo) return []
    const su = testo.toUpperCase()
    const trovati = new Set<string>()
    for (const variante of [su, su.replace(/\s+/g, '')]) {
        for (const regex of [CF_REGEX, CF_OMOCODE_REGEX]) {
            const match = variante.match(regex)
            if (match) for (const cf of match) trovati.add(cf)
        }
    }
    return [...trovati]
}

/** Bonus dell'aggancio per CF: domina qualunque combinazione di segnali deboli (max 100). */
const CF_BONUS = 1000

export interface RisultatoMatch {
    stato: 'suggerito' | 'da_abbinare'
    suggerimenti: Suggerimento[]
    /** Presente solo con almeno un aggancio CF: true se ≥2 alunni distinti → «Incasso unico». */
    multi?: boolean
    /** Presente solo con almeno un aggancio CF: l'elenco dei pagamenti agganciati per CF. */
    cf_match?: { pagamento_id: string; alunno_id: string | null }[]
}

/**
 * UN PAGAMENTO APERTO CON I SUOI SEGNALI GIÀ CALCOLATI.
 *
 * Non è un'ottimizzazione a occhio: sull'estratto annuale vero sono **6.775 accrediti ×
 * 545 pagamenti aperti = 3,7 milioni di confronti**, e dentro ognuno c'era una `norm()` —
 * cioè un `normalize('NFD')` — rifatta ogni volta sugli stessi nomi, sulle stesse
 * descrizioni, sugli stessi periodi. I nomi dei pagamenti aperti non cambiano fra un
 * movimento e l'altro: si normalizzano UNA volta, all'inizio.
 */
export interface PagamentoPreparato {
    id: string
    alunnoId: string | null
    /** Residuo, arrotondato al centesimo come lo era nel ciclo. */
    residuo: number
    /** I token (>2 caratteri) di ogni nome, già normalizzati: uno per alunno, uno per intestatario. */
    tokenNomi: string[][]
    /** Il mese italiano del periodo di competenza, già risolto. */
    mese: string | null
    /** L'anno-mese `YYYY-MM` del periodo di competenza. */
    ym: string | null
    /** La descrizione normalizzata, o `null` quando il pagamento non ne ha una. */
    descrizioneNorm: string | null
    /** Il CF dell'alunno in MAIUSCOLO, o `null`. */
    cf: string | null
}

/**
 * I pagamenti aperti, normalizzati una volta sola.
 *
 * Il risultato è di sola lettura per progetto: si passa allo stesso `suggerisciMatchPreparato`
 * per ogni movimento del file, e nessuna chiamata lo consuma o lo modifica.
 */
export function preparaAperti(aperti: PagamentoAperto[]): PagamentoPreparato[] {
    return aperti.map((p) => {
        const nomi = [p.alunno_nome, p.intestatario_nome].filter(Boolean) as string[]
        const mese = p.periodo_competenza ? MESI_IT[new Date(p.periodo_competenza).getMonth()] ?? null : null
        return {
            id: p.id,
            alunnoId: p.alunno_id ?? null,
            residuo: Math.round((Number(p.importo) - Number(p.importo_pagato || 0)) * 100) / 100,
            tokenNomi: nomi.map((n) => norm(n).split(' ').filter((t) => t.length > 2)),
            mese,
            ym: p.periodo_competenza ? p.periodo_competenza.slice(0, 7) : null,
            // ⚠️ `p.descrizione` VUOTA non è `''` normalizzato: è «nessuna descrizione».
            //    `testo.includes('')` è sempre vero, e regalerebbe 10 punti a chiunque.
            descrizioneNorm: p.descrizione ? norm(p.descrizione) : null,
            cf: p.codice_fiscale ? String(p.codice_fiscale).toUpperCase() : null,
        }
    })
}

/**
 * Score di un pagamento aperto rispetto al movimento:
 *   +1000 CF dell'alunno nel movimento (DOMINANTE) · +50 residuo esattamente uguale
 *   +25 nome (alunno/intestatario) in causale · +15 mese di competenza citato
 *   +10 descrizione contenuta.
 * "suggerito" con best ≥ 60 E distacco ≥ 20 dal secondo, OPPURE con almeno un CF agganciato.
 * Un CF forza lo stato a 'suggerito' (giallo): MAI auto-conferma. Solo i pagamenti in `aperti`
 * (residuo aperto) sono candidati: un CF che punta a un alunno senza voce aperta NON eleva nulla.
 *
 * Questa è la strada VELOCE: prende i pagamenti già preparati. `suggerisciMatch` qui sotto
 * resta il guscio a una riga, e un test di equivalenza sorveglia che le due strade dicano la
 * stessa cosa — perché due strade che possono divergere, prima o poi divergono.
 */
export function suggerisciMatchPreparato(mov: MovimentoCsv, aperti: PagamentoPreparato[]): RisultatoMatch {
    const testo = norm(`${mov.causale} ${mov.controparte}`)
    const cfSet = new Set(estraiCodiciFiscali(`${mov.causale} ${mov.controparte}`))
    const candidati: Suggerimento[] = []
    const cfMatches: { pagamento_id: string; alunno_id: string | null }[] = []
    const alunniConCf = new Set<string>()

    for (const p of aperti) {
        let score = 0
        const motivi: string[] = []
        if (p.residuo === mov.importo) { score += 50; motivi.push('importo esatto') }

        const nomeTrovato = p.tokenNomi.some(
            (tokens) => tokens.length > 0 && tokens.every((t) => testo.includes(t)),
        )
        if (nomeTrovato) { score += 25; motivi.push('nome in causale') }

        if (p.ym !== null) {
            if ((p.mese && testo.includes(p.mese)) || testo.includes(p.ym)) { score += 15; motivi.push('periodo citato') }
        }

        if (p.descrizioneNorm !== null && testo.includes(p.descrizioneNorm)) { score += 10; motivi.push('descrizione in causale') }

        const cfMatch = p.cf !== null && cfSet.has(p.cf)
        if (cfMatch) {
            score += CF_BONUS
            motivi.push('codice fiscale')
            cfMatches.push({ pagamento_id: p.id, alunno_id: p.alunnoId })
            if (p.alunnoId) alunniConCf.add(p.alunnoId)
        }

        if (score > 0) candidati.push({ pagamento_id: p.id, score, motivi, alunno_id: p.alunnoId, ...(cfMatch ? { cf_match: true } : {}) })
    }

    candidati.sort((a, b) => b.score - a.score)
    // Con agganci CF NON si cappano i candidati per codice fiscale a 3: una famiglia con ≥4 figli
    // perderebbe i suggerimenti oltre il terzo, mentre il totale precompilato è l'intero bonifico →
    // l'«Incasso unico» allocherebbe corto. Si tengono TUTTI i cf_match, poi si riempie fino a 3 con
    // i migliori non-CF. Senza CF il comportamento resta identico (i primi 3 per score).
    const cfMatched = candidati.filter((c) => c.cf_match)
    const nonCf = candidati.filter((c) => !c.cf_match)
    const top = [...cfMatched, ...nonCf].slice(0, Math.max(3, cfMatched.length))
    const best = top[0]
    const second = top[1]
    const haCf = cfMatches.length > 0
    // Un CF agganciato vale sempre "suggerito" (giallo): anche con due fratelli a pari punteggio,
    // dove il distacco è 0 e la regola standard direbbe "da_abbinare".
    const suggerito = haCf || (!!best && best.score >= 60 && (!second || best.score - second.score >= 20))

    const out: RisultatoMatch = { stato: suggerito ? 'suggerito' : 'da_abbinare', suggerimenti: top }
    if (haCf) {
        out.multi = alunniConCf.size >= 2
        out.cf_match = cfMatches
    }
    return out
}

/**
 * Il guscio di sempre: prepara e cerca in un colpo solo.
 *
 * Resta esportato con la firma di ieri perché è quello che usano i test e chi cerca il
 * match di UN movimento. Su un file intero si chiama `preparaAperti` una volta e poi
 * `suggerisciMatchPreparato` per ogni riga.
 */
export function suggerisciMatch(mov: MovimentoCsv, aperti: PagamentoAperto[]): RisultatoMatch {
    return suggerisciMatchPreparato(mov, preparaAperti(aperti))
}
