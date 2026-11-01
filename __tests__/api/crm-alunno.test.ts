import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * CRM della segreteria · l'aggancio a mano del bambino all'alunno (Compito 4 del piano «quota e
 * disponibilità»): `PUT`/`DELETE …/bambini/[bambinoId]/alunno` e la ricerca `GET /api/admin/crm/alunni`.
 *
 * Il database è il FINTO che applica davvero i filtri; la funzione SQL `crm_aggancia_alunno` è finta di test:
 * prova che la route la chiami con gli argomenti giusti e che traduca ogni suo esito nella risposta giusta
 * (la prova SQL vera sta in `migrazione-quota-settimane-sql.test.ts`). Il gate di ruolo è finto (decide solo
 * chi entra); `resolveScuoleAttive`, `assertSchedaInScope` e `scuoleDiUtente` sono quelli VERI, perché sono
 * loro a dire quale sede vale.
 *
 * Dati di prova soltanto: «Bimbo Prova», sedi da `fixtures/sedi.ts`.
 */

type ArgsRpc = Record<string, unknown>
type RispostaRpc = { data: unknown; error: unknown }

const h = vi.hoisted(() => ({
  ruolo: 'segreteria' as string,
  sedePropria: null as string | null,
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  letture: [] as string[],
  errori: {} as Record<string, unknown>,
  rpc: undefined as undefined | ((args: ArgsRpc) => RispostaRpc | Promise<RispostaRpc>),
  chiamateRpc: [] as { nome: string; args: ArgsRpc }[],
  log: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
    if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    return Promise.resolve({ user: { id: USER, role: h.ruolo, scuola_id: h.sedePropria } })
  },
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (...a: Parameters<typeof vero.logEvento>) => {
      h.log.push({ evento: a[0], livello: a[1], campi: a[2] as Record<string, unknown> })
      return vero.logEvento(...a)
    },
    logErrore: (...a: Parameters<typeof vero.logErrore>) => {
      h.log.push({ evento: 'errore', livello: 'error', campi: a[0] as Record<string, unknown> })
      return vero.logErrore(...a)
    },
  }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () =>
    creaFintoSupabase(h.db as DBFinto, h.letture, {
      scritture: h.scritture as Scrittura[],
      errori: h.errori as Record<string, ErrorePostgrest>,
      rpc: {
        crm_aggancia_alunno: async (args: ArgsRpc) => {
          h.chiamateRpc.push({ nome: 'crm_aggancia_alunno', args })
          if (!h.rpc) throw new Error('rpc crm_aggancia_alunno non preparata dal test')
          return await h.rpc(args)
        },
      },
    }),
}))

import { PUT, DELETE } from '@/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/alunno/route'
import { GET as CERCA } from '@/app/api/admin/crm/alunni/route'

const USER = '20000000-0000-4000-8000-0000000000aa'

const S1 = '30000000-0000-4000-8000-000000000001' // sede A
const SB = '30000000-0000-4000-8000-0000000000b1' // sede B

const B_LIBERO = '50000000-0000-4000-8000-0000000000a1' // sede A, nessun alunno
const B_ALUNNO = '50000000-0000-4000-8000-0000000000a2' // sede A, già collegato all'alunno ALUNNO
const B_SEDE_B = '50000000-0000-4000-8000-0000000000b1' // sede B, nella scheda SB
const B_INCOERENTE = '50000000-0000-4000-8000-0000000000b2' // dice scheda S1 ma la sede è B

const ALUNNO = '80000000-0000-4000-8000-000000000001'
const ALUNNO_B = '80000000-0000-4000-8000-0000000000b1'
const VOCE = '60000000-0000-4000-8000-000000000001'

const bambino = (id: string, sede: string, scheda: string, extra: Record<string, unknown> = {}) => ({
  id,
  scuola_id: sede,
  scheda_id: scheda,
  nome: 'Bimbo Prova',
  data_nascita: null,
  anno_ingresso: 'prossimo',
  esito: 'aperto',
  alunno_id: null,
  alunno_collegato_il: null,
  quota_stato: null,
  aggiornata_il: '2026-10-01T09:00:00.000Z',
  ...extra,
})

const richiesta = (metodo: string, percorso: string, corpo?: unknown) =>
  new NextRequest(`http://localhost${percorso}`, {
    method: metodo,
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo), headers: { 'content-type': 'application/json' } }),
  })

const ctx = (id: string, bambinoId: string) => ({ params: Promise.resolve({ id, bambinoId }) })
const URL_ALUNNO = (s: string, b: string) => `/api/admin/crm/schede/${s}/bambini/${b}/alunno`

const put = (corpo: unknown, bambinoId = B_LIBERO, schedaId = S1) =>
  PUT(richiesta('PUT', URL_ALUNNO(schedaId, bambinoId), corpo), ctx(schedaId, bambinoId))
const del = (bambinoId = B_ALUNNO, schedaId = S1) =>
  DELETE(richiesta('DELETE', URL_ALUNNO(schedaId, bambinoId)), ctx(schedaId, bambinoId))
const cerca = (query: string) => CERCA(richiesta('GET', `/api/admin/crm/alunni?${query}`))

const rispondeConEsito = (data: unknown) => {
  h.rpc = () => ({ data, error: null })
}
const scritto = (tabella: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)
const logCrm = () => h.log.filter((r) => r.evento === 'crm')
const riga = (tabella: string, id: string) => h.db[tabella].find((r) => r.id === id)

beforeEach(() => {
  h.ruolo = 'segreteria'
  h.sedePropria = SEDE_A
  h.scritture = []
  h.letture = []
  h.errori = {}
  h.rpc = undefined
  h.chiamateRpc = []
  h.log = []
  h.db = {
    utenti: [{ id: USER, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null }],
    utenti_scuole: [],
    crm_schede: [
      { id: S1, scuola_id: SEDE_A, genitore_nome: 'Famiglia Prova' },
      { id: SB, scuola_id: SEDE_B, genitore_nome: 'Famiglia Prova' },
    ],
    crm_bambini: [
      bambino(B_LIBERO, SEDE_A, S1),
      bambino(B_ALUNNO, SEDE_A, S1, { alunno_id: ALUNNO, alunno_collegato_il: '2026-10-20T09:00:00.000Z' }),
      bambino(B_SEDE_B, SEDE_B, SB),
      bambino(B_INCOERENTE, SEDE_B, S1),
    ],
    crm_eventi: [],
    alunni: [],
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// PUT …/alunno
// ─────────────────────────────────────────────────────────────────────────────

describe('PUT …/alunno — collega il bambino a un alunno della sede', () => {
  it('collega un alunno della sede e restituisce il passaggio della quota', async () => {
    rispondeConEsito({
      esito: 'ok',
      collegato: true,
      passaggio: { esito: 'ok', pagamento_id: VOCE, incasso_id: null, voce_nuova: true },
    })
    const res = await put({ alunnoId: ALUNNO })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: {
        collegato: true,
        passaggio: { esito: 'ok', pagamentoId: VOCE, incassoId: null, voceNuova: true },
      },
    })
    // La funzione SQL riceve il bambino VERIFICATO, l'alunno scelto e chi ha premuto il bottone.
    expect(h.chiamateRpc).toEqual([
      { nome: 'crm_aggancia_alunno', args: { p_bambino_id: B_LIBERO, p_alunno_id: ALUNNO, p_eseguito_da: USER } },
    ])
    // La route non scrive da sé: ci pensa la funzione.
    expect(scritto('crm_bambini')).toEqual([])
  })

  it('senza quota da passare: passaggio nullo, e il collegamento è comunque riuscito', async () => {
    rispondeConEsito({ esito: 'ok', collegato: true, passaggio: null })
    const res = await put({ alunnoId: ALUNNO })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { collegato: true, passaggio: null } })
  })

  it('il passaggio bloccato si vede nella risposta (la quota resta in lista)', async () => {
    rispondeConEsito({ esito: 'ok', collegato: true, passaggio: { esito: 'bloccata', motivo: 'gia_pagata' } })
    const res = await put({ alunnoId: ALUNNO })
    expect((await res.json()).data.passaggio).toEqual({ esito: 'bloccata', motivo: 'gia_pagata' })
  })

  it('l’aggancio riuscito lascia una riga di log col bambino', async () => {
    rispondeConEsito({ esito: 'ok', collegato: true, passaggio: null })
    await put({ alunnoId: ALUNNO })
    expect(logCrm().some((r) => r.campi.esito === 'alunno-collegato:segreteria' && r.campi.entita_id === B_LIBERO)).toBe(true)
  })

  it('alunno di un’altra sede: 422 ALUNNO_NON_DELLA_SEDE', async () => {
    rispondeConEsito({ esito: 'sede_diversa' })
    const res = await put({ alunnoId: ALUNNO_B })
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('ALUNNO_NON_DELLA_SEDE')
  })

  it('23505 / alunno_gia_collegato: 409 ALUNNO_GIA_COLLEGATO, non 500', async () => {
    // Review Focus 2: l'import e un collegamento a mano arrivano insieme sullo stesso alunno. Le tre forme in
    // cui il conflitto può arrivare dalla funzione devono dare la STESSA risposta, e mai `GIA_COLLEGATO`
    // (che parla delle domande di iscrizione) né un 500.
    const forme: Array<() => RispostaRpc> = [
      () => ({ data: { esito: 'alunno_gia_collegato' }, error: null }),
      () => ({ data: { esito: 'gia_collegato_altro' }, error: null }),
      () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }),
    ]
    for (const forma of forme) {
      h.rpc = forma
      const res = await put({ alunnoId: ALUNNO })
      const corpo = await res.json()
      expect(res.status).toBe(409)
      expect(corpo.codice).toBe('ALUNNO_GIA_COLLEGATO')
    }
  })

  it('bambino sparito mentre si scriveva (non_trovato): 404 SCHEDA_NON_TROVATA', async () => {
    rispondeConEsito({ esito: 'non_trovato' })
    const res = await put({ alunnoId: ALUNNO })
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('SCHEDA_NON_TROVATA')
  })

  it.each(['PGRST202', 'PGRST205', '42P01', '42883'])('%s: la funzione non c’è, 503 CRM_NON_INSTALLATO', async (code) => {
    h.rpc = () => ({ data: null, error: { code, message: 'manca' } })
    const res = await put({ alunnoId: ALUNNO })
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
  })

  it('42703 dalla funzione è un guasto vero (500), non «CRM non installato»', async () => {
    h.rpc = () => ({ data: null, error: { code: '42703', message: 'colonna inesistente' } })
    const res = await put({ alunnoId: ALUNNO })
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
    expect(logCrm().some((r) => r.livello === 'error')).toBe(true)
  })

  it('la funzione lancia o risponde in modo illeggibile: 500 CRM_OPERAZIONE_NON_RIUSCITA', async () => {
    h.rpc = () => {
      throw new Error('rete caduta')
    }
    const lancia = await put({ alunnoId: ALUNNO })
    expect(lancia.status).toBe(500)
    expect((await lancia.json()).codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')

    rispondeConEsito({ esito: 'boh' })
    const illeggibile = await put({ alunnoId: ALUNNO })
    expect(illeggibile.status).toBe(500)
  })

  it('la colonna alunno_id non c’è ancora (42703 in lettura del bambino): 503, prima di toccare la funzione', async () => {
    h.errori = { crm_bambini: { code: '42703', message: 'column alunno_id does not exist' } }
    const res = await put({ alunnoId: ALUNNO })
    expect(res.status).toBe(503)
    expect(h.chiamateRpc).toEqual([])
  })

  it('un bambino di un’altra sede (scheda di un’altra sede): 403 SEDE_NON_ACCESSIBILE, la funzione non parte', async () => {
    const res = await put({ alunnoId: ALUNNO }, B_SEDE_B, SB)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.chiamateRpc).toEqual([])
  })

  it('un bambino con la scheda giusta e la sede sbagliata non esiste: 404, la funzione non parte', async () => {
    const res = await put({ alunnoId: ALUNNO }, B_INCOERENTE, S1)
    expect(res.status).toBe(404)
    expect(h.chiamateRpc).toEqual([])
  })

  it('un bambino che non è di quella scheda: 404, la funzione non parte', async () => {
    const res = await put({ alunnoId: ALUNNO }, B_SEDE_B, S1)
    expect(res.status).toBe(404)
    expect(h.chiamateRpc).toEqual([])
  })

  it.each([{}, { alunnoId: 'non-un-uuid' }, { alunnoId: 12 }, { alunnoId: null }])(
    'corpo %j: 400, la funzione non parte',
    async (corpo) => {
      const res = await put(corpo)
      expect(res.status).toBe(400)
      expect(h.chiamateRpc).toEqual([])
    },
  )

  it('id nel percorso che non sono uuid: 400', async () => {
    const res = await PUT(richiesta('PUT', URL_ALUNNO('x', 'y'), { alunnoId: ALUNNO }), ctx('x', 'y'))
    expect(res.status).toBe(400)
  })

  it.each(['coordinator', 'parent'])('il ruolo %s non entra: 403, nessuna lettura', async (ruolo) => {
    h.ruolo = ruolo
    const res = await put({ alunnoId: ALUNNO })
    expect(res.status).toBe(403)
    expect(h.chiamateRpc).toEqual([])
    expect(h.letture).toEqual([])
  })

  it('la Direzione entra', async () => {
    h.ruolo = 'admin'
    h.db.utenti = [{ id: USER, nome: 'Anna', cognome: 'Prova', ruolo: 'admin', scuola_id: SEDE_A, archiviato_il: null }]
    h.db.utenti_scuole = [{ utente_id: USER, scuola_id: SEDE_A }]
    rispondeConEsito({ esito: 'ok', collegato: true, passaggio: null })
    const res = await put({ alunnoId: ALUNNO })
    expect(res.status).toBe(200)
  })

  it('nei log non finisce nessun dato personale', async () => {
    rispondeConEsito({ esito: 'sede_diversa' })
    await put({ alunnoId: ALUNNO })
    rispondeConEsito({ esito: 'ok', collegato: true, passaggio: null })
    await put({ alunnoId: ALUNNO })
    const testo = JSON.stringify(h.log)
    for (const dato of ['Bimbo', 'Famiglia', 'Anna']) expect(testo, `«${dato}» è finito in un log`).not.toContain(dato)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DELETE …/alunno
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE …/alunno — toglie il collegamento, finché la quota non è in contabilità', () => {
  it('scollega: azzera alunno e data, scrive l’evento alunno_scollegato, risponde 200', async () => {
    const res = await del(B_ALUNNO)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { scollegato: true } })

    const dopo = riga('crm_bambini', B_ALUNNO)
    expect(dopo?.alunno_id).toBeNull()
    expect(dopo?.alunno_collegato_il).toBeNull()

    const eventi = h.db.crm_eventi
    expect(eventi).toHaveLength(1)
    expect(eventi[0]).toMatchObject({
      scheda_id: S1,
      scuola_id: SEDE_A,
      tipo: 'alunno_scollegato',
      autore: USER,
      autore_via: 'segreteria',
      dati: { bambino_id: B_ALUNNO, alunno_id: ALUNNO },
    })
    expect(logCrm().some((r) => r.campi.esito === 'alunno-scollegato' && r.campi.entita_id === B_ALUNNO)).toBe(true)
  })

  it('l’update porta la sede e lo stato della quota nella STESSA istruzione', async () => {
    await del(B_ALUNNO)
    const aggiornamenti = scritto('crm_bambini').filter((s) => s.operazione === 'update')
    expect(aggiornamenti).toHaveLength(1)
    expect(aggiornamenti[0].colpite.map((r) => r.id)).toEqual([B_ALUNNO])
    expect(aggiornamenti[0].valori[0]).toMatchObject({ alunno_id: null, alunno_collegato_il: null })
  })

  it.each([null, 'senza_importo', 'in_attesa', 'bloccata'])('con la quota %s si scollega', async (quota) => {
    h.db.crm_bambini = [bambino(B_ALUNNO, SEDE_A, S1, { alunno_id: ALUNNO, quota_stato: quota })]
    const res = await del(B_ALUNNO)
    expect(res.status).toBe(200)
    expect(riga('crm_bambini', B_ALUNNO)?.alunno_id).toBeNull()
  })

  it('scollega: con la quota in contabilità 409 QUOTA_GIA_IN_CONTABILITA, e il collegamento resta', async () => {
    h.db.crm_bambini = [bambino(B_ALUNNO, SEDE_A, S1, { alunno_id: ALUNNO, quota_stato: 'in_contabilita' })]
    const res = await del(B_ALUNNO)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('QUOTA_GIA_IN_CONTABILITA')

    // Il filtro sta nell'istruzione: la riga non è stata toccata, e nessun evento è stato scritto.
    expect(riga('crm_bambini', B_ALUNNO)?.alunno_id).toBe(ALUNNO)
    expect(h.db.crm_eventi).toEqual([])
  })

  it('un bambino non collegato: 200 senza scrivere niente (nessun evento fantasma)', async () => {
    const res = await del(B_LIBERO)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { scollegato: false } })
    expect(scritto('crm_bambini')).toEqual([])
    expect(h.db.crm_eventi).toEqual([])
  })

  it('un bambino di un’altra sede: 403, niente scritto', async () => {
    h.db.crm_bambini = [bambino(B_SEDE_B, SEDE_B, SB, { alunno_id: ALUNNO_B })]
    const res = await del(B_SEDE_B, SB)
    expect(res.status).toBe(403)
    expect(riga('crm_bambini', B_SEDE_B)?.alunno_id).toBe(ALUNNO_B)
  })

  it('un bambino con la sede incoerente: 404, niente scritto', async () => {
    h.db.crm_bambini = [bambino(B_INCOERENTE, SEDE_B, S1, { alunno_id: ALUNNO_B })]
    const res = await del(B_INCOERENTE, S1)
    expect(res.status).toBe(404)
    expect(riga('crm_bambini', B_INCOERENTE)?.alunno_id).toBe(ALUNNO_B)
  })

  it('un guasto del database in scrittura: 500, non un finto successo', async () => {
    h.errori = { 'crm_bambini:update': { code: '57014', message: 'timeout' } }
    const res = await del(B_ALUNNO)
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
    expect(h.db.crm_eventi).toEqual([])
  })

  it('il ruolo coordinator non entra: 403', async () => {
    h.ruolo = 'coordinator'
    expect((await del(B_ALUNNO)).status).toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/crm/alunni
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/crm/alunni — la ricerca fra gli alunni della sede', () => {
  const alunno = (id: string, nome: string, cognome: string, sede: string, extra: Record<string, unknown> = {}) => ({
    id,
    scuola_id: sede,
    nome,
    cognome,
    data_nascita: '2024-03-05',
    stato: 'iscritto',
    codice_fiscale: 'XXXXXX00X00X000X',
    allergies: 'testo libero',
    ...extra,
  })
  const uuidN = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  beforeEach(() => {
    h.db.alunni = [
      alunno(uuidN(1), 'Bimbo', 'Prova', SEDE_A),
      alunno(uuidN(2), 'Bimba', 'Esempio', SEDE_A),
      alunno(uuidN(3), 'Bimbo', 'Altrove', SEDE_B),
    ]
  })

  it('q di 1 carattere → 400', async () => {
    const res = await cerca(`scuolaId=${SEDE_A}&q=b`)
    expect(res.status).toBe(400)
    expect(h.letture).not.toContain('alunni')
  })

  it.each(['', '%', '%%', ',()', '  '])('q %j (vuota o fatta di soli caratteri tolti) → 400', async (q) => {
    const res = await cerca(`scuolaId=${SEDE_A}&q=${encodeURIComponent(q)}`)
    expect(res.status).toBe(400)
    expect(h.letture).not.toContain('alunni')
  })

  it('manca q o manca la sede → 400', async () => {
    expect((await cerca(`scuolaId=${SEDE_A}`)).status).toBe(400)
    expect((await cerca('q=bimbo')).status).toBe(400)
    expect((await cerca(`scuolaId=non-un-uuid&q=bimbo`)).status).toBe(400)
  })

  it('filtra per sede nella stessa query: un alunno di un’altra sede non esce mai', async () => {
    const res = await cerca(`scuolaId=${SEDE_A}&q=bimbo`)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.map((r: { id: string }) => r.id)).toEqual([uuidN(1)])
  })

  it('cerca su nome e su cognome, senza badare alle maiuscole', async () => {
    const perNome = await (await cerca(`scuolaId=${SEDE_A}&q=BIMBA`)).json()
    expect(perNome.data.map((r: { id: string }) => r.id)).toEqual([uuidN(2)])
    const perCognome = await (await cerca(`scuolaId=${SEDE_A}&q=esemp`)).json()
    expect(perCognome.data.map((r: { id: string }) => r.id)).toEqual([uuidN(2)])
  })

  it('restituisce SOLO id, nome, cognome e data di nascita: niente codice fiscale, niente sanitari', async () => {
    const { data } = await (await cerca(`scuolaId=${SEDE_A}&q=bimbo`)).json()
    expect(data).toEqual([{ id: uuidN(1), nome: 'Bimbo', cognome: 'Prova', data_nascita: '2024-03-05' }])
  })

  it('solo gli iscritti: un alunno ritirato o sospeso non si offre', async () => {
    h.db.alunni = [
      alunno(uuidN(1), 'Bimbo', 'Iscritto', SEDE_A),
      alunno(uuidN(2), 'Bimbo', 'Ritirato', SEDE_A, { stato: 'ritirato' }),
      alunno(uuidN(3), 'Bimbo', 'Sospeso', SEDE_A, { stato: 'sospeso' }),
    ]
    const { data } = await (await cerca(`scuolaId=${SEDE_A}&q=bimbo`)).json()
    expect(data.map((r: { id: string }) => r.id)).toEqual([uuidN(1)])
  })

  it('al massimo 20 risultati', async () => {
    h.db.alunni = Array.from({ length: 25 }, (_, i) => alunno(uuidN(100 + i), 'Bimbo', `Cognome${i}`, SEDE_A))
    const { data } = await (await cerca(`scuolaId=${SEDE_A}&q=bimbo`)).json()
    expect(data).toHaveLength(20)
  })

  it('la sede di un altro plesso: 403 SEDE_NON_ACCESSIBILE, nessuna lettura degli alunni', async () => {
    const res = await cerca(`scuolaId=${SEDE_B}&q=bimbo`)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.letture).not.toContain('alunni')
  })

  it('i caratteri del filtro PostgREST non si iniettano: «,» «(» «)» «%» si tolgono dal testo', async () => {
    // Senza ripulire, `Bim,scuola_id.neq.x` aggiungerebbe una condizione al filtro `.or(…)`.
    const iniezione = await (await cerca(`scuolaId=${SEDE_A}&q=${encodeURIComponent('xx,scuola_id.neq.zz')}`)).json()
    expect(iniezione.data).toEqual([])
    // Il testo ripulito cerca lo stesso: «Bim,bo» diventa «Bimbo».
    const ripulita = await (await cerca(`scuolaId=${SEDE_A}&q=${encodeURIComponent('Bim,bo(')}`)).json()
    expect(ripulita.data.map((r: { id: string }) => r.id)).toEqual([uuidN(1)])
  })

  it('un guasto del database: 500 CRM_OPERAZIONE_NON_RIUSCITA, non un elenco vuoto', async () => {
    h.errori = { alunni: { code: '57014', message: 'timeout' } }
    const res = await cerca(`scuolaId=${SEDE_A}&q=bimbo`)
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
  })

  it('il ruolo coordinator non entra: 403', async () => {
    h.ruolo = 'coordinator'
    expect((await cerca(`scuolaId=${SEDE_A}&q=bimbo`)).status).toBe(403)
  })

  it('nei log non finisce il testo cercato né i nomi', async () => {
    await cerca(`scuolaId=${SEDE_A}&q=bimbo`)
    await cerca(`scuolaId=${SEDE_B}&q=bimbo`)
    const testo = JSON.stringify(h.log)
    for (const dato of ['Bimbo', 'bimbo', 'Prova', 'Esempio']) expect(testo, `«${dato}» è finito in un log`).not.toContain(dato)
  })
})
