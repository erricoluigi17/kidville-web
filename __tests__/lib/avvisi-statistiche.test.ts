import { describe, it, expect, vi } from 'vitest'
import {
    aBlocchi,
    aggregaStatistiche,
    statistichePerAvviso,
    autoriDegliAvvisi,
    rispostePerAvvisoDelGenitore,
    AVVISI_PER_QUERY,
    RIGHE_PER_PAGINA,
    STATS_ZERO,
    type StatsAvviso,
} from '@/lib/avvisi/statistiche'

/**
 * Le attese si scrivono COMPLETE, a partire dallo zero: `toEqual` su un oggetto
 * parziale non esiste, e usare `toMatchObject` per non riscrivere cinque chiavi
 * renderebbe invisibile proprio ciò che il cantiere A2 aggiunge — un
 * `persone_ammesse` sbagliato passerebbe finché nessuno lo nomina.
 */
const stats = (p: Partial<StatsAvviso>): StatsAvviso => ({ ...STATS_ZERO, ...p })

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
        expect(m.get(A1)).toEqual(stats({ letti: 5, adesioni_si: 3, adesioni_no: 2, adesioni_senza_numero: 3 }))
        expect(m.get(A2)).toEqual(stats({ letti: 1, adesioni_si: 0, adesioni_no: 4 }))
        // Avviso richiesto e mai risposto: presente, a zero. Non `undefined`.
        expect(m.get(A3)).toEqual(stats({}))
    })

    it('una riga di un avviso NON richiesto non entra nei conti di nessuno', () => {
        const estranea = { avviso_id: '99999999-9999-4999-8999-999999999999', letto_il: 'x', risposta: 'si' }
        const m = aggregaStatistiche([A1], [...righeDiProva(), estranea])
        expect(m.get(A1)).toEqual(stats({ letti: 5, adesioni_si: 3, adesioni_no: 2, adesioni_senza_numero: 3 }))
        expect(m.size).toBe(1)
    })

    it('`letto_il` valorizzato conta come letto anche con risposta data', () => {
        const m = aggregaStatistiche([A1], [{ avviso_id: A1, letto_il: '2026-08-01', risposta: 'si' }])
        expect(m.get(A1)).toEqual(stats({ letti: 1, adesioni_si: 1, adesioni_no: 0, adesioni_senza_numero: 1 }))
    })

    it('una risposta diversa da si/no non finisce in nessuna delle due colonne', () => {
        const m = aggregaStatistiche([A1], [{ avviso_id: A1, letto_il: null, risposta: 'forse' }])
        expect(m.get(A1)).toEqual(stats({}))
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// I CINQUE CONTEGGI NUOVI (cantiere A2): posti in PERSONE, coda, e le adesioni
// che un numero non l'hanno mai dichiarato.
// ═════════════════════════════════════════════════════════════════════════════
describe('aggregaStatistiche — i posti si contano in PERSONE, non in adesioni', () => {
    it('somma `numero_partecipanti` sulle ammesse e tiene la coda separata', () => {
        const m = aggregaStatistiche([A1], [
            { avviso_id: A1, letto_il: 'x', risposta: 'si', stato_adesione: 'ammessa', numero_partecipanti: 4 },
            { avviso_id: A1, letto_il: 'x', risposta: 'si', stato_adesione: 'ammessa', numero_partecipanti: 2 },
            { avviso_id: A1, letto_il: 'x', risposta: 'si', stato_adesione: 'in_attesa', numero_partecipanti: 3 },
            { avviso_id: A1, letto_il: 'x', risposta: 'no', stato_adesione: null, numero_partecipanti: null },
        ])
        // Sei persone ammesse in DUE adesioni: il numero che si confronta col tetto
        // è 6, non 2. Contare le righe è il modo di riempire un pullman da 50 con
        // 120 persone e scoprirlo il mattino della gita.
        expect(m.get(A1)).toEqual(stats({
            letti: 4, adesioni_si: 3, adesioni_no: 1,
            adesioni_ammesse: 2, persone_ammesse: 6,
            adesioni_in_attesa: 1, persone_in_attesa: 3,
            adesioni_senza_numero: 0,
        }))
    })

    it('`numero_partecipanti` assente vale UNA persona — gemello del COALESCE in SQL', () => {
        // ⚠️ Se questo valesse 0, `avviso_posti_occupati` (SQL) direbbe 2 e questa
        // schermata direbbe 0: ciascuna metà coerente con sé stessa, nessun test
        // rosso, e il tetto applicato diverso da quello mostrato.
        const m = aggregaStatistiche([A1], [
            { avviso_id: A1, letto_il: null, risposta: 'si', stato_adesione: 'ammessa', numero_partecipanti: null },
            { avviso_id: A1, letto_il: null, risposta: 'si', stato_adesione: 'ammessa' },
        ])
        expect(m.get(A1)?.persone_ammesse).toBe(2)
        expect(m.get(A1)?.adesioni_senza_numero).toBe(2)
    })

    it('un `NaN` non rende NaN il totale: vale 1 come qualunque altro non-numero', () => {
        const m = aggregaStatistiche([A1], [
            { avviso_id: A1, letto_il: null, risposta: 'si', stato_adesione: 'ammessa', numero_partecipanti: Number.NaN },
            { avviso_id: A1, letto_il: null, risposta: 'si', stato_adesione: 'ammessa', numero_partecipanti: 5 },
        ])
        expect(m.get(A1)?.persone_ammesse).toBe(6)
    })

    it('SOLO `ammessa` occupa: uno stato nuovo non finisce nei posti (lista bianca)', () => {
        const m = aggregaStatistiche([A1], [
            { avviso_id: A1, letto_il: null, risposta: 'si', stato_adesione: 'annullata', numero_partecipanti: 9 },
        ])
        // Con una lista NERA (`!== 'in_attesa'`) queste 9 persone occuperebbero
        // posti che nessuno conta più.
        expect(m.get(A1)?.persone_ammesse).toBe(0)
        expect(m.get(A1)?.adesioni_in_attesa).toBe(0)
    })

    it('le tre chiavi storiche non cambiano significato: contano RIGHE, non persone', () => {
        const m = aggregaStatistiche([A1], [
            { avviso_id: A1, letto_il: 'x', risposta: 'si', stato_adesione: 'ammessa', numero_partecipanti: 7 },
        ])
        expect(m.get(A1)?.adesioni_si).toBe(1)
        expect(m.get(A1)?.letti).toBe(1)
        expect(m.get(A1)?.persone_ammesse).toBe(7)
    })
})

describe('statistichePerAvviso — il degrado della proiezione (DB E2E non migrato)', () => {
    it('42703 sulla colonna nuova: riprova con la proiezione storica invece di dare zero', async () => {
        const spia = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { client, query, proiezioni } = clientFinto({
            righe: righeDiProva(),
            colonnaAssente: 'stato_adesione',
        })
        const m = await statistichePerAvviso(client, [A1, A2], 'test')

        // 🔴 IL PUNTO: i tre conteggi storici tornano VERI. Prima di questo degrado
        // sarebbero stati tutti a zero — «nessuno ha letto» su ogni avviso, che non
        // è un errore visibile ma un dato falso.
        expect(m.get(A1)).toEqual(stats({ letti: 5, adesioni_si: 3, adesioni_no: 2, adesioni_senza_numero: 3 }))
        expect(m.get(A2)).toEqual(stats({ letti: 1, adesioni_si: 0, adesioni_no: 4 }))
        // Due tentativi sulla PRIMA pagina: quello allargato e quello ridotto.
        expect(query.avvisi_risposte).toBe(2)
        expect(proiezioni[0]).toContain('stato_adesione')
        expect(proiezioni[1]).not.toContain('stato_adesione')
        spia.mockRestore()
    })

    it('un errore che NON è una colonna mancante resta un errore: niente ripiego', async () => {
        const spia = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { client, query } = clientFinto({
            righe: righeDiProva(),
            erroreRisposte: { code: '42P01', message: 'relation does not exist' },
        })
        const m = await statistichePerAvviso(client, [A1], 'test')
        // Una sola query: su `42P01` non si riprova niente, e i conteggi restano a
        // zero DICHIARANDOLO col log — il comportamento di prima, non toccato.
        expect(query.avvisi_risposte).toBe(1)
        expect(m.get(A1)).toEqual(stats({}))
        spia.mockRestore()
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
    /**
     * Colonna che il finto DB NON ha: ogni `select` che la nomina risponde `42703`,
     * come PostgREST su un progetto non migrato. È l'unico modo di provare il
     * degrado della proiezione senza un mock piatto — con `erroreRisposte` l'errore
     * arriverebbe anche al secondo tentativo, e il test sarebbe verde su un ramo
     * che non ha mai funzionato.
     */
    colonnaAssente?: string
}) {
    const righe = opzioni.righe ?? []
    const tetto = opzioni.tettoServer ?? RIGHE_PER_PAGINA
    const query = { avvisi_risposte: 0, utenti: 0 }
    const proiezioni: string[] = []

    const client = {
        from(tabella: string) {
            const st = { ids: [] as string[], parent: null as string | null, colonne: '' }
            const b: Record<string, unknown> = {}
            b.select = (c?: string) => {
                st.colonne = c ?? ''
                if (tabella === 'avvisi_risposte') proiezioni.push(st.colonne)
                return b
            }
            b.in = (_c: string, v: string[]) => { st.ids = v; return b }
            b.eq = (_c: string, v: string) => { st.parent = v; return b }
            b.range = async (da: number, a: number) => {
                if (tabella === 'avvisi_risposte') {
                    query.avvisi_risposte++
                    if (opzioni.erroreRisposte) {
                        return { data: null, count: null, error: opzioni.erroreRisposte }
                    }
                    if (opzioni.colonnaAssente && st.colonne.includes(opzioni.colonnaAssente)) {
                        return {
                            data: null,
                            count: null,
                            error: { code: '42703', message: `column avvisi_risposte.${opzioni.colonnaAssente} does not exist` },
                        }
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
    return { client: client as never, query, proiezioni }
}

describe('statistichePerAvviso — il numero di query NON dipende dagli avvisi', () => {
    it('con 3 avvisi: UNA query, e i conteggi sono quelli veri', async () => {
        const { client, query } = clientFinto({ righe: righeDiProva() })
        const m = await statistichePerAvviso(client, [A1, A2, A3], 'test')
        expect(query.avvisi_risposte).toBe(1)
        expect(m.get(A1)).toEqual(stats({ letti: 5, adesioni_si: 3, adesioni_no: 2, adesioni_senza_numero: 3 }))
        expect(m.get(A2)).toEqual(stats({ letti: 1, adesioni_si: 0, adesioni_no: 4 }))
        expect(m.get(A3)).toEqual(stats({}))
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
        expect(m.get(A1)).toEqual(stats({ letti: 5, adesioni_si: 3, adesioni_no: 2, adesioni_senza_numero: 3 }))
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

        expect(m.get(A1)).toEqual(stats({ letti: 1400, adesioni_si: 700, adesioni_no: 400, adesioni_senza_numero: 700 }))
        // 2500 righe / 1000 per pagina = 3 pagine. Non 1 (troncato), non 25.
        expect(query.avvisi_risposte).toBe(3)
    })

    it('errore PostgREST: statistiche a zero MA loggate a livello error', async () => {
        const spia = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { client } = clientFinto({ righe: righeDiProva(), erroreRisposte: { code: '42P01', message: 'relation does not exist' } })
        const m = await statistichePerAvviso(client, [A1], 'test')
        expect(m.get(A1)).toEqual(stats({}))
        spia.mockRestore()
    })
})

describe('rispostePerAvvisoDelGenitore', () => {
    it('indicizza per avviso e per figlio, filtrando sul genitore, in UNA query', async () => {
        const righe = [
            { avviso_id: A1, student_id: 's1', parent_id: 'p1', letto_il: '2026-08-01', risposta: 'si', risposto_il: '2026-08-01', stato_adesione: 'ammessa', numero_partecipanti: 3 },
            { avviso_id: A1, student_id: 's2', parent_id: 'p1', letto_il: null, risposta: null, risposto_il: null },
            { avviso_id: A2, student_id: 's1', parent_id: 'p1', letto_il: '2026-08-02', risposta: 'no', risposto_il: '2026-08-02' },
            // Altro genitore: non deve comparire.
            { avviso_id: A1, student_id: 's9', parent_id: 'ALTRO', letto_il: 'x', risposta: 'si', risposto_il: 'x' },
        ]
        const { client, query } = clientFinto({ righe })
        const m = await rispostePerAvvisoDelGenitore(client, [A1, A2], 'p1', 'test')

        expect(query.avvisi_risposte).toBe(1)
        // 🔴 `stato_adesione` e `numero_partecipanti` sono LA PROPRIA RIGA, non una
        // statistica di capienza: dicono dove sta questa famiglia, non quanto spazio
        // resta agli altri. Senza di loro il genitore non ha modo di sapere «sei in
        // lista d'attesa», che è l'informazione per cui la coda esiste.
        expect(m.get(A1)?.get('s1')).toEqual({
            letto_il: '2026-08-01', risposta: 'si', risposto_il: '2026-08-01',
            stato_adesione: 'ammessa', numero_partecipanti: 3,
        })
        // Riga senza le due colonne nuove (le 869 storiche): `null`, mai `undefined`
        // e mai `NaN` — chi legge distingue «non ha un numero» da «non l'ho letto».
        expect(m.get(A1)?.get('s2')).toEqual({
            letto_il: null, risposta: null, risposto_il: null,
            stato_adesione: null, numero_partecipanti: null,
        })
        expect(m.get(A2)?.get('s1')).toEqual({
            letto_il: '2026-08-02', risposta: 'no', risposto_il: '2026-08-02',
            stato_adesione: null, numero_partecipanti: null,
        })
        // La riga dell'altro genitore è stata esclusa dal filtro, non dall'indice.
        expect(m.get(A1)?.get('s9')).toBeUndefined()
    })

    it('senza parentId non interroga il database', async () => {
        const { client, query } = clientFinto({ righe: [] })
        const m = await rispostePerAvvisoDelGenitore(client, [A1], '', 'test')
        expect(query.avvisi_risposte).toBe(0)
        expect(m.size).toBe(0)
    })

    it('sul DB non migrato ripiega sulle colonne STORICHE invece di tornare a mani vuote', async () => {
        // Il DB E2E della CI non ha `stato_adesione`/`numero_partecipanti`: senza il
        // ripiego il `42703` produrrebbe ZERO righe, cioè `my_response: null` su ogni
        // avviso — a schermo «non hai mai risposto» detto a chi ha risposto.
        const righe = [
            { avviso_id: A1, student_id: 's1', parent_id: 'p1', letto_il: '2026-08-01', risposta: 'si', risposto_il: '2026-08-01' },
        ]
        const { client, query, proiezioni } = clientFinto({ righe, colonnaAssente: 'stato_adesione' })
        const m = await rispostePerAvvisoDelGenitore(client, [A1], 'p1', 'test')

        // Due tentativi sulla PRIMA pagina: quello allargato e quello ridotto. Se
        // fosse uno solo il ripiego non sarebbe mai scattato e il verde qui sotto
        // verrebbe da una proiezione che non ha mai fallito.
        expect(query.avvisi_risposte).toBe(2)
        expect(proiezioni[0]).toContain('stato_adesione')
        expect(proiezioni[1]).not.toContain('stato_adesione')

        expect(m.get(A1)?.get('s1')).toEqual({
            letto_il: '2026-08-01', risposta: 'si', risposto_il: '2026-08-01',
            stato_adesione: null, numero_partecipanti: null,
        })
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
