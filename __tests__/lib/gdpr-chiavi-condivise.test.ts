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

import { anonimizzaAlunno, BUCKET_ISCRIZIONI } from '@/lib/gdpr/esegui'

const DOPPIONE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const VERO = 'bbbbbbbb-0000-4000-8000-00000000000b'
// Un codice fiscale INVENTATO, con la forma di uno vero (repo pubblico: mai un CF reale).
const CF = 'DPRBMB20A01Z999X'
const DOC_COMUNE = 'iscrizioni/uuid-documento-comune.pdf'
const DOC_PROPRIO = 'iscrizioni/uuid-documento-proprio.pdf'
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
