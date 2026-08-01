import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// S35 — cancellare un avviso non deve lasciare in giro i suoi resti.
//
// Misurato in produzione dal collaudo del 2026-07-31:
//
//   DELETE /api/avvisi/<id>  →  200
//   select * from notifiche where entita_id = '<id>'  →  LA RIGA C'È ANCORA
//
// Al genitore resta in campanella la notifica di un avviso che non esiste più:
// la tocca, arriva su `/parent/avvisi` e non trova niente. Il tester l'ha dovuta
// rimuovere a mano in SQL durante la pulizia.
//
// Stessa storia per il file: `avvisi_allegati` aveva già **1 oggetto orfano**
// (nessuna riga `avvisi` lo referenziava). Il bucket è privato dal 31/07, quindi
// non è più materiale scaricabile da chiunque — ma un allegato di una
// comunicazione scolastica che resta archiviato per sempre dopo che l'avviso è
// stato cancellato è comunque un dato conservato senza più uno scopo.
//
// Cosa mette alla prova questo file, e perché in questa forma:
//
//  · l'asserzione che conta è sulla MUTAZIONE — quali DELETE sono partite
//    davvero, con quali FILTRI, e verso quale bucket. Uno status 200 non dice
//    niente su cosa è stato cancellato;
//  · ogni asserzione negativa ha accanto il suo CONTROLLO POSITIVO: «non
//    cancella le notifiche altrui» vale solo se, nello stesso mock, cancella le
//    proprie;
//  · l'ordine è parte del contratto: se la cancellazione dell'avviso fallisce,
//    le sue notifiche NON si toccano (l'avviso è ancora vivo e i genitori devono
//    continuare a vederlo);
//  · un guasto sulla coda o sullo Storage NON diventa un 500: l'avviso è già
//    stato cancellato, e un 500 direbbe al segretario una cosa falsa. Diventa
//    una riga `error` col corpo del guasto (AGENTS §3), che è l'unico posto in
//    cui quel fatto può esistere.
// =============================================================================

const SEDE_MIA = 'aaaaaaaa-0000-4000-8000-00000000000a'
const AVVISO_ID = 'cccccccc-0000-4000-8000-00000000000c'
const FILE_ALLEGATO = '1785526750670-91plab2.pdf'
const BUCKET = 'avvisi_allegati'

interface Operazione {
    tabella: string
    tipo: 'select' | 'update' | 'delete'
    sel: string
    filtri: Record<string, unknown>
    valori: Record<string, unknown> | null
}

const h = vi.hoisted(() => ({
    requireDocente: vi.fn(),
    scuoleDiUtente: vi.fn(),
    verificaTargetAvvisoDocente: vi.fn(),
    eventi: [] as { evento: string; livello: string; campi: Record<string, unknown>; err?: unknown }[],
    errori: [] as { contesto: Record<string, unknown>; err: unknown }[],
    /** Ogni query eseguita sul finto PostgREST: tabella, tipo, filtri. */
    operazioni: [] as Operazione[],
    /** Ogni `storage.from(bucket).remove([...])` davvero partita. */
    rimozioni: [] as { bucket: string; percorsi: string[] }[],
    allegato: null as string | null,
    /** Righe restituite dalla DELETE su `notifiche` (il conteggio del log). */
    notificheCancellate: [{ id: 'n-1' }, { id: 'n-2' }] as { id: string }[],
    /** Altri avvisi che puntano allo STESSO file: se ce ne sono, non si cancella. */
    altriRiferimenti: [] as { id: string }[],
    erroreLetturaAllegato: null as { code: string; message: string } | null,
    erroreRicercaAltri: null as { code: string; message: string } | null,
    erroreDeleteAvviso: null as { code: string; message: string } | null,
    erroreDeleteNotifiche: null as { code: string; message: string } | null,
    erroreRemove: null as { message: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: (...a: unknown[]) => h.requireDocente(...a) }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: (...a: unknown[]) => h.scuoleDiUtente(...a) }))
vi.mock('@/lib/avvisi/target-gate', () => ({
    verificaTargetAvvisoDocente: (...a: unknown[]) => h.verificaTargetAvvisoDocente(...a),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/logging/logger', async (orig) => ({
    ...(await orig<typeof import('@/lib/logging/logger')>()),
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>, err?: unknown) => {
        h.eventi.push({ evento, livello, campi, err })
    },
    logErrore: (contesto: Record<string, unknown>, err: unknown) => {
        h.errori.push({ contesto, err })
    },
}))

// `@/lib/allegati/storage` NON è mockato: la decodifica dell'allegato (JSON
// `{file,link}`, URL storico, stringa nuda) è esattamente la parte che qui deve
// funzionare davvero. Un mock la sostituirebbe con la propria idea di percorso.
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        from(tabella: string) {
            const q: Operazione = { tabella, tipo: 'select', sel: '', filtri: {}, valori: null }
            const esegui = () => {
                h.operazioni.push({ ...q, filtri: { ...q.filtri } })
                if (q.tipo === 'delete') {
                    if (tabella === 'avvisi') return { data: null, error: h.erroreDeleteAvviso }
                    if (tabella === 'notifiche') {
                        return h.erroreDeleteNotifiche
                            ? { data: null, error: h.erroreDeleteNotifiche }
                            : { data: h.notificheCancellate, error: null }
                    }
                    return { data: null, error: null }
                }
                if (q.tipo === 'update') return { data: { id: AVVISO_ID, ...(q.valori ?? {}) }, error: null }
                if (tabella === 'avvisi' && q.sel === 'scuola_id') return { data: { scuola_id: SEDE_MIA }, error: null }
                if (tabella === 'avvisi' && q.sel === 'attachment_url') {
                    return h.erroreLetturaAllegato
                        ? { data: null, error: h.erroreLetturaAllegato }
                        : { data: { attachment_url: h.allegato }, error: null }
                }
                if (tabella === 'avvisi' && q.sel === 'id') {
                    return h.erroreRicercaAltri
                        ? { data: null, error: h.erroreRicercaAltri }
                        : { data: h.altriRiferimenti, error: null }
                }
                if (tabella === 'utenti') return { data: { first_name: 'A', last_name: 'B', role: 'educator' }, error: null }
                return { data: null, error: null }
            }
            const b: Record<string, unknown> = {}
            b.select = (s?: string) => { if (typeof s === 'string') q.sel = s; return b }
            b.eq = (c: string, v: unknown) => { q.filtri[c] = v; return b }
            b.neq = (c: string, v: unknown) => { q.filtri[`neq:${c}`] = v; return b }
            b.ilike = (c: string, v: unknown) => { q.filtri[`ilike:${c}`] = v; return b }
            b.limit = () => b
            b.update = (v: Record<string, unknown>) => { q.tipo = 'update'; q.valori = v; return b }
            b.delete = () => { q.tipo = 'delete'; return b }
            b.single = async () => esegui()
            b.maybeSingle = async () => esegui()
            b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
                Promise.resolve(esegui()).then(onF, onR)
            return b
        },
        storage: {
            from: (bucket: string) => ({
                remove: async (percorsi: string[]) => {
                    h.rimozioni.push({ bucket, percorsi })
                    return h.erroreRemove
                        ? { data: null, error: h.erroreRemove }
                        : { data: percorsi.map((p) => ({ name: p })), error: null }
                },
            }),
        },
    }),
}))

import { PUT as AVVISO_PUT, DELETE as AVVISO_DELETE } from '@/app/api/avvisi/[id]/route'

const req = (body?: unknown, method = 'DELETE') => ({
    url: `http://test/api/avvisi/${AVVISO_ID}`,
    method,
    headers: new Headers(),
    nextUrl: { searchParams: new URLSearchParams() },
    cookies: { get: () => undefined },
    json: async () => body ?? {},
}) as never

const ctx = () => ({ params: Promise.resolve({ id: AVVISO_ID }) })

/** Le mutazioni davvero eseguite (le sole che cambiano lo stato). */
const mutazioni = () => h.operazioni.filter((o) => o.tipo !== 'select')
const deleteSu = (tabella: string) => mutazioni().filter((o) => o.tabella === tabella && o.tipo === 'delete')

beforeEach(() => {
    vi.clearAllMocks()
    h.eventi = []
    h.errori = []
    h.operazioni = []
    h.rimozioni = []
    h.allegato = null
    h.notificheCancellate = [{ id: 'n-1' }, { id: 'n-2' }]
    h.altriRiferimenti = []
    h.erroreLetturaAllegato = null
    h.erroreRicercaAltri = null
    h.erroreDeleteAvviso = null
    h.erroreDeleteNotifiche = null
    h.erroreRemove = null
    h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_MIA } })
    h.scuoleDiUtente.mockResolvedValue([SEDE_MIA])
    h.verificaTargetAvvisoDocente.mockResolvedValue(null)
})

// ─────────────────────────────────────────────────────────────────────────────
// Le notifiche già consegnate in campanella
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /api/avvisi/[id] — le notifiche non restano orfane', () => {
    it('cancella le notifiche dell\'avviso, e SOLO quelle: entita_tipo=avviso + entita_id', async () => {
        const res = await AVVISO_DELETE(req(), ctx())

        expect(res.status).toBe(200)
        const suNotifiche = deleteSu('notifiche')
        expect(suNotifiche).toHaveLength(1)
        // I due filtri sono il contratto: senza `entita_id` si cancellerebbe la
        // campanella di tutta la scuola; senza `entita_tipo` si prenderebbero le
        // notifiche di un'altra entità che per caso avesse lo stesso uuid.
        expect(suNotifiche[0].filtri).toEqual({ entita_tipo: 'avviso', entita_id: AVVISO_ID })
    })

    it('CONTROLLO POSITIVO: l\'avviso continua a cancellarsi (una delete su `avvisi`, filtrata per id)', async () => {
        const res = await AVVISO_DELETE(req(), ctx())

        expect(res.status).toBe(200)
        const suAvvisi = deleteSu('avvisi')
        expect(suAvvisi).toHaveLength(1)
        expect(suAvvisi[0].filtri).toMatchObject({ id: AVVISO_ID })
    })

    it('se la cancellazione dell\'AVVISO fallisce → 500 e le sue notifiche NON si toccano', async () => {
        h.erroreDeleteAvviso = { code: '23503', message: 'violates foreign key constraint "avvisi_risposte_avviso_id_fkey"' }
        const res = await AVVISO_DELETE(req(), ctx())

        expect(res.status).toBe(500)
        // L'avviso è ancora vivo: togliere le notifiche lascerebbe le famiglie
        // senza il messaggio di un avviso che c'è.
        expect(deleteSu('notifiche')).toHaveLength(0)
        // Il messaggio del database resta nel log, non torna al client.
        expect(JSON.stringify(await res.json())).not.toContain('foreign key')
        expect(JSON.stringify(h.errori)).toContain('foreign key')
    })

    it('se la cancellazione delle NOTIFICHE fallisce → 200 (l\'avviso è cancellato davvero) + riga error col corpo del guasto', async () => {
        h.erroreDeleteNotifiche = { code: '42703', message: 'column notifiche.entita_tipo does not exist' }
        const res = await AVVISO_DELETE(req(), ctx())

        // Un 500 qui direbbe al segretario che l'avviso non è stato cancellato:
        // sarebbe falso, e lo farebbe riprovare (ottenendo un 404).
        expect(res.status).toBe(200)
        const riga = h.eventi.find((e) => e.campi.esito === 'notifiche-orfane-non-rimosse')
        expect(riga).toBeDefined()
        expect(riga!.livello).toBe('error')
        expect(JSON.stringify(riga!.err)).toContain('entita_tipo does not exist')
    })

    it('IL SUCCESSO SI LOGGA, col numero di notifiche ritirate', async () => {
        h.notificheCancellate = [{ id: 'n-1' }, { id: 'n-2' }, { id: 'n-3' }]
        await AVVISO_DELETE(req(), ctx())

        const riga = h.eventi.find((e) => e.campi.esito === 'cancellato')
        expect(riga).toBeDefined()
        expect(riga!.campi).toMatchObject({ operazione: 'avvisi/[id]:DELETE', n_notifiche_rimosse: 3 })
        // Solo conteggi e uuid: mai il titolo dell'avviso, mai un destinatario.
        expect(JSON.stringify(riga!.campi)).not.toContain('seg-1')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Il file nel bucket
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /api/avvisi/[id] — l\'allegato non resta nel bucket', () => {
    it('allegato in forma JSON {file,link}: rimuove il FILE dal bucket privato', async () => {
        h.allegato = JSON.stringify({ file: FILE_ALLEGATO, link: null })
        const res = await AVVISO_DELETE(req(), ctx())

        expect(res.status).toBe(200)
        expect(h.rimozioni).toEqual([{ bucket: BUCKET, percorsi: [FILE_ALLEGATO] }])
    })

    it('riga storica con l\'URL pubblico intero: ne ricava il percorso e rimuove quello', async () => {
        h.allegato = `https://xyz.supabase.co/storage/v1/object/public/${BUCKET}/${FILE_ALLEGATO}`
        await AVVISO_DELETE(req(), ctx())

        expect(h.rimozioni).toEqual([{ bucket: BUCKET, percorsi: [FILE_ALLEGATO] }])
    })

    it('solo un LINK esterno (il sito del Comune): non si tocca niente nello Storage', async () => {
        h.allegato = JSON.stringify({ file: null, link: 'https://comune.giugliano.na.it/modulo.pdf' })
        const res = await AVVISO_DELETE(req(), ctx())

        expect(res.status).toBe(200)
        expect(h.rimozioni).toHaveLength(0)
        // CONTROLLO POSITIVO: non è che «non rimuove mai» — l'avviso è comunque
        // cancellato e le notifiche ritirate.
        expect(deleteSu('avvisi')).toHaveLength(1)
        expect(deleteSu('notifiche')).toHaveLength(1)
    })

    it('avviso senza allegato: nessuna chiamata allo Storage e nessuna ricerca inutile', async () => {
        h.allegato = null
        await AVVISO_DELETE(req(), ctx())

        expect(h.rimozioni).toHaveLength(0)
        expect(h.operazioni.filter((o) => o.tabella === 'avvisi' && o.sel === 'id')).toHaveLength(0)
    })

    it('allegato con JSON malformato: non si cancella niente, e la riga resta', async () => {
        // La gemella che FIRMA tratta il JSON rotto come stringa nuda e prova a
        // firmarlo (al peggio un link che non apre). Qui no: cancellare un
        // percorso ricavato per congettura significa perdere un file.
        h.allegato = '{"file": "1785526750670-91plab2.pdf"'
        const res = await AVVISO_DELETE(req(), ctx())

        expect(res.status).toBe(200)
        expect(h.rimozioni).toHaveLength(0)
        const riga = h.eventi.find((e) => e.campi.esito === 'json-malformato-nessuna-rimozione')
        expect(riga).toBeDefined()
        // Nel log la sola lunghezza: `attachment_url` è un percorso, e un percorso qui è una credenziale.
        expect(JSON.stringify(riga!.campi)).not.toContain(FILE_ALLEGATO)
    })

    it('un ALTRO avviso punta allo stesso file → il file NON si cancella', async () => {
        h.allegato = FILE_ALLEGATO
        h.altriRiferimenti = [{ id: 'altro-avviso' }]
        const res = await AVVISO_DELETE(req(), ctx())

        expect(res.status).toBe(200)
        expect(h.rimozioni).toHaveLength(0)
        // La ricerca esclude la riga appena cancellata e cerca il percorso.
        const ricerca = h.operazioni.find((o) => o.tabella === 'avvisi' && o.sel === 'id')
        expect(ricerca).toBeDefined()
        expect(ricerca!.filtri['neq:id']).toBe(AVVISO_ID)
        expect(String(ricerca!.filtri['ilike:attachment_url'])).toContain(FILE_ALLEGATO)
    })

    it('se la ricerca degli altri riferimenti fallisce → NON si cancella (fail-safe) e resta una riga warn', async () => {
        h.allegato = FILE_ALLEGATO
        h.erroreRicercaAltri = { code: '08006', message: 'connection failure' }
        const res = await AVVISO_DELETE(req(), ctx())

        expect(res.status).toBe(200)
        // Un file cancellato per sbaglio non si recupera: nel dubbio resta.
        expect(h.rimozioni).toHaveLength(0)
        const riga = h.eventi.find((e) => e.campi.esito === 'allegato-non-verificabile')
        expect(riga).toBeDefined()
        expect(riga!.livello).toBe('warn')
    })

    it('se la rimozione dallo Storage fallisce → 200 + error COL CORPO del provider', async () => {
        h.allegato = FILE_ALLEGATO
        h.erroreRemove = { message: 'Object not found' }
        const res = await AVVISO_DELETE(req(), ctx())

        expect(res.status).toBe(200)
        const riga = h.eventi.find((e) => e.evento === 'storage' && e.livello === 'error')
        expect(riga).toBeDefined()
        expect(JSON.stringify(riga!.err)).toContain('Object not found')
        // Il nome del file NON finisce nel log: dice di che comunicazione si tratta.
        expect(JSON.stringify(riga!.campi)).not.toContain(FILE_ALLEGATO)
    })

    it('una lettura fallita dell\'allegato non impedisce la cancellazione dell\'avviso', async () => {
        h.erroreLetturaAllegato = { code: '08006', message: 'connection failure' }
        const res = await AVVISO_DELETE(req(), ctx())

        expect(res.status).toBe(200)
        expect(deleteSu('avvisi')).toHaveLength(1)
        expect(h.rimozioni).toHaveLength(0)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Sostituzione dell'allegato: il vecchio file è un orfano a tutti gli effetti
// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /api/avvisi/[id] — l\'allegato sostituito non resta nel bucket', () => {
    const body = (attachment_url: string | null) => ({
        titolo: 'TEST titolo', contenuto: 'TEST contenuto', attachment_url,
    })

    it('il file cambia: il VECCHIO viene rimosso, il nuovo no', async () => {
        h.allegato = JSON.stringify({ file: FILE_ALLEGATO, link: null })
        const nuovo = '1785599999999-nuovo00.pdf'
        const res = await AVVISO_PUT(req(body(JSON.stringify({ file: nuovo, link: null })), 'PUT'), ctx())

        expect(res.status).toBe(200)
        expect(h.rimozioni).toEqual([{ bucket: BUCKET, percorsi: [FILE_ALLEGATO] }])
    })

    it('l\'allegato viene tolto del tutto: il vecchio file viene rimosso', async () => {
        h.allegato = FILE_ALLEGATO
        const res = await AVVISO_PUT(req(body(null), 'PUT'), ctx())

        expect(res.status).toBe(200)
        expect(h.rimozioni).toEqual([{ bucket: BUCKET, percorsi: [FILE_ALLEGATO] }])
    })

    it('CONTROLLO POSITIVO: se il file NON cambia non si tocca lo Storage, e l\'update avviene lo stesso', async () => {
        h.allegato = FILE_ALLEGATO
        // Il modulo di modifica rilegge l'avviso e rimanda indietro il LINK FIRMATO
        // dello stesso file: normalizzato è lo stesso percorso, non una sostituzione.
        const firmato = `https://xyz.supabase.co/storage/v1/object/sign/${BUCKET}/${FILE_ALLEGATO}?token=abc`
        const res = await AVVISO_PUT(req(body(firmato), 'PUT'), ctx())

        expect(res.status).toBe(200)
        expect(h.rimozioni).toHaveLength(0)
        expect(mutazioni().filter((o) => o.tabella === 'avvisi' && o.tipo === 'update')).toHaveLength(1)
    })

    it('il PUT non tocca MAI le notifiche: l\'avviso esiste ancora', async () => {
        h.allegato = FILE_ALLEGATO
        await AVVISO_PUT(req(body(null), 'PUT'), ctx())

        expect(deleteSu('notifiche')).toHaveLength(0)
    })
})
