/**
 * Le OTTO porte OTP del genitore hanno un limitatore di frequenza: quattro che
 * SPEDISCONO il codice, quattro che lo VERIFICANO.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL GUASTO, PRIMA PARTE (invio). Collaudo del 2026-07-31, sicurezza W5:
 * `api/parent/forms/otp`, `api/parent/presenze/giustifica/otp`,
 * `api/parent/primaria/note/firma/otp` e `api/parent/primaria/pagella/firma/otp` non
 * importavano `@/lib/security/rate-limit` — che invece è usato da `forms/send-otp` e
 * `public/cancellazione-account` da mesi. Nessun tetto: un ciclo di richieste riempiva la
 * casella del genitore di codici di firma, a spese della reputazione del dominio mittente
 * (e le email di credenziali di questo progetto sono già rimaste bloccate una volta da un
 * `403` del provider).
 *
 * IL GUASTO, SECONDA PARTE (verifica) — scoperto il 2026-08-01, ondata 4 step S30. La
 * correzione del 31 luglio aveva messo il tetto sulla verifica di UNA rotta sola
 * (`parent/forms/otp:PATCH`). Le altre TRE firme non verificano il codice nella rotta
 * `…/otp`: lo verificano nella rotta SORELLA che firma davvero —
 * `parent/presenze/giustifica:POST`, `parent/primaria/note/firma:POST`,
 * `parent/primaria/pagella/firma:POST` — e quelle non erano state toccate. Il tetto
 * proteggeva una firma su quattro, mentre la testata di questo file dichiarava «le quattro
 * rotte OTP del genitore hanno un limitatore» e il test passava: l'elenco per nome
 * dimostrava soltanto ciò che qualcuno si era ricordato di elencare.
 *
 * Perché è grave: il codice è di **sei cifre** (`otp-ticket.ts:135`), la verifica è un
 * confronto HMAC che NON consuma il ticket quando fallisce (`consumeTicket` è chiamata solo
 * dopo un esito positivo) e il ticket vive 10 minuti. Senza limitatore i tentativi sono
 * illimitati e gratuiti, e ciò che si ottiene indovinando non è un accesso: è la
 * giustificazione di un'assenza, la presa visione di una nota disciplinare o di una pagella
 * apposte A NOME DI UN GENITORE VERO, con valore legale (CAD art. 20). Il tetto qui non è
 * anti-spam: è ciò che tiene in piedi l'unica prova che quel genitore abbia davvero firmato.
 *
 * COSA ASSERISCE QUESTO FILE, e perché così. Non lo status: la **mutazione**. Oltre il
 * tetto, `sendOtp` non viene più chiamata (nessuna email parte), `verifyTicket` non viene
 * più chiamata (nessun tentativo viene valutato) e il registro FEA non riceve una riga
 * `verify_failed` per ogni tentativo bloccato. Uno status 429 con l'email spedita lo stesso,
 * o col codice provato lo stesso, sarebbe un limitatore finto — e passerebbe un test scritto
 * sullo status.
 *
 * QUESTO FILE NON BASTA, ED È IL SUO LIMITE STRUTTURALE: elenca le rotte per nome (`INVIO`,
 * `VERIFICA`), quindi la nona porta OTP che nascerà domani non comparirà in nessun elenco e
 * non romperà niente — esattamente come è successo alle tre rotte di verifica. La copertura
 * per costruzione sta in `__tests__/architecture/otp-con-tetto.test.ts`, che parte da TUTTE
 * le route.ts e pretende il tetto ovunque si tocchi un OTP. I due test servono a cose
 * diverse: quello è un censimento, questo dimostra che il tetto FUNZIONA.
 *
 * PROVA DI VALIDITÀ (eseguita, 2026-08-01): togliendo il blocco `limitaVerificaOtp` da
 * `parent/primaria/note/firma/route.ts` i casi «oltre il tetto» di quella rotta tornano
 * rossi — 400 invece di 429, `verifyTicket` chiamata 11 volte su 11.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const dati = vi.hoisted(() => ({
  ALUNNO: {
    id: '44444444-4444-4444-8444-444444444444',
    section_id: '55555555-5555-4555-8555-555555555555',
    scuola_id: '66666666-6666-4666-8666-666666666666',
  },
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue({
    from: (tabella: string) => ({
      select: () => ({
        eq: () => ({
          // Solo `alunni` risponde: è l'unica lettura che precede la verifica OTP
          // (gating primaria della giustifica). Tutto il resto sta DOPO il 400 del
          // codice sbagliato, e non deve essere raggiunto in nessuno di questi test.
          maybeSingle: () => Promise.resolve({ data: tabella === 'alunni' ? dati.ALUNNO : null, error: null }),
        }),
      }),
    }),
  }),
}))

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: auth.requireUser }))

const parentGate = vi.hoisted(() => ({ requireParentOfStudent: vi.fn() }))
vi.mock('@/lib/auth/require-parent', () => parentGate)

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

const sospensione = vi.hoisted(() => ({
  assertGenitoreNonSospesoSalvoEssenziale: vi.fn(),
  assertGenitoreNonSospeso: vi.fn(),
}))
vi.mock('@/lib/pagamenti/sospensione', () => sospensione)

const config = vi.hoisted(() => ({ getModuleConfig: vi.fn() }))
vi.mock('@/lib/settings/module-config', () => config)

vi.mock('@/lib/forms/sempre-firmabile', () => ({ leggiSempreFirmabile: vi.fn().mockResolvedValue(false) }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: vi.fn().mockResolvedValue(true) }))

const persist = vi.hoisted(() => ({ persistSignedSubmission: vi.fn() }))
vi.mock('@/lib/forms/persist-submission', () => persist)

import { POST as postForms, PATCH as patchForms } from '@/app/api/parent/forms/otp/route'
import { POST as postGiustifica } from '@/app/api/parent/presenze/giustifica/otp/route'
import { POST as postNota } from '@/app/api/parent/primaria/note/firma/otp/route'
import { POST as postPagella } from '@/app/api/parent/primaria/pagella/firma/otp/route'
import { POST as firmaGiustifica } from '@/app/api/parent/presenze/giustifica/route'
import { POST as firmaNota } from '@/app/api/parent/primaria/note/firma/route'
import { POST as firmaPagella } from '@/app/api/parent/primaria/pagella/firma/route'
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

/** Il PATCH che verifica il codice del modulo Sistema B. */
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

/** Campi OTP comuni alle tre rotte sorelle: un tentativo di codice sbagliato. */
const tentativo = () => ({ code: '000000', expiry: Date.now() + 60_000, ticket: 'ticket-di-prova' })

function post(url: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

const firmaGiustificaReq = () =>
  post('http://localhost/api/parent/presenze/giustifica', {
    studentId: dati.ALUNNO.id,
    data: new Date().toISOString().slice(0, 10),
    motivo: 'motivo',
    ...tentativo(),
  })

const firmaNotaReq = () =>
  post('http://localhost/api/parent/primaria/note/firma', {
    notaId: '77777777-7777-4777-8777-777777777777',
    ...tentativo(),
  })

const firmaPagellaReq = () =>
  post('http://localhost/api/parent/primaria/pagella/firma', {
    scrutinioId: '88888888-8888-4888-8888-888888888888',
    studentId: dati.ALUNNO.id,
    ...tentativo(),
  })

/**
 * Le QUATTRO porte che VERIFICANO un codice. Tre di esse non sono le rotte `…/otp`:
 * sono le rotte che firmano, ed è esattamente ciò che le aveva fatte sfuggire.
 */
const VERIFICA = [
  ['parent/forms/otp:PATCH', patchForms, verifica],
  ['presenze/giustifica:POST', firmaGiustifica, firmaGiustificaReq],
  ['primaria/note/firma:POST', firmaNota, firmaNotaReq],
  ['primaria/pagella/firma:POST', firmaPagella, firmaPagellaReq],
] as const

/** Le tre che scrivono `verify_failed` nel registro FEA a ogni tentativo fallito. */
const VERIFICA_CON_AUDIT = VERIFICA.filter(([nome]) => nome !== 'parent/forms/otp:PATCH')

beforeEach(() => {
  vi.clearAllMocks()
  resetRateLimit()
  auth.requireUser.mockResolvedValue({ user: { id: UTENTE, role: 'genitore' } })
  parentGate.requireParentOfStudent.mockResolvedValue({ user: { id: UTENTE, role: 'genitore' } })
  otp.sendOtp.mockResolvedValue({ email: 'g@example.test', expiry: 0, ticket: 't', sent: true })
  otp.getUserEmail.mockResolvedValue('g@example.test')
  otp.verifyTicket.mockReturnValue({ ok: false, error: 'Codice non valido' })
  otp.consumeTicket.mockResolvedValue({ ok: true })
  sospensione.assertGenitoreNonSospesoSalvoEssenziale.mockResolvedValue(null)
  sospensione.assertGenitoreNonSospeso.mockResolvedValue(null)
  config.getModuleConfig.mockResolvedValue({
    giustifica_richiede_firma_otp: true,
    giustifica_max_giorni_retroattivi: 5,
  })
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
  it.each(VERIFICA)('%s — entro il tetto ogni tentativo viene valutato', async (_nome, handler, richiesta) => {
    for (let i = 0; i < LIMITE_OTP_VERIFICA; i++) {
      const res = await handler(richiesta())
      expect(res.status, `tentativo ${i + 1} rifiutato dal limitatore`).toBe(400)
    }
    expect(otp.verifyTicket).toHaveBeenCalledTimes(LIMITE_OTP_VERIFICA)
  })

  it.each(VERIFICA)('%s — oltre il tetto: 429 e NESSUN tentativo valutato', async (_nome, handler, richiesta) => {
    for (let i = 0; i < LIMITE_OTP_VERIFICA; i++) await handler(richiesta())
    otp.verifyTicket.mockClear()

    const res = await handler(richiesta())

    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(
      otp.verifyTicket,
      'il 429 è arrivato MA il codice è stato provato lo stesso: il brute force continua',
    ).not.toHaveBeenCalled()
    expect(persist.persistSignedSubmission).not.toHaveBeenCalled()
  })

  it('il budget della verifica è UNO SOLO per le quattro firme', async () => {
    // Budget separati per firma vorrebbero dire 40 tentativi invece di 10, ottenuti
    // semplicemente cambiando rotta: un tetto che si aggira senza nemmeno forzarlo.
    for (let i = 0; i < LIMITE_OTP_VERIFICA; i++) {
      const [, handler, richiesta] = VERIFICA[i % VERIFICA.length]
      await handler(richiesta())
    }
    otp.verifyTicket.mockClear()

    for (const [nome, handler, richiesta] of VERIFICA) {
      const res = await handler(richiesta())
      expect(res.status, `${nome} ha un budget suo`).toBe(429)
    }
    expect(otp.verifyTicket).not.toHaveBeenCalled()
  })

  it('il tetto della verifica è per UTENTE (controllo positivo)', async () => {
    // Un limitatore che nega a tutti passerebbe le prove qui sopra pur essendo un guasto:
    // impedirebbe di firmare a chi non ha fatto nessun tentativo.
    for (let i = 0; i < LIMITE_OTP_VERIFICA; i++) await firmaNota(firmaNotaReq())
    expect((await firmaNota(firmaNotaReq())).status).toBe(429)

    auth.requireUser.mockResolvedValue({ user: { id: ALTRO_UTENTE, role: 'genitore' } })
    otp.verifyTicket.mockClear()

    const res = await firmaNota(firmaNotaReq())
    expect(res.status, 'un altro genitore paga i tentativi del primo').toBe(400)
    expect(otp.verifyTicket).toHaveBeenCalledTimes(1)
  })

  it.each(VERIFICA_CON_AUDIT)(
    '%s — il registro FEA non si riempie di tentativi bloccati',
    async (_nome, handler, richiesta) => {
      // Controllo positivo prima: entro il tetto il tentativo fallito DEVE lasciare
      // traccia (`verify_failed` è l'unico segnale che qualcuno sta provando).
      await handler(richiesta())
      expect(fea.logFeaEvent, 'un tentativo valutato e fallito non è stato registrato').toHaveBeenCalledTimes(1)
      expect(fea.logFeaEvent.mock.calls[0][1]).toMatchObject({ evento: 'verify_failed' })

      for (let i = 1; i < LIMITE_OTP_VERIFICA; i++) await handler(richiesta())
      fea.logFeaEvent.mockClear()

      expect((await handler(richiesta())).status).toBe(429)
      expect(fea.logFeaEvent, 'il tentativo bloccato è finito nel registro FEA lo stesso').not.toHaveBeenCalled()
    },
  )

  it('il tetto della verifica è distinto da quello dell’invio (controllo positivo)', async () => {
    // Se condividessero il budget, chiedere un codice nuovo consumerebbe i tentativi di
    // digitazione — e chi sbaglia a digitare resterebbe fuori dalla firma.
    for (let i = 0; i < LIMITE_OTP_INVIO; i++) await postForms(invio(INVIO[0][2]))
    expect((await postForms(invio(INVIO[0][2]))).status).toBe(429)

    const res = await patchForms(verifica())
    expect(res.status, 'la verifica è stata bloccata dal budget degli invii').toBe(400)
  })

  it('la giustifica senza firma OTP non consuma il budget dei tentativi', async () => {
    // Quando la scuola disattiva `giustifica_richiede_firma_otp` non c'è nessun codice da
    // indovinare: il tetto non deve applicarsi, o un genitore con tre figli si troverebbe
    // sbarrato dopo dieci giustifiche in dieci minuti senza nessun guadagno di sicurezza.
    config.getModuleConfig.mockResolvedValue({
      giustifica_richiede_firma_otp: false,
      giustifica_max_giorni_retroattivi: 5,
    })
    for (let i = 0; i < LIMITE_OTP_VERIFICA + 2; i++) {
      const res = await firmaGiustifica(firmaGiustificaReq())
      expect(res.status, `giustifica ${i + 1} bloccata da un tetto che non c’entra`).not.toBe(429)
    }
    expect(otp.verifyTicket, 'senza firma OTP non si verifica nessun codice').not.toHaveBeenCalled()

    // …e il budget dei tentativi VERI è rimasto intatto.
    expect((await firmaNota(firmaNotaReq())).status).toBe(400)
  })
})
