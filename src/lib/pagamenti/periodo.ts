// Deriva il mese (it-IT, in lettere) e l'anno da `periodo_competenza` (colonna
// `date` → PostgREST la serve come «yyyy-mm-dd»). Usato per comporre la causale
// consigliata del bonifico coi segnaposto {mese}/{anno}.
//
// DETERMINISTICO di proposito: legge la stringa con una regex invece di `new Date`,
// così non c'è lo sfasamento di fuso di `getMonth()` (una data UTC a mezzanotte in
// un fuso negativo scivolerebbe al mese precedente). null/assente/non valido →
// mese e anno vuoti, che il renderer della causale omette con grazia.

const MESI_IT = [
    'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
    'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
]

/** { mese, anno } da «yyyy-mm[-dd]». Mese fuori range o stringa non valida → «». */
export function meseAnnoDaPeriodo(periodo?: string | null): { mese: string; anno: string } {
    const m = /^(\d{4})-(\d{2})/.exec((periodo ?? '').trim())
    if (!m) return { mese: '', anno: '' }
    const idx = Number(m[2]) - 1
    return { mese: MESI_IT[idx] ?? '', anno: m[1] }
}
