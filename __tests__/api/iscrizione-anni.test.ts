// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_E2E } from '../fixtures/sedi'
import { STANDARD_ENROLLMENT_MODEL_ID } from '@/lib/forms/enrollment-default-schema'

/**
 * Compito 4.5.7 · il modulo pubblico: la famiglia sceglie l'anno.
 *
 *  · `GET /api/iscrizione/anni?scuola_id=` — l'elenco PUBBLICO degli anni che accettano domande;
 *  · `POST /api/iscrizione` con `anno_id` — la domanda porta l'anno scelto, e un anno non offerto è un
 *    rifiuto (422), non un ripiego silenzioso sul `corrente`.
 *
 * Database finto che applica filtri e scritture; `annoPerScritturaPubblica` è quello vero. Gli anni sono
 * scritti negli stati, mai letti dall'orologio. Uuid e dati finti: nessun dato di una famiglia vera.
 * `anni_scolastici.id` = `a…`, `anni_sede.id` = `b…`.
 */

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message?: string }>,
  erroriInsert: [] as ({ code: string; message?: string } | null)[],
  chiamateInsert: 0,
  scritture: [] as unknown[],
  rl: { ok: true, remaining: 29, retryAfterMs: 0 },
  logEvento: vi.fn(),
  email: vi.fn(),
}))

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn(() => h.rl),
  clientIp: vi.fn(() => 'ip'),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/email/send', () => ({
  sendEmailDetailed: (m: unknown) => {
    h.email(m)
    return Promise.resolve({ ok: true })
  },
}))
vi.mock('@/lib/email/contesto', () => ({
  risolviContestoSede: async () => ({
    nome: 'Sede Alfa', indirizzo: null, telefono: null, email: null,
    app: 'https://app.example.test', privacy: 'https://app.example.test/privacy',
  }),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const vero = creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori, scritture: h.scritture as Scrittura[] })
    return {
      from(tabella: string) {
        const b = vero.from(tabella)
        if (tabella !== 'enrollment_submissions') return b
        return {
          insert(riga: Riga) {
            const errore = h.erroriInsert[h.chiamateInsert++] ?? null
            if (!errore) return b.insert(riga)
            return { select: () => ({ single: async () => ({ data: null, error: errore }) }) }
          },
        }
      },
    }
  },
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})

import { GET as ELENCO_ANNI } from '@/app/api/iscrizione/anni/route'
import { GET as ELENCO_SEDI } from '@/app/api/iscrizione/sedi/route'
import { POST } from '@/app/api/iscrizione/route'
import { messaggioRicevutaIscrizione } from '@/lib/email/messaggi/ricevuta-iscrizione'

// `anni_scolastici.id`
const A_CORR = 'a2222222-2222-4222-8222-222222222222' // 2026/27, corrente
const A_PROSS = 'a3333333-3333-4333-8333-333333333333' // 2027/28, in preparazione
const A_CHIUSO = 'a1111111-1111-4111-8111-111111111111' // 2025/26, chiuso
const A_ALTRO = 'a9999999-9999-4999-8999-999999999999' // un anno che la sede non ha
// `anni_sede.id`
const S_CORR = 'b2222222-2222-4222-8222-222222222222'
const S_PROSS = 'b3333333-3333-4333-8333-333333333333'
const S_CHIUSO = 'b1111111-1111-4111-8111-111111111111'

const modello = {
  id: STANDARD_ENROLLMENT_MODEL_ID,
  schema: {
    version: '1',
    pages: [
      { id: 'bambino', title: 'B', fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true }] },
      { id: 'adulto', title: 'A', fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true }] },
    ],
  },
}

const anniScolastici = () => [
  { id: A_CHIUSO, anno_inizio: 2025, etichetta_breve: '2025/26' },
  { id: A_CORR, anno_inizio: 2026, etichetta_breve: '2026/27' },
  { id: A_PROSS, anno_inizio: 2027, etichetta_breve: '2027/28' },
]

const richiestaAnni = (scuolaId?: string, extra = '') =>
  new NextRequest(`http://localhost/api/iscrizione/anni${scuolaId === undefined ? '' : `?scuola_id=${scuolaId}`}${extra}`)

type CorpoAnni = {
  success?: boolean
  data?: { anni: Record<string, unknown>[]; scelta: boolean; chiuso: boolean }
  error?: string
}

const invia = (scuolaId?: string, annoId?: string, adults: Record<string, unknown>[] = [{ nome: 'Ines' }]) =>
  POST(
    new NextRequest('http://localhost/api/iscrizione', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scuola_id: scuolaId,
        ...(annoId ? { anno_id: annoId } : {}),
        data: { presa_visione_informativa: true, children: [{ nome: 'Tino' }], adults },
      }),
    }),
  )

const inserimenti = () =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === 'enrollment_submissions' && s.operazione === 'insert')
const warn = (tipo: string) =>
  h.logEvento.mock.calls.filter((c) => c[0] === 'anno-scolastico' && c[1] === 'warn' && c[2]?.tipo === tipo)

beforeEach(() => {
  h.errori = {}
  h.erroriInsert = []
  h.chiamateInsert = 0
  h.scritture = []
  h.rl = { ok: true, remaining: 29, retryAfterMs: 0 }
  h.logEvento.mockClear()
  h.email.mockClear()
  h.db = {
    schools: [{ id: SEDE_A, nome: 'Sede Alfa' }],
    scuole: [],
    form_models: [modello],
    enrollment_submissions: [],
    anni_scolastici: anniScolastici(),
    anni_sede: [
      { id: S_CHIUSO, scuola_id: SEDE_A, anno_id: A_CHIUSO, stato: 'chiuso', domande_aperte: false },
      { id: S_CORR, scuola_id: SEDE_A, anno_id: A_CORR, stato: 'corrente', domande_aperte: true },
      { id: S_PROSS, scuola_id: SEDE_A, anno_id: A_PROSS, stato: 'in_preparazione', domande_aperte: true },
    ],
  }
})

describe('GET /api/iscrizione/anni · l\'elenco pubblico', () => {
  it('offre solo gli anni con le domande aperte: corrente "durante", gli altri "inizio", scelta vera', async () => {
    const res = await ELENCO_ANNI(richiestaAnni(SEDE_A))
    expect(res.status).toBe(200)
    const corpo = (await res.json()) as CorpoAnni
    expect(corpo.success).toBe(true)
    expect(corpo.data?.scelta).toBe(true)
    expect(corpo.data?.anni).toEqual([
      { anno_id: A_CORR, etichetta_breve: '2026/27', ingresso: 'durante' },
      { anno_id: A_PROSS, etichetta_breve: '2027/28', ingresso: 'inizio' },
    ])
  })

  it('NON espone date, stati, uuid di sede né altro che id, etichetta e tipo', async () => {
    h.db.anni_sede[2] = { ...h.db.anni_sede[2], inizio: '2027-09-01', fine: '2028-08-31', note: 'segreta' }
    h.db.anni_scolastici = anniScolastici().map((a) => ({ ...a, inizio: '2026-09-01', stato_interno: 'x' }))
    const res = await ELENCO_ANNI(richiestaAnni(SEDE_A))
    const corpo = (await res.json()) as CorpoAnni
    // Tutto il corpo ha solo `anni`, `scelta` e `chiuso` (un booleano): niente altro che un genitore non debba vedere.
    expect(Object.keys(corpo.data ?? {}).sort()).toEqual(['anni', 'chiuso', 'scelta'])
    for (const anno of corpo.data?.anni ?? []) {
      expect(Object.keys(anno).sort()).toEqual(['anno_id', 'etichetta_breve', 'ingresso'])
    }
    const grezzo = JSON.stringify(corpo.data?.anni)
    for (const vietato of ['corrente', 'in_preparazione', 'chiuso', 'stato', '2026-09', '2027-09', 'segreta', S_CORR, S_PROSS, SEDE_A]) {
      expect(grezzo).not.toContain(vietato)
    }
  })

  it('un solo anno offerto: l\'elenco c\'è ma scelta è falsa', async () => {
    h.db.anni_sede[2] = { ...h.db.anni_sede[2], domande_aperte: false }
    const corpo = (await (await ELENCO_ANNI(richiestaAnni(SEDE_A))).json()) as CorpoAnni
    expect(corpo.data).toEqual({
      anni: [{ anno_id: A_CORR, etichetta_breve: '2026/27', ingresso: 'durante' }],
      scelta: false,
      chiuso: false,
    })
  })

  it('nessun anno offerto: elenco vuoto, scelta falsa e chiuso vero (il wizard lo dice prima di far compilare)', async () => {
    h.db.anni_sede = h.db.anni_sede.map((r) => ({ ...r, domande_aperte: false }))
    const corpo = (await (await ELENCO_ANNI(richiestaAnni(SEDE_A))).json()) as CorpoAnni
    expect(corpo.data).toEqual({ anni: [], scelta: false, chiuso: true })
  })

  it('una sede SENZA alcuna riga di anni (appena nata): non è "chiusa", è senza anno — e il POST scrive come sempre', async () => {
    h.db.anni_sede = []
    const corpo = (await (await ELENCO_ANNI(richiestaAnni(SEDE_A))).json()) as CorpoAnni
    expect(corpo.data).toEqual({ anni: [], scelta: false, chiuso: false })
    const res = await invia(SEDE_A)
    expect(res.status).toBe(201)
    expect(inserimenti()[0].valori[0]).not.toHaveProperty('anno_id')
  })

  it('porta la cache pubblica di 60 secondi sulla risposta buona', async () => {
    const res = await ELENCO_ANNI(richiestaAnni(SEDE_A))
    const cc = res.headers.get('Cache-Control') ?? ''
    expect(cc).toContain('public')
    expect(cc).toContain('max-age=60')
    expect(cc).not.toContain('max-age=600')
  })

  it('senza scuola_id o con un valore che non è un uuid: 400, niente lettura', async () => {
    expect((await ELENCO_ANNI(richiestaAnni())).status).toBe(400)
    expect((await ELENCO_ANNI(richiestaAnni('non-un-uuid'))).status).toBe(400)
  })

  it('una sede che non è fra quelle del deployment: 400 SEDE_DA_SPECIFICARE, e nessun anno trapela', async () => {
    const res = await ELENCO_ANNI(richiestaAnni(SEDE_B))
    expect(res.status).toBe(400)
    const corpo = await res.json()
    expect(corpo.codice).toBe('SEDE_DA_SPECIFICARE')
    expect(JSON.stringify(corpo)).not.toContain(A_CORR)
  })

  it('rate limit superato: 429 con Retry-After, senza cache', async () => {
    h.rl = { ok: false, remaining: 0, retryAfterMs: 61_000 }
    const res = await ELENCO_ANNI(richiestaAnni(SEDE_A))
    expect(res.status).toBe(429)
    expect((await res.json()).codice).toBe('TROPPE_RICHIESTE')
    expect(res.headers.get('Retry-After')).toBe('61')
    expect(res.headers.get('Cache-Control') ?? '').not.toContain('public')
  })

  it('schema indietro (E2E non migrato): 200, scelta falsa, nessun errore e nessuna cache', async () => {
    h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
    const res = await ELENCO_ANNI(richiestaAnni(SEDE_A))
    expect(res.status).toBe(200)
    // `chiuso: false`: un database in ritardo NON è "iscrizioni chiuse".
    expect(((await res.json()) as CorpoAnni).data).toEqual({ anni: [], scelta: false, chiuso: false })
    expect(res.headers.get('Cache-Control') ?? '').not.toContain('public')
    expect(h.logEvento.mock.calls.filter((c) => c[1] === 'error')).toHaveLength(0)
  })

  it('colonna domande_aperte assente (42703): lo stesso degrado pulito', async () => {
    h.errori = { anni_sede: { code: '42703' } }
    const res = await ELENCO_ANNI(richiestaAnni(SEDE_A))
    expect(res.status).toBe(200)
    expect(((await res.json()) as CorpoAnni).data?.scelta).toBe(false)
  })

  it('un guasto vero di anni_sede (57014): 500 e una riga error, mai un elenco inventato', async () => {
    h.errori = { anni_sede: { code: '57014', message: 'statement timeout' } }
    const res = await ELENCO_ANNI(richiestaAnni(SEDE_A))
    expect(res.status).toBe(500)
    expect(h.logEvento.mock.calls.filter((c) => c[0] === 'anno-scolastico' && c[1] === 'error').length).toBeGreaterThanOrEqual(1)
  })

  it('la sede E2E: un genitore non la vede nell\'elenco delle sedi, ma il suo id regge l\'elenco degli anni (come il POST)', async () => {
    h.db.schools = [
      { id: SEDE_A, nome: 'Sede Alfa' },
      { id: SEDE_E2E, nome: 'Sede di prova e2e' },
    ]
    h.db.anni_sede = [...h.db.anni_sede, { id: 'b5555555-5555-4555-8555-555555555555', scuola_id: SEDE_E2E, anno_id: A_CORR, stato: 'corrente', domande_aperte: true }]
    const sedi = (await (await ELENCO_SEDI(new NextRequest('http://localhost/api/iscrizione/sedi'))).json()) as { data: { id: string }[] }
    expect(sedi.data.map((s) => s.id)).toEqual([SEDE_A])
    expect((await ELENCO_ANNI(richiestaAnni(SEDE_E2E))).status).toBe(200)
  })
})

describe('POST /api/iscrizione · la famiglia sceglie l\'anno', () => {
  it('un anno offerto: la domanda porta quell\'anno_id (anche se non è il corrente)', async () => {
    const res = await invia(SEDE_A, A_PROSS)
    expect(res.status).toBe(201)
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).toMatchObject({ scuola_id: SEDE_A, anno_id: A_PROSS })
  })

  it('un anno_id non offerto: 422 ANNO_NON_OFFERTO e NESSUNA riga scritta', async () => {
    for (const annoId of [A_ALTRO, A_CHIUSO]) {
      const res = await invia(SEDE_A, annoId)
      expect(res.status).toBe(422)
      expect((await res.json()).codice).toBe('ANNO_NON_OFFERTO')
    }
    expect(inserimenti()).toHaveLength(0)
  })

  it('un anno con le domande sospese non è offerto: 422, non il ripiego sul corrente', async () => {
    h.db.anni_sede[2] = { ...h.db.anni_sede[2], domande_aperte: false }
    const res = await invia(SEDE_A, A_PROSS)
    expect(res.status).toBe(422)
    expect(inserimenti()).toHaveLength(0)
  })

  it('due anni offerti e nessuna scelta: il corrente, con un warn anno-pubblico-non-dichiarato', async () => {
    const res = await invia(SEDE_A)
    expect(res.status).toBe(201)
    expect(inserimenti()[0].valori[0]).toMatchObject({ anno_id: A_CORR })
    expect(warn('anno-pubblico-non-dichiarato')).toHaveLength(1)
  })

  it('un solo anno offerto e nessuna scelta: il corrente, senza warn (come oggi)', async () => {
    h.db.anni_sede[2] = { ...h.db.anni_sede[2], domande_aperte: false }
    const res = await invia(SEDE_A)
    expect(res.status).toBe(201)
    expect(inserimenti()[0].valori[0]).toMatchObject({ anno_id: A_CORR })
    expect(warn('anno-pubblico-non-dichiarato')).toHaveLength(0)
  })

  it('nessun anno offerto: 409 ISCRIZIONI_CHIUSE e nessuna riga, con o senza anno_id', async () => {
    h.db.anni_sede = h.db.anni_sede.map((r) => ({ ...r, domande_aperte: false }))
    for (const annoId of [undefined, A_CORR]) {
      const res = await invia(SEDE_A, annoId)
      expect(res.status).toBe(409)
      expect((await res.json()).codice).toBe('ISCRIZIONI_CHIUSE')
    }
    expect(inserimenti()).toHaveLength(0)
  })

  it('anno_id che non è un uuid: 400 dal zod, nessuna riga', async () => {
    const res = await invia(SEDE_A, 'non-un-uuid')
    expect(res.status).toBe(400)
    expect(inserimenti()).toHaveLength(0)
  })

  it('il ripiego senza colonne (PGRST204) scrive lo STESSO anno scelto', async () => {
    h.erroriInsert = [{ code: 'PGRST204', message: 'colonna consents_log assente' }]
    const res = await invia(SEDE_A, A_PROSS)
    expect(res.status).toBe(201)
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).not.toHaveProperty('consents_log')
    expect(inserimenti()[0].valori[0].anno_id).toBe(A_PROSS)
  })

  it('schema indietro (E2E): il POST scrive come oggi, senza anno_id, anche se la famiglia ne ha dichiarato uno', async () => {
    h.errori = { anni_sede: { code: 'PGRST205' } }
    for (const annoId of [undefined, A_PROSS]) {
      h.scritture = []
      h.chiamateInsert = 0
      const res = await invia(SEDE_A, annoId)
      expect(res.status).toBe(201)
      expect(inserimenti()[0].valori[0]).not.toHaveProperty('anno_id')
    }
    expect(h.logEvento.mock.calls.filter((c) => c[1] === 'error')).toHaveLength(0)
  })

  it('nel log entrano solo codici e uuid: mai il nome del bambino né dell\'adulto', async () => {
    await invia(SEDE_A, A_ALTRO)
    await invia(SEDE_A)
    const log = JSON.stringify(h.logEvento.mock.calls)
    expect(log).not.toContain('Tino')
    expect(log).not.toContain('Ines')
  })
})

describe('La ricevuta dice l\'anno quando non è il corrente', () => {
  const adulti = [{ nome: 'Ines', cognome: 'Prova', email: 'famiglia@example.test' }]
  const testoInviato = () => String((h.email.mock.calls[0]?.[0] as { text?: string } | undefined)?.text ?? '')

  it('anno non corrente: una riga con l\'etichetta', async () => {
    const res = await invia(SEDE_A, A_PROSS, adulti)
    expect(res.status).toBe(201)
    expect(h.email).toHaveBeenCalledTimes(1)
    expect(testoInviato()).toContain('2027/28')
  })

  it('anno corrente: nessuna riga in più', async () => {
    const res = await invia(SEDE_A, A_CORR, adulti)
    expect(res.status).toBe(201)
    expect(h.email).toHaveBeenCalledTimes(1)
    expect(testoInviato()).not.toContain('Anno scolastico')
    expect(testoInviato()).not.toContain('2026/27')
  })

  it('il messaggio: la riga c\'è con l\'anno e manca senza', () => {
    const base = { riferimento: 'ISC-AAAA1111', inviataIl: '01/01/2027 10:00', nomeBambino: 'Tino Prova' }
    const sede = {
      nome: 'Sede Alfa', indirizzo: null, telefono: null, email: null,
      app: 'https://app.example.test', privacy: 'https://app.example.test/privacy',
    }
    const con = messaggioRicevutaIscrizione({ ...base, anno: '2027/28' }, sede)
    const senza = messaggioRicevutaIscrizione(base, sede)
    expect(con.testo).toContain('Anno scolastico')
    expect(con.testo).toContain('2027/28')
    expect(con.html).toContain('2027/28')
    expect(senza.testo).not.toContain('Anno scolastico')
  })
})
