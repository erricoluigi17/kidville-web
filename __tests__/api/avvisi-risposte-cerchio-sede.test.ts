import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// L'ISOLAMENTO FRA SEDI SULLE ADESIONI — LA SCRITTURA CHE LO APRIVA E LE DUE
// LETTURE CHE NON ERANO D'ACCORDO.
//
// ─── IL DIFETTO, MISURATO ───────────────────────────────────────────────────
//
// `POST /api/avvisi/[id]/risposte` verificava `genitoreHasFiglio` E NULLA ALTRO:
// né la route né `avviso_adesione_registra` guardavano la sede dell'alunno o le
// `target_classes` dell'avviso. Un genitore con due figli in due plessi — caso
// dichiarato reale dal commento della rotta di esportazione, che apposta NON
// filtra i genitori per sede — poteva rispondere a un avviso di UNA sede
// mandando lo `student_id` del figlio dell'ALTRA. La riga veniva scritta.
//
// Da lì in poi le due letture della stessa cosa non erano d'accordo:
//
//   · `…/risposte/esporta` filtrava gli alunni per `scuola_id` → il bambino
//     SPARIVA dal file, con Classe e Alunno vuote e **nessun log**;
//   · `…/risposte` (GET) non filtrava niente → il bambino COMPARIVA a schermo,
//     col nome, e contava nel riepilogo.
//
// La schermata su cui la segreteria decide chi va in gita e il file che stampa e
// si porta dietro contenevano elenchi DIVERSI, e nessuno dei due diceva perché.
//
// ─── COSA MISURA QUESTO FILE, e perché proprio queste tre cose ───────────────
//
//  1. IL CERCHIO. La stessa riga anomala esce UGUALE dalle due letture. È
//     l'unica asserzione che impedisce alle due copie di ri-divergere: da oggi
//     la regola vive in `@/lib/avvisi/nomi-risposte`, che entrambe importano, e
//     questo `it` è ciò che se ne accorge il giorno in cui una delle due si
//     riscrive la propria.
//  2. IL 403 DELLA SCRITTURA, nei DUE casi che il gate copre — la sede e la
//     classe — con la controprova che un'adesione legittima resta 200 (un gate
//     che nega tutto passerebbe metà di questi test).
//  3. IL NOME CHE MANCA NON È MUTO: `alunni-non-risolti`, preteso PER NOME e col
//     conteggio, da entrambe le letture. Senza, «manca un nome» e «quel bambino
//     è di un altro plesso» restano la stessa cella vuota.
//
// ─── LE PROVE DI ROTTURA, ESEGUITE (2026-09-19) ─────────────────────────────
//
//  1. tolto il gate dal `POST` (le due letture di `avvisi`/`alunni` e il rifiuto)
//     → ROSSI i tre `it` del 403: la riga viene scritta e la RPC parte.
//  2. rimessa nella GET una risoluzione dei nomi TUTTA SUA, senza il filtro di
//     sede (com'era fino a ieri) → ROSSO «esce UGUALE dalle due letture»: la GET
//     mostra il nome, il CSV lascia la cella vuota.
//  3. tolto il `logEvento('avvisi','warn', …)` da una delle due letture → ROSSO
//     l'`it` che lo pretende per nome in entrambe.
// =============================================================================

const AVVISO_ID = '11111111-1111-1111-1111-111111111111'
const PARENT_ID = '33333333-3333-3333-3333-333333333333'
/** Il figlio iscritto NELLA sede dell'avviso. */
const ALU_DENTRO = '44444444-4444-4444-4444-444444444444'
/** Il fratello, iscritto in un ALTRO plesso: è lui a produrre la riga anomala. */
const ALU_FUORI = '55555555-5555-5555-5555-555555555555'

type Riga = Record<string, unknown>

const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    requireDocente: vi.fn(),
    requireStaff: vi.fn(),
    scuoleDiUtente: vi.fn(),
    assertAvvisoInScope: vi.fn(),
    genitoreHasFiglio: vi.fn(),
    assertGenitoreNonSospeso: vi.fn(),
    logEvento: vi.fn(),
    /** Le tabelle, come le vedono tutte e tre le rotte in questo file. */
    db: {} as Record<string, Riga[]>,
    lastRpc: null as { nome: string; args: Record<string, unknown> } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireUser: (...a: unknown[]) => h.requireUser(...a),
    requireDocente: (...a: unknown[]) => h.requireDocente(...a),
    requireStaff: (...a: unknown[]) => h.requireStaff(...a),
}))
vi.mock('@/lib/auth/scope', async (originale) => ({
    ...(await originale<typeof import('@/lib/auth/scope')>()),
    scuoleDiUtente: (...a: unknown[]) => h.scuoleDiUtente(...a),
}))
vi.mock('@/lib/auth/scope-avvisi', () => ({
    assertAvvisoInScope: (...a: unknown[]) => h.assertAvvisoInScope(...a),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: (...a: unknown[]) => h.genitoreHasFiglio(...a) }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: (...a: unknown[]) => h.assertGenitoreNonSospeso(...a) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(async () => undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => []) }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/logging/logger', async (originale) => ({
    ...(await originale<typeof import('@/lib/logging/logger')>()),
    logEvento: (...a: unknown[]) => h.logEvento(...a),
}))

/**
 * UN POSTGREST CHE APPLICA DAVVERO `.eq` E `.in`.
 *
 * 🔑 È il punto su cui poggia tutto questo file: il filtro di sede degli alunni
 * (`.eq('scuola_id', …)`) deve TOGLIERE righe, altrimenti «con filtro» e «senza
 * filtro» darebbero lo stesso risultato e il test del cerchio sarebbe verde con
 * e senza la correzione — la prima delle cinque forme di verde falso.
 */
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        rpc(nome: string, args: Record<string, unknown>) {
            if (nome !== 'avviso_adesione_registra') {
                throw new Error(`rpc non emulata in questo finto: ${nome}`)
            }
            h.lastRpc = { nome, args }
            return Promise.resolve({
                data: {
                    ok: true,
                    stato: args.p_risposta === 'si' ? 'ammessa' : null,
                    numero: args.p_numero ?? null,
                    prima_lettura: true,
                    prima_risposta: args.p_risposta != null,
                    riga: { id: 'r-nuova', avviso_id: args.p_avviso_id, student_id: args.p_student_id },
                },
                error: null,
            })
        },
        from(tabella: string) {
            const filtri: Array<(r: Riga) => boolean> = []
            const righe = () => (h.db[tabella] ?? []).filter((r) => filtri.every((f) => f(r)))
            const b: Record<string, unknown> = {}
            b.select = () => b
            b.order = () => b
            b.eq = (c: string, v: unknown) => { filtri.push((r) => r[c] === v); return b }
            b.in = (c: string, v: unknown[]) => { filtri.push((r) => v.includes(r[c])); return b }
            b.maybeSingle = async () => ({ data: righe()[0] ?? null, error: null })
            b.single = b.maybeSingle
            b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
                Promise.resolve({ data: righe(), error: null }).then(ok, ko)
            return b
        },
    }),
}))

import { GET, POST } from '@/app/api/avvisi/[id]/risposte/route'
import { GET as ESPORTA } from '@/app/api/avvisi/[id]/risposte/esporta/route'

const ctx = () => ({ params: Promise.resolve({ id: AVVISO_ID }) })
const reqGet = () => new Request(`http://localhost/api/avvisi/${AVVISO_ID}/risposte`)
const reqEsporta = () => new Request(`http://localhost/api/avvisi/${AVVISO_ID}/risposte/esporta`)
const reqPost = (body: unknown) => ({
    url: `http://test/api/avvisi/${AVVISO_ID}/risposte`,
    method: 'POST',
    headers: new Headers(),
    json: async () => body,
}) as never

/** I `warn` scritti con l'esito chiesto, in ordine. */
function warn(esito: string): Array<Record<string, unknown>> {
    return h.logEvento.mock.calls
        .filter((c) => c[1] === 'warn' && (c[2] as { esito?: string })?.esito === esito)
        .map((c) => c[2] as Record<string, unknown>)
}

/**
 * La riga del CSV, spezzata. I dati di questo file non contengono virgole né
 * apici di proposito: un parser vero qui misurerebbe sé stesso.
 */
function celleCsv(testo: string): string[][] {
    return testo
        .replace(/^﻿/, '')
        .split('\r\n')
        .filter((r) => r !== '')
        .slice(1)
        .map((r) => r.split(','))
}

beforeEach(() => {
    vi.clearAllMocks()
    h.lastRpc = null
    h.db = {
        avvisi: [{
            id: AVVISO_ID,
            author_id: 'aut-x',
            titolo: 'Gita',
            scuola_id: SEDE_A,
            target_scope: 'globale',
            target_classes: null,
            etichetta_numero: 'Accompagnatori',
        }],
        // DUE righe, e sono due fratelli: una legittima, una che punta al figlio
        // iscritto nell'ALTRO plesso. Con una riga sola non si distinguerebbe
        // «l'elenco è vuoto» da «l'elenco nasconde qualcosa».
        avvisi_risposte: [
            {
                id: 'r-dentro', avviso_id: AVVISO_ID, parent_id: PARENT_ID, student_id: ALU_DENTRO,
                letto_il: '2026-09-18T09:00:00.000Z', risposta: 'si', risposto_il: '2026-09-18T09:01:00.000Z',
                numero_partecipanti: 2, stato_adesione: 'ammessa', in_coda_dal: null,
            },
            {
                id: 'r-fuori', avviso_id: AVVISO_ID, parent_id: PARENT_ID, student_id: ALU_FUORI,
                letto_il: '2026-09-18T09:00:00.000Z', risposta: 'si', risposto_il: '2026-09-18T09:02:00.000Z',
                numero_partecipanti: 1, stato_adesione: 'ammessa', in_coda_dal: null,
            },
        ],
        alunni: [
            { id: ALU_DENTRO, nome: 'Bruna', cognome: 'Dentro', classe_sezione: '1A', scuola_id: SEDE_A },
            { id: ALU_FUORI, nome: 'Nicola', cognome: 'Fuori', classe_sezione: '2B', scuola_id: SEDE_B },
        ],
        utenti: [
            { id: PARENT_ID, nome: 'Genitore', cognome: 'Unico', first_name: null, last_name: null, role: 'genitore', ruolo: 'genitore' },
            { id: 'aut-x', nome: null, cognome: null, first_name: 'Aut', last_name: 'Ore', role: 'segreteria', ruolo: 'segreteria' },
        ],
    }
    h.requireDocente.mockResolvedValue({ user: { id: 'doc-1', role: 'admin', scuola_id: SEDE_A }, response: null })
    h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
    h.scuoleDiUtente.mockResolvedValue([SEDE_A])
    h.assertAvvisoInScope.mockResolvedValue(null)
    h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: SEDE_A } })
    h.genitoreHasFiglio.mockResolvedValue(true)
    h.assertGenitoreNonSospeso.mockResolvedValue(null)
})

// ═════════════════════════════════════════════════════════════════════════════
describe('adesioni — IL CERCHIO: le due letture non possono divergere', () => {
    it('🔑 una riga che punta a un alunno di un ALTRO plesso esce UGUALE dalle due letture', async () => {
        const schermata = (await (await GET(reqGet(), ctx())).json()) as Array<Record<string, string>>
        const file = celleCsv(await (await ESPORTA(reqEsporta(), ctx())).text())

        // 1. La riga C'È in entrambe: nessuna delle due la fa sparire in silenzio.
        expect(schermata).toHaveLength(2)
        expect(file).toHaveLength(2)

        // 2. E dicono la stessa cosa, riga per riga, su chi è noto e chi no.
        //    Le colonne del CSV sono [Classe, Alunno, Genitore, …].
        const daSchermata = schermata.map((r) => ({
            alunnoNoto: r.student_name !== '?',
            genitoreNoto: r.parent_name !== '?',
        }))
        const daFile = file.map((c) => ({
            alunnoNoto: c[1] !== '',
            genitoreNoto: c[2] !== '',
        }))
        expect(
            daSchermata,
            'la schermata su cui si decide chi va in gita e il file che si stampa contengono elenchi diversi',
        ).toEqual(daFile)

        // 3. CONTROPROVA POSITIVA: senza questa, una regola che nascondesse TUTTI
        //    i nomi passerebbe i due controlli qui sopra.
        expect(daSchermata[0]).toEqual({ alunnoNoto: true, genitoreNoto: true })
        expect(daSchermata[1].alunnoNoto, 'il bambino dell’altro plesso è tornato a comparire').toBe(false)
    })

    it('il nome dell’altro plesso non compare NÉ a schermo NÉ nel file', async () => {
        const schermata = await (await GET(reqGet(), ctx())).text()
        const file = await (await ESPORTA(reqEsporta(), ctx())).text()

        for (const [dove, testo] of [['schermata', schermata], ['file', file]] as const) {
            expect(testo, `il nome di un minore di un altro plesso è uscito dalla ${dove}`).not.toContain('Nicola')
            expect(testo).not.toContain('Fuori')
            // …e quello legittimo c'è: la regola toglie una riga, non tutte.
            expect(testo).toContain('Bruna')
        }
    })

    it('🔑 entrambe DICHIARANO il nome che manca: `alunni-non-risolti`, con lo stesso conteggio', async () => {
        await GET(reqGet(), ctx())
        const daGet = warn('alunni-non-risolti')

        h.logEvento.mockClear()
        await ESPORTA(reqEsporta(), ctx())
        const daEsporta = warn('alunni-non-risolti')

        expect(daGet, 'la schermata non dice che un nome manca: resta una cella vuota e basta').toHaveLength(1)
        expect(daEsporta, 'il file non dice che un nome manca: restano due celle vuote e basta').toHaveLength(1)
        expect(daGet[0].n).toBe(1)
        expect(daEsporta[0].n).toBe(daGet[0].n)
        expect(daGet[0].avviso).toBe(AVVISO_ID)
        expect(daEsporta[0].avviso).toBe(AVVISO_ID)
        // Solo uuid, conteggi e nomi di esito: mai un nome di famiglia (regola 8).
        expect(Object.keys(daGet[0]).sort()).toEqual(['avviso', 'esito', 'n', 'operazione'])
        expect(Object.keys(daEsporta[0]).sort()).toEqual(['avviso', 'esito', 'n', 'operazione'])
    })

    it('sul percorso pulito nessuna delle due dichiara niente', async () => {
        // Senza questo `it` il `warn` potrebbe partire SEMPRE, e un avviso che
        // suona a ogni apertura è un avviso che si impara a ignorare.
        h.db.avvisi_risposte = [h.db.avvisi_risposte[0]]

        await GET(reqGet(), ctx())
        await ESPORTA(reqEsporta(), ctx())

        expect(warn('alunni-non-risolti')).toEqual([])
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/avvisi/[id]/risposte — la scrittura è chiusa ALLA RADICE', () => {
    it('🔴 403 quando l’alunno è di un ALTRO plesso, e la RPC non parte', async () => {
        const res = await POST(reqPost({ student_id: ALU_FUORI, risposta: 'si' }), ctx())

        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('ADESIONE_ALUNNO_FUORI_AVVISO')
        expect(h.lastRpc, 'la riga è stata scritta lo stesso: il gate non ferma niente').toBeNull()
        // Il legame di famiglia C'È: è esattamente il caso che `genitoreHasFiglio`
        // da solo lasciava passare (due fratelli in due plessi).
        expect(h.genitoreHasFiglio).toHaveBeenCalledWith(expect.anything(), PARENT_ID, ALU_FUORI)
    })

    it('🔴 403 quando l’avviso è di CLASSE e la classe dell’alunno non è fra le `target`', async () => {
        h.db.avvisi[0].target_scope = 'classe'
        h.db.avvisi[0].target_classes = ['3C']

        const res = await POST(reqPost({ student_id: ALU_DENTRO, risposta: 'si' }), ctx())

        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('ADESIONE_ALUNNO_FUORI_AVVISO')
        expect(h.lastRpc).toBeNull()
    })

    it('200 quando la classe È fra le `target` (il gate non nega tutto)', async () => {
        h.db.avvisi[0].target_scope = 'classe'
        h.db.avvisi[0].target_classes = ['3C', '1A']

        const res = await POST(reqPost({ student_id: ALU_DENTRO, risposta: 'si' }), ctx())

        expect(res.status).toBe(200)
        expect(h.lastRpc?.args.p_student_id).toBe(ALU_DENTRO)
    })

    it('200 su avviso di CLASSE con elenco vuoto: vale globale, come ovunque nel repo', async () => {
        // `POST /api/avvisi` archivia `target_classes: null` quando le classi
        // valide sono zero, e il promemoria legge lo stesso modo. Trattare quel
        // caso come «nessuno è destinatario» chiuderebbe l'adesione a tutti su
        // avvisi che oggi arrivano a tutti.
        h.db.avvisi[0].target_scope = 'classe'
        h.db.avvisi[0].target_classes = []

        const res = await POST(reqPost({ student_id: ALU_DENTRO }), ctx())

        expect(res.status).toBe(200)
        expect(h.lastRpc).not.toBeNull()
    })

    it('il rifiuto lascia una traccia, e nella traccia non c’è nessun nome', async () => {
        await POST(reqPost({ student_id: ALU_FUORI, risposta: 'si' }), ctx())

        const righe = warn('adesione-alunno-fuori-avviso')
        expect(righe, 'un 403 che non si vede nei log è un 403 che nessuno saprà mai di aver dato').toHaveLength(1)
        expect(righe[0]).toEqual({
            operazione: 'avvisi/[id]/risposte:POST',
            esito: 'adesione-alunno-fuori-avviso',
            avviso: AVVISO_ID,
            alunno: ALU_FUORI,
            uid: PARENT_ID,
            tipo: 'sede',
            n_classi: 0,
        })

        const tutto = JSON.stringify(h.logEvento.mock.calls)
        for (const vietato of ['Nicola', 'Fuori', 'Bruna', 'Dentro', 'Gita', '2B']) {
            expect(tutto, `un dato personale è finito nei log: ${vietato}`).not.toContain(vietato)
        }
    })

    it('il caso CLASSE si distingue dal caso SEDE nel log, non a schermo', async () => {
        h.db.avvisi[0].target_scope = 'classe'
        h.db.avvisi[0].target_classes = ['3C']

        const res = await POST(reqPost({ student_id: ALU_DENTRO, risposta: 'si' }), ctx())

        // Stesso codice per chi legge: la frase non deve dire a un genitore dove
        // è iscritto un bambino che non ha davanti.
        expect((await res.json()).codice).toBe('ADESIONE_ALUNNO_FUORI_AVVISO')
        // …e la differenza c'è, dove serve a chi indaga.
        expect(warn('adesione-alunno-fuori-avviso')[0].tipo).toBe('classe')
    })

    it('un avviso che non esiste è un 404, non un 403: due cause, due risposte', async () => {
        h.db.avvisi = []

        const res = await POST(reqPost({ student_id: ALU_DENTRO }), ctx())

        expect(res.status).toBe(404)
        expect((await res.json()).codice).toBe('AVVISO_NON_TROVATO')
        expect(h.lastRpc).toBeNull()
    })

    it('un alunno che l’anagrafica non restituisce si FERMA: fail-closed', async () => {
        // `genitoreHasFiglio` dice che il legame c'è, ma la riga di `alunni` no:
        // il dato è incoerente, e una scrittura su un dato incoerente è
        // esattamente ciò che questo gate esiste per impedire.
        h.db.alunni = []

        const res = await POST(reqPost({ student_id: ALU_DENTRO }), ctx())

        expect(res.status).toBe(403)
        expect(h.lastRpc).toBeNull()
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('le due letture restano gatate come prima', () => {
    it('GET: un avviso di un altro plesso resta 403', async () => {
        h.scuoleDiUtente.mockResolvedValue([SEDE_B])
        expect((await GET(reqGet(), ctx())).status).toBe(403)
    })

    it('esporta: il diniego di `assertAvvisoInScope` resta il primo gate', async () => {
        h.assertAvvisoInScope.mockResolvedValue(NextResponse.json({ error: 'fuori plesso' }, { status: 403 }))
        expect((await ESPORTA(reqEsporta(), ctx())).status).toBe(403)
    })
})
