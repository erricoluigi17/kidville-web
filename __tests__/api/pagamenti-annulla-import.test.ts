import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DISFARE IN BLOCCO CIÒ CHE LA MACCHINA HA CHIUSO DA SOLA.
 *
 * `GET  /api/pagamenti/riconciliazione/annulla-import?import_id=…` — l'elenco
 * `POST /api/pagamenti/riconciliazione/annulla-import` — lo storno di tutte
 *
 * ─── LE CINQUE COSE CHE QUESTI TEST TENGONO FERME ───────────────────────────
 *
 * 1. **L'elenco e il bersaglio sono lo STESSO insieme.** La conferma si digita —
 *    si scrive il NUMERO delle righe — quindi un elenco più largo del bersaglio
 *    renderebbe quel numero una firma su un documento diverso. Qui si misura che
 *    la query porti le tre condizioni insieme: import, `confermato`, marca non
 *    nulla. La terza è quella che tiene fuori il lavoro fatto a MANO.
 *
 * 2. **Il perimetro dell'annullo è quello dell'OPERATORE**, non la deroga
 *    cross-sede della fase automatica: se anche una riga è di un'altra sede si
 *    risponde 403 **e non si scrive niente**. Misurato come assenza di
 *    chiamate a `riapriMovimento`, non come status.
 *
 * 3. **Non è atomica e non finge di esserlo**: la risposta elenca le righe
 *    fallite col loro codice, e il credito già speso ha un contatore suo.
 *
 * 4. **Il ritentativo è idempotente per COSTRUZIONE**: al secondo giro le righe
 *    riaperte non sono più `confermato` e la query non le restituisce.
 *
 * 5. **Senza la marca non si ripiega**: su un database che non ha
 *    `abbinato_auto_il` si risponde 503, mai «tutti i confermati di questo
 *    import» — che vorrebbe dire stornare il lavoro di una persona.
 */

const h = vi.hoisted(() => ({
    requireStaff: vi.fn(),
    logScrittura: vi.fn(),
    logErrore: vi.fn(),
    logEvento: vi.fn(),
    logOk: vi.fn(),
    /** Le sedi dell'operatore: il perimetro dell'ANNULLO. */
    sediAttive: ['sc-1'] as string[],
    /** Le righe che la query dell'import restituisce, pagina per pagina. */
    righe: [] as Record<string, unknown>[],
    righeError: null as { code: string; message: string } | null,
    pagamenti: [] as Record<string, unknown>[],
    pagamentiError: null as { code: string; message: string } | null,
    transazioni: [] as Record<string, unknown>[],
    transazioniError: null as { code: string; message: string } | null,
    /** Ogni lettura, con le colonne e i filtri: è la prova della query. */
    letture: [] as { table: string; cols: string; filtri: Record<string, unknown> }[],
    /** Ogni chiamata a `riapriMovimento`, nell'ordine. */
    riaperture: [] as Record<string, unknown>[],
    /** Esito pilotabile della riapertura, per id di movimento. */
    esitoRiapertura: {} as Record<string, unknown>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async () => h.sediAttive }))
vi.mock('@/lib/logging/logger', () => ({ logOk: h.logOk, logErrore: h.logErrore, logEvento: h.logEvento }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => finto() }))

/**
 * ⚠️ `riapriMovimento` È MOCKATA, e la ragione va detta: qui non si ricollauda
 * lo storno — ce l'ha il suo test (`pagamenti-riconciliazione-riapri`) — si
 * misura che questa rotta lo CHIAMI, una volta per riga, coi parametri giusti, e
 * che sappia leggere ogni forma di risposta. Il mock restituisce forme VERE di
 * quel modulo (`{ status, body, ok }`), non un `true` piatto: un finto che
 * risponde sempre la stessa cosa misura il finto, non il codice.
 */
vi.mock('@/lib/pagamenti/riapertura-movimento', () => ({
    riapriMovimento: async (_s: unknown, args: Record<string, unknown>) => {
        h.riaperture.push(args)
        const id = (args.movimento as { id: string }).id
        return (
            h.esitoRiapertura[id] ?? {
                status: 200,
                body: { success: true, data: { stato: 'da_abbinare' } },
                ok: { transazioneAnnullata: false, incassiStornati: 1, movimentiRiaperti: 1, fattureVive: 0 },
            }
        )
    },
}))

/** Il finto: una forma sola per tutte le tabelle, pilotata per NOME. */
function finto() {
    return {
        from: (table: string) => {
            const filtri: Record<string, unknown> = {}
            const b: Record<string, unknown> = {}
            b.select = (cols?: string) => { b._cols = cols ?? ''; return b }
            b.eq = (c: string, v: unknown) => { filtri[c] = v; return b }
            b.in = (c: string, v: unknown) => { filtri[c] = v; return b }
            b.not = (c: string, op: string, v: unknown) => { filtri[`not:${c}`] = `${op}:${String(v)}`; return b }
            b.order = () => b
            b.range = (da: number, a: number) => { filtri.range = [da, a]; return b }
            b.then = (resolve: (v: unknown) => unknown) => {
                h.letture.push({ table, cols: typeof b._cols === 'string' ? b._cols : '', filtri: { ...filtri } })
                if (table === 'riconciliazione_movimenti') {
                    if (h.righeError) return resolve({ data: null, error: h.righeError })
                    // La paginazione è vera: si risponde la fetta chiesta, e la
                    // pagina dopo l'ultima è VUOTA. Un finto che rispondesse
                    // sempre le stesse righe farebbe girare il ciclo per sempre —
                    // e nasconderebbe il fatto che l'avanzamento è sbagliato.
                    const [da, a] = (filtri.range as number[]) ?? [0, 99]
                    return resolve({ data: h.righe.slice(da, a + 1), error: null })
                }
                if (table === 'pagamenti') {
                    return resolve({ data: h.pagamentiError ? null : h.pagamenti, error: h.pagamentiError })
                }
                if (table === 'pagamenti_transazioni') {
                    return resolve({ data: h.transazioniError ? null : h.transazioni, error: h.transazioniError })
                }
                return resolve({ data: [], error: null })
            }
            return b
        },
    }
}

import { GET, POST } from '@/app/api/pagamenti/riconciliazione/annulla-import/route'
import { codiceVoce } from '@/lib/pagamenti/codice-voce'
// La vera `messaggioDaCorpo`: è la sola cosa che dica che cosa l'operatrice
// legge davvero quando un codice non è in `CODICI_CON_DETTAGLIO`.
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch'

const IMP = 'ffffffff-ffff-4fff-8fff-fffffffffff0'
const M1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
const M2 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2'
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const P2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const TX = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'

const get = (q = `import_id=${IMP}`) =>
    GET(new Request(`http://localhost/api/pagamenti/riconciliazione/annulla-import?${q}`) as never)

const post = (body: unknown) =>
    POST(
        new Request('http://localhost/api/pagamenti/riconciliazione/annulla-import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }) as never,
    )

const letteDa = (t: string) => h.letture.filter((l) => l.table === t)

/** Una riga chiusa dalla macchina, coi campi che la rotta legge. */
const riga = (over: Record<string, unknown> = {}) => ({
    id: M1,
    scuola_id: 'sc-1',
    data_operazione: '2026-09-18',
    importo: 150,
    causale: 'BONIFICO RETTA',
    controparte: 'MARIO ROSSI',
    pagamento_id: P1,
    incasso_id: 'inc-1',
    transazione_id: null,
    abbinato_auto_il: '2026-09-20T08:00:00.000Z',
    ...over,
})

beforeEach(() => {
    vi.clearAllMocks()
    h.letture = []
    h.riaperture = []
    h.esitoRiapertura = {}
    h.sediAttive = ['sc-1']
    h.righe = [riga()]
    h.righeError = null
    h.pagamenti = [{ id: P1, descrizione: 'Retta ottobre', alunni: { nome: 'Anna', cognome: 'Bianchi', codice_fiscale: 'BNCNNA10A41H501K' } }]
    h.pagamentiError = null
    h.transazioni = []
    h.transazioniError = null
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
})

describe('la QUERY: l’elenco e il bersaglio sono lo stesso insieme', () => {
    it('chiede import + stato confermato + marca NON nulla, nella stessa query', async () => {
        await get()
        const q = letteDa('riconciliazione_movimenti')[0]
        expect(q.filtri.import_id).toBe(IMP)
        expect(q.filtri.stato).toBe('confermato')
        // 🔴 È la condizione che tiene fuori il lavoro fatto A MANO: una riga
        // riaperta e riconfermata da una persona ha la marca spenta.
        expect(q.filtri['not:abbinato_auto_il']).toBe('is:null')
        expect(q.cols).toContain('abbinato_auto_il')
    })

    it('la STESSA query la fa anche il POST: elenco e bersaglio non possono divergere', async () => {
        await post({ import_id: IMP, conferma: true })
        const q = letteDa('riconciliazione_movimenti')[0]
        expect(q.filtri.stato).toBe('confermato')
        expect(q.filtri['not:abbinato_auto_il']).toBe('is:null')
    })

    it('pagina avanzando di quante righe ha RICEVUTO, e si ferma sulla pagina vuota', async () => {
        // 150 righe: due pagine da 100 e la terza vuota. Il ciclo deve fermarsi
        // sulla terza, non alla centesima riga — il tetto è 200.
        h.righe = Array.from({ length: 150 }, (_, i) => riga({ id: `mov-${i}`, pagamento_id: `pag-${i}` }))
        const res = await get()
        const j = (await res.json()) as { data: { n: number } }
        expect(j.data.n).toBe(150)
        const pagine = letteDa('riconciliazione_movimenti').map((l) => l.filtri.range)
        expect(pagine).toEqual([[0, 99], [100, 199], [150, 249]])
    })
})

describe('GET — l’elenco, col PERCHÉ', () => {
    it('porta data, importo, causale, la voce e il motivo ricostruito', async () => {
        const codice = codiceVoce(P1)
        h.righe = [riga({ causale: `RETTA OTTOBRE ${codice}` })]
        const res = await get()
        expect(res.status).toBe(200)
        const j = (await res.json()) as { data: { righe: Record<string, unknown>[]; annullabile: boolean } }
        const r = j.data.righe[0]
        expect(r.importo).toBe(150)
        expect(r.data_operazione).toBe('2026-09-18')
        expect(r.voce).toBe('Anna Bianchi · Retta ottobre')
        expect(r.motivi).toEqual(['codice_voce', 'residuo_esatto'])
        expect(r.codice).toBe(codice)
        expect(j.data.annullabile).toBe(true)
    })

    it('🔴 il CODICE FISCALE letto dall’anagrafica non diventa MAI un campo della risposta', async () => {
        // ⚠️ IL CONFINE VA DETTO PER INTERO, perché è più sottile di «il CF non
        // esce»: il CF compare nella CAUSALE, ed è la causale della banca — la
        // stessa che il registro mostra già a tutte le segreterie, per decisione
        // dichiarata (l'estratto conto è unico per le tre sedi). Quello che
        // questa rotta non deve fare è AGGIUNGERE il CF che ha letto
        // dall'anagrafica: lo usa per il confronto e lo lascia lì. Il motivo che
        // esce è un enumerato, non il dato.
        const CF = 'BNCNNA10A41H501K'
        h.righe = [riga({ causale: `RETTA ${CF}` })]
        const res = await get()
        const j = (await res.json()) as { data: { righe: Record<string, unknown>[] } }
        const r = j.data.righe[0]
        expect(r.motivi).toContain('codice_fiscale')
        // Nessun campo della riga porta il CF — tranne la causale, che è il testo
        // della banca e arriva così com'è anche dal registro.
        for (const [chiave, valore] of Object.entries(r)) {
            if (chiave === 'causale') continue
            expect(JSON.stringify(valore), `il campo ${chiave} porta un codice fiscale`).not.toContain(CF)
        }
    })

    it('il codice fiscale di un’altra sede non si LEGGE nemmeno: il filtro è in query', async () => {
        // La minimizzazione che vale non è omettere dopo aver letto: è non
        // leggere. Su una riga fuori perimetro il pagamento non viene proprio
        // chiesto, quindi il perché ricade sul solo codice voce (che nasce
        // dall'uuid e non costa nessuna lettura).
        h.righe = [riga({ scuola_id: 'sc-2', causale: 'RETTA BNCNNA10A41H501K' })]
        h.pagamenti = []
        const res = await get()
        const j = (await res.json()) as { data: { righe: Record<string, unknown>[] } }
        expect(j.data.righe[0].motivi).toEqual(['non_ricostruito', 'residuo_esatto'])
        expect(letteDa('pagamenti')[0].filtri.scuola_id).toEqual(['sc-1'])
    })

    it('la VOCE di un’altra sede non si legge nemmeno: `null`, e la riga è marcata fuori perimetro', async () => {
        h.righe = [riga({ scuola_id: 'sc-2' })]
        // Il filtro di sede è IN QUERY: quel pagamento non torna affatto.
        h.pagamenti = []
        const res = await get()
        const j = (await res.json()) as { data: { righe: Record<string, unknown>[]; annullabile: boolean; fuori_perimetro: number } }
        expect(j.data.righe[0].voce).toBeNull()
        expect(j.data.righe[0].fuori_perimetro).toBe(true)
        // E il pannello lo sa PRIMA di offrire il pulsante.
        expect(j.data.annullabile).toBe(false)
        expect(j.data.fuori_perimetro).toBe(1)
        // La lettura delle voci porta il filtro di sede nella query, non dopo.
        expect(letteDa('pagamenti')[0].filtri.scuola_id).toEqual(['sc-1'])
    })

    it('zero righe ⇒ `annullabile: false`: non c’è niente da annullare', async () => {
        h.righe = []
        const res = await get()
        const j = (await res.json()) as { data: { n: number; annullabile: boolean } }
        expect(j.data.n).toBe(0)
        expect(j.data.annullabile).toBe(false)
    })

    it('oltre il tetto ⇒ l’elenco esce ma NON è annullabile', async () => {
        h.righe = Array.from({ length: 201 }, (_, i) => riga({ id: `mov-${i}`, pagamento_id: `pag-${i}` }))
        const res = await get()
        const j = (await res.json()) as { data: { oltre_tetto: boolean; annullabile: boolean; n: number } }
        expect(j.data.oltre_tetto).toBe(true)
        expect(j.data.annullabile).toBe(false)
        expect(j.data.n).toBe(200)
    })

    it('🔴 oltre il tetto, l’anagrafica della riga in PIÙ non si legge nemmeno', async () => {
        // Oltre il tetto la query restituisce TETTO+1 righe — è così che dichiara
        // `troppe` — e quella in più non esce nella risposta. Leggerne il
        // pagamento vorrebbe dire portare nel processo nome, cognome e codice
        // fiscale di un minore per buttarli una riga dopo: è la minimizzazione
        // che questo file rivendica («quella che vale è quella che non li legge
        // affatto»), e valeva per 200 righe su 201.
        h.righe = Array.from({ length: 201 }, (_, i) => riga({ id: `mov-${i}`, pagamento_id: `pag-${i}` }))
        await get()
        const chiesti = letteDa('pagamenti').flatMap((l) => (l.filtri.id as string[]) ?? [])
        expect(chiesti).toHaveLength(200)
        expect(chiesti).not.toContain('pag-200')
        // E un blocco in meno di round-trip: 200 uuid stanno in due finestre da
        // 100, 201 ne volevano tre — la terza per un solo id mai mostrato.
        expect(letteDa('pagamenti')).toHaveLength(2)
    })

    it('marca assente (DB E2E non migrato) ⇒ 200 con `disponibile: false`, non un errore', async () => {
        h.righeError = { code: '42703', message: 'column does not exist' }
        const res = await get()
        expect(res.status).toBe(200)
        const j = (await res.json()) as { disponibile: boolean; data: unknown }
        expect(j.disponibile).toBe(false)
        expect(j.data).toBeNull()
    })

    it('una lettura fallita è un 500 col suo codice, MAI un elenco vuoto', async () => {
        h.righeError = { code: '57014', message: 'statement timeout' }
        const res = await get()
        expect(res.status).toBe(500)
        const j = (await res.json()) as { codice: string }
        expect(j.codice).toBe('ANNULLO_IMPORT_NON_LETTO')
        expect(h.logErrore).toHaveBeenCalled()
    })

    it('un `import_id` che non è un uuid è un 400 di validazione', async () => {
        const res = await get('import_id=non-un-uuid')
        expect(res.status).toBe(400)
        expect(letteDa('riconciliazione_movimenti')).toHaveLength(0)
    })
})

describe('POST — il gate di sede: TUTTO o NIENTE, prima di ogni scrittura', () => {
    it('🔴 una sola riga di un’altra sede ⇒ 403 e NESSUNO storno', async () => {
        h.righe = [riga(), riga({ id: M2, scuola_id: 'sc-2', pagamento_id: P2 })]
        const res = await post({ import_id: IMP, conferma: true })
        expect(res.status).toBe(403)
        const j = (await res.json()) as { codice: string }
        expect(j.codice).toBe('ANNULLO_IMPORT_FUORI_PERIMETRO')
        // La prova che conta: non è partito NIENTE, nemmeno per la riga buona.
        expect(h.riaperture).toEqual([])
        expect(h.logScrittura).not.toHaveBeenCalled()
    })

    it('una riga SENZA sede non passa: «non lo so» non è «è mia»', async () => {
        h.righe = [riga({ scuola_id: null })]
        const res = await post({ import_id: IMP, conferma: true })
        expect(res.status).toBe(403)
        expect(h.riaperture).toEqual([])
    })

    it('la sede del DOCUMENTO si controlla sulla transazione, non solo sul movimento', async () => {
        // Un bonifico che paga figli di plessi diversi produce UN documento, la
        // cui sede può differire da quella della voce àncora: è il caso in cui
        // il gate sul solo movimento non basterebbe.
        h.righe = [riga({ transazione_id: TX })]
        h.transazioni = [{ id: TX, scuola_id: 'sc-2', annullata_il: null }]
        const res = await post({ import_id: IMP, conferma: true })
        expect(res.status).toBe(403)
        expect(h.riaperture).toEqual([])
    })

    it('una transazione citata e NON trovata ferma tutto: non si indovina', async () => {
        h.righe = [riga({ transazione_id: TX })]
        h.transazioni = []
        const res = await post({ import_id: IMP, conferma: true })
        expect(res.status).toBe(403)
        expect(h.riaperture).toEqual([])
    })

    it('transazioni non LETTE ⇒ 503 fail-closed, nessuno storno', async () => {
        h.righe = [riga({ transazione_id: TX })]
        h.transazioniError = { code: '57014', message: 'statement timeout' }
        const res = await post({ import_id: IMP, conferma: true })
        expect(res.status).toBe(503)
        expect(h.riaperture).toEqual([])
        expect(h.logErrore).toHaveBeenCalled()
    })
})

describe('POST — il ciclo, e la risposta che non finge', () => {
    it('riapre ogni riga passando dal modulo del pulsante singolo', async () => {
        h.righe = [riga(), riga({ id: M2, pagamento_id: P2, incasso_id: 'inc-2' })]
        const res = await post({ import_id: IMP, conferma: true })
        expect(res.status).toBe(200)
        const j = (await res.json()) as { data: { riaperti: number; incassi_stornati: number; falliti: unknown[] } }
        expect(h.riaperture).toHaveLength(2)
        expect((h.riaperture[0].movimento as { id: string }).id).toBe(M1)
        expect((h.riaperture[1].movimento as { id: string }).id).toBe(M2)
        expect(j.data.riaperti).toBe(2)
        expect(j.data.incassi_stornati).toBe(2)
        expect(j.data.falliti).toEqual([])
        // Audit per riga PIÙ una riga d'insieme.
        expect(h.logScrittura).toHaveBeenCalledTimes(3)
    })

    it('le due colonne si dichiarano presenti: la query che le ha lette è appena riuscita', async () => {
        await post({ import_id: IMP, conferma: true })
        expect(h.riaperture[0].colonnaMarca).toBe(true)
        expect(h.riaperture[0].colonnaTransazione).toBe(true)
    })

    it('«transazione GIÀ annullata» arriva dal chiamante, come sul pulsante singolo', async () => {
        h.righe = [riga({ transazione_id: TX })]
        h.transazioni = [{ id: TX, scuola_id: 'sc-1', annullata_il: '2026-09-20T09:00:00.000Z' }]
        await post({ import_id: IMP, conferma: true })
        expect(h.riaperture[0].transazioneGiaAnnullata).toBe(true)
    })

    it('🔴 NON è atomica: una riga fallita non ferma le altre, ed esce nell’elenco col suo codice', async () => {
        h.righe = [riga(), riga({ id: M2, pagamento_id: P2 })]
        h.esitoRiapertura[M1] = {
            status: 500,
            body: { error: 'storno non riuscito', codice: 'RIAPERTURA_NON_RIUSCITA' },
        }
        const res = await post({ import_id: IMP, conferma: true })
        expect(res.status).toBe(200)
        const j = (await res.json()) as { data: { riaperti: number; falliti: { movimento_id: string; codice: string }[] } }
        expect(j.data.riaperti).toBe(1)
        expect(j.data.falliti).toEqual([{ movimento_id: M1, stato: 500, codice: 'RIAPERTURA_NON_RIUSCITA' }])
        // Ogni riga rimasta indietro è denaro ancora attaccato a un bonifico:
        // livello `error`, non `warn`.
        const errori = h.logEvento.mock.calls.filter((c) => c[1] === 'error')
        expect(errori.length).toBeGreaterThan(0)
    })

    it('il CREDITO GIÀ SPESO ha un contatore suo: quella riga è INTATTA, non a metà', async () => {
        h.righe = [riga(), riga({ id: M2, pagamento_id: P2 })]
        h.esitoRiapertura[M2] = {
            status: 409,
            body: { error: 'credito già speso', codice: 'RIAPERTURA_CREDITO_GIA_SPESO' },
        }
        const res = await post({ import_id: IMP, conferma: true })
        const j = (await res.json()) as { data: { credito_gia_speso: number; riaperti: number } }
        expect(j.data.credito_gia_speso).toBe(1)
        expect(j.data.riaperti).toBe(1)
    })

    it('le fatture vive si AGGREGANO, e alzano un warn dedicato: dovrebbero essere zero', async () => {
        h.esitoRiapertura[M1] = {
            status: 200,
            body: {
                success: true,
                avviso: { codice: 'RIAPERTURA_CON_FATTURA_VIVA', messaggio: '…', numeri: ['Asilo 2328/2026'] },
            },
            ok: { transazioneAnnullata: false, incassiStornati: 1, movimentiRiaperti: 1, fattureVive: 1 },
        }
        const res = await post({ import_id: IMP, conferma: true })
        const j = (await res.json()) as { data: { fatture: { movimento_id: string; numeri: string[] }[] } }
        expect(j.data.fatture).toEqual([{ movimento_id: M1, numeri: ['Asilo 2328/2026'] }])
        // L'automatismo non emette fatture: se una è viva, l'annullo arriva tardi.
        const avvisi = h.logEvento.mock.calls.filter(
            (c) => (c[2] as { esito?: string })?.esito === 'annullo-import-fatture-emesse-nel-frattempo',
        )
        expect(avvisi).toHaveLength(1)
    })
})

describe('POST — i rifiuti, e l’idempotenza', () => {
    it('senza `conferma: true` è un 400 di validazione, prima di ogni lettura', async () => {
        const res = await post({ import_id: IMP })
        expect(res.status).toBe(400)
        expect(letteDa('riconciliazione_movimenti')).toHaveLength(0)
        expect(h.riaperture).toEqual([])
    })

    it('`conferma: false` non è una conferma: 400, non 200', async () => {
        const res = await post({ import_id: IMP, conferma: false })
        expect(res.status).toBe(400)
        expect(h.riaperture).toEqual([])
    })

    it('oltre il tetto ⇒ 422 col suo codice, e nessuno storno', async () => {
        h.righe = Array.from({ length: 201 }, (_, i) => riga({ id: `mov-${i}`, pagamento_id: `pag-${i}` }))
        const res = await post({ import_id: IMP, conferma: true })
        expect(res.status).toBe(422)
        const j = (await res.json()) as { codice: string; error: string }
        expect(j.codice).toBe('ANNULLO_IMPORT_TROPPE_RIGHE')
        expect(h.riaperture).toEqual([])
        // La frase che l'operatrice legge davvero: il codice è dichiarato, quindi
        // vince il catalogo — e deve dire che cosa fare, non «errore».
        expect(messaggioDaCorpo(j, 'ripiego')).toContain('registro')
    })

    it('🔴 senza la marca NON si ripiega sui confermati: 503, mai il lavoro di una persona', async () => {
        h.righeError = { code: '42703', message: 'column abbinato_auto_il does not exist' }
        const res = await post({ import_id: IMP, conferma: true })
        expect(res.status).toBe(503)
        const j = (await res.json()) as { codice: string }
        expect(j.codice).toBe('ANNULLO_IMPORT_NON_DISPONIBILE')
        expect(h.riaperture).toEqual([])
    })

    it('il SECONDO giro non trova niente e risponde 200 con gli zeri', async () => {
        // Le righe riaperte non sono più `confermato`: la query non le porta.
        h.righe = []
        const res = await post({ import_id: IMP, conferma: true })
        expect(res.status).toBe(200)
        const j = (await res.json()) as { data: { riaperti: number; falliti: unknown[] } }
        expect(j.data.riaperti).toBe(0)
        expect(j.data.falliti).toEqual([])
        expect(h.riaperture).toEqual([])
        // Il log di SUCCESSO si scrive anche a zero (regola 5 di AGENTS.md).
        const ok = h.logEvento.mock.calls.filter(
            (c) => (c[2] as { esito?: string })?.esito === 'annullo_import_eseguito',
        )
        expect(ok).toHaveLength(1)
    })

    it('senza gate di ruolo non si arriva alla query', async () => {
        h.requireStaff.mockResolvedValue({ response: new Response('no', { status: 403 }) })
        const res = await post({ import_id: IMP, conferma: true })
        expect(res.status).toBe(403)
        expect(letteDa('riconciliazione_movimenti')).toHaveLength(0)
    })
})
