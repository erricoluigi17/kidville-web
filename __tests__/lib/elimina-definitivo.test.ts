// __tests__/lib/elimina-definitivo.test.ts
import { describe, it, expect } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { contaPerEliminazione, scelteDisponibili } from '@/lib/alunni/elimina-definitivo'

const AL = '10000000-0000-4000-8000-000000000001'
const FRATELLO = '10000000-0000-4000-8000-000000000002'

function db(extra: Partial<DBFinto> = {}): DBFinto {
  return {
    alunni: [{ id: AL, stato: 'ritirato', section_id: null }],
    presenze: [{ id: 'pr-1', alunno_id: AL }],
    eventi_diario: [],
    student_parents: [{ student_id: AL, parent_id: 'p-1' }],
    pagamenti: [],
    ricevute_emesse: [],
    fatture_emesse: [],
    riconciliazione_movimenti: [],
    incassi: [],
    valutazioni: [],
    pagelle: [],
    scrutinio_giudizi: [],
    scrutinio_comportamento: [],
    note_disciplinari: [],
    certificati_competenze: [],
    certificati_medici: [],
    student_documents: [],
    galleria_media_v2: [],
    news_posts: [],
    chat_threads: [],
    chat_messages: [],
    ...extra,
  }
}

describe('scelteDisponibili — la tabella delle decisioni del titolare', () => {
  it('nessun pagamento e nessun registro: solo «elimina»', () => {
    expect(scelteDisponibili({ pagamenti: 0, pagamenti_bloccati: 0, registro_primaria: false })).toEqual({
      scelte: { elimina: true, elimina_con_pagamenti: false, anonimizza: false },
      motivo: null,
    })
  })

  it('pagamenti cancellabili: «cancella anche i pagamenti» oppure «anonimizza»', () => {
    expect(scelteDisponibili({ pagamenti: 2, pagamenti_bloccati: 0, registro_primaria: false })).toEqual({
      scelte: { elimina: false, elimina_con_pagamenti: true, anonimizza: true },
      motivo: 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI',
    })
  })

  it('un pagamento bloccato: resta solo «anonimizza»', () => {
    expect(scelteDisponibili({ pagamenti: 2, pagamenti_bloccati: 1, registro_primaria: false })).toEqual({
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: true },
      motivo: 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI',
    })
  })

  it('il registro della primaria vince su tutto: nessuna scelta, nemmeno anonimizzare', () => {
    expect(scelteDisponibili({ pagamenti: 2, pagamenti_bloccati: 0, registro_primaria: true })).toEqual({
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: false },
      motivo: 'REGISTRO_PRIMARIA_DA_CONSERVARE',
    })
  })
})

describe('contaPerEliminazione', () => {
  it('conta presenze, legami e pagamenti, e dice se il registro c’è', async () => {
    const esito = await contaPerEliminazione(creaFintoSupabase(db()) as never, AL, 'test')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.conteggi).toMatchObject({
      presenze: 1,
      diario: 0,
      legami_genitori: 1,
      pagamenti: 0,
      pagamenti_bloccati: 0,
      registro_primaria: false,
    })
  })

  it('un pagamento con incasso è BLOCCATO, uno senza no', async () => {
    const supabase = creaFintoSupabase(
      db({
        pagamenti: [
          { id: 'pag-1', alunno_id: AL, parent_payment_id: null },
          { id: 'pag-2', alunno_id: AL, parent_payment_id: null },
        ],
        incassi: [{ id: 'inc-1', pagamento_id: 'pag-1' }],
      }),
    )
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok && esito.conteggi).toMatchObject({ pagamenti: 2, pagamenti_bloccati: 1 })
  })

  it('la quota di un fratello appesa a un suo pagamento lo blocca', async () => {
    const supabase = creaFintoSupabase(
      db({
        pagamenti: [
          { id: 'pag-1', alunno_id: AL, parent_payment_id: null },
          { id: 'pag-f', alunno_id: FRATELLO, parent_payment_id: 'pag-1' },
        ],
      }),
    )
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok && esito.conteggi).toMatchObject({ pagamenti: 1, pagamenti_bloccati: 1 })
  })

  it('una ricevuta senza pagamento conta come contabilità bloccata', async () => {
    const supabase = creaFintoSupabase(db({ ricevute_emesse: [{ id: 'r-1', alunno_id: AL, pagamento_id: null }] }))
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok && esito.conteggi).toMatchObject({ pagamenti_bloccati: 1 })
  })

  it('una lettura fallita non diventa uno zero: ok=false', async () => {
    const supabase = creaFintoSupabase(db(), [], { errori: { presenze: { code: '57014', message: 'timeout' } } })
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok).toBe(false)
  })

  it('un conteggio ASSENTE (HEAD con 404: error null, count null) non diventa uno zero', async () => {
    // Così risponde postgrest-js a una HEAD su una risorsa che dà 404: nessun
    // errore, nessun conteggio. Il finto restituisce sempre un numero, quindi il
    // caso si costruisce avvolgendo `from` per la sola tabella `presenze`.
    const vero = creaFintoSupabase(db()) as unknown as { from: (t: string) => unknown }
    const supabase = {
      ...vero,
      from: (t: string) =>
        t === 'presenze'
          ? { select: () => ({ eq: async () => ({ data: null, error: null, count: null }) }) }
          : vero.from(t),
    }
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok).toBe(false)
  })
})
