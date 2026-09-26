import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C, SEDE_E2E, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_E2E } from '../fixtures/sedi'

// =============================================================================
// Configurazione per sede — `admin/settings` e `admin/settings/categorie`.
//
// Due difetti gemelli, entrambi invisibili finché la sede era una sola:
//
//  1. `payment_categories` PATCH/DELETE lavoravano per solo `id`. Le 5 causali di
//     produzione hanno tutte `scuola_id` NULL, cioè sono GLOBALI: valgono per
//     tutti e tre i plessi. Una segreteria di plesso poteva rinominarle (la PATCH
//     non aveva nemmeno il guard `is_sistema` che la DELETE ha) ed eliminare le
//     due non di sistema — con ricaduta contabile su tutte le sedi. E appena
//     nascerà la prima causale DI plesso (il POST la sede la scrive già), quella
//     sarà modificabile da chiunque sia staff altrove conoscendone l'uuid.
//
//  2. `admin/settings` accettava `scuola_id` ma non lo VALIDAVA: un valore fuori
//     scope non veniva rifiutato, veniva **ignorato** e sostituito in silenzio
//     dalla sede di ripiego. Chi credeva di configurare Aversa configurava
//     Giugliano, senza errore e senza log — la stessa forma del guasto che
//     `resolveScuolaScrittura` ha chiuso il 31/07.
//
// Regola applicata (F5b del piano): una riga GLOBALE si LEGGE da tutte le sedi
// ma si MODIFICA solo da chi ha in scope TUTTE le sedi reali (la sede finta E2E
// non conta). Una riga DI SEDE si tocca solo dalla sua sede.
//
// I test girano sul finto client che filtra e scrive DAVVERO, con lo `scope.ts`
// VERO (nessun mock): l'asserzione è sullo stato del database, non sullo stato.
// =============================================================================

const CAT_GLOBALE_SISTEMA = '11111111-1111-4111-8111-111111111111'
const CAT_GLOBALE_LIBERA = '22222222-2222-4222-8222-222222222222'
const CAT_A = '33333333-3333-4333-8333-333333333333'
const CAT_B = '44444444-4444-4444-8444-444444444444'
const CAT_FANTASMA = '55555555-5555-4555-8555-555555555555'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, { code: string }>,
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// Spie che CONSERVANO l'implementazione vera del logger (K2): il log multi-sede
// si verifica senza spegnere redazione e fail-open di produzione.
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  h.logEvento.mockImplementation(vero.logEvento)
  h.logErrore.mockImplementation(vero.logErrore)
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.errori }),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.errori }),
  }
})

import { GET as CAT_GET, POST as CAT_POST, PATCH as CAT_PATCH, DELETE as CAT_DELETE } from '@/app/api/admin/settings/categorie/route'
import { GET as SET_GET, PATCH as SET_PATCH } from '@/app/api/admin/settings/route'

const req = (url: string, cookie?: string) =>
  new NextRequest(`http://localhost${url}`, cookie ? { headers: { cookie } } : undefined)

const reqCorpo = (url: string, metodo: string, corpo: unknown, cookie?: string) =>
  new NextRequest(`http://localhost${url}`, {
    method: metodo,
    headers: cookie
      ? { 'content-type': 'application/json', cookie }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })

const SEGRETERIA_A = { id: 'seg-a', role: 'segreteria', scuola_id: SEDE_A }
const ADMIN_TUTTE = { id: 'admin-1', role: 'admin', scuola_id: SEDE_A }

const dbBase = (): DBFinto => ({
  // Tre sedi in `schools`, di cui una è la sede finta del seed E2E: NON conta
  // come «sede reale», quindi non serve averla in scope per essere full-scope.
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
    { id: SEDE_E2E, nome: NOME_SEDE_E2E },
  ],
  scuole: [
    { id: SEDE_A, attiva: true },
    { id: SEDE_B, attiva: true },
    { id: SEDE_E2E, attiva: true },
  ],
  // Il ponte multi-sede vale solo per l'admin (cfr. scuoleDiUtente).
  utenti_scuole: [
    { utente_id: 'admin-1', scuola_id: SEDE_A },
    { utente_id: 'admin-1', scuola_id: SEDE_B },
  ],
  payment_categories: [
    { id: CAT_GLOBALE_SISTEMA, scuola_id: null, nome: 'Retta', slug: 'retta', is_sistema: true, attivo: true, ordine: 1 },
    { id: CAT_GLOBALE_LIBERA, scuola_id: null, nome: 'Divisa', slug: 'divisa', is_sistema: false, attivo: true, ordine: 2 },
    { id: CAT_A, scuola_id: SEDE_A, nome: 'Gita', slug: 'gita', is_sistema: false, attivo: true, ordine: 3 },
    { id: CAT_B, scuola_id: SEDE_B, nome: 'Gita', slug: 'gita', is_sistema: false, attivo: true, ordine: 4 },
  ],
  admin_settings: [
    { scuola_id: SEDE_A, retta_default_importo: 150, avvisi_config: { ruoli_pubblicazione: ['admin'] } },
    { scuola_id: SEDE_B, retta_default_importo: 999, avvisi_config: { ruoli_pubblicazione: ['admin', 'educator'] } },
  ],
})

const categoria = (id: string): Riga | undefined => h.db.payment_categories.find((c) => c.id === id)
const impostazioni = (sede: string): Riga | undefined => h.db.admin_settings.find((s) => s.scuola_id === sede)
const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.requireStaff.mockResolvedValue({ user: SEGRETERIA_A })
})

// -----------------------------------------------------------------------------
// PATCH /api/admin/settings/categorie
// -----------------------------------------------------------------------------

describe('PATCH /api/admin/settings/categorie — scope di sede e is_sistema', () => {
  it('categoria GLOBALE: la segreteria di una sola sede riceve 403 e il nome NON cambia', async () => {
    const res = await CAT_PATCH(reqCorpo('/api/admin/settings/categorie', 'PATCH', {
      id: CAT_GLOBALE_LIBERA, nome: 'Rinominata da un plesso solo',
    }))
    expect(res.status).toBe(403)
    expect(categoria(CAT_GLOBALE_LIBERA)?.nome).toBe('Divisa')
    expect(scrittureSu('payment_categories')).toEqual([])
  })

  it('categoria GLOBALE: l\'admin che ha in scope tutte le sedi REALI la modifica (200)', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await CAT_PATCH(reqCorpo('/api/admin/settings/categorie', 'PATCH', {
      id: CAT_GLOBALE_LIBERA, nome: 'Divisa scolastica',
    }))
    expect(res.status).toBe(200)
    expect(categoria(CAT_GLOBALE_LIBERA)?.nome).toBe('Divisa scolastica')
  })

  it('categoria di SISTEMA: 409 anche in PATCH, anche per l\'admin full-scope, e la riga resta intatta', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await CAT_PATCH(reqCorpo('/api/admin/settings/categorie', 'PATCH', {
      id: CAT_GLOBALE_SISTEMA, nome: 'Retta mensile', attivo: false,
    }))
    expect(res.status).toBe(409)
    expect(categoria(CAT_GLOBALE_SISTEMA)?.nome).toBe('Retta')
    expect(categoria(CAT_GLOBALE_SISTEMA)?.attivo).toBe(true)
    expect(scrittureSu('payment_categories')).toEqual([])
  })

  it('categoria di un\'ALTRA sede: 403 e la riga di SEDE_B resta com\'era', async () => {
    const res = await CAT_PATCH(reqCorpo('/api/admin/settings/categorie', 'PATCH', {
      id: CAT_B, nome: 'Presa dall\'altro plesso',
    }))
    expect(res.status).toBe(403)
    expect(categoria(CAT_B)?.nome).toBe('Gita')
    expect(scrittureSu('payment_categories')).toEqual([])
  })

  it('categoria inesistente: 404', async () => {
    const res = await CAT_PATCH(reqCorpo('/api/admin/settings/categorie', 'PATCH', {
      id: CAT_FANTASMA, nome: 'X',
    }))
    expect(res.status).toBe(404)
    expect(scrittureSu('payment_categories')).toEqual([])
  })

  it('categoria della PROPRIA sede: 200 e la riga è aggiornata', async () => {
    const res = await CAT_PATCH(reqCorpo('/api/admin/settings/categorie', 'PATCH', {
      id: CAT_A, nome: 'Gita al museo',
    }))
    expect(res.status).toBe(200)
    expect(categoria(CAT_A)?.nome).toBe('Gita al museo')
    // La gemella omonima dell'altra sede non è stata sfiorata.
    expect(categoria(CAT_B)?.nome).toBe('Gita')
  })

  it('lo slug NON viene rigenerato dalla rinomina (genera_rette_mensili risolve per slug=retta)', async () => {
    const res = await CAT_PATCH(reqCorpo('/api/admin/settings/categorie', 'PATCH', {
      id: CAT_A, nome: 'Uscita didattica',
    }))
    expect(res.status).toBe(200)
    expect(categoria(CAT_A)?.slug).toBe('gita')
  })
})

// -----------------------------------------------------------------------------
// DELETE /api/admin/settings/categorie
// -----------------------------------------------------------------------------

describe('DELETE /api/admin/settings/categorie — scope di sede e is_sistema', () => {
  it('categoria di SISTEMA: 409 e la riga c\'è ancora', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await CAT_DELETE(req(`/api/admin/settings/categorie?id=${CAT_GLOBALE_SISTEMA}`))
    expect(res.status).toBe(409)
    expect(categoria(CAT_GLOBALE_SISTEMA)).toBeDefined()
    expect(scrittureSu('payment_categories')).toEqual([])
  })

  it('categoria GLOBALE non di sistema: la segreteria di una sola sede riceve 403 e la riga resta', async () => {
    const res = await CAT_DELETE(req(`/api/admin/settings/categorie?id=${CAT_GLOBALE_LIBERA}`))
    expect(res.status).toBe(403)
    expect(categoria(CAT_GLOBALE_LIBERA)).toBeDefined()
    expect(scrittureSu('payment_categories')).toEqual([])
  })

  it('categoria di un\'ALTRA sede: 403 e la riga di SEDE_B è ancora lì', async () => {
    const res = await CAT_DELETE(req(`/api/admin/settings/categorie?id=${CAT_B}`))
    expect(res.status).toBe(403)
    expect(categoria(CAT_B)).toBeDefined()
    expect(scrittureSu('payment_categories')).toEqual([])
  })

  it('categoria della PROPRIA sede: 200 e sparisce dal database', async () => {
    const res = await CAT_DELETE(req(`/api/admin/settings/categorie?id=${CAT_A}`))
    expect(res.status).toBe(200)
    expect(categoria(CAT_A)).toBeUndefined()
    // L'omonima dell'altra sede non è stata toccata dalla delete.
    expect(categoria(CAT_B)).toBeDefined()
  })
})

// -----------------------------------------------------------------------------
// GET /api/admin/settings/categorie
// -----------------------------------------------------------------------------

describe('GET /api/admin/settings/categorie — la sede dichiarata si valida, non si ripiega', () => {
  it('sede dichiarata FUORI SCOPE: 403, e non si spacciano per sue le categorie di un\'altra sede', async () => {
    const res = await CAT_GET(req(`/api/admin/settings/categorie?scuola_id=${SEDE_B}`))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('payment_categories')
  })

  it('sede propria: globali + quelle della sede, mai quelle dell\'altra', async () => {
    const res = await CAT_GET(req(`/api/admin/settings/categorie?scuola_id=${SEDE_A}`))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    const ids = (corpo.data as Riga[]).map((c) => c.id)
    expect(ids).toEqual([CAT_GLOBALE_SISTEMA, CAT_GLOBALE_LIBERA, CAT_A])
  })

  // K2 (2026-09-26) — fino a ieri qui c'era il 400 «chi ha più sedi deve dire
  // quale sta guardando». Era giusto per una SCRITTURA e sbagliato per questa
  // LETTURA: lo Scadenzario con due o tre sedi selezionate chiamava la GET senza
  // `scuola_id`, riceveva 400, e il menu delle causali restava vuoto senza un
  // messaggio. Ora la lettura multi-sede è l'unione: globali + le causali di
  // OGNI sede attiva, ciascuna con il proprio `scuola_id` (null per le globali),
  // così l'interfaccia sa di quale plesso è ogni riga.
  it('admin multi-sede senza scuola_id: 200 con globali + causali di TUTTE le sedi attive, ciascuna col suo scuola_id', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await CAT_GET(req('/api/admin/settings/categorie'))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    const righe = corpo.data as Riga[]
    expect(righe.map((c) => c.id)).toEqual([CAT_GLOBALE_SISTEMA, CAT_GLOBALE_LIBERA, CAT_A, CAT_B])
    expect(righe.map((c) => c.scuola_id)).toEqual([null, null, SEDE_A, SEDE_B])
    // Il log della lettura multi-sede: solo conteggi (e l'id/ruolo di chi legge),
    // mai nomi di causali o di sedi.
    const chiamate = h.logEvento.mock.calls.filter(
      (c) => c[0] === 'multi_sede' && (c[2] as { tipo?: string })?.tipo === 'categorie-multi-sede',
    )
    expect(chiamate).toHaveLength(1)
    expect(chiamate[0][1]).toBe('info')
    const ctx = chiamate[0][2] as Record<string, unknown>
    expect(ctx).toEqual(expect.objectContaining({ attive: 2, n: 4, globali: 2 }))
    expect(Object.keys(ctx).sort()).toEqual(['attive', 'azione', 'globali', 'n', 'ruolo', 'tipo', 'utente'])
  })
})

describe('GET /api/admin/settings/categorie — lettura multi-sede (K2)', () => {
  const CAT_C = '66666666-6666-4666-8666-666666666666'

  it('una causale di una sede NON in scope non entra nell\'unione', async () => {
    h.db.payment_categories.push({
      id: CAT_C, scuola_id: SEDE_C, nome: 'Gita', slug: 'gita', is_sistema: false, attivo: true, ordine: 5,
    })
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await CAT_GET(req('/api/admin/settings/categorie'))
    expect(res.status).toBe(200)
    const ids = ((await res.json()).data as Riga[]).map((c) => c.id)
    expect(ids).toContain(CAT_A)
    expect(ids).toContain(CAT_B)
    expect(ids).not.toContain(CAT_C)
  })

  it('SedeSelector ristretto a una sede sola: si comporta come prima (globali + quella sede)', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await CAT_GET(req('/api/admin/settings/categorie', `sedi_attive=${SEDE_B}`))
    expect(res.status).toBe(200)
    const ids = ((await res.json()).data as Riga[]).map((c) => c.id)
    expect(ids).toEqual([CAT_GLOBALE_SISTEMA, CAT_GLOBALE_LIBERA, CAT_B])
  })

  it('con scuola_id dichiarato resta invariato anche per l\'admin multi-sede: solo quella sede', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await CAT_GET(req(`/api/admin/settings/categorie?scuola_id=${SEDE_B}`))
    expect(res.status).toBe(200)
    const ids = ((await res.json()).data as Riga[]).map((c) => c.id)
    expect(ids).toEqual([CAT_GLOBALE_SISTEMA, CAT_GLOBALE_LIBERA, CAT_B])
  })

  it('segreteria di una sede sola senza scuola_id: invariato (globali + la sua sede)', async () => {
    const res = await CAT_GET(req('/api/admin/settings/categorie'))
    expect(res.status).toBe(200)
    const ids = ((await res.json()).data as Riga[]).map((c) => c.id)
    expect(ids).toEqual([CAT_GLOBALE_SISTEMA, CAT_GLOBALE_LIBERA, CAT_A])
  })

  it('cookie manomesso (solo sedi non proprie): 403 come prima, e le categorie non si leggono', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await CAT_GET(req('/api/admin/settings/categorie', `sedi_attive=${SEDE_C}`))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('payment_categories')
  })

  it('errore PostgREST sulla lettura multi-sede: 500, niente elenco vuoto spacciato per «nessuna causale»', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    h.errori = { 'payment_categories:select': { code: '57014' } }
    const res = await CAT_GET(req('/api/admin/settings/categorie'))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'admin/settings/categorie:GET', stato: 500, evento: 'db' }),
      expect.anything(),
    )
    // Nessun log di successo su una lettura fallita.
    expect(h.logEvento.mock.calls.filter(
      (c) => (c[2] as { tipo?: string })?.tipo === 'categorie-multi-sede',
    )).toEqual([])
  })

  // Il ramo a sede dichiarata restituiva il 500 SENZA una riga di log applicativo:
  // una lettura fallita delle causali con la sede indicata non lasciava traccia.
  // Status e corpo restano quelli di prima (requisito «con scuola_id → invariato»);
  // cambia solo che ora il guasto si vede nei log, con `evento: 'db'` (il catch
  // generico in fondo alla GET non lo mette, quindi non può far passare il test).
  it('errore PostgREST con scuola_id dichiarato: 500 invariato, ma ora LOGGATO come errore db', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    h.errori = { 'payment_categories:select': { code: '57014' } }
    const res = await CAT_GET(req(`/api/admin/settings/categorie?scuola_id=${SEDE_B}`))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBeUndefined()
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'admin/settings/categorie:GET', stato: 500, evento: 'db' }),
      expect.objectContaining({ code: '57014' }),
    )
    // Il ramo multi-sede non è stato attraversato (la sede era dichiarata).
    expect(h.logEvento.mock.calls.filter(
      (c) => (c[2] as { tipo?: string })?.tipo === 'categorie-multi-sede',
    )).toEqual([])
  })

  it('una sede sola senza scuola_id: nessun log multi-sede (il ramo non scatta)', async () => {
    const res = await CAT_GET(req('/api/admin/settings/categorie'))
    expect(res.status).toBe(200)
    expect(h.logEvento.mock.calls.filter(
      (c) => (c[2] as { tipo?: string })?.tipo === 'categorie-multi-sede',
    )).toEqual([])
  })
})

describe('POST /api/admin/settings/categorie — la sede si dichiara', () => {
  it('admin multi-sede senza scuola_id: 400 e NESSUNA categoria creata', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await CAT_POST(reqCorpo('/api/admin/settings/categorie', 'POST', { nome: 'Gita' }))
    expect(res.status).toBe(400)
    expect(scrittureSu('payment_categories')).toEqual([])
    expect(h.db.payment_categories).toHaveLength(4)
  })

  it('sede dichiarata: la categoria nasce in QUELLA sede, non in quella di ripiego', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await CAT_POST(reqCorpo('/api/admin/settings/categorie', 'POST', {
      nome: 'Laboratorio', scuola_id: SEDE_B,
    }))
    expect(res.status).toBe(201)
    const scritte = scrittureSu('payment_categories')
    expect(scritte).toHaveLength(1)
    expect(scritte[0].valori[0].scuola_id).toBe(SEDE_B)
    expect(h.db.payment_categories.find((c) => c.nome === 'Laboratorio')?.scuola_id).toBe(SEDE_B)
  })
})

// -----------------------------------------------------------------------------
// /api/admin/settings — la sede si dichiara e si valida
// -----------------------------------------------------------------------------

describe('PATCH /api/admin/settings — la sede dichiarata si valida, non si ripiega', () => {
  it('scuola_id di un\'ALTRA sede: 403, e le impostazioni della PROPRIA non vengono scritte', async () => {
    const res = await SET_PATCH(reqCorpo('/api/admin/settings', 'PATCH', {
      scuola_id: SEDE_B, retta_default_importo: 1,
    }))
    expect(res.status).toBe(403)
    expect(impostazioni(SEDE_A)?.retta_default_importo).toBe(150)
    expect(impostazioni(SEDE_B)?.retta_default_importo).toBe(999)
    expect(scrittureSu('admin_settings')).toEqual([])
  })

  it('scuola_id della propria sede: 200 e l\'upsert porta quella sede', async () => {
    const res = await SET_PATCH(reqCorpo('/api/admin/settings', 'PATCH', {
      scuola_id: SEDE_A, retta_default_importo: 175,
    }))
    expect(res.status).toBe(200)
    expect(impostazioni(SEDE_A)?.retta_default_importo).toBe(175)
    expect(impostazioni(SEDE_B)?.retta_default_importo).toBe(999)
    const scritte = scrittureSu('admin_settings')
    expect(scritte).toHaveLength(1)
    expect(scritte[0].valori[0].scuola_id).toBe(SEDE_A)
  })

  it('admin multi-sede senza scuola_id: 400 e NESSUNA scrittura (la sede si dichiara)', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await SET_PATCH(reqCorpo('/api/admin/settings', 'PATCH', { retta_default_importo: 42 }))
    expect(res.status).toBe(400)
    expect(scrittureSu('admin_settings')).toEqual([])
    expect(impostazioni(SEDE_A)?.retta_default_importo).toBe(150)
  })

  it('admin multi-sede che dichiara la SECONDA sede: scrive lì, non sulla sede primaria', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await SET_PATCH(reqCorpo('/api/admin/settings', 'PATCH', {
      scuola_id: SEDE_B, retta_default_importo: 220,
    }))
    expect(res.status).toBe(200)
    expect(impostazioni(SEDE_B)?.retta_default_importo).toBe(220)
    expect(impostazioni(SEDE_A)?.retta_default_importo).toBe(150)
  })

  it('sede deselezionata nel SedeSelector: 403 invece di scrivere sulla sede selezionata', async () => {
    // Cookie = solo SEDE_A: l'admin ha entrambe, ma sta guardando SEDE_A. Una
    // PATCH che dichiara SEDE_B non deve né scrivere su B (non è quella che
    // l'operatore vede) né ripiegare su A (scriverebbe nel plesso sbagliato).
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await SET_PATCH(reqCorpo('/api/admin/settings', 'PATCH', {
      scuola_id: SEDE_B, retta_default_importo: 7,
    }, `sedi_attive=${SEDE_A}`))
    expect(res.status).toBe(403)
    expect(impostazioni(SEDE_A)?.retta_default_importo).toBe(150)
    expect(impostazioni(SEDE_B)?.retta_default_importo).toBe(999)
    expect(scrittureSu('admin_settings')).toEqual([])
  })
})

describe('GET /api/admin/settings — la sede dichiarata si valida, non si ripiega', () => {
  it('scuola_id di un\'ALTRA sede: 403 (mai le impostazioni di ripiego spacciate per sue)', async () => {
    const res = await SET_GET(req(`/api/admin/settings?scuola_id=${SEDE_B}`))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('admin_settings')
  })

  it('scuola_id della propria sede: 200 con i valori di quella sede', async () => {
    const res = await SET_GET(req(`/api/admin/settings?scuola_id=${SEDE_A}`))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data.scuola_id).toBe(SEDE_A)
    expect(corpo.data.retta_default_importo).toBe(150)
  })

  it('admin multi-sede che dichiara la seconda sede: legge le impostazioni di QUELLA sede', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await SET_GET(req(`/api/admin/settings?scuola_id=${SEDE_B}`))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data.retta_default_importo).toBe(999)
  })
})
