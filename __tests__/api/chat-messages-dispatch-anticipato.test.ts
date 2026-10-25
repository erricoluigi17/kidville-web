import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CASO_PEGGIORE_GIRO_MS } from '@/lib/push/durata-dispatch'

/**
 * LA PUSH DELLA CHAT PARTE 30 SECONDI DOPO IL MESSAGGIO (PS3, spec «sei interventi» del 24/09).
 *
 * Fino al 24/09 la notifica di un messaggio restava in coda fino al giro del cron, ogni 5 minuti:
 * 2,8 minuti di ritardo medio misurato. Ora la POST, DOPO aver accodato la notifica, programma con
 * `after()` un'attesa di 30 s e poi `eseguiDispatch({ origine: 'chat' })`.
 *
 * Cosa si prova, e perché ogni test diventerebbe rosso senza la modifica:
 *  · il giro è programmato UNA volta, DOPO l'accodamento, e non parte prima di 30 s (timer finti:
 *    a 29.999 ms non è partito, a 30.000 sì), con l'origine `chat` — non `cron`, che scriverebbe il
 *    battito del cron e renderebbe vivo un cron fermo;
 *  · la risposta è 201 PRIMA che il giro parta, e resta 201 anche se `after()` non è disponibile;
 *  · senza controparte (nessuna notifica accodata) o con l'accodamento fallito, niente giro;
 *  · i log di avvio e d'esito (ok, fallito, eccezione), con il thread e i contatori, senza testo;
 *  · il `maxDuration` della route copre l'attesa PIÙ il caso peggiore del giro.
 *
 * UUID finti e fissi, nessun dato di una persona vera.
 */

const TEACHER = 'aaaaaaaa-0000-4000-8000-000000000021'
const PARENT = 'bbbbbbbb-0000-4000-8000-000000000022'
const ALUNNO = 'cccccccc-0000-4000-8000-000000000023'
const THREAD = 'dddddddd-0000-4000-8000-000000000024'
const ALTRO_THREAD = 'dddddddd-0000-4000-8000-000000000026'
const SEDE = 'eeeeeeee-0000-4000-8000-000000000025'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  controparteThread: vi.fn(),
  notificaEvento: vi.fn(),
  eseguiDispatch: vi.fn(),
  logEvento: vi.fn(),
  after: vi.fn(),
  /** I callback consegnati ad `after()`, da eseguire a mano come farebbe la piattaforma. */
  programmati: [] as Array<() => Promise<void>>,
  /** Fase 8: quante notifiche della conversazione sono ancora da spedire dopo l'attesa. Una
   *  funzione, così una raffica può vederle sparire dopo il primo giro. */
  inCoda: (() => 1) as () => number,
  erroreCoda: null as null | { code: string; message: string },
  /** I filtri della lettura della coda, per provare che guarda QUESTA conversazione. */
  filtriCoda: [] as Array<Record<string, unknown>>,
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: h.after,
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: async () => null }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ controparteThread: h.controparteThread }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento, nomeUtente: async () => null }))
// Le costanti del giro restano vere (servono a `durata-dispatch` per il caso peggiore): si
// sostituisce solo la funzione.
vi.mock('@/lib/push/dispatch', async (orig) => ({
  ...(await orig<typeof import('@/lib/push/dispatch')>()),
  eseguiDispatch: h.eseguiDispatch,
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

const adminClient = {
  from(table: string) {
    const b: Record<string, unknown> = {}
    const filtri: Record<string, unknown> = {}
    b.select = () => b
    b.eq = (c: string, v: unknown) => { filtri[c] = v; return b }
    b.is = (c: string, v: unknown) => { filtri[c] = v; return b }
    if (table === 'notifiche') {
      // La lettura della coda della conversazione (fase 8): `count` con `head: true`.
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
        h.filtriCoda.push({ ...filtri })
        const esito = h.erroreCoda ? { count: null, error: h.erroreCoda } : { count: h.inCoda(), error: null }
        return Promise.resolve(esito).then(ok, ko)
      }
    }
    b.maybeSingle = async () => {
      if (table === 'chat_threads') return { data: { teacher_id: TEACHER, parent_id: PARENT, student_id: ALUNNO }, error: null }
      if (table === 'parents') return { data: { consensi_gdpr: { privacy: true, termini: true } }, error: null }
      if (table === 'alunni') return { data: { scuola_id: SEDE }, error: null }
      return { data: null, error: null }
    }
    b.insert = (row: Record<string, unknown>) => ({
      select: () => ({ single: async () => ({ data: { id: 'msg-nuovo', ...row }, error: null }) }),
    })
    b.update = () => ({ eq: async () => ({ error: null }) })
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { POST } from '@/app/api/chat/messages/route'
import { azzeraFinestreDispatch } from '@/lib/chat/finestra-dispatch'

const postReq = (body: unknown) =>
  new Request('http://localhost/api/chat/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const DATI_OK = {
  inviate: 1,
  native_inviate: 2,
  fallite: 0,
  notifiche: 1,
  subs_rimosse: 0,
  escluse_staff: 0,
  gia_prese: 0,
  rimesse_in_coda: 0,
  arrese: 0,
  rinviate_per_tempo: 0,
  consegne_chat: 1,
  consegne_chat_righe: 3,
  consegne_chat_saltate: 0,
}

/** Le righe di log del dispatch anticipato, per esito. */
const righe = (esito: string) =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)

/** Esegue il callback programmato attraversando l'attesa coi timer finti. */
async function eseguiProgrammato(): Promise<void> {
  expect(h.programmati).toHaveLength(1)
  const corsa = h.programmati[0]()
  await vi.advanceTimersByTimeAsync(30_000)
  await corsa
}

beforeEach(() => {
  vi.clearAllMocks()
  azzeraFinestreDispatch()
  h.programmati.length = 0
  h.inCoda = () => 1
  h.erroreCoda = null
  h.filtriCoda = []
  h.after.mockImplementation((cb: () => Promise<void>) => {
    h.programmati.push(cb)
  })
  h.notificaEvento.mockResolvedValue(undefined)
  h.eseguiDispatch.mockResolvedValue({ stato: 200, data: DATI_OK })
  h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore', scuola_id: SEDE } })
  h.controparteThread.mockResolvedValue({ utenteId: TEACHER, versoGenitore: false })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/chat/messages — la push parte 30 s dopo il messaggio', () => {
  it('programma UN giro con after(), DOPO l’accodamento, e risponde 201 senza aspettarlo', async () => {
    const res = await POST(postReq({ thread_id: THREAD, content: 'buongiorno maestra' }))

    expect(res.status).toBe(201)
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    expect(h.after).toHaveBeenCalledTimes(1)
    // L'ordine conta: un giro programmato prima dell'accodamento potrebbe non trovare la notifica.
    expect(h.notificaEvento.mock.invocationCallOrder[0]).toBeLessThan(h.after.mock.invocationCallOrder[0])
    // Alla risposta il giro non è ancora partito: è dopo, dentro `after()`.
    expect(h.eseguiDispatch).not.toHaveBeenCalled()
  })

  it('aspetta 30 secondi esatti, poi chiama eseguiDispatch con origine «chat» (timer finti)', async () => {
    await POST(postReq({ thread_id: THREAD, content: 'buongiorno maestra' }))
    vi.useFakeTimers()

    const corsa = h.programmati[0]()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(h.eseguiDispatch).not.toHaveBeenCalled()
    expect(righe('dispatch-anticipato-avviato')).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    await corsa
    expect(h.eseguiDispatch).toHaveBeenCalledTimes(1)
    expect(h.eseguiDispatch).toHaveBeenCalledWith({ origine: 'chat' })
  })

  it('logga l’avvio e l’esito, con il thread e i contatori del giro', async () => {
    await POST(postReq({ thread_id: THREAD, content: 'buongiorno maestra' }))
    vi.useFakeTimers()
    await eseguiProgrammato()

    const [avvio] = righe('dispatch-anticipato-avviato')
    expect(avvio).toBeDefined()
    expect(avvio[0]).toBe('push')
    expect(avvio[1]).toBe('info')
    expect(avvio[2]).toMatchObject({ operazione: 'chat/messages:POST', threadId: THREAD })

    const [ok] = righe('dispatch-anticipato-ok')
    expect(ok).toBeDefined()
    expect(ok[0]).toBe('push')
    expect(ok[1]).toBe('info')
    expect(ok[2]).toMatchObject({ threadId: THREAD, notifiche: 1, inviate: 1, native_inviate: 2, gia_prese: 0 })
    // Le doppie spunte del giro (D1). Sono dell'INTERO giro, non della conversazione appena
    // scritta: `eseguiDispatch` svuota tutta la coda pendente. Le coppie (`consegne_chat`) e le
    // righe accese (`consegne_chat_righe`) sono numeri DIVERSI, e devono restare distinti.
    expect(ok[2]).toMatchObject({ consegne_chat: 1, consegne_chat_righe: 3, consegne_chat_saltate: 0 })
    // L'avvio viene prima dell'esito.
    const indice = (r: unknown) => h.logEvento.mock.calls.indexOf(r as never)
    expect(indice(avvio)).toBeLessThan(indice(ok))
  })

  it('un giro fallito (500) si dice a `error`, e la POST ha già risposto 201', async () => {
    h.eseguiDispatch.mockResolvedValue({ stato: 500 })
    const res = await POST(postReq({ thread_id: THREAD, content: 'buongiorno maestra' }))
    expect(res.status).toBe(201)
    vi.useFakeTimers()
    await eseguiProgrammato()

    expect(righe('dispatch-anticipato-ok')).toHaveLength(0)
    const [fallito] = righe('dispatch-anticipato-fallito')
    expect(fallito?.[1]).toBe('error')
    expect(fallito?.[2]).toMatchObject({ threadId: THREAD })
    // Un 500 di eseguiDispatch non dice che fine ha fatto la notifica (può essere già spedita o
    // marcata e bloccata): la riga persistita non deve promettere il recupero dal cron.
    const msg = (fallito?.[2] as { msg?: string } | undefined)?.msg ?? ''
    expect(msg).not.toMatch(/la notifica resta al cron/)
    expect(msg).toMatch(/push-dispatch-chat/)
    expect(msg).toMatch(/non prese restano in coda/)
  })

  it('senza canali configurati: riga `error`, non un «ok» con zero invii', async () => {
    h.eseguiDispatch.mockResolvedValue({ stato: 200, data: { inviate: 0, non_configurato: true } })
    await POST(postReq({ thread_id: THREAD, content: 'buongiorno maestra' }))
    vi.useFakeTimers()
    await eseguiProgrammato()

    expect(righe('dispatch-anticipato-ok')).toHaveLength(0)
    expect(righe('dispatch-anticipato-non-configurato')[0]?.[1]).toBe('error')
  })

  it('un’eccezione dentro il giro non esce dal callback: si logga e basta', async () => {
    h.eseguiDispatch.mockRejectedValue(new Error('imprevisto'))
    await POST(postReq({ thread_id: THREAD, content: 'buongiorno maestra' }))
    vi.useFakeTimers()
    await expect(eseguiProgrammato()).resolves.toBeUndefined()

    const [eccezione] = righe('dispatch-anticipato-eccezione')
    expect(eccezione?.[1]).toBe('error')
    expect(eccezione?.[3]).toBeInstanceOf(Error)
  })

  it('after() non disponibile (fuori contesto): 201 lo stesso, riga `warn`, nessun giro lanciato a mano', async () => {
    h.after.mockImplementation(() => {
      throw new Error('`after` was called outside a request scope')
    })
    const res = await POST(postReq({ thread_id: THREAD, content: 'buongiorno maestra' }))

    expect(res.status).toBe(201)
    expect(h.eseguiDispatch).not.toHaveBeenCalled()
    const [riga] = righe('dispatch-anticipato-non-programmato')
    expect(riga?.[0]).toBe('push')
    expect(riga?.[1]).toBe('warn')
    expect(riga?.[2]).toMatchObject({ threadId: THREAD })
  })

  it('senza controparte non si accoda niente, e non si programma nessun giro', async () => {
    h.controparteThread.mockResolvedValue(null)
    const res = await POST(postReq({ thread_id: THREAD, content: 'buongiorno maestra' }))

    expect(res.status).toBe(201)
    expect(h.notificaEvento).not.toHaveBeenCalled()
    expect(h.after).not.toHaveBeenCalled()
  })

  it('accodamento fallito: nessun giro programmato, e la POST resta 201', async () => {
    h.notificaEvento.mockRejectedValue(new Error('coda giù'))
    const res = await POST(postReq({ thread_id: THREAD, content: 'buongiorno maestra' }))

    expect(res.status).toBe(201)
    expect(h.after).not.toHaveBeenCalled()
    expect(righe('notifica-controparte-non-accodata')).toHaveLength(1)
  })

  it('S7: due messaggi nella stessa finestra programmano UN giro; il secondo lo dice a `info`', async () => {
    for (const content of ['uno', 'due']) {
      const res = await POST(postReq({ thread_id: THREAD, content }))
      expect(res.status).toBe(201)
    }
    // Entrambe le notifiche sono accodate: il giro unico spedisce quella che resta.
    expect(h.notificaEvento).toHaveBeenCalledTimes(2)
    expect(h.after).toHaveBeenCalledTimes(1)
    const [gia] = righe('dispatch-anticipato-gia-programmato')
    expect(gia?.[0]).toBe('push')
    expect(gia?.[1]).toBe('info')
    expect(gia?.[2]).toMatchObject({ operazione: 'chat/messages:POST', threadId: THREAD })

    vi.useFakeTimers()
    await eseguiProgrammato()
    expect(h.eseguiDispatch).toHaveBeenCalledTimes(1)
    expect(h.eseguiDispatch).toHaveBeenCalledWith({ origine: 'chat' })
  })

  it('🔴 fase 8: la raffica fa UN giro solo — dopo il primo la notifica della conversazione non è più in coda', async () => {
    // Tre istanze diverse della funzione: ognuna ha la sua finestra (S7), e il «superfluo» della
    // fase 8 resta la difesa fra istanze.
    for (const content of ['uno', 'due', 'tre']) {
      await POST(postReq({ thread_id: THREAD, content }))
      azzeraFinestreDispatch()
    }
    // la notifica (una sola, per il debounce) resta in coda finché un giro non la prende
    let presa = false
    h.inCoda = () => (presa ? 0 : 1)
    h.eseguiDispatch.mockImplementation(async () => { presa = true; return { stato: 200, data: DATI_OK } })
    vi.useFakeTimers()
    for (const cb of h.programmati) {
      const corsa = cb()
      await vi.advanceTimersByTimeAsync(30_000)
      await corsa
    }
    expect(h.eseguiDispatch).toHaveBeenCalledTimes(1)
    expect(righe('dispatch-anticipato-superfluo')).toHaveLength(2)
    expect(righe('dispatch-anticipato-superfluo')[0][1]).toBe('info')
    // la coda guardata è quella di QUESTA conversazione, e solo le notifiche non spedite
    expect(h.filtriCoda[0]).toEqual({ entita_tipo: 'chat_thread', entita_id: THREAD, push_inviata_il: null })
  })

  it('fase 8: la coda della conversazione non si legge ⇒ il giro parte lo stesso, e una riga `warn` lo dice', async () => {
    h.erroreCoda = { code: '57014', message: 'canceling statement due to statement timeout' }
    await POST(postReq({ thread_id: THREAD, content: 'uno' }))
    vi.useFakeTimers()
    await eseguiProgrammato()
    expect(h.eseguiDispatch).toHaveBeenCalledTimes(1)
    const [riga] = righe('dispatch-anticipato-verifica-fallita')
    expect(riga[1]).toBe('warn')
    expect((riga[3] as { code?: string }).code).toBe('57014')
  })

  it('nei log del dispatch anticipato non finisce il testo del messaggio', async () => {
    await POST(postReq({ thread_id: THREAD, content: 'il pediatra ha detto varicella' }))
    vi.useFakeTimers()
    await eseguiProgrammato()

    const tutto = JSON.stringify(h.logEvento.mock.calls)
    expect(tutto).not.toContain('varicella')
    expect(tutto).not.toContain(ALUNNO)
  })

  it('S7: dopo il giro la finestra si riapre — il messaggio successivo programma il suo', async () => {
    await POST(postReq({ thread_id: THREAD, content: 'uno' }))
    vi.useFakeTimers()
    await eseguiProgrammato()
    vi.useRealTimers()
    await POST(postReq({ thread_id: THREAD, content: 'due' }))
    expect(h.after).toHaveBeenCalledTimes(2)
    expect(h.programmati).toHaveLength(2)
    expect(righe('dispatch-anticipato-gia-programmato')).toHaveLength(0)
  })

  it('S7: `after()` che lancia non lascia la finestra aperta — il messaggio dopo programma il suo giro', async () => {
    h.after.mockImplementationOnce(() => {
      throw new Error('`after` was called outside a request scope')
    })
    await POST(postReq({ thread_id: THREAD, content: 'uno' }))
    expect(righe('dispatch-anticipato-non-programmato')).toHaveLength(1)
    await POST(postReq({ thread_id: THREAD, content: 'due' }))
    expect(h.after).toHaveBeenCalledTimes(2)
    expect(h.programmati).toHaveLength(1)
    expect(righe('dispatch-anticipato-gia-programmato')).toHaveLength(0)
  })

  it('S7: la finestra è per conversazione — un altro thread nello stesso istante programma il suo giro', async () => {
    await POST(postReq({ thread_id: THREAD, content: 'uno' }))
    await POST(postReq({ thread_id: ALTRO_THREAD, content: 'due' }))
    expect(h.after).toHaveBeenCalledTimes(2)
    expect(righe('dispatch-anticipato-gia-programmato')).toHaveLength(0)
  })

  it('🔴 S7: nessuna notifica resta senza giro — quella del messaggio nella finestra la spedisce il giro in attesa, quella arrivata a giro avviato ne programma un altro', async () => {
    // Una coda finta che fa, come quella vera, le due cose che contano qui: il `debounce` di
    // `notificaEvento` sostituisce la notifica NON PRESA della conversazione (`push_inviata_il`
    // null), e il giro prende — la presa atomica — TUTTE quelle in coda nel momento in cui legge,
    // poi le spedisce (`eseguiDispatch`: `push_inviata_il is null` e `invio_programmato_il <= adesso`,
    // e la chat accoda con `bufferMin: 0`). Con un `eseguiDispatch` finto e piatto questo test
    // resterebbe verde anche con una finestra che inghiotte un messaggio.
    type Notifica = { n: number; presa: boolean; inviata: boolean }
    const coda: Notifica[] = []
    let progressivo = 0
    h.notificaEvento.mockImplementation(async () => {
      for (let i = coda.length - 1; i >= 0; i--) if (!coda[i].presa) coda.splice(i, 1)
      coda.push({ n: ++progressivo, presa: false, inviata: false })
    })
    h.inCoda = () => coda.filter((x) => !x.presa).length
    let segnalaArrivo: () => void = () => {}
    const arrivato = new Promise<void>((fatto) => { segnalaArrivo = fatto })
    let rilascia: () => void = () => {}
    const cancello = new Promise<void>((fatto) => { rilascia = fatto })
    let giri = 0
    h.eseguiDispatch.mockImplementation(async () => {
      giri++
      const prese = coda.filter((x) => !x.presa)
      for (const x of prese) x.presa = true
      if (giri === 1) {
        // Il primo giro resta a metà, dopo la presa: è qui che arriva il terzo messaggio.
        segnalaArrivo()
        await cancello
      }
      for (const x of prese) x.inviata = true
      return { stato: 200, data: DATI_OK }
    })

    // «uno» apre la finestra; «due», dentro la finestra, non programma niente.
    await POST(postReq({ thread_id: THREAD, content: 'uno' }))
    await POST(postReq({ thread_id: THREAD, content: 'due' }))
    expect(h.programmati).toHaveLength(1)
    expect(righe('dispatch-anticipato-gia-programmato')).toHaveLength(1)

    // Il giro di «uno» parte dopo 30 s e prende la notifica di «due»: quella di «uno» l'ha
    // sostituita il debounce, ed è una sola per conversazione.
    vi.useFakeTimers()
    const primo = h.programmati[0]()
    await vi.advanceTimersByTimeAsync(30_000)
    await arrivato
    expect(coda.filter((x) => x.presa).map((x) => x.n), 'il giro in attesa non ha preso la notifica del messaggio nella finestra').toEqual([2])

    // «tre» arriva col giro già avviato (orologio vero: pochi millisecondi dopo «uno», dentro i 45 s
    // della scadenza): la finestra deve essere già chiusa, e «tre» deve programmare il suo giro.
    vi.useRealTimers()
    await POST(postReq({ thread_id: THREAD, content: 'tre' }))
    expect(h.programmati, 'il messaggio arrivato a giro avviato è rimasto senza giro: la sua push aspetterebbe il cron').toHaveLength(2)
    rilascia()
    await primo

    vi.useFakeTimers()
    const secondo = h.programmati[1]()
    await vi.advanceTimersByTimeAsync(30_000)
    await secondo

    // Nessuna notifica resta in coda non spedita.
    expect(coda.map((x) => ({ n: x.n, inviata: x.inviata }))).toEqual([
      { n: 2, inviata: true },
      { n: 3, inviata: true },
    ])
    expect(h.eseguiDispatch).toHaveBeenCalledTimes(2)
  })
})

describe('la durata della route copre l’attesa più il caso peggiore del giro', () => {
  it('`export const maxDuration` ≥ 30 s + CASO_PEGGIORE_GIRO_MS', () => {
    const testo = readFileSync(join(process.cwd(), 'src', 'app', 'api', 'chat', 'messages', 'route.ts'), 'utf8')
      // Senza commenti: un numero citato in un commento non deve bastare.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const m = testo.match(/^export\s+const\s+maxDuration\s*=\s*(\d+)\s*;?\s*$/m)
    expect(m, 'la route chat/messages deve dichiarare `export const maxDuration = N`').not.toBeNull()
    expect(Number(m![1]) * 1_000).toBeGreaterThanOrEqual(30_000 + CASO_PEGGIORE_GIRO_MS)
    // E l'attesa scritta nella route è quella della spec: 30 secondi.
    expect(testo).toMatch(/const ATTESA_DISPATCH_CHAT_MS = 30_000;/)
  })
})
