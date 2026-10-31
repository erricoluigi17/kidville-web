import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * CRM della segreteria · la quota d'iscrizione: la logica pura (anno, etichetta, competenza, metodo, cassa
 * chiusa), la lettura del jsonb della funzione SQL e `passaQuotaInContabilita`, che non lancia mai.
 *
 * Dati di prova soltanto: gli id sono uuid inventati, nessun nome.
 */

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (...a: Parameters<typeof vero.logEvento>) => {
      h.logEvento(...a)
      return vero.logEvento(...a)
    },
  }
})

import {
  annoDellaQuota,
  competenzaDellaQuota,
  esitoPassaggioDa,
  etichettaAnno,
  giornoContantiAmmesso,
  metodoIncasso,
  passaQuotaInContabilita,
  statoDopoPassaggio,
} from '@/lib/crm/quota'

const BAMBINO = '50000000-0000-4000-8000-0000000000a1'
const AUTORE = '20000000-0000-4000-8000-0000000000aa'
const VOCE = '60000000-0000-4000-8000-000000000001'
const INCASSO = '70000000-0000-4000-8000-000000000001'

type RispostaRpc = { data: unknown; error: unknown }
const conRpc = (rpc: (nome: string, args: Record<string, unknown>) => Promise<RispostaRpc>) =>
  ({ rpc: vi.fn(rpc) }) as unknown as SupabaseClient & { rpc: ReturnType<typeof vi.fn> }

/** Le righe loggate nell'area `crm`, dalla più recente: livello, campi. */
const logCrm = () =>
  h.logEvento.mock.calls
    .filter((c) => c[0] === 'crm')
    .map((c) => ({ livello: c[1] as string, campi: c[2] as Record<string, unknown> }))

beforeEach(() => {
  h.logEvento.mockClear()
})

describe('annoDellaQuota', () => {
  it('in_corso è il primo anno dell’anno scolastico corrente, prossimo quello dopo', () => {
    expect(annoDellaQuota('in_corso', new Date('2026-10-31T10:00:00Z'))).toBe(2026)
    expect(annoDellaQuota('prossimo', new Date('2026-10-31T10:00:00Z'))).toBe(2027)
  })

  it('prima di agosto l’anno in corso è ancora il precedente', () => {
    expect(annoDellaQuota('in_corso', new Date('2026-07-15T10:00:00Z'))).toBe(2025)
    expect(annoDellaQuota('prossimo', new Date('2026-07-15T10:00:00Z'))).toBe(2026)
  })

  it('il cambio d’anno si conta a Roma: l’1 agosto alle 00:30 italiane (31 luglio 22:30 UTC) è già il nuovo anno', () => {
    expect(annoDellaQuota('in_corso', new Date('2026-07-31T21:30:00Z'))).toBe(2025)
    expect(annoDellaQuota('in_corso', new Date('2026-07-31T22:30:00Z'))).toBe(2026)
  })

  it('non_indicato non ha un anno', () => {
    expect(annoDellaQuota('non_indicato')).toBeNull()
  })
})

describe('etichetta, competenza e metodo', () => {
  it('etichettaAnno: 2027 → 2027/28, e il secolo non rompe la forma', () => {
    expect(etichettaAnno(2027)).toBe('2027/28')
    expect(etichettaAnno(2099)).toBe('2099/00')
    expect(etichettaAnno(2008)).toBe('2008/09')
  })

  it('competenzaDellaQuota è il 1° settembre dell’anno d’apertura', () => {
    expect(competenzaDellaQuota(2027)).toBe('2027-09-01')
  })

  it('metodoIncasso: la carta in contabilità è «pos», gli altri due restano', () => {
    expect(metodoIncasso('carta')).toBe('pos')
    expect(metodoIncasso('contanti')).toBe('contanti')
    expect(metodoIncasso('bonifico')).toBe('bonifico')
  })
})

describe('giornoContantiAmmesso', () => {
  const oggi = '2026-10-31'

  it('dopo il giorno dell’ultima chiusura sì, nello stesso giorno o prima no', () => {
    expect(giornoContantiAmmesso('2026-10-30', '2026-10-29T17:00:00Z', oggi)).toBe(true)
    expect(giornoContantiAmmesso('2026-10-29', '2026-10-29T17:00:00Z', oggi)).toBe(false)
    expect(giornoContantiAmmesso('2026-10-28', '2026-10-29T17:00:00Z', oggi)).toBe(false)
  })

  it('oggi è sempre ammesso, anche dopo la chiusura di oggi (soldi arrivati dopo)', () => {
    expect(giornoContantiAmmesso('2026-10-31', '2026-10-31T16:00:00Z', oggi)).toBe(true)
  })

  it('senza nessuna chiusura ogni giorno è ammesso', () => {
    expect(giornoContantiAmmesso('2026-10-20', null, oggi)).toBe(true)
  })

  it('il giorno della chiusura è quello di Roma: alle 23:30 UTC del 29 a Roma è già il 30', () => {
    expect(giornoContantiAmmesso('2026-10-30', '2026-10-29T23:30:00Z', oggi)).toBe(false)
    expect(giornoContantiAmmesso('2026-10-31', '2026-10-29T23:30:00Z', oggi)).toBe(true)
  })

  it('una chiusura che non si sa leggere chiude il giorno: meglio rifiutare che contare due volte', () => {
    expect(giornoContantiAmmesso('2026-10-30', 'non-una-data', oggi)).toBe(false)
    expect(giornoContantiAmmesso('2026-10-31', 'non-una-data', oggi)).toBe(true)
  })
})

describe('esitoPassaggioDa', () => {
  it('legge l’esito ok con la voce, l’incasso e se la voce è nuova', () => {
    expect(
      esitoPassaggioDa({ esito: 'ok', pagamento_id: VOCE, incasso_id: INCASSO, voce_nuova: true, metodo: 'contanti' }),
    ).toEqual({ esito: 'ok', pagamentoId: VOCE, incassoId: INCASSO, voceNuova: true })
  })

  it('per il bonifico l’incasso non c’è: resta nullo', () => {
    expect(esitoPassaggioDa({ esito: 'ok', pagamento_id: VOCE, incasso_id: null, voce_nuova: false })).toEqual({
      esito: 'ok',
      pagamentoId: VOCE,
      incassoId: null,
      voceNuova: false,
    })
  })

  it('legge i quattro motivi di blocco e rifiuta quelli che non conosce', () => {
    expect(esitoPassaggioDa({ esito: 'bloccata', motivo: 'gia_pagata' })).toEqual({ esito: 'bloccata', motivo: 'gia_pagata' })
    for (const motivo of ['supera_residuo', 'piu_voci', 'entrata_stornata'] as const) {
      expect(esitoPassaggioDa({ esito: 'bloccata', motivo })).toEqual({ esito: 'bloccata', motivo })
    }
    expect(esitoPassaggioDa({ esito: 'bloccata', motivo: 'boh' })).toEqual({ esito: 'errore' })
    expect(esitoPassaggioDa({ esito: 'bloccata' })).toEqual({ esito: 'errore' })
  })

  it('gia_in_contabilita porta la voce', () => {
    expect(esitoPassaggioDa({ esito: 'gia_in_contabilita', pagamento_id: VOCE })).toEqual({
      esito: 'gia_in_contabilita',
      pagamentoId: VOCE,
    })
  })

  it('gli esiti senza dati passano così come sono', () => {
    for (const esito of ['non_pronta', 'non_trovato', 'sede_diversa', 'categoria_assente'] as const) {
      expect(esitoPassaggioDa({ esito })).toEqual({ esito })
    }
  })

  it('tutto ciò che non si riconosce è «errore», mai un’eccezione', () => {
    expect(esitoPassaggioDa({ esito: 'boh' })).toEqual({ esito: 'errore' })
    expect(esitoPassaggioDa({ esito: 'ok' })).toEqual({ esito: 'errore' }) // senza la voce
    expect(esitoPassaggioDa({ esito: 'ok', pagamento_id: 42 })).toEqual({ esito: 'errore' })
    expect(esitoPassaggioDa({ esito: 'gia_in_contabilita' })).toEqual({ esito: 'errore' })
    expect(esitoPassaggioDa(null)).toEqual({ esito: 'errore' })
    expect(esitoPassaggioDa(undefined)).toEqual({ esito: 'errore' })
    expect(esitoPassaggioDa('ok')).toEqual({ esito: 'errore' })
    expect(esitoPassaggioDa(['ok'])).toEqual({ esito: 'errore' })
  })
})

describe('statoDopoPassaggio', () => {
  it('nessun passaggio = in attesa; ok = in contabilità; bloccata = bloccata; gli altri esiti non toccano lo stato', () => {
    expect(statoDopoPassaggio(null)).toBe('in_attesa')
    expect(statoDopoPassaggio({ esito: 'ok', pagamentoId: VOCE, incassoId: null, voceNuova: true })).toBe('in_contabilita')
    expect(statoDopoPassaggio({ esito: 'bloccata', motivo: 'piu_voci' })).toBe('bloccata')
    expect(statoDopoPassaggio({ esito: 'sede_diversa' })).toBe('in_attesa')
    expect(statoDopoPassaggio({ esito: 'categoria_assente' })).toBe('in_attesa')
  })
})

describe('passaQuotaInContabilita', () => {
  it('chiama crm_quota_passa con il bambino e chi esegue, e logga il successo', async () => {
    const supabase = conRpc(async () => ({
      data: { esito: 'ok', pagamento_id: VOCE, incasso_id: INCASSO, voce_nuova: true, metodo: 'contanti' },
      error: null,
    }))
    const esito = await passaQuotaInContabilita(supabase, BAMBINO, AUTORE)

    expect(esito).toEqual({ esito: 'ok', pagamentoId: VOCE, incassoId: INCASSO, voceNuova: true })
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('crm_quota_passa', { p_bambino_id: BAMBINO, p_eseguito_da: AUTORE })
    const riga = logCrm().find((r) => r.campi.esito === 'quota-in-contabilita')
    expect(riga).toBeDefined()
    expect(riga!.livello).toBe('info')
    expect(riga!.campi).toMatchObject({ entita_id: BAMBINO, pagamento_id: VOCE, voce_nuova: true })
  })

  it('senza un autore (l’import) passa nullo: la funzione scrive «sistema»', async () => {
    const supabase = conRpc(async () => ({ data: { esito: 'non_pronta' }, error: null }))
    await passaQuotaInContabilita(supabase, BAMBINO, null)
    expect(supabase.rpc).toHaveBeenCalledWith('crm_quota_passa', { p_bambino_id: BAMBINO, p_eseguito_da: null })
  })

  it('una quota bloccata è un avviso con il motivo dentro l’esito (la chiave «motivo» il logger la redige)', async () => {
    const supabase = conRpc(async () => ({ data: { esito: 'bloccata', motivo: 'gia_pagata' }, error: null }))
    const esito = await passaQuotaInContabilita(supabase, BAMBINO, AUTORE)

    expect(esito).toEqual({ esito: 'bloccata', motivo: 'gia_pagata' })
    const riga = logCrm().find((r) => String(r.campi.esito).startsWith('quota-bloccata'))
    expect(riga).toBeDefined()
    expect(riga!.livello).toBe('warn')
    expect(riga!.campi.esito).toBe('quota-bloccata:gia_pagata')
    expect(riga!.campi.entita_id).toBe(BAMBINO)
    expect(Object.keys(riga!.campi)).not.toContain('motivo')
  })

  it('«gia_in_contabilita» e «non_pronta» sono risposte normali, non guasti', async () => {
    const giaDentro = conRpc(async () => ({ data: { esito: 'gia_in_contabilita', pagamento_id: VOCE }, error: null }))
    expect(await passaQuotaInContabilita(giaDentro, BAMBINO, AUTORE)).toEqual({ esito: 'gia_in_contabilita', pagamentoId: VOCE })
    const nonPronta = conRpc(async () => ({ data: { esito: 'non_pronta' }, error: null }))
    expect(await passaQuotaInContabilita(nonPronta, BAMBINO, AUTORE)).toEqual({ esito: 'non_pronta' })
    expect(logCrm().filter((r) => r.livello === 'error')).toHaveLength(0)
  })

  it('la categoria di sistema «iscrizione» assente è un incidente di configurazione: livello error', async () => {
    const supabase = conRpc(async () => ({ data: { esito: 'categoria_assente' }, error: null }))
    expect(await passaQuotaInContabilita(supabase, BAMBINO, AUTORE)).toEqual({ esito: 'categoria_assente' })
    const riga = logCrm().find((r) => r.campi.esito === 'quota-categoria-assente')
    expect(riga?.livello).toBe('error')
  })

  it('l’alunno di un’altra sede è un avviso con la sede, mai un passaggio', async () => {
    const supabase = conRpc(async () => ({ data: { esito: 'sede_diversa' }, error: null }))
    expect(await passaQuotaInContabilita(supabase, BAMBINO, AUTORE)).toEqual({ esito: 'sede_diversa' })
    expect(logCrm().find((r) => r.campi.esito === 'quota-sede-diversa')?.livello).toBe('warn')
  })

  it.each(['PGRST202', 'PGRST205', '42P01', '42883'])(
    'la funzione o la tabella assente (%s) è «non_installato», con un avviso',
    async (code) => {
      const supabase = conRpc(async () => ({ data: null, error: { code, message: 'assente' } }))
      expect(await passaQuotaInContabilita(supabase, BAMBINO, AUTORE)).toEqual({ esito: 'non_installato' })
      const righe = logCrm()
      expect(righe.some((r) => r.livello === 'warn' && r.campi.esito === 'schema-crm-assente')).toBe(true)
      expect(righe.some((r) => r.livello === 'error')).toBe(false)
    },
  )

  it.each(['42703', 'PGRST204'])(
    'dopo la rpc un %s è un errore vero nel corpo della funzione: «errore», livello error, mai «non_installato»',
    async (code) => {
      const supabase = conRpc(async () => ({ data: null, error: { code, message: 'column "x" does not exist' } }))
      expect(await passaQuotaInContabilita(supabase, BAMBINO, AUTORE)).toEqual({ esito: 'errore' })
      const righe = logCrm()
      expect(righe.some((r) => r.livello === 'error' && r.campi.esito === 'errore')).toBe(true)
      expect(righe.some((r) => r.campi.esito === 'schema-crm-assente')).toBe(false)
    },
  )

  it('se rpc lancia con un 42703 sull’eccezione, è «errore» e non «non_installato»', async () => {
    const supabase = conRpc(async () => {
      throw Object.assign(new Error('colonna'), { code: '42703' })
    })
    await expect(passaQuotaInContabilita(supabase, BAMBINO, AUTORE)).resolves.toEqual({ esito: 'errore' })
    expect(logCrm().some((r) => r.campi.esito === 'schema-crm-assente')).toBe(false)
  })

  it('un errore del database è «errore» e resta nel log a livello error', async () => {
    const supabase = conRpc(async () => ({ data: null, error: { code: 'P0001', message: 'registra_incasso_voce non ha registrato' } }))
    expect(await passaQuotaInContabilita(supabase, BAMBINO, AUTORE)).toEqual({ esito: 'errore' })
    const riga = logCrm().find((r) => r.livello === 'error')
    expect(riga).toBeDefined()
    expect(riga!.campi.entita_id).toBe(BAMBINO)
  })

  it('se rpc LANCIA, nessuna eccezione esce: «errore» e una riga nel log', async () => {
    const supabase = conRpc(async () => {
      throw new Error('rete caduta')
    })
    await expect(passaQuotaInContabilita(supabase, BAMBINO, AUTORE)).resolves.toEqual({ esito: 'errore' })
    expect(logCrm().some((r) => r.livello === 'error')).toBe(true)
  })

  it('se rpc lancia perché la funzione manca (codice sull’eccezione), è «non_installato»', async () => {
    const supabase = conRpc(async () => {
      throw Object.assign(new Error('manca'), { code: '42883' })
    })
    await expect(passaQuotaInContabilita(supabase, BAMBINO, AUTORE)).resolves.toEqual({ esito: 'non_installato' })
  })

  it('un jsonb che non si capisce è «errore» e lascia una riga error (non un successo muto)', async () => {
    const supabase = conRpc(async () => ({ data: { esito: 'boh' }, error: null }))
    expect(await passaQuotaInContabilita(supabase, BAMBINO, AUTORE)).toEqual({ esito: 'errore' })
    expect(logCrm().some((r) => r.livello === 'error')).toBe(true)
  })

  it('nel log non entrano mai nomi né importi della famiglia: solo id, esiti e booleani', async () => {
    const supabase = conRpc(async () => ({
      data: { esito: 'ok', pagamento_id: VOCE, incasso_id: INCASSO, voce_nuova: false },
      error: null,
    }))
    await passaQuotaInContabilita(supabase, BAMBINO, AUTORE)
    for (const r of logCrm()) {
      for (const chiave of Object.keys(r.campi)) {
        expect(['operazione', 'esito', 'entita_id', 'pagamento_id', 'voce_nuova']).toContain(chiave)
      }
    }
  })
})
