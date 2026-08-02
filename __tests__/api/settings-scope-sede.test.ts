import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_E2E, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_E2E } from '../fixtures/sedi'

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
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture }),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture }),
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

  // Contratto della route, non dell'interfaccia: chi ha più sedi DEVE dire quale
  // sta guardando. È il complemento del 400 di `resolveScuolaScrittura`, e sta
  // qui perché il ripiego può tornare in QUESTO file (`?? auth.user.scuola_id`)
  // senza che nessuno tocchi `scope.ts`. Chi ha un plesso solo non è toccato.
  it('admin multi-sede senza scuola_id: 400 e le categorie non si leggono nemmeno', async () => {
    h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
    const res = await CAT_GET(req('/api/admin/settings/categorie'))
    expect(res.status).toBe(400)
    expect(h.tabelle).not.toContain('payment_categories')
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
