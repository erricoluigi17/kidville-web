import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import { SEDE_A, SEDE_B, NOME_SEDE_B } from '../fixtures/sedi'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  D1 · LA ZONA PERICOLOSA COMPARE ANCHE ALLA SEGRETERIA, SULLA SUA SEDE   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Fino al 2026-09-24 la zona stava dietro `canEdit` (sola Direzione), mentre le
 * tre rotte ammettevano già la Segreteria sulla propria sede: un permesso
 * concesso dal server e irraggiungibile dall'interfaccia. Decisione del titolare:
 * la zona compare anche alla Segreteria, ma SOLO dove il server le darebbe
 * ragione — bersaglio nella sua sede, non di Direzione, non sé stessa.
 *
 * ⚠️ TRAPPOLA 3 DI `.claude/rules/test.md`: «la zona non c'è» è vero anche mentre
 * la scheda sta ancora caricando. Ogni assenza si asserisce DOPO la presenza del
 * cognome in testata, che arriva solo a risposta ricevuta.
 *
 * ─── PROVA PER ROTTURA — eseguita il 2026-09-25 ───────────────────────────────
 *   • rimessa la condizione di montaggio a `canEdit` soltanto → 2 rossi
 *   • tolto il confronto con `sediUtente`                     → 5 rossi
 *   • `.consentito` sostituito con `true`                     → 7 rossi
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

const IO = 'aaaa0000-0000-4000-8000-0000000000a1'
const STAFF_ID = 'bbbb0000-0000-4000-8000-0000000000b1'

let ruoloCorrente = 'segreteria'
let idCorrente: string | null = IO
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: idCorrente, role: ruoloCorrente, ready: true }),
}))

const COGNOME = 'Zetaprova'

let membro: { id: string; nome: string; cognome: string; email: string; ruolo: string; scuola_id: string | null; gradi: string[] }
/** Le sedi dell'utente, come le restituisce `admin/staff:GET` (= `scuoleDiUtente`). */
let sediUtente: { id: string; nome: string }[]
const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  ruoloCorrente = 'segreteria'
  idCorrente = IO
  membro = {
    id: STAFF_ID,
    nome: 'Prova',
    cognome: COGNOME,
    email: 'prova@esempio.test',
    ruolo: 'educator',
    scuola_id: SEDE_B,
    gradi: [],
  }
  sediUtente = [{ id: SEDE_B, nome: NOME_SEDE_B }]
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://t.test')
    if (u.pathname === '/api/admin/sedi/destinazioni') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [], motivo: 'ok' }) })
    }
    if (u.pathname === '/api/admin/staff/eliminazione') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            decisione: 'cancella',
            motivi: [],
            ponteGenitore: true,
            haAnagrafica: false,
            haPraticaOrigine: false,
            mantiene: [],
          },
        }),
      })
    }
    if (u.pathname === '/api/admin/staff') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [membro],
          schools: sediUtente,
          sections: [],
          assegnazioni: [],
        }),
      })
    }
    // Anagrafica del personale: 404 = «assente», non un guasto.
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('alert', vi.fn())
})

afterEach(() => cleanup())

import { StaffDetailPanel } from '@/components/features/admin/StaffDetailPanel'
import { segreteriaVedeZonaPericolosa } from '@/components/features/admin/ZonaPericolosaStaff'

const apri = () => render(<StaffDetailPanel staffId={STAFF_ID} onClose={() => {}} />)

/** La scheda è CARICATA: il cognome in testata arriva solo a risposta ricevuta. */
const schedaCaricata = async () => {
  expect((await screen.findAllByText(new RegExp(COGNOME))).length).toBeGreaterThan(0)
}
const zona = () => screen.queryByTestId('zona-pericolosa-apri')

describe('StaffDetailPanel — la zona pericolosa per la Segreteria', () => {
  it('COMPARE sulla propria sede, e il comando interroga davvero la rotta del bersaglio', async () => {
    apri()
    const bottone = await screen.findByTestId('zona-pericolosa-apri')
    fireEvent.click(bottone)
    await screen.findByTestId('zona-pericolosa-decisione')
    const chiamate = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(chiamate).toContain(`/api/admin/staff/eliminazione?id=${encodeURIComponent(STAFF_ID)}`)
    // Il comando «Trasforma in genitore» è raggiungibile: è il caso reale del compito.
    expect(screen.getByTestId('zona-pericolosa-genitore')).toBeTruthy()
  })

  it('COMPARE anche su una cuoca della propria sede', async () => {
    membro = { ...membro, ruolo: 'cuoca' }
    apri()
    expect(await screen.findByTestId('zona-pericolosa-apri')).toBeTruthy()
  })

  it('NON compare su un collega di UN’ALTRA sede', async () => {
    membro = { ...membro, scuola_id: SEDE_A }
    apri()
    await schedaCaricata()
    expect(zona()).toBeNull()
  })

  it('NON compare su un bersaglio senza sede', async () => {
    membro = { ...membro, scuola_id: null }
    apri()
    await schedaCaricata()
    expect(zona()).toBeNull()
  })

  it('NON compare su un account di Direzione, nemmeno della propria sede', async () => {
    for (const ruolo of ['coordinator', 'admin']) {
      membro = { ...membro, ruolo }
      apri()
      await schedaCaricata()
      expect(zona()).toBeNull()
      cleanup()
    }
  })

  it('NON compare sulla propria scheda', async () => {
    membro = { ...membro, id: IO }
    render(<StaffDetailPanel staffId={IO} onClose={() => {}} />)
    await schedaCaricata()
    expect(zona()).toBeNull()
  })

  it('NON compare finché l’identità di sessione non è risolta', async () => {
    idCorrente = null
    apri()
    await schedaCaricata()
    expect(zona()).toBeNull()
  })
})

describe('StaffDetailPanel — la Direzione resta com’era', () => {
  it.each(['admin', 'coordinator'])('%s: compare anche su un collega fuori dalle proprie sedi', async (ruolo) => {
    ruoloCorrente = ruolo
    membro = { ...membro, scuola_id: SEDE_A }
    apri()
    expect(await screen.findByTestId('zona-pericolosa-apri')).toBeTruthy()
  })

  it.each(['admin', 'coordinator'])('%s: compare anche su un account di Direzione (il server decide)', async (ruolo) => {
    ruoloCorrente = ruolo
    membro = { ...membro, ruolo: 'coordinator' }
    apri()
    expect(await screen.findByTestId('zona-pericolosa-apri')).toBeTruthy()
  })

  it('una docente che apre la scheda non la vede', async () => {
    ruoloCorrente = 'educator'
    apri()
    await schedaCaricata()
    expect(zona()).toBeNull()
  })
})

describe('segreteriaVedeZonaPericolosa — la regola, senza schermo', () => {
  const base = {
    ruoloAttivo: 'segreteria',
    userId: IO,
    bersaglio: { id: STAFF_ID, ruolo: 'educator', scuola_id: SEDE_B },
    sediUtente: [SEDE_B],
  }

  it('segreteria, collega della sua sede → sì', () => {
    expect(segreteriaVedeZonaPericolosa(base)).toBe(true)
  })

  it('una segreteria con più sedi la vede su ciascuna', () => {
    expect(segreteriaVedeZonaPericolosa({ ...base, sediUtente: [SEDE_A, SEDE_B] })).toBe(true)
  })

  it('un’altra segreteria della sua sede → sì (non è Direzione)', () => {
    expect(segreteriaVedeZonaPericolosa({ ...base, bersaglio: { ...base.bersaglio, ruolo: 'segreteria' } })).toBe(true)
  })

  it.each([
    ['altra sede', { ...base, sediUtente: [SEDE_A] }],
    ['nessuna sede dell’utente', { ...base, sediUtente: [] }],
    ['bersaglio senza sede', { ...base, bersaglio: { ...base.bersaglio, scuola_id: null } }],
    ['bersaglio coordinator', { ...base, bersaglio: { ...base.bersaglio, ruolo: 'coordinator' } }],
    ['bersaglio admin', { ...base, bersaglio: { ...base.bersaglio, ruolo: 'admin' } }],
    ['sé stessa', { ...base, bersaglio: { ...base.bersaglio, id: IO } }],
    ['ruolo del bersaglio sconosciuto', { ...base, bersaglio: { ...base.bersaglio, ruolo: 'boh' } }],
    ['ruolo del bersaglio non letto', { ...base, bersaglio: { ...base.bersaglio, ruolo: null } }],
    ['scheda in caricamento', { ...base, bersaglio: null }],
    ['identità non risolta', { ...base, userId: null }],
    ['chi guarda è una docente', { ...base, ruoloAttivo: 'educator' }],
    ['chi guarda è un genitore', { ...base, ruoloAttivo: 'genitore' }],
    // La Direzione NON passa da qui: la sua condizione resta `canEdit`.
    ['chi guarda è admin', { ...base, ruoloAttivo: 'admin' }],
  ])('%s → no', (_nome, args) => {
    expect(segreteriaVedeZonaPericolosa(args)).toBe(false)
  })
})
