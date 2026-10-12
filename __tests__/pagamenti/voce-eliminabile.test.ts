import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { creaFintoSupabase, type DBFinto, type Riga } from '../fixtures/finto-supabase'

/**
 * Le guardie dell'eliminazione di una voce, scritte una volta sola (2026-10-12). Le usano la
 * DELETE della voce, la GET «eliminabile» e la sostituzione di Rateizza. Ogni caso guarda il
 * VERDETTO e, dove conta, che una lettura guasta non diventi via libera. Dati sintetici.
 */

vi.mock('@/lib/logging/logger', async (orig) => ({ ...(await orig<object>()), logEvento: vi.fn(), logErrore: vi.fn() }))

import { controllaVoceEliminabile } from '@/lib/pagamenti/voce-eliminabile'

const ALU = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const PAG = 'b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb'
const RATA = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const RATA2 = 'b3b3b3b3-3333-4333-8333-bbbbbbbbbbbb'
const GUASTO = { code: '57014', message: 'canceling statement due to statement timeout' }

let db: DBFinto
const voce = (extra: Riga = {}): Riga => ({
  id: PAG, alunno_id: ALU, scuola_id: SEDE_A, descrizione: 'Gita finta', importo: 30, importo_pagato: 0,
  stato: 'da_pagare', tipo: 'singolo', parent_payment_id: null, ...extra,
})
const sb = (errori?: Record<string, { code: string; message: string }>) =>
  creaFintoSupabase(db, [], errori ? { errori } : {}) as unknown as SupabaseClient
const controlla = (s: SupabaseClient, perSostituzione = false) =>
  controllaVoceEliminabile(s, PAG, { sedi: [SEDE_A], perSostituzione, operazione: 'test' })
const ricarica = (saldo: number) => {
  db.mensa_ticket_movimenti = [{ id: 'm1', pagamento_id: PAG, alunno_id: ALU, tipo: 'ricarica', delta: 10 }]
  db.ticket_mensa = [{ alunno_id: ALU, saldo_ticket: saldo }]
}

beforeEach(() => {
  db = {
    pagamenti: [], incassi: [], fatture_emesse: [], fatture_coda: [],
    divise_ordini: [], mensa_ticket_movimenti: [], ticket_mensa: [],
  } as DBFinto
})

describe('controllaVoceEliminabile · i verdetti', () => {
  it('voce pulita → eliminabile, famiglia = sé stessa, 0 rate, 0 ticket', async () => {
    db.pagamenti = [voce()]
    expect(await controlla(sb())).toMatchObject({ ok: true, famiglia: [PAG], rate: 0, ticket: 0 })
  })

  it('voce fuori dalle sedi attive → 404 (come una voce che non esiste)', async () => {
    db.pagamenti = [voce({ scuola_id: SEDE_B })]
    expect(await controlla(sb())).toMatchObject({ ok: false, stato: 404 })
  })

  it('voce inesistente → 404', async () => {
    expect(await controlla(sb())).toMatchObject({ ok: false, stato: 404 })
  })

  it('rata → 409 VOCE_RATA', async () => {
    db.pagamenti = [voce({ tipo: 'rata', parent_payment_id: RATA })]
    expect(await controlla(sb())).toMatchObject({ ok: false, stato: 409, codice: 'VOCE_RATA' })
  })

  it('padre con 2 rate pulite → eliminabile con rate = 2', async () => {
    db.pagamenti = [voce({ tipo: 'padre' }), voce({ id: RATA, tipo: 'rata', parent_payment_id: PAG }),
      voce({ id: RATA2, tipo: 'rata', parent_payment_id: PAG })]
    expect(await controlla(sb())).toMatchObject({ ok: true, rate: 2, famiglia: [PAG, RATA, RATA2] })
  })

  it('fattura emessa su una rata → 409 VOCE_FATTURATA', async () => {
    db.pagamenti = [voce({ tipo: 'padre' }), voce({ id: RATA, tipo: 'rata', parent_payment_id: PAG })]
    db.fatture_emesse = [{ id: 'f1', pagamento_id: RATA }]
    expect(await controlla(sb())).toMatchObject({ ok: false, stato: 409, codice: 'VOCE_FATTURATA' })
  })

  it('incassi stornati a zero → 409 VOCE_CON_INCASSI (anche uno storno è contabilità)', async () => {
    db.pagamenti = [voce()]
    db.incassi = [
      { id: 'i1', pagamento_id: PAG, importo: 10, transazione_id: null },
      { id: 'i2', pagamento_id: PAG, importo: -10, transazione_id: null },
    ]
    expect(await controlla(sb())).toMatchObject({ ok: false, codice: 'VOCE_CON_INCASSI' })
  })

  it('incasso di una transazione di famiglia → 409 VOCE_IN_TRANSAZIONE', async () => {
    db.pagamenti = [voce()]
    db.incassi = [{ id: 'i1', pagamento_id: PAG, importo: 10, transazione_id: 'd1d1d1d1-1111-4111-8111-dddddddddddd' }]
    expect(await controlla(sb())).toMatchObject({ ok: false, codice: 'VOCE_IN_TRANSAZIONE' })
  })

  it('coda fatture occupata → 409 VOCE_IN_CODA_FATTURE; «tolta» non trattiene', async () => {
    db.pagamenti = [voce()]
    db.fatture_coda = [{ id: 'q1', pagamento_id: PAG, stato: 'in_coda' }]
    expect(await controlla(sb())).toMatchObject({ ok: false, codice: 'VOCE_IN_CODA_FATTURE' })
    db.fatture_coda = [{ id: 'q1', pagamento_id: PAG, stato: 'tolta' }]
    expect(await controlla(sb())).toMatchObject({ ok: true })
  })

  it('ordine divise attivo → 409 ORDINE_DIVISE_ATTIVO; annullato → eliminabile', async () => {
    db.pagamenti = [voce()]
    db.divise_ordini = [{ id: 'o1', pagamento_id: PAG, stato: 'inviato' }]
    expect(await controlla(sb())).toMatchObject({ ok: false, codice: 'ORDINE_DIVISE_ATTIVO' })
    db.divise_ordini = [{ id: 'o1', pagamento_id: PAG, stato: 'annullato' }]
    expect(await controlla(sb())).toMatchObject({ ok: true })
  })

  it('ricarica con i ticket ancora tutti lì → eliminabile con ticket = 10', async () => {
    db.pagamenti = [voce()]
    ricarica(12)
    expect(await controlla(sb())).toMatchObject({ ok: true, ticket: 10 })
  })

  it('ricarica con ticket già usati → 409 TICKET_GIA_USATI', async () => {
    db.pagamenti = [voce()]
    ricarica(7)
    expect(await controlla(sb())).toMatchObject({ ok: false, codice: 'TICKET_GIA_USATI' })
  })

  it('perSostituzione: ricarica e ordine attivo NON bloccano, e ticket = 0 (il debito continua nel piano)', async () => {
    db.pagamenti = [voce()]
    db.divise_ordini = [{ id: 'o1', pagamento_id: PAG, stato: 'inviato' }]
    ricarica(0)
    expect(await controlla(sb(), true)).toMatchObject({ ok: true, ticket: 0 })
  })

  it('perSostituzione: gli incassi bloccano comunque', async () => {
    db.pagamenti = [voce()]
    db.incassi = [{ id: 'i1', pagamento_id: PAG, importo: 10, transazione_id: null }]
    expect(await controlla(sb(), true)).toMatchObject({ ok: false, codice: 'VOCE_CON_INCASSI' })
  })
})

describe('controllaVoceEliminabile · una guardia che non ha potuto guardare ferma tutto', () => {
  for (const tabella of ['pagamenti', 'incassi', 'fatture_emesse', 'fatture_coda', 'divise_ordini', 'mensa_ticket_movimenti', 'ticket_mensa']) {
    it(`🔴 ${tabella} non letta per un guasto → 500, mai via libera`, async () => {
      db.pagamenti = [voce()]
      ricarica(12)
      const e = await controlla(sb({ [`${tabella}:select`]: GUASTO }))
      expect(e.ok).toBe(false)
      expect('guasto' in e ? e.guasto.status : null).toBe(500)
    })
  }

  it('tabelle assenti sul DB non migrato (42P01) → saltano, come oggi', async () => {
    db.pagamenti = [voce()]
    const assente = { code: '42P01', message: 'relation does not exist' }
    const e = await controlla(sb({
      'fatture_emesse:select': assente, 'fatture_coda:select': assente,
      'divise_ordini:select': assente, 'mensa_ticket_movimenti:select': assente,
    }))
    expect(e).toMatchObject({ ok: true, ticket: 0 })
  })
})
