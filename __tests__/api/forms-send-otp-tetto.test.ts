import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'

// =============================================================================
// `forms/send-otp:PATCH` — il quinto OTP, quello senza nessuno dietro.
//
// TROVATO il 2026-08-01, mentre si estendeva il tetto alle quattro firme del
// genitore (S30): il lock nuovo `otp-con-tetto.test.ts` non guarda un elenco di
// rotte ma spezza ogni file nei singoli handler HTTP, e ha tirato fuori una quinta
// porta che nessuno stava cercando.
//
// Questo PATCH confronta un codice a SEI CIFRE
// (`hashOtp(submissionId, code) !== submission.otp_secret`) e fino a oggi:
//
//   1. non aveva NESSUN tetto — il POST della stessa route ne ha uno per IP da
//      mesi, il PATCH no. Un milione di combinazioni, tutte gratuite;
//   2. non ha NESSUN gate d'identità: bastano un `submissionId` e un codice. Questo
//      **non è un difetto** — il modulo «Sistema A» è firmabile anche da chi non ha
//      una sessione, ed è una scelta di prodotto — ma toglie di mezzo la chiave
//      naturale del tetto, che altrove è l'id di sessione.
//
// Chi indovina porta la domanda a `completed`, con `signed_at` e la riga nel
// registro delle firme. È una firma con valore legale.
//
// LA CHIAVE È IL BERSAGLIO. Non l'IP, che chi attacca cambia a piacere e che
// punirebbe un intero plesso dietro lo stesso NAT: il `submissionId`, cioè l'unica
// cosa che chi tenta non può sostituire senza rinunciare alla firma che sta
// forzando. È il rovescio del ragionamento fatto per l'utente, e porta allo stesso
// posto: si conta ciò che l'attore non può cambiare.
//
// LE ASSERZIONI CHE CONTANO sono sulla MUTAZIONE e sul NON-EVENTO: oltre il tetto
// la domanda non deve essere aggiornata, e soprattutto il codice non deve nemmeno
// essere confrontato — è quel confronto il tentativo che si sta contando. Un 429
// che avesse già valutato il codice sarebbe un tetto per finta.
// =============================================================================

const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
    captured: { update: [] as unknown[] },
    /** Quante volte la riga della domanda è stata LETTA: prova che il tetto viene prima. */
    letture: 0,
  }
  function take(table: string) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    if (table === 'form_submissions') state.letture += 1
    return q[i] ?? { data: null, error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        for (const m of ['select', 'insert', 'eq', 'order', 'limit', 'in']) qb[m] = () => qb
        qb.update = (v: unknown) => { state.captured.update.push({ table, value: v }); return qb }
        qb.upsert = () => qb
        qb.single = () => Promise.resolve(take(table))
        qb.maybeSingle = () => Promise.resolve(take(table))
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(take(table)).then(res, rej)
        return qb
      },
    }
  }
  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.makeClient()),
}))
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }))

// `rate-limit` NON è mockato: è la macchina sotto esame. La finestra è reale e il
// contatore è in memoria, quindi ogni test parte da una chiave diversa.
import { PATCH } from '@/app/api/forms/send-otp/route'
import { LIMITE_OTP_VERIFICA } from '@/lib/security/otp-rate-limit'

function hashOtp(submissionId: string, code: string): string {
  return createHash('sha256').update(`${submissionId}:${code}`).digest('hex')
}

function patchReq(body: unknown): Request {
  return new Request('http://localhost/api/forms/send-otp', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

/** Un id diverso per ogni test: il contatore vive in memoria fra un test e l'altro. */
let contatore = 0
function nuovoSid(): string {
  contatore += 1
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(contatore).padStart(12, '0')}`
}

/** La riga che il finto database restituisce a ogni lettura della domanda. */
function preparaDomanda(sid: string, codiceGiusto: string, quante: number) {
  h.state.queues.form_submissions = Array.from({ length: quante }, () => ({
    data: {
      id: sid,
      otp_secret: hashOtp(sid, codiceGiusto),
      status: 'pending',
      user_id: null,
      model_id: 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm',
      otp_generato_il: new Date().toISOString(),
    },
    error: null,
  }))
  h.state.queues.form_models = Array.from({ length: quante }, () => ({
    data: { signature_mode: 'single' },
    error: null,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.captured.update = []
  h.state.letture = 0
})

describe('PATCH /api/forms/send-otp — i tentativi si contano sul bersaglio', () => {
  it(`oltre ${LIMITE_OTP_VERIFICA} tentativi ⇒ 429, con Retry-After`, async () => {
    const sid = nuovoSid()
    preparaDomanda(sid, '123456', LIMITE_OTP_VERIFICA + 5)

    // I primi N sono tentativi sbagliati ma LECITI: il tetto non deve scattare prima.
    for (let i = 0; i < LIMITE_OTP_VERIFICA; i += 1) {
      const res = await PATCH(patchReq({ submissionId: sid, code: '000000' }))
      expect(res.status, `il tentativo ${i + 1} non deve essere bloccato`).toBe(400)
    }

    const bloccato = await PATCH(patchReq({ submissionId: sid, code: '000000' }))
    expect(bloccato.status).toBe(429)
    expect(bloccato.headers.get('Retry-After')).toBeTruthy()
    const corpo = await bloccato.json()
    expect(corpo.codice, 'il 429 porta un codice traducibile').toBe('TROPPE_RICHIESTE')
  })

  it('il tentativo bloccato non arriva nemmeno a LEGGERE la domanda', async () => {
    // Il tetto sta prima di ogni query: un tentativo bloccato non deve costare un
    // giro di database, e soprattutto non deve raggiungere il confronto — è QUEL
    // confronto il tentativo che si sta contando.
    const sid = nuovoSid()
    preparaDomanda(sid, '123456', LIMITE_OTP_VERIFICA + 5)

    for (let i = 0; i < LIMITE_OTP_VERIFICA; i += 1) {
      await PATCH(patchReq({ submissionId: sid, code: '000000' }))
    }
    const lettureFinoAQui = h.state.letture
    await PATCH(patchReq({ submissionId: sid, code: '000000' }))
    expect(h.state.letture, 'nessuna lettura in più dopo il blocco').toBe(lettureFinoAQui)
  })

  it('oltre il tetto NON si firma, nemmeno col codice GIUSTO (la mutazione)', async () => {
    // È l'asserzione che conta: se il codice giusto passasse comunque, il tetto
    // sarebbe una formalità e la forzatura resterebbe possibile — basterebbe
    // arrivare all'ultimo tentativo con quello buono.
    const sid = nuovoSid()
    preparaDomanda(sid, '123456', LIMITE_OTP_VERIFICA + 5)

    for (let i = 0; i < LIMITE_OTP_VERIFICA; i += 1) {
      await PATCH(patchReq({ submissionId: sid, code: '000000' }))
    }
    h.state.captured.update = []
    const res = await PATCH(patchReq({ submissionId: sid, code: '123456' }))
    expect(res.status).toBe(429)
    expect(h.state.captured.update, 'nessun aggiornamento della domanda').toEqual([])
  })

  it('CONTROLLO POSITIVO: il codice giusto, sotto il tetto, firma ancora', async () => {
    // Senza questo, tutto il file certificherebbe un tetto che blocca chiunque —
    // cioè una firma che non si può più completare.
    const sid = nuovoSid()
    preparaDomanda(sid, '654321', 4)

    const res = await PATCH(patchReq({ submissionId: sid, code: '654321' }))
    expect(res.status).toBe(200)
    expect(h.state.captured.update.length, 'la domanda viene aggiornata').toBeGreaterThan(0)
  })

  it('il budget è PER DOMANDA: una firma esaurita non blocca le altre', async () => {
    // Il rovescio del tetto per IP: bruciare i tentativi su una domanda non deve
    // impedire a un'altra famiglia di firmare la propria.
    const bruciata = nuovoSid()
    preparaDomanda(bruciata, '111111', LIMITE_OTP_VERIFICA + 3)
    for (let i = 0; i < LIMITE_OTP_VERIFICA + 1; i += 1) {
      await PATCH(patchReq({ submissionId: bruciata, code: '000000' }))
    }

    h.state.used = {}
    const altra = nuovoSid()
    preparaDomanda(altra, '222222', 4)
    const res = await PATCH(patchReq({ submissionId: altra, code: '222222' }))
    expect(res.status, 'l’altra domanda non è toccata dal tetto della prima').toBe(200)
  })
})
