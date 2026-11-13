import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { improntaToken } from '@/lib/crm/ai/token'
import {
  ADMIN_AI as ADMIN, INTEGRAZIONE_A, INTEGRAZIONE_B, INTEGRAZIONE_REVOCATA,
  TOKEN_A, accendiAi, integrazioniFinte,
} from '../fixtures/crm-ai'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({
  ruolo: 'admin',
  db: {} as DBFinto,
  errori: {} as Record<string, ErrorePostgrest>,
  scritture: [] as Scrittura[],
  tabelle: [] as string[],
  concorrenza: null as (() => void) | null,
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async (_request: Request, ruoli: readonly string[]) =>
    ruoli.includes(h.ruolo)
      ? { user: { id: ADMIN, role: h.ruolo, scuola_id: null } }
      : { response: NextResponse.json({ error: 'Accesso negato.' }, { status: 403 }) },
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const vero = creaFintoSupabase(h.db, h.tabelle, { errori: h.errori, scritture: h.scritture })
    let chiamateIntegrazioni = 0
    return new Proxy(vero, {
      get(bersaglio, prop, ricevitore) {
        if (prop !== 'from') return Reflect.get(bersaglio, prop, ricevitore)
        return (tabella: string) => {
          // Un'altra revoca si conclude dopo la prima lettura e prima della scrittura.
          if (tabella === 'crm_integrazioni' && ++chiamateIntegrazioni === 2) h.concorrenza?.()
          return bersaglio.from(tabella)
        }
      },
    })
  },
}))
vi.mock('@/lib/logging/logger', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: h.logErrore,
  logOk: h.logOk,
}))

import { GET, POST } from '@/app/api/admin/crm/integrazioni/route'
import { DELETE } from '@/app/api/admin/crm/integrazioni/[id]/route'

const URL = 'http://localhost/api/admin/crm/integrazioni'
const get = (sede = SEDE_A, cookie?: string) =>
  new NextRequest(URL + '?scuolaId=' + sede, { headers: cookie ? { cookie } : undefined })
const post = (corpo: unknown) =>
  new NextRequest(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })
const del = (id = INTEGRAZIONE_A) => new NextRequest(URL + '/' + id, { method: 'DELETE' })
const ctx = (id = INTEGRAZIONE_A) => ({ params: Promise.resolve({ id }) })
const integrazione = (id = INTEGRAZIONE_A) => h.db.crm_integrazioni.find((riga) => riga.id === id)
const scritte = () => h.scritture.filter(({ tabella }) => tabella === 'crm_integrazioni')
const righeLog = () => JSON.stringify([h.logEvento.mock.calls, h.logErrore.mock.calls, h.logOk.mock.calls])

beforeEach(() => {
  h.ruolo = 'admin'
  h.db = {
    utenti_scuole: [
      { utente_id: ADMIN, scuola_id: SEDE_A },
      { utente_id: ADMIN, scuola_id: SEDE_B },
    ],
    crm_integrazioni: integrazioniFinte(),
  }
  h.errori = {}
  h.tabelle = []
  h.scritture = []
  h.concorrenza = null
  vi.clearAllMocks()
  accendiAi([SEDE_A, SEDE_B])
})

afterEach(() => vi.unstubAllEnvs())

describe('Chiavi dell’assistente · API della Direzione', () => {
  it('la segreteria non crea, non elenca e non revoca: 403 SOLO_ADMIN', async () => {
    h.ruolo = 'segreteria'
    const richiesta = post({ scuolaId: SEDE_A, nome: 'Assistente' })
    const leggiCorpo = vi.spyOn(richiesta, 'json')
    for (const r of [await GET(get('non-uuid')), await POST(richiesta), await DELETE(del(), ctx('non-uuid'))]) {
      expect(r.status).toBe(403)
      expect(await r.json()).toMatchObject({ codice: 'SOLO_ADMIN' })
    }
    expect(leggiCorpo).not.toHaveBeenCalled()
    expect(h.tabelle).toEqual([])
    expect(scritte()).toEqual([])
  })

  it('crea la chiave: la risposta porta il token, il database solo l’impronta', async () => {
    h.db.crm_integrazioni = []
    const r = await POST(post({ scuolaId: SEDE_A, nome: '  Assistente  ' }))
    expect(r.status).toBe(201)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const { id, token } = await r.json()
    expect(token).toMatch(/^kvai_[A-Za-z0-9_-]{43}$/)
    const impronta = improntaToken(token)
    expect(h.db.crm_integrazioni).toEqual([
      { id, scuola_id: SEDE_A, nome: 'Assistente', token_impronta: impronta, token_coda: token.slice(-4), creata_da: ADMIN },
    ])
    expect(JSON.stringify(h.db)).not.toContain(token)
    expect(righeLog()).not.toContain(token)
    expect(righeLog()).not.toContain(impronta)
  })

  it('la sede non ammessa non riceve una chiave: 403 SEDE_NON_AMMESSA', async () => {
    accendiAi([SEDE_B])
    const r = await POST(post({ scuolaId: SEDE_A, nome: 'Assistente' }))
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ codice: 'SEDE_NON_AMMESSA' })
    expect(h.tabelle).not.toContain('crm_integrazioni')
    expect(scritte()).toEqual([])
  })

  it('la sede ha già una chiave attiva (23505): 409 INTEGRAZIONE_ESISTENTE', async () => {
    h.errori = { 'crm_integrazioni:insert': { code: '23505', message: 'duplicate key' } }
    const r = await POST(post({ scuolaId: SEDE_A, nome: 'Seconda' }))
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ codice: 'INTEGRAZIONE_ESISTENTE' })
    expect(scritte()).toEqual([])
  })

  it('l’elenco non porta mai l’impronta, e dice se l’interruttore è acceso per quella sede', async () => {
    // In archivio la vecchia riga viene prima: è la query a ordinare l’elenco.
    h.db.crm_integrazioni.reverse()
    const r = await GET(get())
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.aiAttivo).toBe(true)
    expect(j.sedeAmmessa).toBe(true)
    expect(j.data.map((x: { id: string }) => x.id)).toEqual([INTEGRAZIONE_A, INTEGRAZIONE_REVOCATA])
    expect(j.data[0]).toEqual({
      id: INTEGRAZIONE_A, nome: 'Assistente', coda: 'AAAA', creataIl: '2026-11-10T09:00:00.000Z',
      revocataIl: null, ultimoUsoIl: null,
    })
    expect(JSON.stringify(j)).not.toContain(improntaToken(TOKEN_A))
    expect(JSON.stringify(j)).not.toContain(TOKEN_A)

    accendiAi([SEDE_B])
    vi.stubEnv('CRM_AI_ATTIVO', '')
    expect(await (await GET(get())).json()).toMatchObject({ aiAttivo: false, sedeAmmessa: false })
    expect(await (await GET(get(SEDE_B))).json()).toMatchObject({ aiAttivo: false, sedeAmmessa: true })
  })

  it('un’admin non vede le chiavi di una sede che non è sua: 403 SEDE_NON_ACCESSIBILE', async () => {
    h.db.utenti_scuole = [{ utente_id: ADMIN, scuola_id: SEDE_A }]
    for (const r of [
      await GET(get(SEDE_B)),
      await POST(post({ scuolaId: SEDE_B, nome: 'Assistente' })),
      await DELETE(del(INTEGRAZIONE_B), ctx(INTEGRAZIONE_B)),
    ]) {
      expect(r.status).toBe(403)
      expect(await r.json()).toMatchObject({ codice: 'SEDE_NON_ACCESSIBILE' })
    }
    expect(integrazione(INTEGRAZIONE_B)?.revocata_il).toBeNull()
    expect(scritte()).toEqual([])
  })

  it('l’elenco rispetta la sede attiva e la creazione nega lo scope vuoto', async () => {
    const r = await GET(get(SEDE_B, 'sedi_attive=' + SEDE_A))
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ codice: 'SEDE_NON_ACCESSIBILE' })
    h.db.utenti_scuole = []
    const creazione = await POST(post({ scuolaId: SEDE_A, nome: 'Assistente' }))
    expect(creazione.status).toBe(403)
    expect(await creazione.json()).toMatchObject({ codice: 'SEDE_NON_ACCESSIBILE' })
    expect(h.tabelle).not.toContain('crm_integrazioni')
  })

  it('valida sede, nome e id prima di aprire il database', async () => {
    for (const r of [
      await GET(get('non-uuid')),
      await POST(post({ scuolaId: SEDE_A, nome: ' ' })),
      await POST(post({ scuolaId: SEDE_A, nome: 'a'.repeat(81) })),
      await POST(post({ scuolaId: SEDE_A, nome: 'Assistente', inatteso: true })),
      await DELETE(del('non-uuid'), ctx('non-uuid')),
    ]) expect(r.status).toBe(400)
    expect(h.tabelle).toEqual([])
  })

  it('revoca: scrive quando e chi, e la seconda volta risponde lo stesso 200 senza riscrivere', async () => {
    const r1 = await DELETE(del(), ctx())
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ id: INTEGRAZIONE_A, revocata: true })
    expect(integrazione()?.revocata_da).toBe(ADMIN)
    const quando = integrazione()?.revocata_il
    expect(typeof quando).toBe('string')
    const r2 = await DELETE(del(), ctx())
    expect(r2.status).toBe(200)
    expect(await r2.json()).toEqual({ id: INTEGRAZIONE_A, revocata: true })
    expect(integrazione()?.revocata_il).toBe(quando)
    expect(scritte().map(({ operazione }) => operazione)).toEqual(['update'])
  })

  it('due revoche sovrapposte conservano la data e l’autore di quella già scritta', async () => {
    const prima = { revocata_il: '2026-11-11T10:00:00.000Z', revocata_da: '20000000-0000-4000-8000-0000000000bb' }
    h.concorrenza = () => Object.assign(h.db.crm_integrazioni[0], prima)
    const r = await DELETE(del(), ctx())
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ id: INTEGRAZIONE_A, revocata: true })
    expect(integrazione()).toMatchObject(prima)
    expect(scritte().flatMap(({ colpite }) => colpite)).toEqual([])
  })

  it('una chiave che non esiste: 404 ELEMENTO_NON_TROVATO', async () => {
    const id = '50000000-0000-4000-8000-000000000404'
    const r = await DELETE(del(id), ctx(id))
    expect(r.status).toBe(404)
    expect(await r.json()).toMatchObject({ codice: 'ELEMENTO_NON_TROVATO' })
    expect(scritte()).toEqual([])
  })

  it('D1 · ruotare: revoca la chiave consegnata, poi ne crea una nuova per la stessa sede', async () => {
    expect((await DELETE(del(), ctx())).status).toBe(200)
    const r = await POST(post({ scuolaId: SEDE_A, nome: 'Assistente' }))
    expect(r.status).toBe(201)
    const { id, token } = await r.json()
    expect(token).not.toBe(TOKEN_A)
    // Il database finto non applica i default SQL: la chiave nuova non ha la data di revoca.
    const attive = h.db.crm_integrazioni.filter((x) => x.scuola_id === SEDE_A && x.revocata_il == null)
    expect(attive.map((x) => x.id)).toEqual([id])
    expect(typeof integrazione()?.revocata_il).toBe('string')
  })

  it.each([
    ['crm_integrazioni:select', 'PGRST205', 503, 'CRM_NON_INSTALLATO', () => GET(get())],
    ['crm_integrazioni:insert', '23514', 500, 'CRM_OPERAZIONE_NON_RIUSCITA', () => POST(post({ scuolaId: SEDE_A, nome: 'Assistente' }))],
    ['crm_integrazioni:update', '42703', 503, 'CRM_NON_INSTALLATO', () => DELETE(del(), ctx())],
  ] as const)('traduce %s (%s) e ai log passa solo il codice', async (operazione, code, stato, codice, chiama) => {
    const errore = { code, message: 'messaggio-' + TOKEN_A, details: improntaToken(TOKEN_A), hint: 'dettaglio-riservato' }
    h.errori = { [operazione]: errore }
    const r = await chiama()
    expect(r.status).toBe(stato)
    expect(await r.json()).toEqual({ error: expect.any(String), codice })
    expect([...h.logEvento.mock.calls, ...h.logErrore.mock.calls]).toContainEqual(
      expect.arrayContaining([{ code }]),
    )
    for (const campo of [errore.message, errore.details, errore.hint]) expect(righeLog()).not.toContain(campo)
    expect(scritte()).toEqual([])
  })
})
