import { createHash } from 'crypto'

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
}

export interface Suggerimento {
    pagamento_id: string
    score: number
    motivi: string[]
    label?: string
}

const SINONIMI: Record<keyof MappingCsv, string[]> = {
    data: ['data', 'data operazione', 'data contabile', 'data valuta', 'valuta', 'date'],
    importo: ['importo', 'entrate', 'accrediti', 'avere', 'amount', 'importo eur', 'importo (eur)'],
    causale: ['causale', 'descrizione', 'descrizione operazione', 'descrizione estesa', 'description', 'dettagli'],
    controparte: ['controparte', 'ordinante', 'beneficiario/ordinante', 'beneficiario', 'nome ordinante'],
}

const norm = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()

/** Split di una riga CSV con supporto alle virgolette. */
function splitRiga(riga: string, sep: string): string[] {
    const out: string[] = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < riga.length; i++) {
        const ch = riga[i]
        if (ch === '"') {
            if (inQuote && riga[i + 1] === '"') { cur += '"'; i++ } else inQuote = !inQuote
        } else if (ch === sep && !inQuote) {
            out.push(cur)
            cur = ''
        } else {
            cur += ch
        }
    }
    out.push(cur)
    return out.map((c) => c.trim())
}

function parseImporto(raw: string): number | null {
    let s = raw.replace(/[€\s+]/g, '')
    if (!s) return null
    // "1.234,56" → it; "1234.56" → en; "150,00" → it
    if (s.includes(',') ) s = s.replace(/\./g, '').replace(',', '.')
    const n = Number(s)
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

function parseData(raw: string): string | null {
    const s = raw.trim().slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
    const it = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s)
    if (it) return `${it[3]}-${it[2].padStart(2, '0')}-${it[1].padStart(2, '0')}`
    return null
}

// Cap prudenziale: gli estratti conto mensili stanno ampiamente sotto.
const MAX_RIGHE = 2000

export function parseCsv(contenuto: string, mapping?: MappingCsv): {
    movimenti: MovimentoCsv[]
    scartate: number
    intestazioni: string[]
} {
    const righe = contenuto.split(/\r?\n/).filter((r) => r.trim().length > 0)
    if (righe.length < 2) return { movimenti: [], scartate: 0, intestazioni: [] }

    const sep = righe[0].includes(';') ? ';' : ','
    const intestazioni = splitRiga(righe[0], sep)
    const normHeaders = intestazioni.map(norm)

    const indice = (campo: keyof MappingCsv): number => {
        if (mapping?.[campo]) return normHeaders.indexOf(norm(mapping[campo]!))
        const sinonimi = SINONIMI[campo]
        let idx = normHeaders.findIndex((h) => sinonimi.includes(h))
        if (idx === -1) idx = normHeaders.findIndex((h) => sinonimi.some((s) => h.includes(s)))
        return idx
    }

    const iData = indice('data')
    const iImporto = indice('importo')
    const iCausale = indice('causale')
    const iControparte = indice('controparte')
    if (iData === -1 || iImporto === -1) return { movimenti: [], scartate: righe.length - 1, intestazioni }

    const movimenti: MovimentoCsv[] = []
    let scartate = 0
    for (const riga of righe.slice(1, MAX_RIGHE + 1)) {
        const celle = splitRiga(riga, sep)
        const data = parseData(celle[iData] ?? '')
        const importo = parseImporto(celle[iImporto] ?? '')
        if (!data || importo == null || importo <= 0) { scartate++; continue }
        movimenti.push({
            data_operazione: data,
            importo,
            causale: (iCausale >= 0 ? celle[iCausale] : '') ?? '',
            controparte: (iControparte >= 0 ? celle[iControparte] : '') ?? '',
        })
    }
    return { movimenti, scartate, intestazioni }
}

/** Impronta anti re-import: stesso movimento (data+importo+causale) = stesso hash. */
export function hashMovimento(m: MovimentoCsv): string {
    return createHash('sha256')
        .update(`${m.data_operazione}|${m.importo.toFixed(2)}|${norm(m.causale)}`)
        .digest('hex')
}

const MESI_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre']

/**
 * Score di un pagamento aperto rispetto al movimento:
 *   +50 residuo esattamente uguale · +25 nome (alunno/intestatario) in causale
 *   +15 mese di competenza citato · +10 descrizione contenuta.
 * "suggerito" solo con best ≥ 60 E distacco ≥ 20 dal secondo. Mai auto-conferma.
 */
export function suggerisciMatch(mov: MovimentoCsv, aperti: PagamentoAperto[]): {
    stato: 'suggerito' | 'da_abbinare'
    suggerimenti: Suggerimento[]
} {
    const testo = norm(`${mov.causale} ${mov.controparte}`)
    const candidati: Suggerimento[] = []

    for (const p of aperti) {
        let score = 0
        const motivi: string[] = []
        const residuo = Math.round((Number(p.importo) - Number(p.importo_pagato || 0)) * 100) / 100
        if (residuo === mov.importo) { score += 50; motivi.push('importo esatto') }

        const nomi = [p.alunno_nome, p.intestatario_nome].filter(Boolean) as string[]
        const nomeTrovato = nomi.some((n) => {
            const tokens = norm(n).split(' ').filter((t) => t.length > 2)
            return tokens.length > 0 && tokens.every((t) => testo.includes(t))
        })
        if (nomeTrovato) { score += 25; motivi.push('nome in causale') }

        if (p.periodo_competenza) {
            const d = new Date(p.periodo_competenza)
            const mese = MESI_IT[d.getMonth()]
            const ym = p.periodo_competenza.slice(0, 7)
            if ((mese && testo.includes(mese)) || testo.includes(ym)) { score += 15; motivi.push('periodo citato') }
        }

        if (p.descrizione && testo.includes(norm(p.descrizione))) { score += 10; motivi.push('descrizione in causale') }

        if (score > 0) candidati.push({ pagamento_id: p.id, score, motivi })
    }

    candidati.sort((a, b) => b.score - a.score)
    const top = candidati.slice(0, 3)
    const best = top[0]
    const second = top[1]
    const suggerito = !!best && best.score >= 60 && (!second || best.score - second.score >= 20)
    return { stato: suggerito ? 'suggerito' : 'da_abbinare', suggerimenti: top }
}
