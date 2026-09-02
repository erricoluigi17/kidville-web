import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `sedi_attive` LO AZZERA IL SERVER, e nella STESSA risposta che cambia la veste.
 *
 * ─── IL DIFETTO, che non lascia nessuna traccia utile ───────────────────────
 * `sedi_attive` è una preferenza del COCKPIT: «di quali plessi voglio vedere i
 * dati». Chi la imposta è la Direzione o la Segreteria. Il giorno in cui una di
 * quelle persone — che è anche genitore — passa alla veste di famiglia, il
 * cookie resta: `resolveScuoleAttive` (`lib/auth/scope.ts`) interseca le sedi
 * ACCESSIBILI in quella veste (quella del figlio) con quelle SELEZIONATE nel
 * cockpit, trova due insiemi disgiunti e restituisce `[]`.
 *
 * `[]` in quel modulo **nega**, di proposito. Il risultato per l'utente è una
 * app che funziona e non mostra niente: diario vuoto, galleria vuota, mensa
 * vuota — e in `app_log` un `warn` `sedi-attive-non-accessibili` a nome di una
 * persona che non ha fatto niente di male.
 *
 * ─── PERCHÉ IL SERVER E NON IL CLIENT ───────────────────────────────────────
 * Il client potrebbe cancellarlo (non è httpOnly), ma solo DOPO che la risposta
 * è tornata: fra il 200 e quella riga c'è una finestra in cui una richiesta già
 * in volo porta ancora il cookie vecchio insieme alla veste nuova. Dentro la
 * stessa risposta la finestra non esiste.
 *
 * ─── LA REGOLA, E LA SUA METÀ NEGATIVA ──────────────────────────────────────
 * Si azzera quando la veste richiesta ha per casa un'area DIVERSA dal cockpit.
 * NON si azzera per le vesti di cockpit — ed è la parte importante: la stessa
 * route è quella che il LOGIN chiama a ogni accesso. Azzerare lì la selezione di
 * sede rimetterebbe la Direzione multi-sede davanti a «Seleziona una sede» ogni
 * mattina, e a un 400 su ogni scrittura (`resolveScuolaScrittura`) — cioè
 * esattamente il difetto che `AdminMenuSheet` racconta nella sua testata.
 */

const h = vi.hoisted(() => ({
  identity: { userId: 'u-1', source: 'session' } as { userId: string | null; source: string | null },
  profili: [
    { ruolo: 'segreteria', area: 'admin' },
    { ruolo: 'genitore', area: 'parent' },
  ] as { ruolo: string; area: string }[] | null,
  appUser: { id: 'u-1', role: 'segreteria' } as { id: string; role: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  resolveIdentity: vi.fn(async () => h.identity),
  loadAppUser: vi.fn(async () => h.appUser),
}))

vi.mock('@/lib/auth/profili', () => ({
  getSessionProfili: vi.fn(async () => (h.profili ? { authUid: 'u-1', profili: h.profili } : null)),
}))

import { SEDE_A } from '../fixtures/sedi'

import { POST } from '@/app/api/auth/active-role/route'

function req(body: unknown, cookie?: string) {
  return new Request('http://localhost/api/auth/active-role', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })
}

/** Tutti i `Set-Cookie` della risposta, uno per riga. */
function cookies(res: Response): string[] {
  const getSet = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getSet === 'function') return getSet.call(res.headers)
  return (res.headers.get('set-cookie') ?? '').split(/,(?=[^;]+=)/).map((s) => s.trim())
}

/** La riga che CANCELLA `sedi_attive` (scadenza a zero), se c'è. */
function cancellaSedi(res: Response): string | undefined {
  return cookies(res).find((c) => /^sedi_attive=/.test(c) && /max-age=0/i.test(c))
}

beforeEach(() => {
  h.identity = { userId: 'u-1', source: 'session' }
  h.profili = [
    { ruolo: 'segreteria', area: 'admin' },
    { ruolo: 'genitore', area: 'parent' },
  ]
  h.appUser = { id: 'u-1', role: 'segreteria' }
})

describe('POST /api/auth/active-role — la selezione di sede non segue la veste', () => {
  it('veste di FAMIGLIA: `sedi_attive` viene cancellato nella stessa risposta', async () => {
    const res = await POST(req({ ruolo: 'genitore' }, `sedi_attive=${SEDE_A}`))
    expect(res.status).toBe(200)

    const riga = cancellaSedi(res)
    expect(
      riga,
      'Senza questa riga, entrando in veste genitore con una sede selezionata nel ' +
        'cockpit `resolveScuoleAttive` restituisce [] — liste vuote e un `warn` a ' +
        'nome di un utente innocente.',
    ).toBeDefined()
    expect(riga).toMatch(/path=\//i)

    // E la veste è comunque stata scritta: le due cose viaggiano insieme.
    expect(cookies(res).some((c) => c.startsWith('kv-active-role=genitore'))).toBe(true)
  })

  it('veste di DOCENTE: stesso trattamento — anche `/teacher` passa da resolveScuoleAttive', async () => {
    h.profili = [
      { ruolo: 'educator', area: 'teacher' },
      { ruolo: 'genitore', area: 'parent' },
    ]
    h.appUser = { id: 'u-1', role: 'educator' }
    const res = await POST(req({ ruolo: 'educator' }, `sedi_attive=${SEDE_A}`))
    expect(res.status).toBe(200)
    expect(cancellaSedi(res)).toBeDefined()
  })

  it('veste di COCKPIT: NON si tocca — è la sua preferenza, e il login passa di qui', async () => {
    const res = await POST(req({ ruolo: 'segreteria' }, `sedi_attive=${SEDE_A}`))
    expect(res.status).toBe(200)
    expect(
      cancellaSedi(res),
      'Azzerarlo qui vorrebbe dire rimettere la Direzione multi-sede davanti a ' +
        '«Seleziona una sede» a ogni accesso, e a un 400 su ogni scrittura.',
    ).toBeUndefined()
    expect(cookies(res).some((c) => c.startsWith('kv-active-role=segreteria'))).toBe(true)
  })

  it('403: non si tocca niente — un tentativo negato non cambia lo scope di nessuno', async () => {
    h.profili = [{ ruolo: 'segreteria', area: 'admin' }]
    const res = await POST(req({ ruolo: 'genitore' }, `sedi_attive=${SEDE_A}`))
    expect(res.status).toBe(403)
    expect(cookies(res).filter(Boolean)).toEqual([])
  })
})
