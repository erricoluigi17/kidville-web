import { describe, it, expect, vi } from 'vitest'
import {
    aBlocchi,
    aggregaStatistiche,
    statistichePerAvviso,
    autoriDegliAvvisi,
    rispostePerAvvisoDelGenitore,
    AVVISI_PER_QUERY,
    RIGHE_PER_PAGINA,
} from '@/lib/avvisi/statistiche'

// T11-F2 — le statistiche degli avvisi si leggono IN BLOCCO.
//
// Prima: 4 query per ogni avviso (3 count + 1 autore) dentro un `.map()`.
// Qui si prova che (a) i conti restano ESATTI, (b) il numero di query non
// dipende più da quanti avvisi ci sono, (c) una lettura troncata dal server
// (`db-max-rows`) viene completata e non silenziosamente sotto-contata.
//
// FIXTURE: ogni grandezza ha un valore DIVERSO da ogni altra (letti 5, sì 3,
// no 2 sul primo; 1/0/4 sul secondo). Con numeri uguali un'aggregazione che
// confonde «letti» con «adesioni sì», o l'avviso A con l'avviso B, resterebbe
// verde: sarebbe un test che non distingue le grandezze che dichiara di contare.

const A1 = '11111111-1111-4111-8111-111111111111'
const A2 = '22222222-2222-4222-8222-222222222222'
const A3 = '33333333-3333-4333-8333-333333333333'

/** Righe con conteggi tutti diversi fra loro e fra i due avvisi. */
function righeDiProva() {
    const righe: Array<{ avviso_id: string; letto_il: string | null; risposta: string | null }> = []
    // A1: 5 letti · 3 sì · 2 no  (2 righe lette senza risposta, 3 sì letti…)
    for (let i = 0; i < 5; i++) righe.push({ avviso_id: A1, letto_il: '2026-08-01', risposta: null })
    for (let i = 0; i < 3; i++) righe.push({ avviso_id: A1, letto_il: null, risposta: 'si' })
    for (let i = 0; i < 2; i++) righe.push({ avviso_id: A1, letto_il: null, risposta: 'no' })
    // A2: 1 letto · 0 sì · 4 no
    righe.push({ avviso_id: A2, letto_il: '2026-08-02', risposta: null })
    for (let i = 0; i < 4; i++) righe.push({ avviso_id: A2, letto_il: null, risposta: 'no' })
    return righe
}

describe('aggregaStatistiche — i conti, senza database', () => {
    it('conta letti / sì / no separatamente e per avviso', () => {
        const m = aggregaStatistiche([A1, A2, A3], righeDiProva())
        // Valori ASSOLUTI: pinnare solo l'ordine relativo lascerebbe passare una
        // mutazione che moltiplica tutto.
        expect(m.get(A1)).toEqual({ letti: 5, adesioni_si: 3, adesioni_no: 2 })
        expect(m.get(A2)).toEqual({ letti: 1, adesioni_si: 0, adesioni_no: 4 })
        // Avviso richiesto e mai risposto: presente, a zero. Non `undefined`.
        expect(m.get(A3)).toEqual({ letti: 0, adesioni_si: 0, adesioni_no: 0 })
    })

    it('una riga di un avviso NON richiesto non entra nei conti di nessuno', () => {
        const estranea = { avviso_id: '99999999-9999-4999-8999-999999999999', letto_il: 'x', risposta: 'si' }
        const m = aggregaStatistiche([A1], [...righeDiProva(), estranea])
        expect(m.get(A1)).toEqual({ letti: 5, adesioni_si: 3, adesioni_no: 2 })
        expect(m.size).toBe(1)
    })

    it('`letto_il` valorizzato conta come letto anche con risposta data', () => {
        const m = aggregaStatistiche([A1], [{ avviso_id: A1, letto_il: '2026-08-01', risposta: 'si' }])
        expect(m.get(A1)).toEqual({ letti: 1, adesioni_si: 1, adesioni_no: 0 })
    })

    it('una risposta diversa da si/no non finisce in nessuna delle due colonne', () => {
        const m = aggregaStatistiche([A1], [{ avviso_id: A1, letto_il: null, risposta: 'forse' }])
        expect(m.get(A1)).toEqual({ letti: 0, adesioni_si: 0, adesioni_no: 0 })
    })
})

describe('aBlocchi', () => {
    it('divide in blocchi della dimensione data, ultimo più corto', () => {
        expect(aBlocchi([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
        expect(aBlocchi([], 2)).toEqual([])
        expect(aBlocchi([1, 2, 3], 10)).toEqual([[1, 2, 3]])
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Finto client che CONTA le query e simula il tetto di righe del server.
// ─────────────────────────────────────────────────────────────────────────────
function clientFinto(opzioni: {
    righe?: Array<Record<string, unknown>>
    utenti?: Array<Record<string, unknown>>
    /** Tetto di righe per risposta, come `db-max-rows` su Supabase. */
    tettoServer?: number
    erroreRisposte?: { code: string; message: string } | null
}) {
    const righe = opzioni.righe ?? []
    const tetto = opzioni.tettoServer ?? RIGHE_PER_PAGINA
    const query = { avvisi_risposte: 0, utenti: 0 }

    const client = {
        from(tabella: string) {
            const st = { ids: [] as string[], parent: null as string | null }
            const b: Record<string, unknown> = {}
            b.select = () => b
            b.in = (_c: string, v: string[]) => { st.ids = v; return b }
            b.eq = (_c: string, v: string) => { st.parent = v; return b }
            b.range = async (da: number, a: number) => {
                if (tabella === 'avvisi_risposte') {
                    query.avvisi_risposte++
                    if (opzioni.erroreRisposte) {
                        return { data: null, count: null, error: opzioni.erroreRisposte }
                    }
                    const filtrate = righe.filter(
                        (r) => st.ids.includes(r.avviso_id as string) &&
                            (st.parent === null || r.parent_id === st.parent),
                    )
                    const chieste = a - da + 1
                    const fetta = filtrate.slice(da, da + Math.min(chieste, tetto))
                    return { data: fetta, count: filtrate.length, error: null }
                }
                return { data: [], count: 0, error: null }
            }
            b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
                if (tabella === 'utenti') {
                    query.utenti++
                    const trovati = (opzioni.utenti ?? []).filter((u) => st.ids.includes(u.id as string))
                    return Promise.resolve({ data: trovati, error: null }).then(onF, onR)
                }
                return Promise.resolve({ data: [], error: null }).then(onF, onR)
            }
            return b
        },
    }
    return { client: client as never, query }
}

describe('statistichePerAvviso — il numero di query NON dipende dagli avvisi', () => {
    it('con 3 avvisi: UNA query, e i conteggi sono quelli veri', async () => {
        const { client, query } = clientFinto({ righe: righeDiProva() })
        const m = await statistichePerAvviso(client, [A1, A2, A3], 'test')
        expect(query.avvisi_risposte).toBe(1)
        expect(m.get(A1)).toEqual({ letti: 5, adesioni_si: 3, adesioni_no: 2 })
        expect(m.get(A2)).toEqual({ letti: 1, adesioni_si: 0, adesioni_no: 4 })
        expect(m.get(A3)).toEqual({ letti: 0, adesioni_si: 0, adesioni_no: 0 })
    })

    it('con 100 avvisi resta UNA query — prima ne sarebbero servite 300', async () => {
        const ids = Array.from({ length: AVVISI_PER_QUERY }, (_, i) => `av-${i}`)
        const { client, query } = clientFinto({ righe: [] })
        await statistichePerAvviso(client, ids, 'test')
        // Tetto ASSOLUTO, non «meno di prima»: con la vecchia route erano 3×100.
        expect(query.avvisi_risposte).toBe(1)
    })

    it('con 250 avvisi sono 3 blocchi, non 250 — e il tetto per blocco è rispettato', async () => {
        const ids = Array.from({ length: 250 }, (_, i) => `av-${i}`)
        const { client, query } = clientFinto({ righe: [] })
        await statistichePerAvviso(client, ids, 'test')
        expect(query.avvisi_risposte).toBe(Math.ceil(250 / AVVISI_PER_QUERY))
        expect(query.avvisi_risposte).toBe(3)
    })

    it('elenco vuoto: NESSUNA query', async () => {
        const { client, query } = clientFinto({ righe: righeDiProva() })
        const m = await statistichePerAvviso(client, [], 'test')
        expect(query.avvisi_risposte).toBe(0)
        expect(m.size).toBe(0)
    })

    it('id duplicati non moltiplicano né le query né i conteggi', async () => {
        const { client, query } = clientFinto({ righe: righeDiProva() })
        const m = await statistichePerAvviso(client, [A1, A1, A1, A2], 'test')
        expect(query.avvisi_risposte).toBe(1)
        expect(m.get(A1)).toEqual({ letti: 5, adesioni_si: 3, adesioni_no: 2 })
    })
})

describe('statistichePerAvviso — il troncamento del server NON diventa un numero falso', () => {
    it('con 2500 risposte e tetto server 1000 pagina fino in fondo e conta tutto', async () => {
        // 2500 righe su A1: 1400 lette, 700 sì, 400 no. Tre grandezze diverse,
        // tutte sopra il tetto di pagina: se il ciclo si fermasse alla prima
        // pagina i numeri sarebbero 1000/qualcosa, e questo test lo direbbe.
        const righe: Array<Record<string, unknown>> = []
        for (let i = 0; i < 1400; i++) righe.push({ avviso_id: A1, letto_il: 'x', risposta: null })
        for (let i = 0; i < 700; i++) righe.push({ avviso_id: A1, letto_il: null, risposta: 'si' })
        for (let i = 0; i < 400; i++) righe.push({ avviso_id: A1, letto_il: null, risposta: 'no' })

        const { client, query } = clientFinto({ righe, tettoServer: 1000 })
        const m = await statistichePerAvviso(client, [A1], 'test')

        expect(m.get(A1)).toEqual({ letti: 1400, adesioni_si: 700, adesioni_no: 400 })
        // 2500 righe / 1000 per pagina = 3 pagine. Non 1 (troncato), non 25.
        expect(query.avvisi_risposte).toBe(3)
    })

    it('errore PostgREST: statistiche a zero MA loggate a livello error', async () => {
        const spia = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { client } = clientFinto({ righe: righeDiProva(), erroreRisposte: { code: '42P01', message: 'relation does not exist' } })
        const m = await statistichePerAvviso(client, [A1], 'test')
        expect(m.get(A1)).toEqual({ letti: 0, adesioni_si: 0, adesioni_no: 0 })
        spia.mockRestore()
    })
})

describe('rispostePerAvvisoDelGenitore', () => {
    it('indicizza per avviso e per figlio, filtrando sul genitore, in UNA query', async () => {
        const righe = [
            { avviso_id: A1, student_id: 's1', parent_id: 'p1', letto_il: '2026-08-01', risposta: 'si', risposto_il: '2026-08-01' },
            { avviso_id: A1, student_id: 's2', parent_id: 'p1', letto_il: null, risposta: null, risposto_il: null },
            { avviso_id: A2, student_id: 's1', parent_id: 'p1', letto_il: '2026-08-02', risposta: 'no', risposto_il: '2026-08-02' },
            // Altro genitore: non deve comparire.
            { avviso_id: A1, student_id: 's9', parent_id: 'ALTRO', letto_il: 'x', risposta: 'si', risposto_il: 'x' },
        ]
        const { client, query } = clientFinto({ righe })
        const m = await rispostePerAvvisoDelGenitore(client, [A1, A2], 'p1', 'test')

        expect(query.avvisi_risposte).toBe(1)
        expect(m.get(A1)?.get('s1')).toEqual({ letto_il: '2026-08-01', risposta: 'si', risposto_il: '2026-08-01' })
        expect(m.get(A1)?.get('s2')).toEqual({ letto_il: null, risposta: null, risposto_il: null })
        expect(m.get(A2)?.get('s1')).toEqual({ letto_il: '2026-08-02', risposta: 'no', risposto_il: '2026-08-02' })
        // La riga dell'altro genitore è stata esclusa dal filtro, non dall'indice.
        expect(m.get(A1)?.get('s9')).toBeUndefined()
    })

    it('senza parentId non interroga il database', async () => {
        const { client, query } = clientFinto({ righe: [] })
        const m = await rispostePerAvvisoDelGenitore(client, [A1], '', 'test')
        expect(query.avvisi_risposte).toBe(0)
        expect(m.size).toBe(0)
    })
})

describe('autoriDegliAvvisi', () => {
    it('un solo giro su `utenti` per tutti gli autori, con fallback sui campi storici', async () => {
        const { client, query } = clientFinto({
            utenti: [
                { id: 'u1', first_name: 'Anna', last_name: 'Bianchi', role: 'educator', nome: null, cognome: null, ruolo: null },
                { id: 'u2', first_name: null, last_name: null, role: null, nome: 'Mario', cognome: 'Rossi', ruolo: 'segreteria' },
            ],
        })
        const m = await autoriDegliAvvisi(client, ['u1', 'u2', 'u1', 'u2'], 'test')
        expect(query.utenti).toBe(1)
        expect(m.get('u1')).toEqual({ first_name: 'Anna', last_name: 'Bianchi', role: 'educator' })
        // Colonne storiche `nome`/`cognome`/`ruolo` quando le nuove sono nulle.
        expect(m.get('u2')).toEqual({ first_name: 'Mario', last_name: 'Rossi', role: 'segreteria' })
        expect(m.get('ignoto')).toBeUndefined()
    })

    it('elenco vuoto: nessuna query', async () => {
        const { client, query } = clientFinto({ utenti: [] })
        await autoriDegliAvvisi(client, [], 'test')
        expect(query.utenti).toBe(0)
    })
})
