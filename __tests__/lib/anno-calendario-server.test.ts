import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

import { logErrore, logEvento } from '@/lib/logging/logger'
import { annoDellaFrequenza, annoDi, azzeraSegnalazioniFuoriCalendario, caricaCalendario, statoCalendario } from '@/lib/anno/calendario'

/** PR 4.1 · COMPITO 4.1.2 · il calendario lato server: una lettura per richiesta, degrado, mai eccezioni. */
const SEDE = '11111111-1111-4111-8111-111111111111'
const SEDE2 = '22222222-2222-4222-8222-222222222222'
const ALUNNO = '99999999-9999-4999-8999-999999999999'
const AS25 = 'aaaaaaa1-0000-4000-8000-000000000025'
const AS26 = 'aaaaaaa1-0000-4000-8000-000000000026'
const AS27 = 'aaaaaaa1-0000-4000-8000-000000000027'

type Esito = { data: unknown; error: { code?: string; message?: string } | null }

const riga = (over: Record<string, unknown> = {}) => ({
  id: AS25,
  anno_id: 'bbbbbbb1-0000-4000-8000-000000000025',
  inizio: '2025-09-01',
  fine: '2026-09-14',
  ultimo_giorno_aperto: '2026-07-31',
  prepara_successivo_dal: '2026-03-01',
  stato: 'chiuso',
  domande_aperte: false,
  anni_scolastici: { anno_inizio: 2025 },
  ...over,
})
const r25 = (over: Record<string, unknown> = {}) => riga(over)
const r26 = (over: Record<string, unknown> = {}) =>
  riga({
    id: AS26,
    anno_id: 'bbbbbbb1-0000-4000-8000-000000000026',
    inizio: '2026-09-15',
    fine: '2027-08-31',
    ultimo_giorno_aperto: '2027-07-31',
    prepara_successivo_dal: '2027-03-01',
    stato: 'corrente',
    anni_scolastici: { anno_inizio: 2026 },
    ...over,
  })
const r27 = (over: Record<string, unknown> = {}) =>
  riga({
    id: AS27,
    anno_id: 'bbbbbbb1-0000-4000-8000-000000000027',
    inizio: '2027-09-01',
    fine: '2028-08-31',
    ultimo_giorno_aperto: '2028-07-31',
    prepara_successivo_dal: '2028-03-01',
    stato: 'iscrizioni_aperte',
    anni_scolastici: { anno_inizio: 2027 },
    ...over,
  })

/**
 * Le righe di prova portano `anni_scolastici` (com'era l'embed): il finto le divide nelle due letture
 * vere. `anni_sede` risponde senza quel campo; `anni_scolastici` risponde `{ id, anno_inizio }` a meno
 * che il test non lo dia a mano. Un join null o storto non produce la riga (l'anno non torna).
 */
function esitoDi(risposte: Record<string, unknown>, tabella: string): Esito {
  const dato = risposte[tabella] as Esito | undefined
  const sede = risposte.anni_sede as Esito | undefined
  if (tabella === 'anni_sede' && sede && Array.isArray(sede.data)) {
    return { ...sede, data: sede.data.map((r) => ({ ...(r as object), anni_scolastici: undefined })) }
  }
  if (tabella === 'anni_scolastici' && !dato && sede && Array.isArray(sede.data)) {
    const righe = (sede.data as Array<{ anno_id: string; anni_scolastici?: unknown }>).flatMap((r) => {
      const j = Array.isArray(r.anni_scolastici) ? r.anni_scolastici[0] : r.anni_scolastici
      return j && typeof j === 'object' ? [{ id: r.anno_id, anno_inizio: (j as { anno_inizio?: unknown }).anno_inizio }] : []
    })
    return { data: righe, error: null }
  }
  return dato ?? { data: [], error: null }
}

/** Client finto che registra le chiamate e risponde per tabella. */
function cliente(risposte: { anni_sede?: Esito; anni_scolastici?: Esito; frequenze?: Esito; lancia?: boolean }) {
  const chiamate: Array<{ tabella: string; passi: Array<[string, unknown[]]> }> = []
  const from = vi.fn((tabella: string) => {
    if (risposte.lancia) throw new Error('rete')
    const reg = { tabella, passi: [] as Array<[string, unknown[]]> }
    chiamate.push(reg)
    const esito = esitoDi(risposte, tabella)
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order']) {
      q[m] = (...a: unknown[]) => {
        reg.passi.push([m, a])
        return q
      }
    }
    q.then = (ok: (v: Esito) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(esito).then(ok, ko)
    return q
  })
  return { c: { from } as unknown as SupabaseClient, from, chiamate }
}
const lette = (f: { from: ReturnType<typeof vi.fn> }, t: string) => f.from.mock.calls.filter((a) => a[0] === t).length
const OK = (...righe: unknown[]): Esito => ({ data: righe, error: null })
const errori = () => vi.mocked(logEvento).mock.calls.filter((a) => a[1] === 'error')
const eventi = (tipo: string) => vi.mocked(logEvento).mock.calls.filter((a) => a[2]?.tipo === tipo)

describe('cache per richiesta', () => {
  beforeEach(() => vi.clearAllMocks())

  it('tre domande sulla stessa sede leggono anni_sede una volta sola', async () => {
    const f = cliente({ anni_sede: OK(r25(), r26()) })
    await annoDi(f.c, SEDE, '2026-01-10')
    await annoDi(f.c, SEDE, '2026-02-10')
    await annoDi(f.c, SEDE, '2026-03-10')
    expect(lette(f, 'anni_sede')).toBe(1)
  })

  it('due sedi ne fanno due', async () => {
    const f = cliente({ anni_sede: OK(r25()) })
    await annoDi(f.c, SEDE, '2026-01-10')
    await annoDi(f.c, SEDE2, '2026-01-10')
    expect(lette(f, 'anni_sede')).toBe(2)
  })

  it('due client diversi non si condividono la cache', async () => {
    const a = cliente({ anni_sede: OK(r25()) })
    const b = cliente({ anni_sede: OK(r25()) })
    await annoDi(a.c, SEDE, '2026-01-10')
    await annoDi(b.c, SEDE, '2026-01-10')
    expect(lette(a, 'anni_sede') + lette(b, 'anni_sede')).toBe(2)
  })

  it('due chiamate in parallelo fanno una lettura sola', async () => {
    const f = cliente({ anni_sede: OK(r25()) })
    await Promise.all([annoDi(f.c, SEDE, '2026-01-10'), annoDi(f.c, SEDE, '2026-01-11')])
    expect(lette(f, 'anni_sede')).toBe(1)
  })

  it('la query è quella del brief', async () => {
    const f = cliente({ anni_sede: OK(r25()) })
    await caricaCalendario(f.c, SEDE)
    expect(f.chiamate[0].passi).toEqual([
      ['select', ['id, anno_id, inizio, fine, ultimo_giorno_aperto, prepara_successivo_dal, stato, domande_aperte']],
      ['eq', ['scuola_id', SEDE]],
      ['order', ['inizio', { ascending: true }]],
    ])
    // niente embed: nel DB della CI risponderebbe PGRST200, che non è «schema indietro»
    expect(String(f.chiamate[0].passi[0][1][0])).not.toContain('(')
    expect(f.chiamate[1].tabella).toBe('anni_scolastici')
    expect(f.chiamate[1].passi).toEqual([
      ['select', ['id, anno_inizio']],
      ['in', ['id', [r25().anno_id]]],
    ])
    expect(lette(f, 'anni_scolastici')).toBe(1)
  })

  it('più chiamate sulla stessa sede: anche anni_scolastici si legge una volta sola', async () => {
    const f = cliente({ anni_sede: OK(r25(), r26()) })
    await Promise.all([annoDi(f.c, SEDE, '2026-01-10'), annoDi(f.c, SEDE, '2026-01-11')])
    await annoDi(f.c, SEDE, '2026-01-12')
    expect(lette(f, 'anni_scolastici')).toBe(1)
  })
})

describe('caricaCalendario', () => {
  beforeEach(() => vi.clearAllMocks())

  it('le righe diventano RigaCalendario con l’anno_inizio del join', async () => {
    const f = cliente({ anni_sede: OK(r25(), r26({ anni_scolastici: [{ anno_inizio: 2026 }] })) })
    const cal = await caricaCalendario(f.c, SEDE)
    expect(cal).toEqual([
      {
        annoId: 'bbbbbbb1-0000-4000-8000-000000000025',
        annoSedeId: AS25,
        annoInizio: 2025,
        inizio: '2025-09-01',
        fine: '2026-09-14',
        ultimoGiornoAperto: '2026-07-31',
        preparaSuccessivoDal: '2026-03-01',
        stato: 'chiuso',
        domandeAperte: false,
      },
      {
        annoId: 'bbbbbbb1-0000-4000-8000-000000000026',
        annoSedeId: AS26,
        annoInizio: 2026,
        inizio: '2026-09-15',
        fine: '2027-08-31',
        ultimoGiornoAperto: '2027-07-31',
        preparaSuccessivoDal: '2027-03-01',
        stato: 'corrente',
        domandeAperte: false,
      },
    ])
  })

  it('una riga storta si scarta e le altre restano', async () => {
    const f = cliente({ anni_sede: OK(r25(), r26({ fine: '2027-02-30' }), r27({ stato: 'boh' })) })
    const cal = await caricaCalendario(f.c, SEDE)
    expect(cal?.map((r) => r.annoInizio)).toEqual([2025])
    const warn = eventi('calendario-riga-scartata')
    expect(warn).toHaveLength(1)
    expect(warn[0][1]).toBe('warn')
    expect(warn[0][2]).toMatchObject({ scuola_id: SEDE, scartate: 2 })
  })

  it('anno_inizio non intero: la riga si scarta', async () => {
    const f = cliente({ anni_sede: OK(r25({ anni_scolastici: { anno_inizio: 'x' } }), r26({ anni_scolastici: null })) })
    expect(await caricaCalendario(f.c, SEDE)).toEqual([])
    expect(eventi('calendario-riga-scartata')[0][2]).toMatchObject({ scartate: 2 })
  })

  it.each(['42P01', 'PGRST205', 'PGRST204', '42703'])(
    'schema indietro (%s) → predefinito e un solo info',
    async (code) => {
      vi.clearAllMocks()
      const f = cliente({ anni_sede: { data: null, error: { code, message: 'x' } } })
      expect(await caricaCalendario(f.c, SEDE)).toBeNull()
      const a = await annoDi(f.c, SEDE, '2026-08-15')
      expect(a.annoInizio).toBe(2025)
      expect(a.fonte).toBe('predefinito')
      await annoDi(f.c, SEDE, '2026-08-16')
      const info = eventi('calendario-non-disponibile')
      expect(info).toHaveLength(1)
      expect(info[0][1]).toBe('info')
      expect(info[0][2]).toMatchObject({ scuola_id: SEDE })
      expect(errori()).toHaveLength(0)
    },
  )

  it('anni_scolastici assente (PGRST205) → predefinito, una info, zero error', async () => {
    const f = cliente({ anni_sede: OK(r25(), r26()), anni_scolastici: { data: null, error: { code: 'PGRST205' } } })
    expect(await caricaCalendario(f.c, SEDE)).toBeNull()
    expect(await caricaCalendario(f.c, SEDE)).toBeNull()
    expect(errori()).toHaveLength(0)
    const info = eventi('calendario-non-disponibile')
    expect(info).toHaveLength(1)
    expect(info[0][1]).toBe('info')
    expect(await statoCalendario(f.c, SEDE)).toBe('non_disponibile')
  })

  it('anni_scolastici con un guasto vero → calendario-non-letto, un error con la sede', async () => {
    const f = cliente({ anni_sede: OK(r25()), anni_scolastici: { data: null, error: { code: 'XX000' } } })
    expect(await caricaCalendario(f.c, SEDE)).toBeNull()
    expect(errori()).toHaveLength(1)
    expect(errori()[0][2]).toMatchObject({ tipo: 'calendario-non-letto', scuola_id: SEDE })
    expect(await statoCalendario(f.c, SEDE)).toBe('guasto')
  })

  it('PGRST200 su anni_sede (quello che darebbe un embed nel DB della CI) è un guasto, e la select non ha embed', async () => {
    const f = cliente({ anni_sede: { data: null, error: { code: 'PGRST200', message: 'relationship' } } })
    expect(await caricaCalendario(f.c, SEDE)).toBeNull()
    expect(errori()).toHaveLength(1)
    expect(errori()[0][2]).toMatchObject({ tipo: 'calendario-non-letto', scuola_id: SEDE })
    expect(String(f.chiamate[0].passi[0][1][0])).not.toContain('(')
    expect(lette(f, 'anni_scolastici')).toBe(0)
  })

  it('una riga di anni_sede il cui anno_id non torna da anni_scolastici si scarta con il warn', async () => {
    const f = cliente({
      anni_sede: OK(r25(), r26()),
      anni_scolastici: { data: [{ id: r25().anno_id, anno_inizio: 2025 }], error: null },
    })
    const cal = await caricaCalendario(f.c, SEDE)
    expect(cal?.map((r) => r.annoInizio)).toEqual([2025])
    expect(eventi('calendario-riga-scartata')[0][2]).toMatchObject({ scuola_id: SEDE, scartate: 1 })
  })

  it('un altro errore → predefinito e un logErrore', async () => {
    const f = cliente({ anni_sede: { data: null, error: { code: 'XX000', message: 'boom' } } })
    expect(await caricaCalendario(f.c, SEDE)).toBeNull()
    expect(await caricaCalendario(f.c, SEDE)).toBeNull()
    expect(errori()).toHaveLength(1)
    expect(errori()[0][2]).toMatchObject({
      tipo: 'calendario-non-letto',
      operazione: 'anno/calendario:caricaCalendario',
      scuola_id: SEDE,
    })
    expect(logErrore).not.toHaveBeenCalled()
  })

  it('un client che lancia → null, un errore con la sede, nessuna eccezione', async () => {
    const f = cliente({ lancia: true })
    await expect(caricaCalendario(f.c, SEDE)).resolves.toBeNull()
    expect(errori()).toHaveLength(1)
    expect(errori()[0][2]).toMatchObject({ tipo: 'calendario-non-letto', scuola_id: SEDE })
    expect(logErrore).not.toHaveBeenCalled()
  })
})

describe('annoDi', () => {
  beforeEach(() => vi.clearAllMocks())

  it('col calendario della sede vince la sede', async () => {
    const f = cliente({ anni_sede: OK(r25(), r26()) })
    const a = await annoDi(f.c, SEDE, '2026-09-10')
    expect(a.annoInizio).toBe(2025)
    expect(a.fonte).toBe('sede')
  })

  it('giorno fuori da un calendario non vuoto → predefinito e un warn', async () => {
    azzeraSegnalazioniFuoriCalendario()
    const f = cliente({ anni_sede: OK(r25(), r26()) })
    const a = await annoDi(f.c, SEDE, '2030-01-10')
    await annoDi(f.c, SEDE, '2030-01-11')
    expect(a.annoInizio).toBe(2029)
    expect(a.fonte).toBe('predefinito')
    const w = eventi('anno-fuori-calendario')
    expect(w).toHaveLength(1)
    expect(w[0][1]).toBe('warn')
    expect(w[0][2]).toMatchObject({ scuola_id: SEDE, giorno: '2030-01-10' })
  })

  it('anno-fuori-calendario: una volta per sede e per giorno NEL PROCESSO, anche con client (richieste) diversi', async () => {
    azzeraSegnalazioniFuoriCalendario()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2030-01-10T10:00:00Z'))
      // tre richieste = tre client: prima della correzione la segnalazione usciva a ogni richiesta
      for (let i = 0; i < 3; i++) await annoDi(cliente({ anni_sede: OK(r25(), r26()) }).c, SEDE, '2030-01-10')
      expect(eventi('anno-fuori-calendario')).toHaveLength(1)
      // un'altra sede segnala la sua
      await annoDi(cliente({ anni_sede: OK(r25(), r26()) }).c, SEDE2, '2030-01-10')
      expect(eventi('anno-fuori-calendario')).toHaveLength(2)
      // il giorno dopo la stessa sede segnala di nuovo (una volta)
      vi.setSystemTime(new Date('2030-01-11T10:00:00Z'))
      for (let i = 0; i < 2; i++) await annoDi(cliente({ anni_sede: OK(r25(), r26()) }).c, SEDE, '2030-01-11')
      expect(eventi('anno-fuori-calendario')).toHaveLength(3)
      // la riga porta solo sede e giorno
      for (const w of eventi('anno-fuori-calendario')) expect(Object.keys(w[2] as object).sort()).toEqual(['giorno', 'scuola_id', 'tipo'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('un giorno non valido lancia', async () => {
    const f = cliente({ anni_sede: OK(r25()) })
    await expect(annoDi(f.c, SEDE, '2026-02-30')).rejects.toThrow(RangeError)
  })
})

describe('annoDellaFrequenza', () => {
  beforeEach(() => vi.clearAllMocks())
  const cal = OK(r25(), r26(), r27())
  const freq = (...ids: string[]): Esito => ({ data: ids.map((anno_sede_id) => ({ anno_sede_id })), error: null })

  it('(a) frequenza viva sull’anno attivo → quell’anno', async () => {
    const f = cliente({ anni_sede: cal, frequenze: freq(AS26) })
    const a = await annoDellaFrequenza(f.c, ALUNNO, SEDE, '2027-03-10')
    expect(a.annoInizio).toBe(2026)
    expect(a.fonte).toBe('sede')
    expect(a.riga?.annoSedeId).toBe(AS26)
    const q = f.chiamate.find((x) => x.tabella === 'frequenze')!
    expect(q.passi).toEqual([
      ['select', ['anno_sede_id']],
      ['eq', ['alunno_id', ALUNNO]],
      ['eq', ['scuola_id', SEDE]],
      ['in', ['stato', ['in_attesa', 'iscritto']]],
    ])
  })

  it('(b) solo una frequenza sul 2027 → 2027', async () => {
    const f = cliente({ anni_sede: cal, frequenze: freq(AS27) })
    const a = await annoDellaFrequenza(f.c, ALUNNO, SEDE, '2027-03-10')
    expect(a.annoInizio).toBe(2027)
    expect(a.fonte).toBe('sede')
  })

  it('fra attivo e successivo vince l’attivo', async () => {
    const f = cliente({ anni_sede: cal, frequenze: freq(AS27, AS26) })
    expect((await annoDellaFrequenza(f.c, ALUNNO, SEDE, '2027-03-10')).annoInizio).toBe(2026)
  })

  it('(c) nessuna frequenza → l’anno del giorno oggi', async () => {
    const f = cliente({ anni_sede: cal, frequenze: freq() })
    const a = await annoDellaFrequenza(f.c, ALUNNO, SEDE, '2027-03-10')
    expect(a.annoInizio).toBe(2026)
  })

  it('(d) PGRST205 sulle frequenze → ripiego, info, nessun logErrore', async () => {
    const f = cliente({ anni_sede: cal, frequenze: { data: null, error: { code: 'PGRST205' } } })
    const a = await annoDellaFrequenza(f.c, ALUNNO, SEDE, '2027-03-10')
    expect(a.annoInizio).toBe(2026)
    const info = eventi('frequenze-non-disponibili')
    expect(info).toHaveLength(1)
    expect(info[0][1]).toBe('info')
    expect(errori()).toHaveLength(0)
  })

  it('altro errore sulle frequenze → ripiego e un logErrore', async () => {
    const f = cliente({ anni_sede: cal, frequenze: { data: null, error: { code: 'XX000' } } })
    const a = await annoDellaFrequenza(f.c, ALUNNO, SEDE, '2027-03-10')
    expect(a.annoInizio).toBe(2026)
    expect(errori()).toHaveLength(1)
    expect(errori()[0][2]).toMatchObject({
      tipo: 'frequenze-non-lette',
      operazione: 'anno/calendario:annoDellaFrequenza',
      scuola_id: SEDE,
    })
    expect(logErrore).not.toHaveBeenCalled()
  })

  it('(e) calendario null → predefinito di oggi, senza leggere le frequenze', async () => {
    const f = cliente({ anni_sede: { data: null, error: { code: '42P01' } }, frequenze: freq(AS26) })
    const a = await annoDellaFrequenza(f.c, ALUNNO, SEDE, '2027-03-10')
    expect(a.annoInizio).toBe(2026)
    expect(a.fonte).toBe('predefinito')
    expect(lette(f, 'frequenze')).toBe(0)
  })

  it('nessun log porta l’uuid del bambino', async () => {
    const scenari: Array<Parameters<typeof cliente>[0]> = [
      { anni_sede: cal, frequenze: freq(AS26) },
      { anni_sede: cal, frequenze: freq(AS27) },
      { anni_sede: cal, frequenze: freq() },
      { anni_sede: cal, frequenze: { data: null, error: { code: 'PGRST205' } } },
      { anni_sede: cal, frequenze: { data: null, error: { code: 'XX000', message: ALUNNO } } },
      { anni_sede: { data: null, error: { code: '42P01' } } },
    ]
    for (const s of scenari) await annoDellaFrequenza(cliente(s).c, ALUNNO, SEDE, '2027-03-10')
    const tutti = [...vi.mocked(logEvento).mock.calls, ...vi.mocked(logErrore).mock.calls]
    expect(tutti.length).toBeGreaterThan(0)
    for (const args of tutti) {
      expect(JSON.stringify(args, (_k, v) => (v instanceof Error ? v.message : v))).not.toContain(ALUNNO)
    }
  })
})
