import { describe, it, expect, vi, beforeEach } from 'vitest'

/* ═══════════════════════════════════════════════════════════════════════════════
 * L'ARCHIVIAZIONE TOGLIE LA VESTE DA STAFF, NON L'ACCESSO ALLA PERSONA
 *
 * ─── PERCHÉ QUESTI TEST MOCKANO I CLIENT E NON IL GATE ─────────────────────────
 *
 * 296 file di test sostituiscono `@/lib/auth/require-staff` per intero con
 * `vi.mock`. Un test che mocka il gate e poi verifica che il gate nega è la
 * definizione del mock piatto: resta verde con e senza la correzione. Qui si
 * mockano i due CLIENT Supabase — gli stessi due di `ruolo-attivo.test.ts`, che
 * esiste per la domanda gemella — e si invocano i gate VERI.
 *
 * ─── IL FATTO CHE QUESTI TEST PROTEGGONO ───────────────────────────────────────
 *
 * Al 2026-09-20 dodici persone hanno insieme una riga `utenti` con ruolo
 * `educator` e il ponte `parents.auth_user_id`: insegnano, e hanno un figlio
 * iscritto qui. Scritta come «archiviato ⇒ 401», la regola chiuderebbe fuori una
 * madre dal diario di suo figlio. Il terzo test è quello che lo impedisce.
 *
 * ─── PROVA PER ROTTURA — eseguita il 2026-09-20, una mutazione alla volta su
 *     file ripristinati da copia pulita. I numeri sono MISURATI: la prima
 *     stesura ne dichiarava due sbagliati su quattro. ────────────────────────
 *   • tolto il ramo `if (profiloStaffRevocato(...))` da `utenteDellaRichiesta`
 *                                                            → 5 test rossi
 *   • sostituito `ident.ponteGenitore === true` con `false` nel ramo
 *     dell'archiviazione (cioè «archiviato ⇒ nega sempre»)   → 1 test rosso
 *   • reso fail-CLOSED il degrado `42703` di `leggiRigaUtenti` → 1 test rosso
 *   • fatto tornare `true` a `profiloStaffRevocato(null)`      → 4 test rossi
 *
 * La seconda mutazione ne rende rosso uno solo, ed è quello che conta: è il test
 * «resta la madre, sparisce la maestra». Se sparisse, la regola che protegge
 * dodici persone reali tornerebbe indifesa senza che nient'altro se ne accorga.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  utentiMaybeSingle: vi.fn(),
  parentsMaybeSingle: vi.fn(),
  utentiSingle: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: vi.fn().mockResolvedValue({ auth: { getUser: mocks.getUser } }),
  createAdminClient: vi.fn().mockResolvedValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: table === 'utenti' ? mocks.utentiMaybeSingle : mocks.parentsMaybeSingle,
          single: mocks.utentiSingle,
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { requireDocente, requireStaff, requireUser, ruoliDi } from '@/lib/auth/require-staff'
import { profiloStaffRevocato } from '@/lib/auth/predicati-ruolo'
import { logEvento } from '@/lib/logging/logger'
import { SEDE_A } from '../../fixtures/sedi'

const UID = 'd0000000-0000-4000-8000-0000000000d1'
const PARENT_ROW = 'd0000000-0000-4000-8000-0000000000a1'

function riga(archiviatoIl: string | null | undefined) {
  const r: Record<string, unknown> = {
    id: UID,
    nome: 'X',
    cognome: 'Y',
    ruolo: 'educator',
    role: 'educator',
    scuola_id: SEDE_A,
  }
  // `undefined` = la colonna non è stata proprio letta (schema non migrato).
  if (archiviatoIl !== undefined) r.archiviato_il = archiviatoIl
  return r
}

function scenario(archiviatoIl: string | null | undefined, ponte: boolean) {
  mocks.getUser.mockResolvedValue({ data: { user: { id: UID } }, error: null })
  mocks.utentiMaybeSingle.mockResolvedValue({ data: riga(archiviatoIl), error: null })
  mocks.parentsMaybeSingle.mockResolvedValue({
    data: ponte ? { id: PARENT_ROW } : null,
    error: null,
  })
}

const richiesta = () => new Request('http://localhost/api/diary/students')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null })
  mocks.utentiMaybeSingle.mockResolvedValue({ data: null, error: null })
  mocks.parentsMaybeSingle.mockResolvedValue({ data: null, error: null })
  mocks.utentiSingle.mockResolvedValue({ data: null, error: { message: 'no rows' } })
})

describe('archiviato SENZA ponte genitore — si nega, e si dice perché', () => {
  it('requireDocente risponde 403 con il codice ACCOUNT_ARCHIVIATO', async () => {
    scenario('2026-09-20T10:00:00Z', false)
    const esito = await requireDocente(richiesta())
    expect(esito.response?.status).toBe(403)
    const corpo = await esito.response!.json()
    expect(corpo.codice).toBe('ACCOUNT_ARCHIVIATO')
  })

  it('anche requireStaff e requireUser negano, e requireUser NON dà 401', async () => {
    // 401 manderebbe a rifare l'accesso, e rifarlo RIUSCIREBBE: GoTrue non sa
    // niente di `archiviato_il`. È l'anello del giro infinito.
    scenario('2026-09-20T10:00:00Z', false)
    expect((await requireStaff(richiesta())).response?.status).toBe(403)
    expect((await requireUser(richiesta())).response?.status).toBe(403)
  })

  it("il diniego esce a `warn`, non a `info` come gli altri: è il contatore di chi bussa ancora", async () => {
    scenario('2026-09-20T10:00:00Z', false)
    await requireDocente(richiesta())
    expect(logEvento).toHaveBeenCalledWith(
      'auth',
      'warn',
      expect.objectContaining({ tipo: 'account-archiviato' }),
    )
  })
})

describe('il controllo NEGATIVO — senza, un diniego incondizionato sarebbe verde', () => {
  it('archiviato_il a null: la persona entra normalmente', async () => {
    scenario(null, false)
    const esito = await requireDocente(richiesta())
    expect(esito.response).toBeUndefined()
    expect(esito.user?.role).toBe('educator')
  })

  it('colonna non letta affatto (undefined): la persona entra', async () => {
    // È lo stato del DB E2E della CI e della produzione prima del merge della
    // migrazione. «Non l'ho letto» non è «è archiviato».
    scenario(undefined, false)
    expect((await requireDocente(richiesta())).response).toBeUndefined()
  })
})

describe('archiviato CON ponte genitore — resta la madre, sparisce la maestra', () => {
  it('requireUser concede, e il ruolo reale è SOLO genitore', async () => {
    scenario('2026-09-20T10:00:00Z', true)
    const esito = await requireUser(richiesta())
    expect(esito.response).toBeUndefined()
    expect(esito.user).toBeTruthy()
    expect(ruoliDi(esito.user!)).toEqual(['genitore'])
    expect(esito.user!.role).toBe('genitore')
  })

  it('ma il gate docente la respinge: la veste da staff non c’è più', async () => {
    scenario('2026-09-20T10:00:00Z', true)
    const esito = await requireDocente(richiesta())
    expect(esito.response?.status).toBe(403)
  })
})

describe('la colonna che non esiste ancora — fail-OPEN, e lo dice', () => {
  it('su 42703 si rilegge senza la colonna, si concede e si logga a warn', async () => {
    // Fail-CLOSED qui chiuderebbe fuori TUTTI — non gli archiviati, tutti — nella
    // finestra fra il deploy del codice e l'applicazione della migrazione.
    mocks.getUser.mockResolvedValue({ data: { user: { id: UID } }, error: null })
    mocks.utentiMaybeSingle
      .mockResolvedValueOnce({ data: null, error: { code: '42703', message: 'column does not exist' } })
      .mockResolvedValueOnce({ data: riga(undefined), error: null })
    mocks.parentsMaybeSingle.mockResolvedValue({ data: null, error: null })

    const esito = await requireDocente(richiesta())
    expect(esito.response).toBeUndefined()
    expect(esito.user?.role).toBe('educator')
    expect(logEvento).toHaveBeenCalledWith(
      'auth',
      'warn',
      expect.objectContaining({ esito: 'archiviazione-non-verificabile' }),
    )
  })
})

describe('profiloStaffRevocato — il predicato puro', () => {
  it('solo un valore presente conta come revoca', () => {
    expect(profiloStaffRevocato('2026-09-20T10:00:00Z')).toBe(true)
    expect(profiloStaffRevocato(null)).toBe(false)
    expect(profiloStaffRevocato(undefined)).toBe(false)
  })
})
