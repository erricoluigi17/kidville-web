// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest } from '../../fixtures/finto-supabase'

const h = vi.hoisted(() => ({
    eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', () => ({
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
        h.eventi.push({ evento, livello, campi })
    },
    logErrore: () => {},
    logOk: () => {},
}))

import { percorsiCitati, PERCORSI_PER_QUERY } from '@/lib/iscrizioni/percorsi-citati'

/**
 * CHI CITA ANCORA UN ALLEGATO (robustezza 2, sessione 1 — D9).
 *
 * L'import copia il percorso del documento dalla domanda all'anagrafica: lo stesso file per
 * due righe. Il database è il finto del repo, che applica davvero `.in()`. Ogni «citato» ha il
 * suo gemello «non citato», e ogni lettura che può fallire ha il suo caso.
 */

const OP = 'test-percorsi-citati'
/** Percorsi inventati nella forma di `src/app/api/iscrizione/upload/route.ts:103`. */
const doc = (n: number) => `iscrizioni/prova-finta/${String(n).padStart(8, '0')}-documento-finto.pdf`

function dbVuoto(): DBFinto {
    return { alunni: [], parents: [], student_documents: [] }
}

async function chiedi(d: DBFinto, percorsi: string[], errori: Record<string, ErrorePostgrest> = {}) {
    const lette: string[] = []
    const esito = await percorsiCitati(
        creaFintoSupabase(d, lette, { errori }) as unknown as SupabaseClient,
        percorsi,
        OP,
    )
    return { esito, lette }
}

const citati = (esito: Awaited<ReturnType<typeof percorsiCitati>>) =>
    esito.verificato ? [...esito.citati].sort() : null

beforeEach(() => {
    h.eventi = []
})

describe('percorsiCitati — chi nomina ancora un allegato', () => {
    it('nessun percorso ⇒ verificato, zero letture', async () => {
        const { esito, lette } = await chiedi(dbVuoto(), [])
        expect(esito).toEqual({ verificato: true, citati: new Set() })
        expect(lette).toEqual([])
    })

    it("il documento copiato in un alunno è citato; quello che nessuno nomina no", async () => {
        const d = dbVuoto()
        d.alunni = [{ id: 'alunno-finto-1', documento_path: doc(1) }]
        const { esito } = await chiedi(d, [doc(1), doc(2)])
        expect(citati(esito)).toEqual([doc(1)])
    })

    it('il documento copiato in un genitore è citato', async () => {
        const d = dbVuoto()
        d.parents = [{ id: 'genitore-finto-1', documento_path: doc(2) }]
        const { esito } = await chiedi(d, [doc(1), doc(2)])
        expect(citati(esito)).toEqual([doc(2)])
    })

    it('il fascicolo cita, su storage_path o su file_url, anche dal CESTINO', async () => {
        const d = dbVuoto()
        d.student_documents = [
            { id: 'fascicolo-finto-1', storage_path: doc(3), file_url: null, eliminato_il: null },
            { id: 'fascicolo-finto-2', storage_path: null, file_url: doc(4), eliminato_il: '2026-10-01T00:00:00.000Z' },
        ]
        const { esito } = await chiedi(d, [doc(3), doc(4), doc(5)])
        expect(citati(esito)).toEqual([doc(3), doc(4)])
    })

    it('il percorso chiesto con spazi ai bordi si confronta senza', async () => {
        const d = dbVuoto()
        d.alunni = [{ id: 'alunno-finto-1', documento_path: doc(1) }]
        const { esito } = await chiedi(d, [`  ${doc(1)} `])
        expect(citati(esito)).toEqual([doc(1)])
    })

    it(`a blocchi di ${PERCORSI_PER_QUERY}: una citazione nell'ULTIMO blocco si trova`, async () => {
        const percorsi = Array.from({ length: 2 * PERCORSI_PER_QUERY + 1 }, (_, i) => doc(100 + i))
        const ultimo = percorsi[percorsi.length - 1]
        const d = dbVuoto()
        d.alunni = [{ id: 'alunno-finto-ultimo', documento_path: ultimo }]
        const { esito, lette } = await chiedi(d, percorsi)
        expect(citati(esito)).toEqual([ultimo])
        expect(lette.filter((t) => t === 'alunni')).toHaveLength(3)
    })
})

describe('percorsiCitati — «non lo so» non è «nessuno»', () => {
    for (const tabella of ['alunni', 'parents', 'student_documents'] as const) {
        it(`lettura fallita su ${tabella} ⇒ NON verificato, e un error che lo dice`, async () => {
            const { esito } = await chiedi(dbVuoto(), [doc(1)], {
                [`${tabella}:select`]: { code: '57014', message: 'canceling statement due to statement timeout' },
            })
            expect(esito).toEqual({ verificato: false })
            const errore = h.eventi.find((e) => e.livello === 'error')
            expect(errore?.campi).toMatchObject({
                operazione: OP,
                esito: 'citazioni-non-lette',
                entita_tipo: tabella,
                n_file: 1,
            })
        })
    }
})

/**
 * Il finto del repo inietta un errore per TABELLA, non per chiamata: non sa far fallire «solo il
 * terzo blocco» né «solo la lettura di `file_url`». Qui un client che inoltra tutto al finto
 * vero tranne la chiamata numero N (1 = la prima `from()` del giro), a cui risponde come
 * risponderebbe PostgREST quando la lettura va male. Le righe che il resto del giro legge
 * restano quelle del finto: così un guasto tardivo si prova CON citazioni già trovate prima.
 */
type Guasto = 'errore' | 'senza-righe'

function conGuastoAllaChiamata(d: DBFinto, numero: number, guasto: Guasto) {
    const chiamate: string[] = []
    const vero = creaFintoSupabase(d)
    const risposta =
        guasto === 'errore'
            ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
            : { data: null, error: null }
    const client = {
        from: (tabella: string) => {
            chiamate.push(tabella)
            if (chiamate.length !== numero) return vero.from(tabella)
            const guasta = { select: () => guasta, in: () => Promise.resolve(risposta) }
            return guasta
        },
    }
    return { client: client as unknown as SupabaseClient, chiamate }
}

describe('percorsiCitati — un guasto in QUALUNQUE punto del giro vale «non lo so»', () => {
    it("il guasto sull'ULTIMO blocco, con citazioni già trovate prima, non lascia un elenco parziale", async () => {
        const percorsi = Array.from({ length: 2 * PERCORSI_PER_QUERY + 1 }, (_, i) => doc(100 + i))
        const d = dbVuoto()
        d.alunni = [{ id: 'alunno-finto-primo', documento_path: percorsi[0] }]
        // Chiamate 1-3: i tre blocchi di `alunni`. La terza è l'ultima.
        const { client, chiamate } = conGuastoAllaChiamata(d, 3, 'errore')
        const esito = await percorsiCitati(client, percorsi, OP)
        expect(esito).toEqual({ verificato: false })
        expect(chiamate).toEqual(['alunni', 'alunni', 'alunni'])
        expect(h.eventi.filter((e) => e.livello === 'error')).toHaveLength(1)
    })

    it('il guasto sulla SOLA lettura di file_url (quarta sorgente) non è coperto dalle tre prima', async () => {
        const d = dbVuoto()
        d.alunni = [{ id: 'alunno-finto-1', documento_path: doc(1) }]
        // 1 percorso ⇒ una chiamata per sorgente: alunni, parents, student_documents (storage_path), student_documents (file_url).
        const { client, chiamate } = conGuastoAllaChiamata(d, 4, 'errore')
        const esito = await percorsiCitati(client, [doc(1)], OP)
        expect(esito).toEqual({ verificato: false })
        expect(chiamate).toEqual(['alunni', 'parents', 'student_documents', 'student_documents'])
        expect(h.eventi.find((e) => e.livello === 'error')?.campi).toMatchObject({
            operazione: OP,
            esito: 'citazioni-non-lette',
            entita_tipo: 'student_documents',
            n_file: 1,
        })
    })

    for (const tabella of ['alunni', 'parents', 'student_documents'] as const) {
        it(`una risposta SENZA righe e SENZA errore su ${tabella} non vale «nessuno»`, async () => {
            const numero = { alunni: 1, parents: 2, student_documents: 3 }[tabella]
            const { client } = conGuastoAllaChiamata(dbVuoto(), numero, 'senza-righe')
            const esito = await percorsiCitati(client, [doc(1)], OP)
            expect(esito).toEqual({ verificato: false })
            expect(h.eventi.find((e) => e.livello === 'error')?.campi).toMatchObject({
                esito: 'citazioni-non-lette',
                entita_tipo: tabella,
            })
        })
    }

    it('dopo il primo guasto non legge più niente', async () => {
        const { esito, lette } = await chiedi(dbVuoto(), [doc(1)], {
            'alunni:select': { code: '57014', message: 'canceling statement due to statement timeout' },
        })
        expect(esito).toEqual({ verificato: false })
        expect(lette).toEqual(['alunni'])
    })

    it('un guasto di lettura è UN error, e il log non porta i percorsi (il nome di un file può essere un nome di persona)', async () => {
        await chiedi(dbVuoto(), [doc(1), doc(2)], {
            'parents:select': { code: '57014', message: 'canceling statement due to statement timeout' },
        })
        const errori = h.eventi.filter((e) => e.livello === 'error')
        expect(errori).toHaveLength(1)
        expect(errori[0].campi).toMatchObject({ n_file: 2, entita_tipo: 'parents' })
        expect(JSON.stringify(h.eventi)).not.toContain('documento-finto')
        expect(JSON.stringify(h.eventi)).not.toContain('prova-finta')
    })
})
