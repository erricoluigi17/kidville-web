import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../../fixtures/finto-supabase'
import { SEDE_A, NOME_SEDE_A } from '../../fixtures/sedi'

// =============================================================================
// IL TETTO DEL PROVIDER NON È UN FALLIMENTO: È UN «NON OGGI».
//
// ─── IL DIFETTO, MISURATO LEGGENDO IL CODICE IL 2026-08-20 ──────────────────
//
// `sendEmailDetailed` distingue da sempre i due fallimenti: `src/lib/email/send.ts`
// ritorna `{ ok: false, rinviabile: true }` sul `429` di Resend, e il commento
// accanto spiega che «un rifiuto definitivo consuma un tentativo, un 429 rinvia».
// Il ciclo d'invio del digest NON guardava quel campo. Scorreva tutti i
// destinatari collezionando 429, e poi marcava `inviata_il` lo stesso.
//
// Conseguenza: `inviata_il IS NULL` — l'unica guardia che decide se rispedire —
// non sarebbe stata mai più vera. L'edizione risultava inviata a chi non l'aveva
// ricevuta. Nessun errore, nessuna eccezione, nessuno che se ne accorge tranne le
// famiglie a cui non arriva niente.
//
// ⚠️ NON È UN'IPOTESI DI LABORATORIO. Il tetto Resend è di 100 email al giorno e
// l'importazione delle iscrizioni 2026/27 sta creando ~496 account genitore: il
// digest del 1° settembre 2026 è il primo giro in cui il numero dei destinatari
// supera il tetto.
//
// ─── IL SECONDO DIFETTO, TROVATO CORREGGENDO IL PRIMO ───────────────────────
//
// «Non marcare» da solo NON BASTA, e per una ragione che il commento accanto al
// ramo prudente nascondeva: diceva «riparte al giro successivo (il cron gira ogni
// giorno)». `news-digest` è `'0 8 1 * *'` — MENSILE. E `generaEInviaDigest`
// lavora su UN mese solo, quello che il chiamante gli passa: un'edizione lasciata
// in coda non veniva ripresa nemmeno il mese dopo. Restava orfana esattamente
// come se fosse stata marcata. Il ripescaggio vive in `eseguiDigest`
// (`src/app/api/news/cron/run/route.ts`) ed è coperto lì.
// =============================================================================

const logEvento = vi.fn()
const logErrore = vi.fn()

/** Comanda l'esito di ogni singolo invio, in ordine di chiamata. */
let esiti: { ok: boolean; rinviabile?: boolean }[] = []
let chiamata = 0
const inviati: string[] = []
const sendEmailDetailed = vi.fn(async (p: { to: string }) => {
    inviati.push(p.to)
    const e = esiti[chiamata++] ?? { ok: true }
    return { ...e, error: e.ok ? null : 'finto', to: p.to }
})

vi.mock('@/lib/logging/logger', () => ({
    logEvento: (...a: unknown[]) => logEvento(...a),
    logErrore: (...a: unknown[]) => logErrore(...a),
    logOk: vi.fn(),
}))
vi.mock('@/lib/email/send', () => ({
    sendEmailDetailed: (p: { to: string }) => sendEmailDetailed(p),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
    getGenitoriDiAlunni: vi.fn(async (_s: unknown, ids: string[]) => {
        const m = new Map<string, string[]>()
        for (const id of ids) m.set(id, [`gen-${id}`])
        return m
    }),
}))

import { generaEInviaDigest } from '@/lib/news/digest'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'

const PUBBLICATA = '2026-06-15T10:00:00.000Z'

/** Cinque famiglie raggiungibili. Le email sono già in ordine alfabetico. */
function dbCinqueFamiglie(): DBFinto {
    return {
        scuole: [{ id: SEDE_A, nome: NOME_SEDE_A, attiva: true }],
        news_posts: [
            {
                id: 'p-a', titolo: 'Gita al parco', stato: 'pubblicata', pinned: false,
                pubblicata_il: PUBBLICATA, scuola_id: SEDE_A, target_scope: 'globale', contenuto_testo: 'x',
            },
        ],
        news_digest_edizioni: [],
        alunni: [1, 2, 3, 4, 5].map((n) => ({ id: `al-${n}`, scuola_id: SEDE_A, stato: 'iscritto' })),
        utenti: [1, 2, 3, 4, 5].map((n) => ({ id: `gen-al-${n}`, email: `f${n}@example.test` })),
        admin_settings: [],
    }
}

const logConEsito = (esito: string) =>
    logEvento.mock.calls.filter((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => {
    vi.clearAllMocks()
    invalidateNotificheConfigCache()
    esiti = []
    chiamata = 0
    inviati.length = 0
})

describe('quota email esaurita — l’edizione resta in coda, non risulta inviata', () => {
    it('🔴 un 429 alla terza email ⇒ ci si ferma, e `inviata_il` resta NULL', async () => {
        const db = dbCinqueFamiglie()
        const scritture: Scrittura[] = []
        // due passano, la terza è il tetto del piano
        esiti = [{ ok: true }, { ok: true }, { ok: false, rinviabile: true }]

        const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db, [], { scritture }), {
            anno: 2026, mese: 6, scuolaId: SEDE_A,
        })

        // (a) ci si FERMA al 429: 3 tentativi, non 5. Continuare significherebbe solo
        //     collezionare altri 429 e, col throttle, occupare la route a vuoto.
        expect(sendEmailDetailed).toHaveBeenCalledTimes(3)
        // (b) l'edizione NON risulta inviata — è tutto il punto
        expect(db.news_digest_edizioni[0]?.inviata_il ?? null).toBeNull()
        expect(edizioni[0].inviata).toBe(false)
        // (c) l'avanzamento è salvato: due sono arrivate davvero
        expect(edizioni[0].destinatari_count).toBe(2)
    })

    it('lo dice, e coi due numeri che contano: quante partite, quante mancano', async () => {
        const db = dbCinqueFamiglie()
        esiti = [{ ok: true }, { ok: true }, { ok: false, rinviabile: true }]

        await generaEInviaDigest(creaFintoSupabase(db, []), { anno: 2026, mese: 6, scuolaId: SEDE_A })

        const righe = logConEsito('rimandata-quota')
        expect(righe.length).toBe(1)
        const campi = righe[0][2] as { inviate?: number; mancanti?: number }
        expect(campi.inviate).toBe(2)
        expect(campi.mancanti).toBe(3)
        // `warn` e non `error`: non è un guasto, è il tetto del piano — la stessa
        // scelta già fatta in send.ts. Ma resta scritto.
        expect(righe[0][1]).toBe('warn')
    })

    it('🔴 il SECONDO giro riprende da dove era arrivato, non da capo', async () => {
        const db = dbCinqueFamiglie()
        esiti = [{ ok: true }, { ok: true }, { ok: false, rinviabile: true }]
        await generaEInviaDigest(creaFintoSupabase(db, []), { anno: 2026, mese: 6, scuolaId: SEDE_A })
        const primoGiro = [...inviati]
        expect(primoGiro).toEqual(['f1@example.test', 'f2@example.test', 'f3@example.test'])

        // Secondo giro, stesso `db`: la quota è tornata.
        inviati.length = 0
        chiamata = 0
        esiti = []
        const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db, []), {
            anno: 2026, mese: 6, scuolaId: SEDE_A,
        })

        // f1 e f2 avevano ricevuto: non si rispedisce a loro.
        expect(inviati).toEqual(['f3@example.test', 'f4@example.test', 'f5@example.test'])
        expect(inviati).not.toContain('f1@example.test')
        // Ora l'edizione è completa e marcata.
        expect(db.news_digest_edizioni[0]?.inviata_il ?? null).not.toBeNull()
        expect(edizioni[0].inviata).toBe(true)
    })
})

describe('un rifiuto DEFINITIVO non è un rinvio: il giro va avanti e l’edizione si chiude', () => {
    it('un 403 in mezzo ⇒ si continua fino in fondo, e `inviata_il` viene marcata', async () => {
        const db = dbCinqueFamiglie()
        // la terza è rifiutata per sempre (indirizzo inesistente, dominio non verificato…)
        esiti = [{ ok: true }, { ok: true }, { ok: false }, { ok: true }, { ok: true }]

        const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db, []), {
            anno: 2026, mese: 6, scuolaId: SEDE_A,
        })

        // NON ci si ferma: un rifiuto definitivo consuma il tentativo e basta.
        expect(sendEmailDetailed).toHaveBeenCalledTimes(5)
        expect(db.news_digest_edizioni[0]?.inviata_il ?? null).not.toBeNull()
        expect(edizioni[0].inviata).toBe(true)
        expect(edizioni[0].errori_count).toBe(1)
        // e non si logga «rimandata-quota», che direbbe una cosa falsa
        expect(logConEsito('rimandata-quota')).toEqual([])
    })
})

describe('l’elenco dei destinatari è ORDINATO, altrimenti l’offset non significa niente', () => {
    it('gli invii seguono l’ordine alfabetico anche se il database li restituisce mescolati', async () => {
        const db = dbCinqueFamiglie()
        // il database li ritorna in un ordine qualunque: PostgREST non promette niente
        db.utenti = [
            { id: 'gen-al-3', email: 'f3@example.test' },
            { id: 'gen-al-1', email: 'f1@example.test' },
            { id: 'gen-al-5', email: 'f5@example.test' },
            { id: 'gen-al-2', email: 'f2@example.test' },
            { id: 'gen-al-4', email: 'f4@example.test' },
        ]

        await generaEInviaDigest(creaFintoSupabase(db, []), { anno: 2026, mese: 6, scuolaId: SEDE_A })

        expect(inviati).toEqual([
            'f1@example.test', 'f2@example.test', 'f3@example.test', 'f4@example.test', 'f5@example.test',
        ])
    })
})
