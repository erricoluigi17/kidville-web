/**
 * Le quattro rotte OTP del genitore hanno un limitatore di frequenza.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL GUASTO. Collaudo del 2026-07-31, sicurezza W5: `api/parent/forms/otp`,
 * `api/parent/presenze/giustifica/otp`, `api/parent/primaria/note/firma/otp` e
 * `api/parent/primaria/pagella/firma/otp` non importavano `@/lib/security/rate-limit` —
 * che invece è usato da `forms/send-otp` e `public/cancellazione-account` da mesi. Nessun
 * tetto: un ciclo di richieste riempiva la casella del genitore di codici di firma, a
 * spese della reputazione del dominio mittente (e le email di credenziali di questo
 * progetto sono già rimaste bloccate una volta da un `403` del provider).
 *
 * E c'è la metà meno visibile, che è la più seria: il PATCH di `parent/forms/otp` è la
 * VERIFICA del codice, ed è il punto in cui nasce una firma elettronica con valore legale.
 * Il codice è di **sei cifre** (`otp-ticket.ts:135`), la verifica è un confronto HMAC che
 * NON consuma il ticket quando fallisce (`consumeTicket` è chiamata solo dopo un esito
 * positivo) e il ticket vive 10 minuti: senza limitatore, i tentativi sbagliati erano
 * illimitati e gratuiti. Il tetto qui non è anti-spam, è ciò che impedisce di indovinare
 * un codice invece di leggerlo nella propria casella — cioè ciò che tiene in piedi
 * l'unica prova che quel genitore ha davvero firmato.
 *
 * COSA ASSERISCE QUESTO FILE, e perché così. Non lo status: la **mutazione**. Oltre il
 * tetto, `sendOtp` non viene più chiamata (nessuna email parte) e `verifyTicket` non viene
 * più chiamata (nessun tentativo viene valutato). Uno status 429 con l'email spedita lo
 * stesso sarebbe un limitatore finto, e passerebbe un test scritto sullo status.
 *
 * PROVA DI VALIDITÀ (eseguita, 2026-08-01): togliendo il blocco `rateLimit` da
 * `parent/presenze/giustifica/otp/route.ts` il caso «oltre il tetto» di quella rotta torna
 * rosso — 20 invii accettati su 20, `sendOtp` chiamata 20 volte invece di 5.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    }),
  }),
}))

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: auth.requireUser }))

const otp = vi.hoisted(() => ({
  sendOtp: vi.fn(),
  verifyTicket: vi.fn(),
  getUserEmail: vi.fn(),
  codeHash: vi.fn(() => 'SHA256-XXXX'),
  consumeTicket: vi.fn(),
}))
vi.mock('@/lib/auth/otp-ticket', () => otp)

const fea = vi.hoisted(() => ({ logFeaEvent: vi.fn() }))
vi.mock('@/lib/fea/audit', () => fea)

const sospensione = vi.hoisted(() => ({ assertGenitoreNonSospesoSalvoEssenziale: vi.fn() }))
vi.mock('@/lib/pagamenti/sospensione', () => sospensione)

vi.mock('@/lib/forms/sempre-firmabile', () => ({ leggiSempreFirmabile: vi.fn().mockResolvedValue(false) }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: vi.fn().mockResolvedValue(true) }))

const persist = vi.hoisted(() => ({ persistSignedSubmission: vi.fn() }))
vi.mock('@/lib/forms/persist-submission', () => persist)

import { POST as postForms, PATCH as patchForms } from '@/app/api/parent/forms/otp/route'
import { POST as postGiustifica } from '@/app/api/parent/presenze/giustifica/otp/route'
import { POST as postNota } from '@/app/api/parent/primaria/note/firma/otp/route'
import { POST as postPagella } from '@/app/api/parent/primaria/pagella/firma/otp/route'
import { resetRateLimit } from '@/lib/security/rate-limit'
import { LIMITE_OTP_INVIO, LIMITE_OTP_VERIFICA } from '@/lib/security/otp-rate-limit'

const UTENTE = '11111111-1111-4111-8111-111111111111'
const ALTRO_UTENTE = '22222222-2222-4222-8222-222222222222'

/** Le quattro rotte che SPEDISCONO un codice. Condividono lo stesso budget. */
const INVIO = [
  ['parent/forms/otp:POST', postForms, 'http://localhost/api/parent/forms/otp'],
  ['presenze/giustifica/otp:POST', postGiustifica, 'http://localhost/api/parent/presenze/giustifica/otp'],
  ['note/firma/otp:POST', postNota, 'http://localhost/api/parent/primaria/note/firma/otp'],
  ['pagella/firma/otp:POST', postPagella, 'http://localhost/api/parent/primaria/pagella/firma/otp'],
] as const

function invio(base: string): NextRequest {
  return new NextRequest(base, {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  })
}

function verifica(): NextRequest {
  return new NextRequest('http://localhost/api/parent/forms/otp', {
    method: 'PATCH',
    body: JSON.stringify({
      code: '000000',
      expiry: Date.now() + 60_000,
      ticket: 'ticket-di-prova',
      form_id: '33333333-3333-4333-8333-333333333333',
      answers: { a: 1 },
    }),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRateLimit()
  auth.requireUser.mockResolvedValue({ user: { id: UTENTE, role: 'genitore' } })
  otp.sendOtp.mockResolvedValue({ email: 'g@example.test', expiry: 0, ticket: 't', sent: true })
  otp.getUserEmail.mockResolvedValue('g@example.test')
  otp.verifyTicket.mockReturnValue({ ok: false, error: 'Codice non valido' })
  otp.consumeTicket.mockResolvedValue({ ok: true })
  sospensione.assertGenitoreNonSospesoSalvoEssenziale.mockResolvedValue(null)
  persist.persistSignedSubmission.mockResolvedValue({ submission: { id: 'sub-1' } })
})

describe('OTP del genitore — invio: il tetto vale, e vale su tutte e quattro insieme', () => {
  it.each(INVIO)('%s — entro il tetto l’OTP parte', async (_nome, handler, base) => {
    for (let i = 0; i < LIMITE_OTP_INVIO; i++) {
      const res = await handler(invio(base))
      expect(res.status, `invio ${i + 1} rifiutato entro il tetto`).toBe(200)
    }
    expect(otp.sendOtp).toHaveBeenCalledTimes(LIMITE_OTP_INVIO)
  })

  it.each(INVIO)('%s — oltre il tetto: 429, Retry-After e NESSUNA email in più', async (_nome, handler, base) => {
    for (let i = 0; i < LIMITE_OTP_INVIO; i++) await handler(invio(base))
    // Si azzerano ENTRAMBI i contatori: gli invii entro il tetto sono legittimi e devono
    // aver spedito e scritto nel registro. Qui si guarda solo ciò che succede DOPO.
    otp.sendOtp.mockClear()
    fea.logFeaEvent.mockClear()

    const res = await handler(invio(base))

    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    // L'asserzione che conta: non lo status, la mutazione. Nessuna email è partita.
    expect(otp.sendOtp, 'il 429 è arrivato MA l’email è partita lo stesso').not.toHaveBeenCalled()
    expect(fea.logFeaEvent, 'un tentativo bloccato non deve entrare nel registro FEA').not.toHaveBeenCalled()
  })

  it('il budget è UNO SOLO per le quattro rotte: la casella del genitore è una sola', async () => {
    // Quattro tetti indipendenti farebbero 4× le email verso la stessa casella, che è
    // esattamente ciò da cui il tetto la deve proteggere.
    for (let i = 0; i < LIMITE_OTP_INVIO; i++) await handler_a_rotazione(i)
    otp.sendOtp.mockClear()

    for (const [nome, handler, base] of INVIO) {
      const res = await handler(invio(base))
      expect(res.status, `${nome} ha un budget suo`).toBe(429)
    }
    expect(otp.sendOtp).not.toHaveBeenCalled()
  })

  it('il tetto è per UTENTE: un genitore non consuma il budget di un altro (controllo positivo)', async () => {
    // Senza questo, un limitatore globale «tutti bloccati sempre» passerebbe le prove
    // qui sopra pur essendo un guasto: nega anche a chi non ha fatto niente.
    for (let i = 0; i < LIMITE_OTP_INVIO; i++) await postGiustifica(invio(INVIO[1][2]))
    expect((await postGiustifica(invio(INVIO[1][2]))).status).toBe(429)

    auth.requireUser.mockResolvedValue({ user: { id: ALTRO_UTENTE, role: 'genitore' } })
    otp.sendOtp.mockClear()

    const res = await postGiustifica(invio(INVIO[1][2]))
    expect(res.status, 'un altro genitore paga il traffico del primo').toBe(200)
    expect(otp.sendOtp).toHaveBeenCalledTimes(1)
  })

  it('senza sessione non si consuma budget (il 401 arriva prima)', async () => {
    auth.requireUser.mockResolvedValue({
      response: new Response(JSON.stringify({ error: 'Non autenticato' }), { status: 401 }),
    })
    for (let i = 0; i < LIMITE_OTP_INVIO + 3; i++) {
      expect((await postNota(invio(INVIO[2][2]))).status).toBe(401)
    }

    // Il budget dell'utente vero è intatto: un anonimo non può esaurirglielo.
    auth.requireUser.mockResolvedValue({ user: { id: UTENTE, role: 'genitore' } })
    expect((await postNota(invio(INVIO[2][2]))).status).toBe(200)
  })
})

/** Consuma il budget alternando le quattro rotte, una richiesta ciascuna a giro. */
async function handler_a_rotazione(i: number): Promise<void> {
  const [, handler, base] = INVIO[i % INVIO.length]
  await handler(invio(base))
}

describe('OTP del genitore — verifica: il codice a sei cifre non si indovina a tentativi', () => {
  it('entro il tetto ogni tentativo viene valutato', async () => {
    for (let i = 0; i < LIMITE_OTP_VERIFICA; i++) {
      const res = await patchForms(verifica())
      expect(res.status, `tentativo ${i + 1} rifiutato dal limitatore`).toBe(400)
    }
    expect(otp.verifyTicket).toHaveBeenCalledTimes(LIMITE_OTP_VERIFICA)
  })

  it('oltre il tetto: 429 e NESSUN tentativo valutato', async () => {
    for (let i = 0; i < LIMITE_OTP_VERIFICA; i++) await patchForms(verifica())
    otp.verifyTicket.mockClear()

    const res = await patchForms(verifica())

    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(
      otp.verifyTicket,
      'il 429 è arrivato MA il codice è stato provato lo stesso: il brute force continua',
    ).not.toHaveBeenCalled()
    expect(persist.persistSignedSubmission).not.toHaveBeenCalled()
  })

  it('il tetto della verifica è distinto da quello dell’invio (controllo positivo)', async () => {
    // Se condividessero il budget, chiedere un codice nuovo consumerebbe i tentativi di
    // digitazione — e chi sbaglia a digitare resterebbe fuori dalla firma.
    for (let i = 0; i < LIMITE_OTP_INVIO; i++) await postForms(invio(INVIO[0][2]))
    expect((await postForms(invio(INVIO[0][2]))).status).toBe(429)

    const res = await patchForms(verifica())
    expect(res.status, 'la verifica è stata bloccata dal budget degli invii').toBe(400)
  })
})
