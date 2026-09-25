import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GIORNI_CESTINO_REGISTRO, GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO } from '@/lib/primaria/cestino-registro'

/**
 * La purga a 7 giorni del cestino di registro e fascicolo
 * (`POST /api/gdpr/retention-cestino-registro`).
 *
 * ─── PERCHÉ UN DATABASE FINTO CHE FILTRA DAVVERO ────────────────────────────
 * Un doppio che restituisse «le righe scadute» già pronte sarebbe verde anche con
 * una route che non filtra affatto (il mock piatto). Qui le righe stanno in due
 * tabelle in memoria e il doppio APPLICA le clausole che la route scrive (`not is
 * null`, `lt`, `in`, `order`, `limit`): se la route perde il taglio dei 7 giorni,
 * o la cintura sulla `delete`, le righe sbagliate spariscono e i test diventano
 * rossi. Lo Storage è un insieme di percorsi per bucket: un file o c'è o non c'è.
 *
 * Nessun dato reale: uuid e percorsi sono inventati.
 */

const CRON_SECRET = 'segreto-di-prova-cestino-registro'

type Riga = Record<string, unknown> & { id: string }

const h = vi.hoisted(() => ({
    tabelle: {} as Record<string, Record<string, unknown>[]>,
    bucket: {} as Record<string, Set<string>>,
    /** File che `remove()` NON toglie pur rispondendo senza errore (ancora presenti). */
    resistenti: new Set<string>(),
    /**
     * Errori iniettati: `${tabella}:scadute|conservazione|reclami|delete` e `remove:${bucket}`.
     * `scadute` è la lettura del cestino (`lt('eliminato_il')`), `conservazione` quella per
     * età di caricamento (`lt('creato_il')`); `${tabella}:delete:creato_il` colpisce la sola
     * cancellazione per conservazione.
     */
    errori: {} as Record<string, unknown>,
    /** Eseguito dopo la lettura delle scadute di una tabella (per simulare un ripristino concorrente). */
    dopoLettura: null as null | ((tabella: string, tipo: string) => void),
    sequenza: [] as { tipo: 'select' | 'remove' | 'delete'; dove: string; valore: unknown }[],
    eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
    staffNegato: null as unknown,
    clientCreati: 0,
}))

vi.mock('@/lib/logging/logger', () => ({
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
        h.eventi.push({ evento, livello, campi })
    },
    logErrore: () => {},
    logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: vi.fn(async () =>
        h.staffNegato
            ? { user: null, response: h.staffNegato }
            : { user: { id: '00000000-0000-4000-8000-000000000001' }, response: null },
    ),
}))

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => {
        h.clientCreati++
        type Filtro = (r: Record<string, unknown>) => boolean
        const builder = (tabella: string) => {
            const filtri: Filtro[] = []
            let op: 'select' | 'delete' = 'select'
            let colonne = ''
            let colLt: string | null = null
            let conIn = false
            let ordine: { col: string; asc: boolean } | null = null
            let tetto: number | null = null
            let conta = false
            const q = {
                select(c: string) {
                    colonne = c
                    return q
                },
                delete(opts?: { count?: string }) {
                    op = 'delete'
                    conta = opts?.count === 'exact'
                    return q
                },
                is(col: string, valore: unknown) {
                    if (valore !== null) throw new Error(`is(${String(valore)}) non previsto`)
                    filtri.push((r) => r[col] === null || r[col] === undefined)
                    return q
                },
                not(col: string, operatore: string, valore: unknown) {
                    if (operatore !== 'is' || valore !== null) throw new Error(`not(${operatore}) non previsto`)
                    filtri.push((r) => r[col] !== null && r[col] !== undefined)
                    return q
                },
                lt(col: string, valore: string) {
                    colLt = col
                    filtri.push((r) => typeof r[col] === 'string' && Date.parse(r[col] as string) < Date.parse(valore))
                    return q
                },
                in(col: string, valori: unknown[]) {
                    conIn = true
                    filtri.push((r) => valori.includes(r[col]))
                    return q
                },
                order(col: string, o?: { ascending?: boolean }) {
                    ordine = { col, asc: o?.ascending !== false }
                    return q
                },
                limit(n: number) {
                    tetto = n
                    return q
                },
                then(risolvi: (v: unknown) => unknown, rifiuta?: (e: unknown) => unknown) {
                    return Promise.resolve()
                        .then(() => {
                            const righe = h.tabelle[tabella] ?? []
                            if (op === 'delete') {
                                const err = h.errori[`${tabella}:delete:${colLt}`] ?? h.errori[`${tabella}:delete`]
                                // La cancellazione per conservazione si riconosce dalla colonna
                                // del suo `lt`: così le prove sull'ordine la distinguono dal cestino.
                                const dove = colLt === 'creato_il' ? `${tabella}:conservazione` : tabella
                                h.sequenza.push({ tipo: 'delete', dove, valore: null })
                                if (err) return { data: null, error: err, count: null }
                                const via = righe.filter((r) => filtri.every((f) => f(r)))
                                h.tabelle[tabella] = righe.filter((r) => !via.includes(r))
                                h.sequenza[h.sequenza.length - 1].valore = via.map((r) => r.id)
                                return { data: null, error: null, count: conta ? via.length : null }
                            }
                            const tipo =
                                colLt === 'creato_il' ? 'conservazione' : colLt ? 'scadute' : conIn ? 'reclami' : 'altro'
                            const err = h.errori[`${tabella}:${tipo}`]
                            h.sequenza.push({ tipo: 'select', dove: `${tabella}:${tipo}`, valore: colonne })
                            if (err) return { data: null, error: err }
                            let out = righe.filter((r) => filtri.every((f) => f(r)))
                            if (ordine) {
                                const { col, asc } = ordine
                                out = [...out].sort((a, b) =>
                                    String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : asc ? 1 : -1,
                                )
                            }
                            if (tetto !== null) out = out.slice(0, tetto)
                            const cols = colonne.split(',').map((c) => c.trim())
                            const proiettate = out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])))
                            if (tipo === 'scadute' || tipo === 'conservazione') h.dopoLettura?.(tabella, tipo)
                            return { data: proiettate, error: null }
                        })
                        .then(risolvi, rifiuta)
                },
            }
            return q
        }
        const storage = {
            from(bucket: string) {
                const insieme = (h.bucket[bucket] ??= new Set<string>())
                return {
                    async remove(percorsi: string[]) {
                        h.sequenza.push({ tipo: 'remove', dove: bucket, valore: [...percorsi] })
                        const err = h.errori[`remove:${bucket}`]
                        if (err) return { data: null, error: err }
                        const tolti = percorsi.filter((p) => insieme.has(p) && !h.resistenti.has(p))
                        for (const p of tolti) insieme.delete(p)
                        return { data: tolti.map((name) => ({ name })), error: null }
                    },
                    async list(cartella: string, opzioni?: { search?: string }) {
                        const prefisso = cartella ? `${cartella}/` : ''
                        const nomi = [...insieme]
                            .filter((p) => p.startsWith(prefisso))
                            .map((p) => p.slice(prefisso.length))
                            .filter((n) => !n.includes('/') && n.startsWith(opzioni?.search ?? ''))
                        return { data: nomi.map((name) => ({ name, id: 'oggetto' })), error: null }
                    },
                }
            },
        }
        return { from: builder, storage }
    },
}))

import { POST } from '@/app/api/gdpr/retention-cestino-registro/route'

const B_ALLEGATI = 'registro-allegati'
const B_FASCICOLO = 'sensitive_documents'
const GIORNO = 24 * 60 * 60 * 1000

const fa = (ms: number) => new Date(Date.now() - ms).toISOString()
const scaduta = () => fa((GIORNI_CESTINO_REGISTRO + 1) * GIORNO)
const giovane = () => fa((GIORNI_CESTINO_REGISTRO - 1) * GIORNO)

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function allegato(n: number, eliminato_il: string | null, file = `registro/${uuid(900)}/file-${n}.pdf`): Riga {
    return { id: uuid(n), file_url: file, eliminato_il }
}
/** Un allegato con la data di CARICAMENTO: è quella che la conservazione guarda. */
function caricato(
    n: number,
    creato_il: string,
    eliminato_il: string | null = null,
    file = `registro/${uuid(900)}/file-${n}.pdf`,
): Riga {
    return { id: uuid(n), file_url: file, eliminato_il, creato_il }
}
const vecchio = () => fa((GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO + 1) * GIORNO)
const recente = () => fa((GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO - 1) * GIORNO)

function documento(
    n: number,
    eliminato_il: string | null,
    percorsi: { storage_path?: string | null; file_url?: string | null } = {},
): Riga {
    const def = `${uuid(800)}/doc-${n}.pdf`
    return {
        id: uuid(n),
        storage_path: 'storage_path' in percorsi ? percorsi.storage_path : def,
        file_url: 'file_url' in percorsi ? percorsi.file_url : def,
        eliminato_il,
    }
}

function semina(allegati: Riga[], documenti: Riga[]) {
    h.tabelle.allegati_registro = allegati.map((r) => ({ ...r }))
    h.tabelle.student_documents = documenti.map((r) => ({ ...r }))
    h.bucket[B_ALLEGATI] = new Set(allegati.map((r) => r.file_url as string).filter(Boolean))
    h.bucket[B_FASCICOLO] = new Set(
        documenti.map((r) => (r.storage_path || r.file_url) as string).filter(Boolean),
    )
}

const ids = (tabella: string) => (h.tabelle[tabella] ?? []).map((r) => r.id as string).sort()

const chiama = (headers: Record<string, string> = { 'x-cron-secret': CRON_SECRET }) =>
    POST(new Request('http://localhost/api/gdpr/retention-cestino-registro', { method: 'POST', headers }) as never)

const battito = () => h.eventi.filter((e) => e.campi.operazione === 'cestino-registro-retention' && !e.campi.tipo && e.livello === 'info').at(-1)

beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    h.tabelle = {}
    h.bucket = {}
    h.resistenti = new Set()
    h.errori = {}
    h.dopoLettura = null
    h.sequenza = []
    h.eventi = []
    h.staffNegato = null
    h.clientCreati = 0
})

describe('POST /api/gdpr/retention-cestino-registro — la purga', () => {
    it('distrugge SOLO le righe oltre i 7 giorni, prima il file e poi la riga, ciascuna nel SUO bucket', async () => {
        semina(
            [allegato(1, scaduta()), allegato(2, giovane()), allegato(3, null)],
            [
                documento(11, scaduta()),
                documento(12, scaduta(), { storage_path: null, file_url: `${uuid(800)}/vecchio.pdf` }),
                documento(13, null),
                documento(14, scaduta(), { storage_path: null, file_url: null }),
                documento(15, giovane()),
            ],
        )
        h.bucket[B_FASCICOLO].add(`${uuid(800)}/vecchio.pdf`)

        const res = await chiama()
        expect(res.status).toBe(200)
        const corpo = await res.json()
        expect(corpo).toMatchObject({ ok: true, giorni: GIORNI_CESTINO_REGISTRO })
        expect(corpo.allegati).toMatchObject({ cancellate: 1, fileRimossi: 1, scadute: 1 })
        expect(corpo.fascicolo).toMatchObject({ cancellate: 3, fileRimossi: 2, senzaFile: 1, scadute: 3 })

        // Le righe: via le scadute, restano la giovane e le vive.
        expect(ids('allegati_registro')).toEqual([uuid(2), uuid(3)])
        expect(ids('student_documents')).toEqual([uuid(13), uuid(15)])

        // I file: via quelli delle scadute, ciascuno dal SUO bucket; gli altri restano.
        expect([...h.bucket[B_ALLEGATI]].sort()).toEqual(
            [`registro/${uuid(900)}/file-2.pdf`, `registro/${uuid(900)}/file-3.pdf`].sort(),
        )
        expect([...h.bucket[B_FASCICOLO]].sort()).toEqual([`${uuid(800)}/doc-13.pdf`, `${uuid(800)}/doc-15.pdf`])
        const removeAllegati = h.sequenza.find((s) => s.tipo === 'remove' && s.dove === B_ALLEGATI)
        expect(removeAllegati?.valore).toEqual([`registro/${uuid(900)}/file-1.pdf`])
        // La riga vecchia del fascicolo col solo `file_url`: il percorso si legge anche da lì.
        const removeFascicolo = h.sequenza.find((s) => s.tipo === 'remove' && s.dove === B_FASCICOLO)
        expect((removeFascicolo?.valore as string[]).sort()).toEqual(
            [`${uuid(800)}/doc-11.pdf`, `${uuid(800)}/vecchio.pdf`].sort(),
        )

        // PRIMA IL FILE, POI LA RIGA, per ciascuna tabella.
        for (const [tabella, bucket] of [
            ['allegati_registro', B_ALLEGATI],
            ['student_documents', B_FASCICOLO],
        ]) {
            const iRemove = h.sequenza.findIndex((s) => s.tipo === 'remove' && s.dove === bucket)
            const iDelete = h.sequenza.findIndex((s) => s.tipo === 'delete' && s.dove === tabella)
            expect(iRemove, `${tabella}: remove`).toBeGreaterThanOrEqual(0)
            expect(iDelete, `${tabella}: il file esce PRIMA della riga`).toBeGreaterThan(iRemove)
        }

        // Il battito: `evento: cron`, esito ok, i conteggi veri.
        const b = battito()
        expect(b?.evento).toBe('cron')
        expect(b?.campi).toMatchObject({
            esito: 'ok',
            canale: 'cron',
            giorni: GIORNI_CESTINO_REGISTRO,
            n_righe: 4,
            n_file_rimossi: 3,
            n_allegati_righe: 1,
            n_fascicolo_righe: 3,
            n_righe_trattenute: 0,
            conteggio_verificato: true,
        })
        // Il successo di ciascun contenitore si logga.
        const purgati = h.eventi.filter((e) => e.campi.esito === 'contenitore-purgato').map((e) => e.campi.tipo)
        expect(purgati.sort()).toEqual(['allegati', 'fascicolo'])
    })

    it('il confine è la custodia: a 7 giorni meno un\'ora resta, a 7 giorni più un\'ora esce', async () => {
        semina(
            [
                allegato(1, fa(GIORNI_CESTINO_REGISTRO * GIORNO - 60 * 60 * 1000)),
                allegato(2, fa(GIORNI_CESTINO_REGISTRO * GIORNO + 60 * 60 * 1000)),
            ],
            [],
        )
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(ids('allegati_registro')).toEqual([uuid(1)])
    })

    it('un giro a cestino vuoto risponde 200 e scrive il battito A ZERO', async () => {
        semina([allegato(1, giovane())], [documento(11, null)])
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(h.sequenza.some((s) => s.tipo === 'remove' || s.tipo === 'delete')).toBe(false)
        expect(battito()?.campi).toMatchObject({ esito: 'ok', n_righe: 0, n_cestino_scaduti: 0 })
    })

    it('un file che un\'ALTRA riga nomina ancora non si tocca: la riga scaduta esce, il file resta', async () => {
        const condiviso = `${uuid(800)}/condiviso.pdf`
        semina(
            [],
            [
                documento(11, scaduta(), { storage_path: condiviso, file_url: condiviso }),
                documento(12, null, { storage_path: condiviso, file_url: condiviso }),
            ],
        )
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(ids('student_documents')).toEqual([uuid(12)])
        expect(h.bucket[B_FASCICOLO].has(condiviso)).toBe(true)
        expect(h.sequenza.some((s) => s.tipo === 'remove' && s.dove === B_FASCICOLO)).toBe(false)
        expect(battito()?.campi).toMatchObject({ n_file_ancora_reclamati: 1, n_righe: 1, n_file_rimossi: 0 })
    })

    it('anche una riga ancora NEL CESTINO (non scaduta) reclama il suo file', async () => {
        const condiviso = `registro/${uuid(900)}/condiviso.pdf`
        semina([allegato(1, scaduta(), condiviso), allegato(2, giovane(), condiviso)], [])
        await chiama()
        expect(ids('allegati_registro')).toEqual([uuid(2)])
        expect(h.bucket[B_ALLEGATI].has(condiviso)).toBe(true)
    })

    it('remove() in errore: le righe di QUEL contenitore restano, l\'altro contenitore si purga lo stesso, 500', async () => {
        semina([allegato(1, scaduta())], [documento(11, scaduta())])
        h.errori[`remove:${B_ALLEGATI}`] = { message: 'storage giù' }
        const res = await chiama()
        expect(res.status).toBe(500)
        const corpo = await res.json()
        expect(corpo.motivo).toBe('file-non-rimossi')
        expect(ids('allegati_registro')).toEqual([uuid(1)])
        expect(ids('student_documents')).toEqual([])
        expect(h.sequenza.some((s) => s.tipo === 'delete' && s.dove === 'allegati_registro' && (s.valore as string[]).length > 0)).toBe(false)
        expect(battito()?.campi).toMatchObject({ esito: 'file-non-rimossi', n_righe_trattenute: 1, n_fascicolo_righe: 1 })
    })

    it('un file che resta nel bucket trattiene la SUA riga e solo quella', async () => {
        semina([allegato(1, scaduta()), allegato(2, scaduta())], [])
        h.resistenti.add(`registro/${uuid(900)}/file-1.pdf`)
        const res = await chiama()
        expect(res.status).toBe(500)
        expect((await res.json()).motivo).toBe('righe-trattenute')
        expect(ids('allegati_registro')).toEqual([uuid(1)])
        expect(h.bucket[B_ALLEGATI].has(`registro/${uuid(900)}/file-1.pdf`)).toBe(true)
        expect(battito()?.campi).toMatchObject({ n_righe: 1, n_righe_trattenute: 1, n_file_bloccanti: 1 })
    })

    it('se non si sa chi reclama i file, non si tocca NIENTE di quel contenitore (fail-closed)', async () => {
        semina([], [documento(11, scaduta())])
        h.errori['student_documents:reclami'] = { code: '57014', message: 'timeout' }
        const res = await chiama()
        expect(res.status).toBe(500)
        expect((await res.json()).motivo).toBe('reclami-non-letti')
        expect(ids('student_documents')).toEqual([uuid(11)])
        expect(h.bucket[B_FASCICOLO].size).toBe(1)
        expect(h.sequenza.some((s) => s.tipo === 'remove')).toBe(false)
    })

    it('un riferimento che non è di questo bucket trattiene la riga (è l\'unica traccia di quel file)', async () => {
        semina([allegato(1, scaduta(), 'https://altro.example/storage/v1/object/public/altro-bucket/x.pdf')], [])
        const res = await chiama()
        expect(res.status).toBe(500)
        expect(ids('allegati_registro')).toEqual([uuid(1)])
    })

    it('la delete ripete le condizioni del cestino: una riga ripristinata dopo la lettura NON si cancella', async () => {
        semina([allegato(1, scaduta()), allegato(2, scaduta())], [])
        h.dopoLettura = (tabella) => {
            if (tabella !== 'allegati_registro') return
            const r = h.tabelle.allegati_registro.find((x) => x.id === uuid(2))
            if (r) r.eliminato_il = null
        }
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(ids('allegati_registro')).toEqual([uuid(2)])
        // Il conteggio dichiarato è quello VERO, e lo scarto si dice.
        expect(battito()?.campi).toMatchObject({ n_allegati_righe: 1 })
        expect(h.eventi.some((e) => e.campi.esito === 'conteggio-discorde')).toBe(true)
    })

    it('è IDEMPOTENTE: una delete fallita dopo il remove si chiude al giro dopo (file «già assente»)', async () => {
        semina([allegato(1, scaduta())], [])
        h.errori['allegati_registro:delete'] = { code: '40001', message: 'serializzazione' }
        const primo = await chiama()
        expect(primo.status).toBe(500)
        expect((await primo.json()).motivo).toBe('cancellazione-fallita')
        expect(h.bucket[B_ALLEGATI].size).toBe(0)
        expect(ids('allegati_registro')).toEqual([uuid(1)])

        delete h.errori['allegati_registro:delete']
        h.eventi = []
        const secondo = await chiama()
        expect(secondo.status).toBe(200)
        expect(ids('allegati_registro')).toEqual([])
        expect(battito()?.campi).toMatchObject({ esito: 'ok', n_righe: 1, n_file_rimossi: 0, n_file_gia_assenti: 1 })
    })

    it('lotti a TETTO anche nel cestino: oltre 500 scaduti ne escono 500, i PIÙ VECCHI per eliminazione', async () => {
        const minuto = 60 * 1000
        const base = (GIORNI_CESTINO_REGISTRO + 1) * GIORNO
        // Dal meno vecchio (n. 1) al più vecchio: senza `.order` resterebbe il più vecchio.
        semina(Array.from({ length: 501 }, (_, i) => allegato(i + 1, fa(base + (i + 1) * minuto))), [])
        const res = await chiama()
        expect(res.status).toBe(200)
        expect((await res.json()).allegati).toMatchObject({ scadute: 500, cancellate: 500, lottoPieno: true })
        expect(ids('allegati_registro')).toEqual([uuid(1)])
        expect(
            h.eventi.some((e) => e.livello === 'warn' && e.campi.esito === 'lotto-pieno' && e.campi.tipo === 'allegati'),
        ).toBe(true)
        expect(battito()?.campi).toMatchObject({ lotto_pieno: true, n_cestino_righe: 500 })
    })

    it('DB non migrato (colonna del cestino assente): 503 dichiarato, nessuna scrittura', async () => {
        semina([allegato(1, scaduta())], [documento(11, scaduta())])
        h.errori['allegati_registro:scadute'] = { code: '42703', message: 'column does not exist' }
        h.errori['student_documents:scadute'] = { code: '42703', message: 'column does not exist' }
        const res = await chiama()
        expect(res.status).toBe(503)
        expect((await res.json()).motivo).toBe('colonne-cestino-assenti')
        expect(h.sequenza.some((s) => s.tipo === 'remove' || s.tipo === 'delete')).toBe(false)
        expect(battito()?.campi).toMatchObject({ esito: 'colonne-cestino-assenti' })
    })

    it('una lettura fallita (non di schema) è un 500, non un 503', async () => {
        semina([], [])
        h.errori['allegati_registro:scadute'] = { code: '57014', message: 'timeout' }
        const res = await chiama()
        expect(res.status).toBe(500)
        expect((await res.json()).motivo).toBe('lettura-fallita')
    })

    it('nei log non entra NESSUN percorso', async () => {
        semina([allegato(1, scaduta())], [documento(11, scaduta())])
        h.resistenti.add(`${uuid(800)}/doc-11.pdf`)
        await chiama()
        const log = JSON.stringify(h.eventi)
        expect(log).not.toContain('file-1.pdf')
        expect(log).not.toContain('doc-11.pdf')
        expect(log).not.toContain(uuid(800))
    })
})

describe('POST /api/gdpr/retention-cestino-registro — la conservazione a 365 giorni dal caricamento', () => {
    // Decisione del titolare del 2026-09-25: gli allegati del registro si distruggono
    // `GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO` giorni dopo il CARICAMENTO, vivi o nel
    // cestino. Il fascicolo non ha questo termine.
    const f = (n: number) => `registro/${uuid(900)}/file-${n}.pdf`

    it('distrugge file e righe caricati oltre 365 giorni (vivi E cestinati), NON quelli a 364; il fascicolo non si tocca', async () => {
        semina(
            [
                caricato(1, vecchio()), //                     vivo, oltre il termine → esce
                caricato(2, vecchio(), giovane()), //          nel cestino da poco, oltre il termine → esce
                caricato(3, recente()), //                     vivo, 364 giorni → resta
                caricato(4, recente(), giovane()), //          nel cestino da poco, 364 giorni → resta
                caricato(5, fa(10 * GIORNO)), //               vivo, recente → resta
            ],
            [{ ...documento(11, null), creato_il: vecchio() }],
        )

        const res = await chiama()
        expect(res.status).toBe(200)
        const corpo = await res.json()
        expect(corpo).toMatchObject({
            ok: true,
            giorni: GIORNI_CESTINO_REGISTRO,
            giorni_conservazione: GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO,
        })
        expect(corpo.conservazione).toMatchObject({ scadute: 2, cancellate: 2, fileRimossi: 2, trattenute: 0 })
        expect(corpo.allegati).toMatchObject({ scadute: 0, cancellate: 0 })

        // Le righe: via le due oltre il termine, restano le tre dentro.
        expect(ids('allegati_registro')).toEqual([uuid(3), uuid(4), uuid(5)])
        // I file: via i due, restano i tre.
        expect([...h.bucket[B_ALLEGATI]].sort()).toEqual([f(3), f(4), f(5)].sort())
        const remove = h.sequenza.filter((x) => x.tipo === 'remove' && x.dove === B_ALLEGATI)
        expect(remove).toHaveLength(1)
        expect((remove[0].valore as string[]).sort()).toEqual([f(1), f(2)].sort())

        // Il fascicolo, anche vecchio di più di un anno, resta com'è: riga e file.
        expect(ids('student_documents')).toEqual([uuid(11)])
        expect(h.bucket[B_FASCICOLO].size).toBe(1)
        expect(h.sequenza.some((x) => x.tipo === 'remove' && x.dove === B_FASCICOLO)).toBe(false)

        // PRIMA IL FILE, POI LA RIGA.
        const iRemove = h.sequenza.findIndex((x) => x.tipo === 'remove' && x.dove === B_ALLEGATI)
        const iDelete = h.sequenza.findIndex((x) => x.tipo === 'delete' && x.dove === 'allegati_registro:conservazione')
        expect(iRemove).toBeGreaterThanOrEqual(0)
        expect(iDelete, 'il file esce PRIMA della riga').toBeGreaterThan(iRemove)
        expect((h.sequenza[iDelete].valore as string[]).sort()).toEqual([uuid(1), uuid(2)])

        // Il battito: conteggi SEPARATI per cestino e conservazione, totali coerenti.
        const b = battito()
        expect(b?.evento).toBe('cron')
        expect(b?.campi).toMatchObject({
            operazione: 'cestino-registro-retention',
            esito: 'ok',
            giorni: GIORNI_CESTINO_REGISTRO,
            giorni_conservazione: GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO,
            n_conservazione_scaduti: 2,
            n_conservazione_righe: 2,
            n_conservazione_file: 2,
            n_cestino_scaduti: 0,
            n_cestino_righe: 0,
            n_cestino_file: 0,
            n_righe: 2,
            n_file_rimossi: 2,
            conteggio_verificato: true,
        })
        // Il successo del contenitore si logga, col suo tipo.
        const purgato = h.eventi.find((e) => e.campi.esito === 'contenitore-purgato' && e.campi.tipo === 'conservazione')
        expect(purgato?.campi).toMatchObject({ n_righe: 2, n_file_rimossi: 2, bucket: B_ALLEGATI })
    })

    it('cestino e conservazione nello stesso giro: conteggi separati, somma nei totali', async () => {
        semina([allegato(1, scaduta()), caricato(2, vecchio())], [documento(11, scaduta())])
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(ids('allegati_registro')).toEqual([])
        expect(battito()?.campi).toMatchObject({
            esito: 'ok',
            n_cestino_righe: 2,
            n_cestino_file: 2,
            n_conservazione_righe: 1,
            n_conservazione_file: 1,
            n_allegati_righe: 1,
            n_fascicolo_righe: 1,
            n_righe: 3,
            n_file_rimossi: 3,
        })
    })

    it('il confine è il termine: a 365 giorni meno un\'ora resta, a 365 giorni più un\'ora esce', async () => {
        const ora = 60 * 60 * 1000
        semina(
            [
                caricato(1, fa(GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO * GIORNO - ora)),
                caricato(2, fa(GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO * GIORNO + ora)),
            ],
            [],
        )
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(ids('allegati_registro')).toEqual([uuid(1)])
        expect([...h.bucket[B_ALLEGATI]]).toEqual([f(1)])
    })

    it('un file che un\'altra riga ANCORA NEL TERMINE nomina non si tocca: la riga vecchia esce, il file resta', async () => {
        const condiviso = `registro/${uuid(900)}/condiviso.pdf`
        semina([caricato(1, vecchio(), null, condiviso), caricato(2, recente(), giovane(), condiviso)], [])
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(ids('allegati_registro')).toEqual([uuid(2)])
        expect(h.bucket[B_ALLEGATI].has(condiviso)).toBe(true)
        expect(h.sequenza.some((x) => x.tipo === 'remove')).toBe(false)
        expect(battito()?.campi).toMatchObject({ n_conservazione_righe: 1, n_conservazione_file: 0, n_file_ancora_reclamati: 1 })
    })

    it('la delete ripete la condizione: una riga che risulta caricata DOPO la soglia non si cancella', async () => {
        semina([caricato(1, vecchio()), caricato(2, vecchio())], [])
        // Fra la lettura e la cancellazione la riga 2 «ringiovanisce»: se la delete
        // cancellasse per soli id, sparirebbe lo stesso.
        h.dopoLettura = (tabella, tipo) => {
            if (tabella !== 'allegati_registro' || tipo !== 'conservazione') return
            const r = h.tabelle.allegati_registro.find((x) => x.id === uuid(2))
            if (r) r.creato_il = fa(GIORNO)
        }
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(ids('allegati_registro')).toEqual([uuid(2)])
        expect(h.eventi.some((e) => e.campi.esito === 'conteggio-discorde' && e.campi.tipo === 'conservazione')).toBe(true)
        expect(battito()?.campi).toMatchObject({ n_conservazione_righe: 1 })
    })

    it('lettura fallita (PostgREST ritorna { error }): 500, nessun file tolto, il cestino si purga lo stesso', async () => {
        semina([allegato(1, scaduta()), caricato(2, vecchio())], [])
        h.errori['allegati_registro:conservazione'] = { code: '57014', message: 'timeout' }
        const res = await chiama()
        expect(res.status).toBe(500)
        const corpo = await res.json()
        expect(corpo.motivo).toBe('lettura-fallita')
        expect(corpo).not.toHaveProperty('error')
        expect(JSON.stringify(corpo)).not.toContain('timeout')
        // Il cestino è indipendente: la riga 1 esce, la 2 (e il suo file) restano.
        expect(ids('allegati_registro')).toEqual([uuid(2)])
        expect(h.bucket[B_ALLEGATI].has(f(2))).toBe(true)
        expect(battito()?.campi).toMatchObject({ esito: 'lettura-fallita', n_cestino_righe: 1, n_conservazione_righe: 0 })
        expect(
            h.eventi.some((e) => e.livello === 'error' && e.campi.tipo === 'conservazione' && e.campi.esito === 'lettura-fallita'),
        ).toBe(true)
    })

    it('se non si sa chi reclama i file, non si tocca NIENTE della conservazione (fail-closed)', async () => {
        semina([caricato(1, vecchio())], [])
        h.errori['allegati_registro:reclami'] = { code: '57014', message: 'timeout' }
        const res = await chiama()
        expect(res.status).toBe(500)
        expect((await res.json()).motivo).toBe('reclami-non-letti')
        expect(ids('allegati_registro')).toEqual([uuid(1)])
        expect(h.bucket[B_ALLEGATI].has(f(1))).toBe(true)
        expect(h.sequenza.some((x) => x.tipo === 'remove')).toBe(false)
    })

    it('un file che resta nel bucket trattiene la SUA riga: 500 «righe-trattenute»', async () => {
        semina([caricato(1, vecchio()), caricato(2, vecchio())], [])
        h.resistenti.add(f(1))
        const res = await chiama()
        expect(res.status).toBe(500)
        expect((await res.json()).motivo).toBe('righe-trattenute')
        expect(ids('allegati_registro')).toEqual([uuid(1)])
        expect(battito()?.campi).toMatchObject({ n_conservazione_righe: 1, n_righe_trattenute: 1 })
    })

    it('è IDEMPOTENTE: una delete fallita dopo il remove si chiude al giro dopo', async () => {
        semina([caricato(1, vecchio())], [])
        h.errori['allegati_registro:delete:creato_il'] = { code: '40001', message: 'serializzazione' }
        const primo = await chiama()
        expect(primo.status).toBe(500)
        expect((await primo.json()).motivo).toBe('cancellazione-fallita')
        expect(h.bucket[B_ALLEGATI].size).toBe(0)
        expect(ids('allegati_registro')).toEqual([uuid(1)])

        delete h.errori['allegati_registro:delete:creato_il']
        h.eventi = []
        const secondo = await chiama()
        expect(secondo.status).toBe(200)
        expect(ids('allegati_registro')).toEqual([])
        expect(battito()?.campi).toMatchObject({ esito: 'ok', n_conservazione_righe: 1, n_file_gia_assenti: 1 })
    })

    it('lotti a TETTO: oltre 500 allegati scaduti ne escono 500, i PIÙ VECCHI per caricamento, e si dichiara', async () => {
        // 501 allegati oltre il termine, ciascuno un minuto più vecchio del precedente:
        // il n. 1 è il meno vecchio. Seminati dal più giovane al più vecchio, così una
        // lettura senza `.order('creato_il')` terrebbe i primi 500 e lascerebbe il più
        // vecchio, e una senza `.limit()` li prenderebbe tutti.
        const minuto = 60 * 1000
        const base = (GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO + 1) * GIORNO
        const tanti = Array.from({ length: 501 }, (_, i) => caricato(i + 1, fa(base + (i + 1) * minuto)))
        semina(tanti, [])
        const res = await chiama()
        expect(res.status).toBe(200)
        const corpo = await res.json()
        expect(corpo.conservazione).toMatchObject({ scadute: 500, cancellate: 500, lottoPieno: true })
        // Resta il SOLO meno vecchio: il giro dopo lo prende.
        expect(ids('allegati_registro')).toEqual([uuid(1)])
        expect([...h.bucket[B_ALLEGATI]]).toEqual([f(1)])
        // Il taglio si dichiara: un warn col tipo del contenitore, e il battito lo porta.
        expect(
            h.eventi.some((e) => e.livello === 'warn' && e.campi.esito === 'lotto-pieno' && e.campi.tipo === 'conservazione'),
        ).toBe(true)
        expect(battito()?.campi).toMatchObject({ esito: 'ok', lotto_pieno: true, n_conservazione_righe: 500 })

        // Il giro dopo chiude il resto, e il lotto non è più pieno.
        h.eventi = []
        const secondo = await chiama()
        expect(secondo.status).toBe(200)
        expect(ids('allegati_registro')).toEqual([])
        expect(battito()?.campi).toMatchObject({ lotto_pieno: false, n_conservazione_righe: 1 })
    })

    it('DB non migrato per la sola `creato_il` (42703 sulla lettura della conservazione): 503, nessun remove, nessuna delete', async () => {
        semina([caricato(1, vecchio())], [])
        h.errori['allegati_registro:conservazione'] = { code: '42703', message: 'column creato_il does not exist' }
        const res = await chiama()
        expect(res.status).toBe(503)
        const corpo = await res.json()
        expect(corpo.motivo).toBe('colonne-cestino-assenti')
        expect(JSON.stringify(corpo)).not.toContain('does not exist')
        expect(h.sequenza.some((x) => x.tipo === 'remove' || x.tipo === 'delete')).toBe(false)
        expect(ids('allegati_registro')).toEqual([uuid(1)])
        expect(h.bucket[B_ALLEGATI].has(f(1))).toBe(true)
        expect(battito()?.campi).toMatchObject({ esito: 'colonne-cestino-assenti', n_conservazione_righe: 0 })
    })

    it('nei log non entra NESSUN percorso', async () => {
        semina([caricato(1, vecchio()), caricato(2, vecchio())], [])
        h.resistenti.add(f(2))
        await chiama()
        const log = JSON.stringify(h.eventi)
        expect(log).not.toContain('file-1.pdf')
        expect(log).not.toContain('file-2.pdf')
        expect(log).not.toContain(uuid(900))
    })
})

describe('POST /api/gdpr/retention-cestino-registro — la porta', () => {
    it('senza segreto e senza staff: la risposta del gate, nessun client, battito «non-autorizzato»', async () => {
        h.staffNegato = new Response(JSON.stringify({ error: 'Non autenticato' }), { status: 401 })
        const res = await chiama({})
        expect(res.status).toBe(401)
        expect(h.clientCreati).toBe(0)
        expect(battito()?.campi).toMatchObject({ esito: 'non-autorizzato' })
    })

    it('segreto sbagliato: si grida (error «secret-errato») e si ripiega sul gate dello staff', async () => {
        semina([], [])
        const res = await chiama({ 'x-cron-secret': 'sbagliato' })
        expect(res.status).toBe(200)
        expect(h.eventi.some((e) => e.livello === 'error' && e.campi.esito === 'secret-errato')).toBe(true)
        expect(battito()?.campi).toMatchObject({ canale: 'manuale' })
    })

    it('CRON_SECRET non configurato: nessuno passa dalla porta del cron', async () => {
        process.env.CRON_SECRET = ''
        h.staffNegato = new Response('{}', { status: 403 })
        const res = await chiama({ 'x-cron-secret': '' })
        expect(res.status).toBe(403)
        expect(h.clientCreati).toBe(0)
    })
})

describe('i bucket della purga sono quelli in cui si CARICA', () => {
    const leggi = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
    const purga = leggi('src/app/api/gdpr/retention-cestino-registro/route.ts')

    /**
     * Risolve l'identificatore `nome` dentro `sorgente`: o una `const` locale con un
     * letterale, o un import nominato da un modulo `@/…` che lo esporta come
     * `export const nome = '…'`. Restituisce il valore e DA DOVE viene, così la
     * prova può pretendere che chi carica e chi cancella leggano la STESSA costante.
     */
    function risolviCostante(sorgente: string, nome: string): { valore?: string; origine?: string } {
        const locale = sorgente.match(new RegExp(`const ${nome} = '([^']+)'`))?.[1]
        if (locale) return { valore: locale, origine: 'locale' }
        const modulo = sorgente.match(
            new RegExp(`import\\s*\\{[^}]*\\b${nome}\\b[^}]*\\}\\s*from\\s*'@/([^']+)'`),
        )?.[1]
        if (!modulo) return {}
        const valore = leggi(`src/${modulo}.ts`).match(new RegExp(`export const ${nome} = '([^']+)'`))?.[1]
        return { valore, origine: modulo }
    }

    it('allegati del registro: lo stesso bucket di `primaria/allegati:POST`', () => {
        // Il bucket si legge dalla chiamata che CARICA (`.storage.from(X).upload(`),
        // non da un nome di costante presunto: se la route cambia il modo di
        // dichiararlo, la prova segue l'identificatore fino al suo valore.
        const route = leggi('src/app/api/primaria/allegati/route.ts')
        const nomeUpload = route.match(/\.storage\s*\.from\((\w+)\)\s*\.upload\(/)?.[1]
        expect(nomeUpload, 'la route degli allegati non carica più con `.storage.from(X).upload(`').toBeTruthy()
        const upload = risolviCostante(route, nomeUpload!)
        expect(upload.valore, `il bucket di caricamento \`${nomeUpload}\` non si risolve a un letterale`).toBeTruthy()

        // Il bucket della purga: quello del contenitore `allegati`.
        const nomePurga = purga.match(/chiave:\s*'allegati',\s*bucket:\s*(\w+)/)?.[1]
        expect(nomePurga, 'la purga non dichiara più il bucket del contenitore `allegati`').toBeTruthy()
        const cancella = risolviCostante(purga, nomePurga!)

        // Stesso valore E stessa costante: una sola fonte per chi carica e chi cancella.
        expect(cancella.valore).toBe(upload.valore)
        expect(cancella.origine).toBe(upload.origine)
        expect(cancella.origine).not.toBe('locale')
        expect(nomePurga).toBe(nomeUpload)

        // E il bucket che le prove di comportamento qui sopra popolano è proprio quello.
        expect(upload.valore).toBe(B_ALLEGATI)
    })

    it('fascicolo: lo stesso bucket di `primaria/fascicolo:POST` e dell\'oblio', () => {
        // La route di caricamento dichiara il bucket in due forme possibili: una
        // costante sua, o `BUCKET_FASCICOLO as BUCKET` importato da un modulo. Si
        // risolve quella che c'è, invece di presumerne una.
        const sorgente = leggi('src/app/api/primaria/fascicolo/route.ts')
        let upload = sorgente.match(/const BUCKET = '([^']+)'/)?.[1]
        if (!upload) {
            const modulo = sorgente.match(
                /BUCKET_FASCICOLO as BUCKET[\s\S]*?\}\s*from\s*'@\/([^']+)'/,
            )?.[1]
            expect(modulo, 'la route del fascicolo non dichiara più il suo bucket in una forma nota').toBeTruthy()
            upload = leggi(`src/${modulo}.ts`).match(/export const BUCKET_FASCICOLO = '([^']+)'/)?.[1]
        }
        expect(upload).toBeTruthy()
        expect(purga).toContain(`const BUCKET_FASCICOLO = '${upload}'`)
        const oblio = leggi('src/lib/gdpr/esegui.ts').match(/export const BUCKET_FASCICOLO = '([^']+)'/)?.[1]
        expect(oblio).toBe(upload)
    })

    it('le letture di `student_documents` dichiarano cosa fanno del cestino', () => {
        // Il lock del fascicolo (`@/lib/primaria/cestino-fascicolo`) pretende un
        // marcatore su ogni `from('student_documents')`: la purga legge NEL cestino
        // (scadute, cancellazione) e ANCHE nel cestino (reclami), mai «solo vive».
        const blocchi = purga.split("from('student_documents')").slice(1)
        expect(blocchi.length).toBe(3)
        expect(purga.match(/fascicoloNelCestino\(\s*s\.from\('student_documents'\)/g)?.length).toBe(2)
        expect(purga).toMatch(/fascicoloAncheNelCestino\(\s*s\.from\('student_documents'\)/)
        expect(purga).not.toMatch(/fascicoloVivo\(/)
    })
})

describe('la migrazione del cron chiama QUESTA route con QUESTO nome di lavoro', () => {
    const sql = readFileSync(
        join(process.cwd(), 'supabase/migrations/20260924220100_cestino_registro_cron.sql'),
        'utf8',
    )
    const route = readFileSync(join(process.cwd(), 'src/app/api/gdpr/retention-cestino-registro/route.ts'), 'utf8')

    it('schedula ogni notte il lavoro col nome della costante JOB, e chiama il path della route', () => {
        const job = route.match(/const JOB = '([^']+)'/)?.[1]
        expect(job).toBe('cestino-registro-retention')
        expect(sql).toMatch(new RegExp(`cron\\.schedule\\(\\s*'${job}',\\s*'29 5 \\* \\* \\*'`))
        expect(sql).toContain(`cron.unschedule(jobid) FROM cron.job WHERE jobname = '${job}'`)
        expect(sql).toContain("'/api/gdpr/retention-cestino-registro'")
    })

    it('il segreto viene dal Vault, la funzione è del solo service_role, pg_cron assente non rompe', () => {
        expect(sql).toContain("public.cron_config('app.cron_secret')")
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.cestino_registro_retention_http\(\) FROM PUBLIC, anon, authenticated/)
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.cestino_registro_retention_http\(\) TO service_role/)
        expect(sql).toMatch(/EXCEPTION WHEN OTHERS THEN null;\s*END \$\$;/)
        expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.cestino_registro_retention_http\(\)/)
    })
})
