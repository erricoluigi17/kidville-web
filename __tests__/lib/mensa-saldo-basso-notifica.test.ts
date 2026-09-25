import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// MENSA «SALDO BASSO» — la push la porta SOLO il dispatch (intervento W2).
//
// Fino al 2026-09-24 `notificaSaldoBasso`, dopo aver inserito la riga in
// `notifiche`, chiamava `sendPush` da sé su TUTTE le `push_subscriptions` dei
// genitori. Due difetti:
//  · i dispositivi NATIVI (token FCM/APNs) non hanno `p256dh`/`auth`: ogni giro
//    produceva l'errore «must have auth and p256dh keys»;
//  · chi usa il web la riceveva DUE volte, perché la riga restava pendente e
//    `notifiche-dispatch` la rispediva comunque.
// Ora nasce la riga pendente e basta, come per l'alert allergie.
//
// Qui il finto client FILTRA e SCRIVE davvero: le righe finite in `notifiche`
// e le scritture su `push_subscriptions` si leggono nell'accumulatore.
// =============================================================================

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))
const sendPush = vi.fn(async () => ({ gone: false }))
vi.mock('@/lib/push/web-push', () => ({ sendPush: (...a: unknown[]) => sendPush(...(a as [])) }))
const sendNativePush = vi.fn(async () => ({ ok: true }))
vi.mock('@/lib/push/native-push', () => ({ sendNativePush: (...a: unknown[]) => sendNativePush(...(a as [])) }))
const isNotificaAbilitata = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true)
vi.mock('@/lib/notifiche/config', () => ({ isNotificaAbilitata: (...a: unknown[]) => isNotificaAbilitata(...a) }))
// I genitori dell'alunno: la risoluzione runtime+anagrafica ha i suoi test.
const getGenitoriDiAlunno = vi.fn<(...a: unknown[]) => Promise<string[]>>(async () => ['gen-1', 'gen-2'])
vi.mock('@/lib/anagrafiche/legami', () => ({ getGenitoriDiAlunno: (...a: unknown[]) => getGenitoriDiAlunno(...a) }))

import { notificaSaldoBasso } from '@/lib/mensa/notify'

const ALUNNO = '00000000-0000-4000-8000-0000000000a1'

function db(): DBFinto {
  return {
    alunni: [{ id: ALUNNO, scuola_id: SEDE_A }],
    notifiche: [],
    push_subscriptions: [
      // Un browser: chiavi web presenti. Prima riceveva la push due volte.
      { id: 'sub-web', utente_id: 'gen-1', endpoint: 'https://push.example.invalid/gen-1', p256dh: 'p', auth: 'a', platform: 'web' },
      // Un telefono con l'app nativa: token senza chiavi web.
      { id: 'sub-android', utente_id: 'gen-1', endpoint: 'token-fcm-finto', p256dh: null, auth: null, platform: 'android' },
      { id: 'sub-ios', utente_id: 'gen-2', endpoint: 'token-apns-finto', p256dh: null, auth: null, platform: 'ios' },
    ],
  }
}

const OPTS = { alunnoId: ALUNNO, saldo: 2, nomeAlunno: 'Bambino di prova' }

function logCon(esito: string) {
  return logEvento.mock.calls.find((c) => c[0] === 'mensa' && (c[2] as { esito?: string })?.esito === esito)
}

beforeEach(() => {
  logEvento.mockClear()
  sendPush.mockClear()
  sendNativePush.mockClear()
  isNotificaAbilitata.mockClear()
  isNotificaAbilitata.mockResolvedValue(true)
  getGenitoriDiAlunno.mockClear()
  getGenitoriDiAlunno.mockResolvedValue(['gen-1', 'gen-2'])
})

describe('notificaSaldoBasso — niente web-push diretto, la riga resta al dispatch', () => {
  it('genitori con browser e app nativa ⇒ `sendPush` MAI chiamata, dispositivi intatti', async () => {
    const scritture: Scrittura[] = []
    const lette: string[] = []
    const stato = db()

    await notificaSaldoBasso(creaFintoSupabase(stato, lette, { scritture }), OPTS)

    expect(sendPush).not.toHaveBeenCalled()
    expect(sendNativePush).not.toHaveBeenCalled()
    // Nessuno legge né tocca i dispositivi da qui: né select né delete.
    // `lette` accumula ogni `from(<tabella>)`, letture comprese; `scritture` solo
    // insert/update/upsert/delete. Servono tutti e due.
    expect(lette).toContain('notifiche') // l'accumulatore è vivo: il controllo sotto non è a vuoto
    expect(lette).not.toContain('push_subscriptions')
    expect(scritture.filter((s) => s.tabella === 'push_subscriptions')).toHaveLength(0)
    expect(stato.push_subscriptions).toHaveLength(3)
  })

  it('UNA riga per genitore in `notifiche`, pendente: la vede il dispatch al giro dopo', async () => {
    const scritture: Scrittura[] = []
    const stato = db()

    await notificaSaldoBasso(creaFintoSupabase(stato, [], { scritture }), OPTS)

    const inserite = scritture.filter((s) => s.tabella === 'notifiche' && s.operazione === 'insert')
    expect(inserite).toHaveLength(1)
    expect(inserite[0].valori.map((r) => r.utente_id).sort()).toEqual(['gen-1', 'gen-2'])
    expect(stato.notifiche).toHaveLength(2)
    for (const r of stato.notifiche) {
      expect(r).toMatchObject({ tipo: 'mensa_saldo_basso', entita_tipo: 'alunno', entita_id: ALUNNO, link: '/parent/mensa' })
      expect(r.push_inviata_il ?? null).toBeNull()
      expect(r.invio_programmato_il ?? null).toBeNull()
    }
    // Il gate del tipo si chiede con la sede dell'alunno.
    expect(isNotificaAbilitata).toHaveBeenCalledWith(expect.anything(), 'mensa_saldo_basso', SEDE_A)
    // Nessun'altra scrittura su `notifiche`: niente marcature di invio da qui.
    expect(scritture.filter((s) => s.tabella === 'notifiche' && s.operazione !== 'insert')).toHaveLength(0)
  })

  it('successo ⇒ log `info` «accodata» con il numero di righe, e nessun nome né saldo', async () => {
    await notificaSaldoBasso(creaFintoSupabase(db()), OPTS)

    const riga = logCon('accodata')
    expect(riga).toBeDefined()
    expect(riga?.[1]).toBe('info')
    expect(riga?.[2]).toMatchObject({ operazione: 'notificaSaldoBasso', alunno_id: ALUNNO, n: 2 })
    expect(JSON.stringify(riga?.[2])).not.toMatch(/Bambino/)
    expect(logCon('notifiche-non-inserite')).toBeUndefined()
  })

  it('insert rifiutato da PostgREST ⇒ log `error`, e NESSUN log di successo', async () => {
    const stato = db()
    await notificaSaldoBasso(
      creaFintoSupabase(stato, [], { errori: { 'notifiche:insert': { code: '42501', message: 'permission denied' } } }),
      OPTS,
    )

    const riga = logCon('notifiche-non-inserite')
    expect(riga).toBeDefined()
    expect(riga?.[1]).toBe('error')
    expect(riga?.[2]).toMatchObject({ alunno_id: ALUNNO, n: 2 })
    expect(logCon('accodata')).toBeUndefined()
    expect(stato.notifiche).toHaveLength(0)
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('sede dell\'alunno non leggibile ⇒ log `warn`, gate con sede nulla, e l\'avviso parte lo stesso (fail-open)', async () => {
    const scritture: Scrittura[] = []
    const stato = db()
    await notificaSaldoBasso(
      creaFintoSupabase(stato, [], {
        scritture,
        errori: { 'alunni:select': { code: '42501', message: 'permission denied' } },
      }),
      OPTS,
    )

    // (a) la lettura fallita non resta muta
    const avviso = logCon('sede-alunno-non-letta')
    expect(avviso).toBeDefined()
    expect(avviso?.[1]).toBe('warn')
    expect(avviso?.[2]).toMatchObject({ operazione: 'notificaSaldoBasso', alunno_id: ALUNNO })
    // (b) il gate del tipo si chiede senza sede, cioè col default
    expect(isNotificaAbilitata).toHaveBeenCalledWith(expect.anything(), 'mensa_saldo_basso', null)
    // (c) fail-open: le due righe nascono comunque, e il successo si registra
    const inserite = scritture.filter((s) => s.tabella === 'notifiche' && s.operazione === 'insert')
    expect(inserite).toHaveLength(1)
    expect(stato.notifiche).toHaveLength(2)
    expect(logCon('accodata')).toBeDefined()
  })

  it('nessun genitore collegato ⇒ nessuna riga, nessuna push', async () => {
    getGenitoriDiAlunno.mockResolvedValue([])
    const scritture: Scrittura[] = []
    await notificaSaldoBasso(creaFintoSupabase(db(), [], { scritture }), OPTS)

    expect(scritture.filter((s) => s.tabella === 'notifiche')).toHaveLength(0)
    expect(sendPush).not.toHaveBeenCalled()
    expect(logCon('accodata')).toBeUndefined()
  })

  it('tipo disattivato per la sede ⇒ nessuna riga', async () => {
    isNotificaAbilitata.mockResolvedValue(false)
    const scritture: Scrittura[] = []
    await notificaSaldoBasso(creaFintoSupabase(db(), [], { scritture }), OPTS)

    expect(scritture.filter((s) => s.tabella === 'notifiche')).toHaveLength(0)
    expect(getGenitoriDiAlunno).not.toHaveBeenCalled()
  })
})
