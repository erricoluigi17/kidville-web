import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto } from '../fixtures/finto-supabase'

// =============================================================================
// L'OBLIO DI UN DOPPIONE NON DEVE DISTRUGGERE IL BAMBINO VERO (2026-10-09).
//
// IL FATTO, misurato in produzione: fra i non iscritti c'è una scheda DOPPIONE con lo
// STESSO codice fiscale di un bambino che frequenta, e tre domande d'iscrizione contengono
// quel codice fiscale. `anonimizzaAlunno` usa codice fiscale e documento come CHIAVI DI
// RICERCA fuori dalla riga dell'alunno: ripulisce in ogni domanda le persone con quel CF o
// quel documento e ne toglie gli allegati, e azzera i bonifici non confermati e i movimenti
// di cassa che citano quel CF. Sul doppione, tutto questo cade sul bambino VERO — e non si
// torna indietro.
//
// La guardia sta DENTRO `anonimizzaAlunno`, non nelle route: le porte che la chiamano sono
// tre (oblio della Direzione, richieste delle famiglie, eliminazione definitiva), e una
// regola valida per tre strade deve vivere in un posto solo.
//
// Finto con le righe vere delle tabelle (filtri e scritture applicati davvero): le
// asserzioni sono sullo STATO finale di domande, bonifici, cassa e archivio dei file.
// =============================================================================

const spie = vi.hoisted(() => ({ logErrore: vi.fn(), logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logErrore: spie.logErrore, logEvento: spie.logEvento }
})

import { anonimizzaAlunno, anonimizzaParent, BUCKET_ISCRIZIONI } from '@/lib/gdpr/esegui'
import { scrubDomandaIscrizione } from '@/lib/gdpr/anonimizza'

const DOPPIONE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const VERO = 'bbbbbbbb-0000-4000-8000-00000000000b'
// Un codice fiscale INVENTATO, con la forma di uno vero (repo pubblico: mai un CF reale).
const CF = 'DPRBMB20A01Z999X'
const DOC_COMUNE = 'iscrizioni/uuid-documento-comune.pdf'
const DOC_PROPRIO = 'iscrizioni/uuid-documento-proprio.pdf'
const GENITORE = 'cccccccc-0000-4000-8000-00000000000c'
const ALTRO_GENITORE = 'dddddddd-0000-4000-8000-00000000000d'
// Il codice fiscale (inventato) di un adulto.
const CF_ADULTO = 'GNTPRV80A01Z999K'
const DOC_ADULTO = 'iscrizioni/uuid-documento-adulto.pdf'
const AT = '2026-10-09T00:00:00Z'

const alunno = (id: string, extra: Record<string, unknown> = {}) => ({
  id, nome: 'Bambino', cognome: 'DiProva', codice_fiscale: null, fiscal_code: null,
  documento_path: null, anonimizzato_il: null, ...extra,
})

const domanda = (id: string, figlio: Record<string, unknown>) => ({
  id,
  data: { children: [{ nome: 'Bambino', cognome: 'DiProva', ...figlio }], adults: [{ nome: 'Genitore', cognome: 'DiProva' }] },
  consents_log: null,
})

function dbBase(): DBFinto {
  return {
    alunni: [],
    parents: [],
    enrollment_submissions: [],
    pagamenti: [],
    riconciliazione_movimenti: [
      { id: 'rm-1', stato: 'da_abbinare', causale: `RETTA OTTOBRE ${CF}`, controparte: 'FAMIGLIA DIPROVA', pagamento_id: null, suggerimenti: [] },
    ],
    cassa_movimenti: [
      { id: 'cm-1', descrizione: `QUOTA ${CF}`, note: null, storno_motivo: null },
    ],
  }
}

/** Lo Storage come archivio: `remove` toglie davvero, `list` dice cosa c'è ancora. */
function archivio(iniziale: Record<string, string[]>) {
  const a = new Map<string, Set<string>>(Object.entries(iniziale).map(([b, p]) => [b, new Set(p)]))
  const storage = {
    from: (bucket: string) => ({
      remove: async (paths: string[]) => {
        const dentro = a.get(bucket) ?? new Set<string>()
        return { data: paths.filter((p) => dentro.delete(p)).map((p) => ({ name: p })), error: null }
      },
      list: async (cartella: string, opts?: { search?: string }) => {
        const cerca = opts?.search ?? ''
        const righe = [...(a.get(bucket) ?? new Set<string>())]
          .map((p) => ({ cartella: p.slice(0, Math.max(0, p.lastIndexOf('/'))), nome: p.slice(p.lastIndexOf('/') + 1) }))
          .filter((s) => s.cartella === cartella && s.nome.startsWith(cerca))
          .map((s) => ({ name: s.nome }))
        return { data: righe, error: null }
      },
    }),
  }
  return { a, storage }
}

const RPC = { video_intent_oblio_alunno: async () => ({ data: { ok: true, intenti: 0, revocati: 0 }, error: null }) }

async function oblio(d: DBFinto, soggetto: Record<string, unknown>, file: Record<string, string[]> = {}, errori: OpzioniFinto['errori'] = {}) {
  const client = creaFintoSupabase(d, [], { rpc: RPC, errori })
  const arch = archivio(file)
  ;(client as unknown as { storage: unknown }).storage = arch.storage
  const r = await anonimizzaAlunno(client as SupabaseClient, soggetto as never, AT, 'test')
  return { r, archivio: arch.a }
}

const esclusioni = () =>
  spie.logEvento.mock.calls
    .map((c) => c[2] as Record<string, unknown>)
    .filter((c) => c?.esito === 'oblio-chiave-condivisa-esclusa')

beforeEach(() => vi.clearAllMocks())

describe('anonimizzaAlunno — il codice fiscale di un doppione', () => {
  it('stesso CF di un alunno VIVO: domanda intatta, bonifici e cassa intatti, ma la riga del doppione si azzera', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { codice_fiscale: CF }), alunno(VERO, { codice_fiscale: CF })]
    d.enrollment_submissions = [domanda('es-1', { codice_fiscale: CF, allergie: 'ALLERGIA DI PROVA' })]
    const primaDomanda = structuredClone(d.enrollment_submissions[0])

    const { r } = await oblio(d, { id: DOPPIONE, codice_fiscale: CF, fiscal_code: null, documento_path: null })

    expect(d.enrollment_submissions[0], 'la domanda del bambino VERO è stata ripulita dall’oblio del doppione').toEqual(primaDomanda)
    expect(d.riconciliazione_movimenti[0].causale, 'un bonifico del bambino vero ha perso la causale').toBe(`RETTA OTTOBRE ${CF}`)
    expect(d.cassa_movimenti[0].descrizione, 'un movimento di cassa del bambino vero è stato riscritto').toBe(`QUOTA ${CF}`)
    // La riga del doppione si azzera comunque: è SUA.
    const riga = d.alunni.find((a) => a.id === DOPPIONE)!
    expect(riga.codice_fiscale).toBeNull()
    expect(riga.anonimizzato_il).toBe(AT)
    // Il bambino vero non si tocca.
    expect(d.alunni.find((a) => a.id === VERO)!.codice_fiscale).toBe(CF)

    expect(r.chiaviCondiviseEscluse).toEqual({ codiceFiscale: 1, documento: 0 })
    expect(r.lettureFallite).toBe(0)
    expect(esclusioni()).toEqual([
      expect.objectContaining({ entita_tipo: 'alunni', entita_id: DOPPIONE, tipo: 'codice_fiscale' }),
    ])
    expect(spie.logEvento.mock.calls.find((c) => (c[2] as { esito?: string }).esito === 'oblio-chiave-condivisa-esclusa')![1]).toBe('warn')
    // Nessun valore in chiaro nei log.
    expect(JSON.stringify([spie.logEvento.mock.calls, spie.logErrore.mock.calls])).not.toContain(CF)
  })

  it('lo stesso CF scritto in un altro modo (minuscolo, spazi, nell’altra colonna) è lo stesso CF', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { codice_fiscale: CF }), alunno(VERO, { fiscal_code: ` ${CF.toLowerCase()} ` })]
    d.enrollment_submissions = [domanda('es-1', { codice_fiscale: CF })]
    const primaDomanda = structuredClone(d.enrollment_submissions[0])

    const { r } = await oblio(d, { id: DOPPIONE, codice_fiscale: CF, fiscal_code: null, documento_path: null })

    expect(d.enrollment_submissions[0]).toEqual(primaDomanda)
    expect(r.chiaviCondiviseEscluse.codiceFiscale).toBe(1)
  })

  it('stesso CF ma l’altra riga è GIÀ anonimizzata → la chiave si usa (comportamento di prima)', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { codice_fiscale: CF }), alunno(VERO, { codice_fiscale: CF, anonimizzato_il: '2026-01-01T00:00:00Z' })]
    d.enrollment_submissions = [domanda('es-1', { codice_fiscale: CF, allergie: 'ALLERGIA DI PROVA' })]

    const { r } = await oblio(d, { id: DOPPIONE, codice_fiscale: CF, fiscal_code: null, documento_path: null })

    const figlio = (d.enrollment_submissions[0].data as { children: Record<string, unknown>[] }).children[0]
    // `scrubPersonaIscrizione` non toglie le chiavi: le porta a null e marca la persona.
    expect(figlio.codice_fiscale, 'la domanda non è stata ripulita').toBeNull()
    expect(figlio.allergie).toBeNull()
    expect(figlio.anonimizzato_il).toBe(AT)
    expect(d.riconciliazione_movimenti[0].causale).toBeNull()
    expect(d.cassa_movimenti[0].descrizione).toBe('[rimosso]')
    expect(r.chiaviCondiviseEscluse).toEqual({ codiceFiscale: 0, documento: 0 })
    expect(esclusioni()).toEqual([])
  })

  it('un CF che nessun altro ha → la chiave si usa, come sempre', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { codice_fiscale: CF })]
    d.enrollment_submissions = [domanda('es-1', { codice_fiscale: CF })]

    const { r } = await oblio(d, { id: DOPPIONE, codice_fiscale: CF, fiscal_code: null, documento_path: null })

    expect((d.enrollment_submissions[0].data as { children: Record<string, unknown>[] }).children[0].codice_fiscale).toBeNull()
    expect(d.riconciliazione_movimenti[0].causale).toBeNull()
    expect(r.iscrizioniScrubbate).toBe(1)
    expect(r.lettureFallite).toBe(0)
  })
})

describe('anonimizzaAlunno — il documento d’identità', () => {
  it('documento condiviso con un altro alunno VIVO → il file NON esce e la domanda resta intatta', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { documento_path: DOC_COMUNE }), alunno(VERO, { codice_fiscale: CF, documento_path: DOC_COMUNE })]
    d.enrollment_submissions = [domanda('es-1', { codice_fiscale: CF, documento_path: DOC_COMUNE })]
    const primaDomanda = structuredClone(d.enrollment_submissions[0])

    const { r, archivio: arch } = await oblio(
      d,
      { id: DOPPIONE, codice_fiscale: null, fiscal_code: null, documento_path: DOC_COMUNE },
      { [BUCKET_ISCRIZIONI]: [DOC_COMUNE] },
    )

    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_COMUNE), 'il documento del bambino vero è uscito dall’archivio').toBe(true)
    expect(d.enrollment_submissions[0]).toEqual(primaDomanda)
    expect(d.alunni.find((a) => a.id === DOPPIONE)!.documento_path).toBeNull()
    expect(r.chiaviCondiviseEscluse).toEqual({ codiceFiscale: 0, documento: 1 })
    expect(esclusioni()).toEqual([expect.objectContaining({ entita_id: DOPPIONE, tipo: 'documento' })])
    expect(JSON.stringify(spie.logEvento.mock.calls)).not.toContain(DOC_COMUNE)
  })

  it('documento che è anche quello di un GENITORE → il file NON esce', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { documento_path: DOC_COMUNE })]
    d.parents = [{ id: 'p-1', documento_path: DOC_COMUNE, anonimizzato_il: null }]

    const { r, archivio: arch } = await oblio(
      d,
      { id: DOPPIONE, codice_fiscale: null, fiscal_code: null, documento_path: DOC_COMUNE },
      { [BUCKET_ISCRIZIONI]: [DOC_COMUNE] },
    )

    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_COMUNE)).toBe(true)
    expect(r.chiaviCondiviseEscluse.documento).toBe(1)
  })

  it('CF proprio ma la SUA domanda nomina un documento condiviso → la domanda si ripulisce, quel file no', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { codice_fiscale: CF }), alunno(VERO, { documento_path: DOC_COMUNE })]
    d.enrollment_submissions = [domanda('es-1', { codice_fiscale: CF, documento_path: DOC_COMUNE })]

    const { r, archivio: arch } = await oblio(
      d,
      { id: DOPPIONE, codice_fiscale: CF, fiscal_code: null, documento_path: null },
      { [BUCKET_ISCRIZIONI]: [DOC_COMUNE] },
    )

    expect(r.iscrizioniScrubbate).toBe(1)
    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_COMUNE), 'il documento di un altro bambino vivo è uscito').toBe(true)
    expect(r.chiaviCondiviseEscluse.documento).toBe(1)
  })

  it('documento nominato SOLO dalla propria domanda (il caso normale, 243 su 243) → domanda ripulita e file rimosso', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { codice_fiscale: CF, documento_path: DOC_PROPRIO })]
    d.enrollment_submissions = [domanda('es-1', { codice_fiscale: CF, documento_path: DOC_PROPRIO })]

    const { r, archivio: arch } = await oblio(
      d,
      { id: DOPPIONE, codice_fiscale: CF, fiscal_code: null, documento_path: DOC_PROPRIO },
      { [BUCKET_ISCRIZIONI]: [DOC_PROPRIO] },
    )

    expect(r.iscrizioniScrubbate).toBe(1)
    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_PROPRIO), 'il documento del bambino non è uscito').toBe(false)
    expect(r.chiaviCondiviseEscluse).toEqual({ codiceFiscale: 0, documento: 0 })
    expect(r.lettureFallite).toBe(0)
  })
})

describe('anonimizzaAlunno — una verifica che non si è potuta fare', () => {
  it('lettura di `alunni` rifiutata → il CF NON si usa e `lettureFallite` sale di uno', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { codice_fiscale: CF })]
    d.enrollment_submissions = [domanda('es-1', { codice_fiscale: CF })]
    const primaDomanda = structuredClone(d.enrollment_submissions[0])

    const { r } = await oblio(d, { id: DOPPIONE, codice_fiscale: CF, fiscal_code: null, documento_path: null }, {}, {
      'alunni:select': { code: '42501', message: 'permission denied' },
    })

    expect(d.enrollment_submissions[0], '«non ho potuto controllare» trattato come «è suo»').toEqual(primaDomanda)
    expect(d.riconciliazione_movimenti[0].causale).toBe(`RETTA OTTOBRE ${CF}`)
    expect(r.lettureFallite).toBe(1)
    expect(r.chiaviCondiviseEscluse.codiceFiscale).toBe(0)
    expect(spie.logErrore.mock.calls.map((c) => (c[0] as { evento?: string }).evento)).toContain('oblio_chiavi_verifica')
  })

  it('lettura di `parents` rifiutata → il documento NON si usa e il file NON esce; `lettureFallite` sale di uno', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { documento_path: DOC_PROPRIO })]
    d.enrollment_submissions = [domanda('es-1', { documento_path: DOC_PROPRIO })]

    const { r, archivio: arch } = await oblio(
      d,
      { id: DOPPIONE, codice_fiscale: null, fiscal_code: null, documento_path: DOC_PROPRIO },
      { [BUCKET_ISCRIZIONI]: [DOC_PROPRIO] },
      { 'parents:select': { code: '42501' } },
    )

    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_PROPRIO)).toBe(true)
    expect(r.lettureFallite).toBe(1)
  })

  it('un CF con caratteri che non sono lettere o cifre non entra in nessun filtro: chiave non usata, `lettureFallite` +1', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { codice_fiscale: 'DPR%BMB' })]
    const { r } = await oblio(d, { id: DOPPIONE, codice_fiscale: 'DPR%BMB', fiscal_code: null, documento_path: null })
    expect(d.riconciliazione_movimenti[0].causale).toBe(`RETTA OTTOBRE ${CF}`)
    expect(d.cassa_movimenti[0].descrizione).toBe(`QUOTA ${CF}`)
    expect(r.lettureFallite).toBe(1)
  })
})

// =============================================================================
// IL GENITORE E I RAMI DELLA DOMANDA (seconda revisione, 2026-10-09).
//
// Misurato in produzione: tre genitori vivi hanno in `parents.fiscal_code` il codice fiscale
// del PROPRIO figlio (due di quei figli iscritti, e quei codici compaiono come figlio in una
// domanda); e tre domande hanno una voce ADULTO con il codice fiscale di un alunno vivo.
// `obliaIscrizioni` cercava e ripuliva TUTTI E DUE i rami della domanda: l'oblio di quel
// genitore avrebbe cancellato identità, allergie e note mediche del figlio iscritto, e ne
// avrebbe tolto il documento. La ricerca ora è per RAMO: un alunno è un `children`, un
// genitore è un `adults`.
// =============================================================================

const genitore = (id: string, extra: Record<string, unknown> = {}) => ({
  id, first_name: 'Genitore', last_name: 'DiProva', fiscal_code: null, documento_path: null,
  auth_user_id: null, anonimizzato_il: null, ...extra,
})

const domandaFamiglia = (id: string, figlio: Record<string, unknown>, adulto: Record<string, unknown>) => ({
  id,
  data: {
    children: [{ nome: 'Bambino', cognome: 'DiProva', ...figlio }],
    adults: [{ ruolo: 'madre', first_name: 'Genitore', last_name: 'DiProva', ...adulto }],
  },
  consents_log: null,
})

async function oblioGenitore(d: DBFinto, parentId: string, file: Record<string, string[]> = {}, errori: OpzioniFinto['errori'] = {}) {
  const client = creaFintoSupabase(d, [], { rpc: RPC, errori })
  const arch = archivio(file)
  ;(client as unknown as { storage: unknown }).storage = arch.storage
  const r = await anonimizzaParent(client as SupabaseClient, parentId, AT, 'test')
  return { r, archivio: arch.a }
}

const ramo = (d: DBFinto, nome: 'children' | 'adults') =>
  (d.enrollment_submissions[0].data as Record<string, Record<string, unknown>[]>)[nome][0]

describe('anonimizzaParent — il genitore che porta il codice fiscale del figlio', () => {
  it('CF del genitore = CF del figlio iscritto → la voce del figlio e il suo documento NON si toccano', async () => {
    const d = dbBase()
    d.alunni = [alunno(VERO, { codice_fiscale: CF, documento_path: DOC_PROPRIO })]
    d.parents = [genitore(GENITORE, { fiscal_code: CF })]
    d.enrollment_submissions = [domandaFamiglia('es-1', { codice_fiscale: CF, documento_path: DOC_PROPRIO, allergie: 'ALLERGIA DI PROVA' }, { fiscal_code: CF_ADULTO })]
    const primaDomanda = structuredClone(d.enrollment_submissions[0])

    const { r, archivio: arch } = await oblioGenitore(d, GENITORE, { [BUCKET_ISCRIZIONI]: [DOC_PROPRIO] })

    expect(d.enrollment_submissions[0], 'l’oblio del genitore ha ripulito la voce del figlio iscritto').toEqual(primaDomanda)
    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_PROPRIO), 'il documento del figlio è uscito dall’archivio').toBe(true)
    expect(r.chiaviCondiviseEscluse.codiceFiscale).toBe(1)
    // La riga del genitore si azzera comunque.
    expect(d.parents[0].fiscal_code).toBeNull()
    expect(esclusioni()).toEqual([expect.objectContaining({ entita_tipo: 'parents', entita_id: GENITORE, tipo: 'codice_fiscale' })])
    expect(JSON.stringify([spie.logEvento.mock.calls, spie.logErrore.mock.calls])).not.toContain(CF)
  })

  it('anche senza nessuna scheda alunno con quel CF, la voce `children` non si tocca: il genitore cerca solo fra gli adulti', async () => {
    const d = dbBase()
    d.parents = [genitore(GENITORE, { fiscal_code: CF })]
    d.enrollment_submissions = [domandaFamiglia('es-1', { codice_fiscale: CF, documento_path: DOC_PROPRIO }, { fiscal_code: CF_ADULTO })]
    const figlioPrima = structuredClone(ramo(d, 'children'))

    const { archivio: arch } = await oblioGenitore(d, GENITORE, { [BUCKET_ISCRIZIONI]: [DOC_PROPRIO] })

    expect(ramo(d, 'children')).toEqual(figlioPrima)
    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_PROPRIO)).toBe(true)
  })

  it('CF del genitore uguale a quello di un ALTRO genitore vivo → chiave non usata', async () => {
    const d = dbBase()
    d.parents = [genitore(GENITORE, { fiscal_code: CF_ADULTO }), genitore(ALTRO_GENITORE, { fiscal_code: CF_ADULTO })]
    d.enrollment_submissions = [domandaFamiglia('es-1', { codice_fiscale: CF }, { fiscal_code: CF_ADULTO, email: 'adulto@example.invalid' })]
    const primaDomanda = structuredClone(d.enrollment_submissions[0])

    const { r } = await oblioGenitore(d, GENITORE)

    expect(d.enrollment_submissions[0]).toEqual(primaDomanda)
    expect(r.chiaviCondiviseEscluse.codiceFiscale).toBe(1)
  })

  it('documento del genitore usato anche da un alunno vivo → il file NON esce', async () => {
    const d = dbBase()
    d.alunni = [alunno(VERO, { documento_path: DOC_COMUNE })]
    d.parents = [genitore(GENITORE, { documento_path: DOC_COMUNE })]

    const { r, archivio: arch } = await oblioGenitore(d, GENITORE, { [BUCKET_ISCRIZIONI]: [DOC_COMUNE] })

    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_COMUNE)).toBe(true)
    expect(r.chiaviCondiviseEscluse.documento).toBe(1)
  })

  it('caso normale: un genitore senza condivisioni → la SUA voce adulto si ripulisce e il documento esce, come prima', async () => {
    const d = dbBase()
    d.alunni = [alunno(VERO, { codice_fiscale: CF })]
    d.parents = [genitore(GENITORE, { fiscal_code: CF_ADULTO, documento_path: DOC_ADULTO })]
    d.enrollment_submissions = [domandaFamiglia('es-1', { codice_fiscale: CF }, { fiscal_code: CF_ADULTO, documento_path: DOC_ADULTO, email: 'adulto@example.invalid' })]
    const figlioPrima = structuredClone(ramo(d, 'children'))

    const { r, archivio: arch } = await oblioGenitore(d, GENITORE, { [BUCKET_ISCRIZIONI]: [DOC_ADULTO] })

    expect(ramo(d, 'adults')).toMatchObject({ fiscal_code: null, email: null, anonimizzato_il: AT, ruolo: 'madre' })
    expect(ramo(d, 'children'), 'controllo positivo: il figlio resta').toEqual(figlioPrima)
    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_ADULTO)).toBe(false)
    expect(r.iscrizioniScrubbate).toBe(1)
    expect(r.chiaviCondiviseEscluse).toEqual({ codiceFiscale: 0, documento: 0 })
    expect(r.lettureFallite).toBe(0)
  })
})

describe('anonimizzaAlunno — la voce ADULTO non è sua', () => {
  it('una voce adulto con il CF dell’alunno (refuso della famiglia) non si tocca', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { codice_fiscale: CF })]
    d.enrollment_submissions = [domandaFamiglia('es-1', { codice_fiscale: 'ALTRBM20A01Z999Y' }, { fiscal_code: CF, email: 'adulto@example.invalid' })]
    const primaDomanda = structuredClone(d.enrollment_submissions[0])

    const { r } = await oblio(d, { id: DOPPIONE, codice_fiscale: CF, fiscal_code: null, documento_path: null })

    expect(d.enrollment_submissions[0], 'l’oblio di un alunno ha ripulito un ADULTO').toEqual(primaDomanda)
    expect(r.iscrizioniScrubbate).toBe(0)
  })
})

describe('anonimizzaAlunno — il documento non aggira l’esclusione del codice fiscale', () => {
  it('CF condiviso + documento PROPRIO nominato dalla domanda condivisa → domanda intatta, file non rimosso', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { codice_fiscale: CF, documento_path: DOC_PROPRIO }), alunno(VERO, { codice_fiscale: CF })]
    d.enrollment_submissions = [domanda('es-1', { codice_fiscale: CF, documento_path: DOC_PROPRIO, allergie: 'ALLERGIA DI PROVA' })]
    const primaDomanda = structuredClone(d.enrollment_submissions[0])

    const { r, archivio: arch } = await oblio(
      d,
      { id: DOPPIONE, codice_fiscale: CF, fiscal_code: null, documento_path: DOC_PROPRIO },
      { [BUCKET_ISCRIZIONI]: [DOC_PROPRIO] },
    )

    expect(d.enrollment_submissions[0], 'il documento ha riaperto la strada che il CF aveva chiuso').toEqual(primaDomanda)
    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_PROPRIO)).toBe(true)
    expect(r.chiaviCondiviseEscluse).toEqual({ codiceFiscale: 1, documento: 1 })
  })

  it('verifica del CF fallita + documento proprio → anche il documento resta fuori', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { codice_fiscale: CF, documento_path: DOC_PROPRIO })]
    d.enrollment_submissions = [domanda('es-1', { codice_fiscale: CF, documento_path: DOC_PROPRIO })]
    const primaDomanda = structuredClone(d.enrollment_submissions[0])

    const { r, archivio: arch } = await oblio(
      d,
      { id: DOPPIONE, codice_fiscale: CF, fiscal_code: null, documento_path: DOC_PROPRIO },
      { [BUCKET_ISCRIZIONI]: [DOC_PROPRIO] },
      { 'alunni:select': { code: '42501' } },
    )

    expect(d.enrollment_submissions[0]).toEqual(primaDomanda)
    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_PROPRIO)).toBe(true)
    expect(r.lettureFallite).toBe(1)
  })
})

describe('scrubDomandaIscrizione — ramo e codici fiscali protetti', () => {
  const dom = () => ({
    children: [{ nome: 'Bambino', codice_fiscale: CF, documento_path: DOC_PROPRIO }],
    adults: [{ first_name: 'Genitore', fiscal_code: CF, documento_path: DOC_ADULTO }],
  })

  it('con `ramo` si guarda solo quel ramo', () => {
    const r = scrubDomandaIscrizione(dom(), { codiciFiscali: [CF], ramo: 'adults' }, AT)
    const out = r.data as ReturnType<typeof dom>
    expect(out.adults[0].first_name).toBeNull()
    expect(out.children[0].nome).toBe('Bambino')
    expect(r.documenti).toEqual([DOC_ADULTO])
  })

  it('una persona con un CF PROTETTO non si ripulisce mai, anche se corrisponde il documento', () => {
    const r = scrubDomandaIscrizione(dom(), { documentoPaths: [DOC_PROPRIO], codiciFiscaliProtetti: [CF.toLowerCase()], ramo: 'children' }, AT)
    expect(r.personeScrubbate).toBe(0)
    expect(r.data).toEqual(dom())
  })
})

describe('anonimizzaAlunno — il filtro usa la stessa stringa che si è validata', () => {
  it('un CF salvato in minuscolo arriva ai filtri di bonifici e cassa normalizzato', async () => {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { codice_fiscale: CF.toLowerCase() })]
    const client = creaFintoSupabase(d, [], { rpc: RPC })
    ;(client as unknown as { storage: unknown }).storage = archivio({}).storage
    const visti: string[] = []
    const avvolto = new Proxy(client, {
      get(t, k) {
        if (k !== 'from') return Reflect.get(t, k, t) as unknown
        return (tabella: string) => {
          const b = t.from(tabella) as unknown as Record<string, unknown>
          if (tabella !== 'riconciliazione_movimenti') return b
          const proxy: object = new Proxy(b, {
            get(bb, kk) {
              const v = Reflect.get(bb, kk, bb) as unknown
              if (typeof v !== 'function') return v
              return (...a: unknown[]) => {
                if (kk === 'ilike') visti.push(String(a[1]))
                const e = (v as (...x: unknown[]) => unknown).apply(bb, a)
                return e === bb ? proxy : e
              }
            },
          })
          return proxy
        }
      },
    }) as SupabaseClient

    await anonimizzaAlunno(avvolto, { id: DOPPIONE, codice_fiscale: CF.toLowerCase(), fiscal_code: null, documento_path: null } as never, AT, 'test')

    expect(visti).toEqual([`%${CF}%`])
  })
})

// =============================================================================
// LA SCHEDA SENZA CODICE FISCALE (terza revisione, 2026-10-09).
//
// Misurato in produzione: tre schede vive SENZA codice fiscale, non iscritte, ognuna con lo
// stesso nome di un alunno iscritto; il loro `documento_path` compare in una domanda nella voce
// `children` che porta il codice fiscale di quell'alunno iscritto (la cui scheda punta a un
// documento diverso). Nessun'altra SCHEDA ha quel percorso, e il soggetto non ha un codice da
// confrontare: la guardia lo dava per «suo», e la pulizia — che tocca una persona anche solo per
// documento — avrebbe ripulito la voce del bambino iscritto e tolto il suo file.
// =============================================================================

describe('anonimizzaAlunno — il documento nominato dalla voce di un ALTRO bambino', () => {
  const CF_VERO = 'VRBMBN20A01Z999W'
  const DOC_VERO = 'iscrizioni/uuid-documento-del-vero.pdf'

  function scenario(): DBFinto {
    const d = dbBase()
    d.alunni = [alunno(DOPPIONE, { documento_path: DOC_PROPRIO }), alunno(VERO, { codice_fiscale: CF_VERO, documento_path: DOC_VERO })]
    d.enrollment_submissions = [domanda('es-1', { codice_fiscale: CF_VERO, documento_path: DOC_PROPRIO, allergie: 'ALLERGIA DI PROVA' })]
    return d
  }
  const soggetto = { id: DOPPIONE, codice_fiscale: null, fiscal_code: null, documento_path: DOC_PROPRIO }

  it('doppione senza CF, documento nella voce di un bambino VIVO con un altro CF → voce intatta, file resta, `documento: 1`', async () => {
    const d = scenario()
    const primaDomanda = structuredClone(d.enrollment_submissions[0])

    const { r, archivio: arch } = await oblio(d, soggetto, { [BUCKET_ISCRIZIONI]: [DOC_PROPRIO] })

    expect(d.enrollment_submissions[0], 'la voce del bambino iscritto è stata ripulita per il documento del doppione').toEqual(primaDomanda)
    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_PROPRIO), 'il file nominato dalla domanda del bambino vero è uscito').toBe(true)
    expect(r.chiaviCondiviseEscluse).toEqual({ codiceFiscale: 0, documento: 1 })
    expect(r.lettureFallite).toBe(0)
    expect(d.alunni.find((a) => a.id === DOPPIONE)!.documento_path, 'la riga del doppione si azzera comunque').toBeNull()
    expect(JSON.stringify([spie.logEvento.mock.calls, spie.logErrore.mock.calls])).not.toContain(CF_VERO)
  })

  it('variante: il CF della voce non è di nessuna persona viva (refuso nella SUA domanda) → la voce si ripulisce e il file esce', async () => {
    const d = scenario()
    d.alunni = d.alunni.filter((a) => a.id !== VERO)

    const { r, archivio: arch } = await oblio(d, soggetto, { [BUCKET_ISCRIZIONI]: [DOC_PROPRIO] })

    expect(ramo(d, 'children')).toMatchObject({ codice_fiscale: null, allergie: null, anonimizzato_il: AT })
    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_PROPRIO)).toBe(false)
    expect(r.iscrizioniScrubbate).toBe(1)
    expect(r.chiaviCondiviseEscluse).toEqual({ codiceFiscale: 0, documento: 0 })
  })

  it('lettura delle domande rifiutata → documento escluso, file resta, `lettureFallite` +1', async () => {
    const d = scenario()
    d.alunni = d.alunni.filter((a) => a.id !== VERO)
    const primaDomanda = structuredClone(d.enrollment_submissions[0])

    const { r, archivio: arch } = await oblio(d, soggetto, { [BUCKET_ISCRIZIONI]: [DOC_PROPRIO] }, {
      'enrollment_submissions:select': { code: '42501' },
    })

    expect(d.enrollment_submissions[0]).toEqual(primaDomanda)
    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_PROPRIO)).toBe(true)
    // Una sola lettura fallita da contare: quella della verifica. La ricerca delle domande dopo
    // non parte nemmeno, perché senza chiavi non c'è niente da cercare.
    expect(r.lettureFallite).toBe(1)
  })
})

describe('anonimizzaParent — il documento nominato dalla voce di un ALTRO adulto', () => {
  it('genitore senza CF, documento nella voce adulto di un altro genitore VIVO → voce intatta, file resta', async () => {
    const d = dbBase()
    d.parents = [genitore(GENITORE, { documento_path: DOC_ADULTO }), genitore(ALTRO_GENITORE, { fiscal_code: CF_ADULTO })]
    d.enrollment_submissions = [domandaFamiglia('es-1', { codice_fiscale: CF }, { fiscal_code: CF_ADULTO, documento_path: DOC_ADULTO, email: 'adulto@example.invalid' })]
    const primaDomanda = structuredClone(d.enrollment_submissions[0])

    const { r, archivio: arch } = await oblioGenitore(d, GENITORE, { [BUCKET_ISCRIZIONI]: [DOC_ADULTO] })

    expect(d.enrollment_submissions[0]).toEqual(primaDomanda)
    expect(arch.get(BUCKET_ISCRIZIONI)!.has(DOC_ADULTO)).toBe(true)
    expect(r.chiaviCondiviseEscluse.documento).toBe(1)
  })
})
