import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Il contratto HTTP della coda fatture (nucleo §3): gli schemi dei corpi, le funzioni pure
 * della GET e la sveglia. Gli uuid sono finti: il repository è pubblico.
 */

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const actual = await originale<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  CODICI_ERRORE_CODA,
  ESITI_CODA,
  RITMO_ORARIO_STIMA,
  STATI_ATTIVI,
  TETTO_VOCI_CODA,
  codaAssente,
  senzaDoppioni,
  stimaFineCoda,
  svegliaCoda,
  voceRpc,
  zCorpoAccoda,
  zCorpoAzioni,
  zCorpoSospensione,
  zRispostaAccoda,
} from '@/lib/fatture-coda/api'
import { SOGLIA_ORARIA_APP } from '@/lib/pagamenti/tetto-orario-aruba'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

beforeEach(() => {
  vi.clearAllMocks()
})

describe('zCorpoAccoda — da 1 a 500 voci', () => {
  const voci = (n: number) => Array.from({ length: n }, (_, i) => ({ pagamento_id: uuid(i + 1) }))

  it('rifiuta zero voci e 501 voci, accetta 1 e 500', () => {
    expect(zCorpoAccoda.safeParse({ voci: [] }).success).toBe(false)
    expect(zCorpoAccoda.safeParse({ voci: voci(1) }).success).toBe(true)
    expect(zCorpoAccoda.safeParse({ voci: voci(TETTO_VOCI_CODA) }).success).toBe(true)
    expect(zCorpoAccoda.safeParse({ voci: voci(TETTO_VOCI_CODA + 1) }).success).toBe(false)
    expect(TETTO_VOCI_CODA).toBe(500)
  })

  it('pretende un uuid come pagamento_id', () => {
    expect(zCorpoAccoda.safeParse({ voci: [{ pagamento_id: 'non-un-uuid' }] }).success).toBe(false)
  })

  it('accetta SOLO il ramo adult dell’intestatario: niente anagrafica digitata in coda', () => {
    const adult = { pagamento_id: uuid(1), intestatario: { tipo: 'adult', adult_id: uuid(9) } }
    expect(zCorpoAccoda.safeParse({ voci: [adult] }).success).toBe(true)
    const persona = {
      pagamento_id: uuid(1),
      intestatario: { tipo: 'persona', nome: 'X', cognome: 'Y', codice_fiscale: 'Z' },
    }
    expect(zCorpoAccoda.safeParse({ voci: [persona] }).success).toBe(false)
  })

  it('causale oltre i 1000 caratteri rifiutata; null ammesso', () => {
    expect(zCorpoAccoda.safeParse({ voci: [{ pagamento_id: uuid(1), causale: 'a'.repeat(1001) }] }).success).toBe(false)
    expect(zCorpoAccoda.safeParse({ voci: [{ pagamento_id: uuid(1), causale: 'a'.repeat(1000) }] }).success).toBe(true)
    expect(zCorpoAccoda.safeParse({ voci: [{ pagamento_id: uuid(1), causale: null }] }).success).toBe(true)
  })

  it('urgente deve essere booleano', () => {
    expect(zCorpoAccoda.safeParse({ voci: voci(1), urgente: 'sì' }).success).toBe(false)
    expect(zCorpoAccoda.safeParse({ voci: voci(1), urgente: true }).success).toBe(true)
  })
})

describe('zCorpoAzioni e zCorpoSospensione', () => {
  it('azione ∈ {togli, rimetti}, ids da 1 a 500 uuid', () => {
    expect(zCorpoAzioni.safeParse({ azione: 'togli', ids: [uuid(1)] }).success).toBe(true)
    expect(zCorpoAzioni.safeParse({ azione: 'rimetti', ids: [uuid(1)] }).success).toBe(true)
    expect(zCorpoAzioni.safeParse({ azione: 'cancella', ids: [uuid(1)] }).success).toBe(false)
    expect(zCorpoAzioni.safeParse({ azione: 'togli', ids: [] }).success).toBe(false)
    expect(zCorpoAzioni.safeParse({ azione: 'togli', ids: ['x'] }).success).toBe(false)
    const troppi = Array.from({ length: 501 }, (_, i) => uuid(i + 1))
    expect(zCorpoAzioni.safeParse({ azione: 'togli', ids: troppi }).success).toBe(false)
    expect(zCorpoAzioni.safeParse({ azione: 'togli', ids: troppi.slice(0, 500) }).success).toBe(true)
  })

  it('sospesa è un booleano obbligatorio', () => {
    expect(zCorpoSospensione.safeParse({ sospesa: true }).success).toBe(true)
    expect(zCorpoSospensione.safeParse({}).success).toBe(false)
    expect(zCorpoSospensione.safeParse({ sospesa: 'true' }).success).toBe(false)
  })
})

describe('costanti del contratto', () => {
  it('codici e stati hanno i nomi fissati dalla spec', () => {
    expect(CODICI_ERRORE_CODA.NON_DISPONIBILE).toBe('CODA_FATTURE_NON_DISPONIBILE')
    expect(CODICI_ERRORE_CODA.PAGAMENTO_NON_SALDATO).toBe('PAGAMENTO_NON_SALDATO')
    expect(ESITI_CODA).toEqual({
      EMESSA: 'emessa',
      GIA_EMESSA: 'gia_emessa',
      SCARTO_ARUBA: 'scarto_aruba',
      ESITO_INCERTO: 'esito_incerto',
    })
    expect([...STATI_ATTIVI].sort()).toEqual(['errore', 'in_coda', 'in_invio'])
  })

  it('la stima usa lo stesso ritmo del lavoratore (50/ora)', () => {
    expect(RITMO_ORARIO_STIMA).toBe(SOGLIA_ORARIA_APP)
    expect(RITMO_ORARIO_STIMA).toBe(50)
  })

  it('zRispostaAccoda legge la forma della RPC', () => {
    expect(zRispostaAccoda.safeParse({ gruppo_id: uuid(1), accodate: 2, gia_in_coda: [uuid(3)] }).success).toBe(true)
    expect(zRispostaAccoda.safeParse({ accodate: 2 }).success).toBe(false)
  })
})

describe('codaAssente — solo tabella o funzione mancanti', () => {
  it.each(['42P01', 'PGRST205', '42883', 'PGRST202'])('%s ⇒ assente', (code) => {
    expect(codaAssente({ code })).toBe(true)
  })
  it.each(['42703', 'PGRST204', '23505', '57014'])('%s ⇒ guasto vero, non degradazione', (code) => {
    expect(codaAssente({ code })).toBe(false)
  })
  it('valori non oggetto ⇒ false', () => {
    expect(codaAssente(null)).toBe(false)
    expect(codaAssente('42P01')).toBe(false)
  })
})

describe('stimaFineCoda — 50 l’ora sulle voci in attesa', () => {
  const adesso = new Date('2026-09-23T08:00:00.000Z')

  it('niente in attesa ⇒ null', () => {
    expect(stimaFineCoda(0, { adesso, sospesa: false, pausaFinoA: null })).toBeNull()
  })

  it('coda sospesa ⇒ null', () => {
    expect(stimaFineCoda(10, { adesso, sospesa: true, pausaFinoA: null })).toBeNull()
  })

  it('100 in attesa ⇒ due ore da adesso', () => {
    expect(stimaFineCoda(100, { adesso, sospesa: false, pausaFinoA: null })).toBe('2026-09-23T10:00:00.000Z')
  })

  it('25 in attesa ⇒ mezz’ora', () => {
    expect(stimaFineCoda(25, { adesso, sospesa: false, pausaFinoA: null })).toBe('2026-09-23T08:30:00.000Z')
  })

  it('pausa in corso ⇒ si parte dalla fine della pausa', () => {
    expect(stimaFineCoda(50, { adesso, sospesa: false, pausaFinoA: '2026-09-23T09:00:00.000Z' })).toBe(
      '2026-09-23T10:00:00.000Z',
    )
  })

  it('pausa già scaduta ⇒ si parte da adesso', () => {
    expect(stimaFineCoda(50, { adesso, sospesa: false, pausaFinoA: '2026-09-23T07:00:00.000Z' })).toBe(
      '2026-09-23T09:00:00.000Z',
    )
  })
})

describe('senzaDoppioni e voceRpc', () => {
  it('toglie i doppioni tenendo il primo, anche con maiuscole diverse', () => {
    const a = uuid(1)
    const b = uuid(2)
    expect(senzaDoppioni([a, b, a.toUpperCase()], (x) => x)).toEqual([a, b])
  })

  it('porta la voce nella forma di p_voci, con ordine di selezione e default', () => {
    expect(voceRpc({ pagamento_id: uuid(1) }, 3)).toEqual({
      pagamento_id: uuid(1),
      intestatario_scelto: null,
      conferma_proposta: false,
      causale_manuale: null,
      ordine_selezione: 3,
    })
    expect(
      voceRpc(
        {
          pagamento_id: uuid(1),
          intestatario: { tipo: 'adult', adult_id: uuid(9) },
          conferma_proposta: true,
          causale: 'Retta settembre',
        },
        0,
      ),
    ).toEqual({
      pagamento_id: uuid(1),
      intestatario_scelto: { tipo: 'adult', adult_id: uuid(9) },
      conferma_proposta: true,
      causale_manuale: 'Retta settembre',
      ordine_selezione: 0,
    })
  })

  it('una causale vuota (dopo il trim dello schema) non diventa causale manuale', () => {
    const letta = zCorpoAccoda.parse({ voci: [{ pagamento_id: uuid(1), causale: '   ' }] })
    expect(voceRpc(letta.voci[0], 0).causale_manuale).toBeNull()
  })
})

describe('svegliaCoda — la RPC parte davvero, e il suo esito si logga', () => {
  function sbCon(risposta: { error: unknown }) {
    const rpc = vi.fn(() => Promise.resolve({ data: null, ...risposta }))
    return { sb: { rpc } as unknown as SupabaseClient, rpc }
  }

  it('chiama fatture_coda_tick_http senza aspettarla, e logga il successo', async () => {
    const { sb, rpc } = sbCon({ error: null })
    svegliaCoda(sb, 'prova')
    // Fuori da una richiesta `after` non c'è: la chiamata parte subito.
    expect(rpc).toHaveBeenCalledWith('fatture_coda_tick_http')
    await vi.waitFor(() =>
      expect(h.logEvento).toHaveBeenCalledWith('fattura', 'info', { operazione: 'prova', esito: 'sveglia-inviata' }),
    )
  })

  it('un errore della sveglia è un warn, non un’eccezione', async () => {
    const { sb } = sbCon({ error: { code: 'XX000', message: 'boom' } })
    expect(() => svegliaCoda(sb, 'prova')).not.toThrow()
    await vi.waitFor(() =>
      expect(h.logEvento).toHaveBeenCalledWith(
        'fattura',
        'warn',
        { operazione: 'prova', esito: 'sveglia-fallita' },
        expect.objectContaining({ code: 'XX000' }),
      ),
    )
  })
})
