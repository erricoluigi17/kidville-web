import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * COMPITO 4.5.9 · IL CRM E L'ANNO DELLA SCHEDA (`anno_id`).
 *
 *  · la QUOTA prende l'anno dalla scheda e non da «oggi»: segnata il 31/08 o il 01/09 dà la stessa quota;
 *  · una scheda che ha solo l'etichetta `anno_ingresso` (nessun `anno_id`) va come prima;
 *  · le route che scrivono la scheda accettano `annoId`: lo controllano (è della sede e non chiuso → altrimenti 422) e scrivono
 *    INSIEME `anno_id`, `anno_ingresso` e `quota_anno` (un'unica scrittura: il trigger dell'etichetta non scatta due volte);
 *  · sul database senza lo schema dell'anno (la CI) l'`annoId` è ignorato e si scrive come prima.
 *
 * Database finto che applica davvero i filtri; le funzioni SQL (`crm_quota_segna`) sono finte e registrano gli argomenti. Gate di
 * ruolo e logger sono finti; `assertSchedaInScope`, `resolveAnnoScrittura` e il calendario sono quelli VERI. Nessuna famiglia vera.
 */

type ArgsRpc = Record<string, unknown>

const h = vi.hoisted(() => ({
  ruolo: 'segreteria' as string,
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  errori: {} as Record<string, unknown>,
  chiamateRpc: [] as { nome: string; args: ArgsRpc }[],
  logEvento: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
    if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    return Promise.resolve({ user: { id: USER, role: h.ruolo, scuola_id: SEDE_A } })
  },
}))
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
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => {
  const nuovo = (header: string | null) => {
    const mio = [] as Scrittura[]
    mio.push = (...s: Scrittura[]) => {
      for (const x of s) (h.scritture as unknown[]).push({ ...x, header })
      return mio.length
    }
    return creaFintoSupabase(h.db as DBFinto, [], {
      errori: h.errori as Record<string, ErrorePostgrest>,
      scritture: mio,
      rpc: {
        // `anno_di(sede, giorno)`: l'anno della sede che contiene il giorno (lo usa il «prossimo» di `risolviAnniBambini`)
        anno_di: ({ p_scuola, p_giorno }: Riga) => {
          const riga = ((h.db.anni_sede ?? []) as Riga[]).find(
            (r) => r.scuola_id === p_scuola && String(r.inizio) <= String(p_giorno) && String(p_giorno) <= String(r.fine),
          )
          return { data: riga ? riga.anno_id : null, error: null }
        },
        crm_quota_segna: async (args: Riga) => {
          h.chiamateRpc.push({ nome: 'crm_quota_segna', args })
          return { data: { esito: 'ok', movimento_id: null, corretta: false, passaggio: null }, error: null }
        },
      },
    })
  }
  return {
    createAdminClient: async () => nuovo(null),
    createAdminClientConHeader: async (hd: Record<string, string>) => nuovo(hd['x-kidville-correzione'] ?? null),
  }
})

import { PUT } from '@/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/quota/route'
import { PATCH } from '@/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/route'
import { POST as POST_BAMBINO } from '@/app/api/admin/crm/schede/[id]/bambini/route'
import { POST as POST_SCHEDA } from '@/app/api/admin/crm/schede/route'

const USER = '20000000-0000-4000-8000-0000000000aa'
const SCHEDA = '30000000-0000-4000-8000-000000000001'

// `anni_scolastici.id` (uguali per tutte le sedi) e `anni_sede.id`
const A2526 = 'a1111111-1111-4111-8111-111111111111' // chiuso
const A2627 = 'a2222222-2222-4222-8222-222222222222' // corrente
const A2728 = 'a3333333-3333-4333-8333-333333333333' // in preparazione
const A2829 = 'a4444444-4444-4444-8444-444444444444' // c'è SOLO nella sede B
const AS = (sede: string, anno: number) => `${sede}:${anno}`

const B_2027 = '50000000-0000-4000-8000-0000000000a1' // etichetta «prossimo», anno_id 2027/28
const B_2027_IN_CORSO = '50000000-0000-4000-8000-0000000000a2' // etichetta «in_corso» ma anno_id 2027/28
const B_SOLO_ETICHETTA = '50000000-0000-4000-8000-0000000000a3' // «prossimo», nessun anno_id (scheda vecchia)
const B_SOLO_IN_CORSO = '50000000-0000-4000-8000-0000000000a4' // «in_corso», nessun anno_id
const B_NON_INDICATO = '50000000-0000-4000-8000-0000000000a5' // «non_indicato», con un anno_id qualsiasi
const B_2026 = '50000000-0000-4000-8000-0000000000a6' // «in_corso», anno_id 2026/27
const B_IN_CONTABILITA = '50000000-0000-4000-8000-0000000000a7' // anno_id 2026/27, quota già in contabilità

const riga = (sede: string, annoId: string, annoInizio: number, stato: string, inizio: string, fine: string) => ({
  id: AS(sede, annoInizio), scuola_id: sede, anno_id: annoId, stato, domande_aperte: false,
  inizio, fine, ultimo_giorno_aperto: fine, prepara_successivo_dal: inizio,
  // `annoInizio` non è una colonna di `anni_sede`: sta in `anni_scolastici`
})

const bambino = (id: string, extra: Record<string, unknown> = {}) => ({
  id, scuola_id: SEDE_A, scheda_id: SCHEDA, nome: 'Bimbo Prova', data_nascita: null,
  anno_ingresso: 'prossimo', esito: 'aperto', motivo_perdita: null, motivo_nota: null,
  alunno_id: null, quota_importo: null, quota_metodo: null, quota_anno: null, quota_stato: null, quota_saldata_il: null,
  creata_il: '2026-10-01T09:00:00.000Z', aggiornata_il: '2026-10-01T09:00:00.000Z',
  ...extra,
})

const richiesta = (metodo: string, percorso: string, corpo?: unknown) =>
  new NextRequest(`http://localhost${percorso}`, {
    method: metodo,
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo), headers: { 'content-type': 'application/json' } }),
  })
const ctx = (bambinoId: string) => ({ params: Promise.resolve({ id: SCHEDA, bambinoId }) })

const putQuota = (bambinoId: string, corpo: Record<string, unknown> = {}) =>
  PUT(richiesta('PUT', `/api/admin/crm/schede/${SCHEDA}/bambini/${bambinoId}/quota`, { importo: 150, metodo: 'bonifico', ...corpo }), ctx(bambinoId))
const patch = (bambinoId: string, corpo: Record<string, unknown>) =>
  PATCH(richiesta('PATCH', `/api/admin/crm/schede/${SCHEDA}/bambini/${bambinoId}`, corpo), ctx(bambinoId))
const postBambino = (corpo: Record<string, unknown>) =>
  POST_BAMBINO(richiesta('POST', `/api/admin/crm/schede/${SCHEDA}/bambini`, { nome: 'Bimbo Prova', ...corpo }), { params: Promise.resolve({ id: SCHEDA }) })
const postScheda = (bambini: Record<string, unknown>[]) =>
  POST_SCHEDA(richiesta('POST', '/api/admin/crm/schede', {
    genitoreNome: 'Famiglia Prova', telefono1: '333 000 0009', origine: 'telefonata', bambini,
  }))

const annoQuota = () => h.chiamateRpc.map((c) => c.args.p_anno)
const scrittiBambini = (operazione: 'insert' | 'update') =>
  (h.scritture as Array<Scrittura & { header: string | null }>).filter((s) => s.tabella === 'crm_bambini' && s.operazione === operazione)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-31T10:00:00.000Z'))
  h.ruolo = 'segreteria'
  h.scritture = []
  h.errori = {}
  h.chiamateRpc = []
  h.logEvento.mockClear()
  h.db = {
    utenti: [{ id: USER, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null }],
    utenti_scuole: [],
    crm_schede: [
      { id: SCHEDA, scuola_id: SEDE_A, genitore_nome: 'Famiglia Prova', creata_il: '2026-10-01T09:00:00.000Z', telefoni_norm: ['3330000001'], email_norm: [] },
    ],
    crm_bambini: [
      bambino(B_2027, { anno_id: A2728 }),
      bambino(B_2027_IN_CORSO, { anno_id: A2728, anno_ingresso: 'in_corso' }),
      bambino(B_SOLO_ETICHETTA),
      bambino(B_SOLO_IN_CORSO, { anno_ingresso: 'in_corso' }),
      bambino(B_NON_INDICATO, { anno_ingresso: 'non_indicato', anno_id: A2627 }),
      bambino(B_2026, { anno_ingresso: 'in_corso', anno_id: A2627 }),
      bambino(B_IN_CONTABILITA, {
        anno_ingresso: 'in_corso', anno_id: A2627, quota_stato: 'in_contabilita', quota_anno: 2026, quota_importo: 100, quota_metodo: 'bonifico',
      }),
    ],
    crm_eventi: [],
    cassa_chiusure: [],
    anni_scolastici: [
      { id: A2526, anno_inizio: 2025 }, { id: A2627, anno_inizio: 2026 }, { id: A2728, anno_inizio: 2027 }, { id: A2829, anno_inizio: 2028 },
    ],
    anni_sede: [
      riga(SEDE_A, A2526, 2025, 'chiuso', '2025-09-01', '2026-08-31'),
      riga(SEDE_A, A2627, 2026, 'corrente', '2026-09-01', '2027-08-31'),
      riga(SEDE_A, A2728, 2027, 'in_preparazione', '2027-09-01', '2028-08-31'),
      riga(SEDE_B, A2627, 2026, 'corrente', '2026-09-01', '2027-08-31'),
      riga(SEDE_B, A2728, 2027, 'iscrizioni_aperte', '2027-09-01', '2028-08-31'),
      riga(SEDE_B, A2829, 2028, 'in_preparazione', '2028-09-01', '2029-08-31'),
    ],
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PUT …/quota · l’anno della quota è quello della scheda', () => {
  it('una scheda del 2027/28 segnata a ottobre 2026 prende il 2027 anche se la sua etichetta dice «in corso»', async () => {
    const res = await putQuota(B_2027_IN_CORSO)
    expect(res.status).toBe(200)
    expect(annoQuota()).toEqual([2027])
  })

  it('stessa quota il 31/08/2026 e il 01/09/2026: l’anno non dipende da «adesso»', async () => {
    vi.setSystemTime(new Date('2026-08-31T10:00:00.000Z'))
    expect((await putQuota(B_2027)).status).toBe(200)
    vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'))
    expect((await putQuota(B_2027)).status).toBe(200)
    expect(annoQuota()).toEqual([2027, 2027])
  })

  it('l’anno attivo della scheda (2026/27) è il 2026, qualunque sia il giorno', async () => {
    vi.setSystemTime(new Date('2026-08-31T10:00:00.000Z'))
    await putQuota(B_2026)
    vi.setSystemTime(new Date('2027-01-10T10:00:00.000Z'))
    await putQuota(B_2026)
    expect(annoQuota()).toEqual([2026, 2026])
  })

  it('una scheda con la sola etichetta (nessun `anno_id`) va come oggi: «prossimo» 2027, «in corso» 2026', async () => {
    await putQuota(B_SOLO_ETICHETTA)
    await putQuota(B_SOLO_IN_CORSO)
    expect(annoQuota()).toEqual([2027, 2026])
  })

  it('una scheda con la sola etichetta dipende ancora da «adesso» (com’è oggi): il 31/08 «in corso» è il 2025', async () => {
    vi.setSystemTime(new Date('2026-08-31T10:00:00.000Z'))
    await putQuota(B_SOLO_IN_CORSO)
    expect(annoQuota()).toEqual([2025])
  })

  it('l’anno di ingresso «non indicato» chiede ancora di indicarlo: 422 QUOTA_ANNO_MANCANTE, senza rpc', async () => {
    const res = await putQuota(B_NON_INDICATO)
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('QUOTA_ANNO_MANCANTE')
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it('con il calendario assente (database non migrato) la scheda con `anno_id` ripiega sull’etichetta, senza errori', async () => {
    h.db.anni_sede = []
    h.errori = { anni_sede: { code: 'PGRST205', message: 'assente' } }
    const res = await putQuota(B_2027)
    expect(res.status).toBe(200)
    expect(annoQuota()).toEqual([2027])
  })
})

describe('PATCH · il bambino cambia anno (`annoId`)', () => {
  it('scrive `anno_id`, `anno_ingresso` e `quota_anno` INSIEME, in un solo update', async () => {
    const res = await patch(B_2026, { annoId: A2728 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: B_2026, modificato: true })
    const u = scrittiBambini('update')
    expect(u).toHaveLength(1)
    expect(u[0].valori[0]).toMatchObject({ anno_id: A2728, anno_ingresso: 'prossimo', quota_anno: 2027 })
  })

  it('l’anno attivo diventa «in corso»', async () => {
    const res = await patch(B_2027, { annoId: A2627 })
    expect(res.status).toBe(200)
    expect(scrittiBambini('update')[0].valori[0]).toMatchObject({ anno_id: A2627, anno_ingresso: 'in_corso', quota_anno: 2026 })
  })

  it('un anno di un’altra sede → 422 ANNO_NON_DELLA_SEDE e nessuna scrittura', async () => {
    const res = await patch(B_2026, { annoId: A2829 })
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('ANNO_NON_DELLA_SEDE')
    expect(h.scritture).toEqual([])
  })

  it('un anno chiuso → 422 ANNO_CHIUSO e nessuna scrittura', async () => {
    const res = await patch(B_2026, { annoId: A2526 })
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('ANNO_CHIUSO')
    expect(h.scritture).toEqual([])
  })

  it('lo stesso anno che la scheda ha già: nessuna scrittura', async () => {
    const res = await patch(B_2026, { annoId: A2627 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ modificato: false })
    expect(h.scritture).toEqual([])
  })

  it('se la quota è già in contabilità l’anno non si sposta: 409 STATO_NON_AMMESSO', async () => {
    const res = await patch(B_IN_CONTABILITA, { annoId: A2728 })
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('STATO_NON_AMMESSO')
    expect(h.scritture).toEqual([])
  })

  it('un `annoId` che non è un uuid → 400', async () => {
    expect((await patch(B_2026, { annoId: 'non-un-uuid' })).status).toBe(400)
    expect(h.scritture).toEqual([])
  })

  it('se arrivano `annoId` e `annoIngresso` insieme vale l’anno scelto', async () => {
    const res = await patch(B_2026, { annoId: A2728, annoIngresso: 'in_corso' })
    expect(res.status).toBe(200)
    expect(scrittiBambini('update')[0].valori[0]).toMatchObject({ anno_id: A2728, anno_ingresso: 'prossimo', quota_anno: 2027 })
  })

  it('col solo `annoIngresso` (un vecchio client) va come oggi: scrive la sola etichetta', async () => {
    const res = await patch(B_SOLO_ETICHETTA, { annoIngresso: 'in_corso' })
    expect(res.status).toBe(200)
    const valori = scrittiBambini('update')[0].valori[0]
    expect(valori).toMatchObject({ anno_ingresso: 'in_corso' })
    expect(valori).not.toHaveProperty('anno_id')
    expect(valori).not.toHaveProperty('quota_anno')
  })

  it('sul database senza lo schema dell’anno l’`annoId` è ignorato e si scrive la sola etichetta', async () => {
    h.db.anni_sede = []
    h.errori = { anni_sede: { code: 'PGRST205', message: 'assente' } }
    const res = await patch(B_SOLO_ETICHETTA, { annoId: A2728, annoIngresso: 'in_corso' })
    expect(res.status).toBe(200)
    const valori = scrittiBambini('update')[0].valori[0]
    expect(valori).toMatchObject({ anno_ingresso: 'in_corso' })
    expect(valori).not.toHaveProperty('anno_id')
  })
})

describe('POST …/bambini · un bambino nell’anno scelto', () => {
  it('nasce con `anno_id`, `anno_ingresso` e `quota_anno` coerenti', async () => {
    const res = await postBambino({ annoId: A2728 })
    expect(res.status).toBe(201)
    const i = scrittiBambini('insert')
    expect(i).toHaveLength(1)
    expect(i[0].valori[0]).toMatchObject({ scuola_id: SEDE_A, scheda_id: SCHEDA, anno_id: A2728, anno_ingresso: 'prossimo', quota_anno: 2027 })
  })

  it('l’anno attivo → «in corso»', async () => {
    expect((await postBambino({ annoId: A2627 })).status).toBe(201)
    expect(scrittiBambini('insert')[0].valori[0]).toMatchObject({ anno_id: A2627, anno_ingresso: 'in_corso', quota_anno: 2026 })
  })

  it('un anno di un’altra sede → 422 e nessuna scrittura', async () => {
    const res = await postBambino({ annoId: A2829 })
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('ANNO_NON_DELLA_SEDE')
    expect(h.scritture).toEqual([])
  })

  it('un anno chiuso → 422 ANNO_CHIUSO', async () => {
    const res = await postBambino({ annoId: A2526 })
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('ANNO_CHIUSO')
    expect(h.scritture).toEqual([])
  })

  it('col solo `annoIngresso` (un vecchio client) va come oggi: l’anno viene dall’etichetta, senza `quota_anno`', async () => {
    const res = await postBambino({ annoIngresso: 'prossimo' })
    expect(res.status).toBe(201)
    const valori = scrittiBambini('insert')[0].valori[0]
    expect(valori).toMatchObject({ anno_ingresso: 'prossimo', anno_id: A2728 })
    expect(valori).not.toHaveProperty('quota_anno')
  })

  it('senza `annoId` né `annoIngresso` → 400 (uno dei due serve)', async () => {
    expect((await postBambino({})).status).toBe(400)
    expect(h.scritture).toEqual([])
  })
})

describe('POST /schede · ogni bambino col suo anno', () => {
  it('due bambini in due anni diversi: una sola scrittura, ciascuno con il suo anno', async () => {
    const res = await postScheda([
      { nome: 'Bimbo Uno', annoId: A2627 },
      { nome: 'Bimbo Due', annoId: A2728 },
    ])
    expect(res.status).toBe(201)
    const i = scrittiBambini('insert')
    expect(i).toHaveLength(1)
    expect(i[0].valori).toHaveLength(2)
    expect(i[0].valori[0]).toMatchObject({ anno_id: A2627, anno_ingresso: 'in_corso', quota_anno: 2026 })
    expect(i[0].valori[1]).toMatchObject({ anno_id: A2728, anno_ingresso: 'prossimo', quota_anno: 2027 })
  })

  it('un bambino con `annoId` e uno con la sola etichetta convivono', async () => {
    const res = await postScheda([
      { nome: 'Bimbo Uno', annoId: A2728 },
      { nome: 'Bimbo Due', annoIngresso: 'in_corso' },
    ])
    expect(res.status).toBe(201)
    const [uno, due] = scrittiBambini('insert')[0].valori
    expect(uno).toMatchObject({ anno_id: A2728, anno_ingresso: 'prossimo', quota_anno: 2027 })
    expect(due).toMatchObject({ anno_id: A2627, anno_ingresso: 'in_corso' })
    expect(due).not.toHaveProperty('quota_anno')
  })

  it('un anno di un’altra sede → 422 e la scheda non nasce', async () => {
    const res = await postScheda([{ nome: 'Bimbo Uno', annoId: A2829 }])
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('ANNO_NON_DELLA_SEDE')
    expect(h.scritture).toEqual([])
  })
})
