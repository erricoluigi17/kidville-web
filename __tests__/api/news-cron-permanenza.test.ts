import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// IL TICK RILEGGE IL CONSENSO — e non pubblica al buio.
//
// Il collaudo privacy del 2026-08-02 ha misurato che il tick di `news-tick`
// (ogni 10 minuti, attivo in produzione) guardava due sole cose: la
// programmazione e la salute degli embed Instagram. `grep -oE "'[a-z-]+'"` sulla
// rotta restituiva `programmata`, `ig-health`, `instagram-non-raggiungibile`,
// `nascosta`, `promozione-fallita`: del consenso fotografico, nulla.
//
// Due conseguenze, e la seconda è peggiore della prima:
//  1. una famiglia che revocava vedeva la foto del figlio restare online;
//  2. la promozione automatica delle programmate NON passa da nessun gate — il
//     consenso era controllato su tre rotte (`news:POST`, `news/[id]:PATCH`,
//     `news/[id]/pubblica:POST`) e su questa quarta strada, l'unica che pubblica
//     da sola, no. Un post programmato ieri veniva pubblicato oggi anche se nel
//     frattempo il consenso era caduto.
//
// Qui si asserisce il COLLEGAMENTO (il modulo ha i suoi test in
// `__tests__/lib/news/permanenza-consenso.test.ts`): che la verifica giri, che
// giri PRIMA della promozione, e che un guasto di lettura fermi la promozione
// invece di pubblicare al buio.
// =============================================================================

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ ...log, EVENTI_PERSISTITI: new Set(['news', 'cron']) }))

const ordine = vi.hoisted(() => ({ passi: [] as string[] }))

const perm = vi.hoisted(() => ({
  esito: {
    disponibile: true,
    verificato: true,
    esaminati: 0,
    ritirati: 0,
    fileRimossi: 0,
    fileNonRimossi: 0,
    fileTrattenuti: 0,
  },
  verificaPermanenzaConsenso: vi.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>(),
}))
vi.mock('@/lib/news/permanenza-consenso', () => ({
  verificaPermanenzaConsenso: (...a: unknown[]) => {
    ordine.passi.push('permanenza')
    return perm.verificaPermanenzaConsenso(...a)
  },
}))

const news = vi.hoisted(() => ({
  notificaNewsPubblicata: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
  generaEInviaDigest: vi.fn<(...a: unknown[]) => Promise<{ edizioni: unknown[] }>>(async () => ({ edizioni: [] })),
}))
vi.mock('@/lib/news/notifiche', () => ({ notificaNewsPubblicata: (...a: unknown[]) => news.notificaNewsPubblicata(...a) }))
vi.mock('@/lib/news/digest', () => ({ generaEInviaDigest: (...a: unknown[]) => news.generaEInviaDigest(...a) }))

const ext = vi.hoisted(() => ({
  externalFetch: vi.fn<(...a: unknown[]) => Promise<{ stato: number; corpo: string; res: undefined }>>(
    async () => ({ stato: 200, corpo: '', res: undefined }),
  ),
}))
vi.mock('@/lib/logging/external', () => ({ externalFetch: (...a: unknown[]) => ext.externalFetch(...a) }))

const db = vi.hoisted(() => {
  const state = {
    programmate: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
  }
  function client() {
    return {
      from() {
        const st = { eqs: {} as Record<string, unknown>, isUpdate: false, rec: null as Record<string, unknown> | null }
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = (c: string, v: unknown) => { st.eqs[c] = v; return b }
        b.lte = () => b
        b.lt = () => b
        b.gte = () => b
        b.is = () => b
        b.or = () => b
        b.order = () => b
        b.in = () => b
        b.not = () => b
        b.limit = () => b
        b.contains = () => b
        b.update = (rec: Record<string, unknown>) => { st.isUpdate = true; st.rec = rec; return b }
        const resolve = (): { data: unknown; error: unknown } => {
          if (st.isUpdate) {
            ordine.passi.push('promozione')
            state.updates.push(st.rec ?? {})
            return { data: null, error: null }
          }
          if (st.eqs.stato === 'programmata') return { data: state.programmate, error: null }
          return { data: [], error: null }
        }
        b.maybeSingle = async () => resolve()
        b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(resolve()).then(onF, onR)
        return b
      },
      storage: { from: () => ({ remove: async (p: string[]) => ({ data: p.map((x) => ({ name: x })), error: null }) }) },
    }
  }
  return { state, client }
})
const supa = vi.hoisted(() => ({ createAdminClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => supa)

import { POST as cronPOST } from '@/app/api/news/cron/run/route'

const SEGRETO = 'test-secret-permanenza'
const tick = () =>
  cronPOST(
    new Request('http://localhost/api/news/cron/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cron-secret': SEGRETO },
      body: JSON.stringify({ job: 'tick' }),
    }),
  )

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = SEGRETO
  ordine.passi = []
  db.state.programmate = []
  db.state.updates = []
  perm.esito = {
    disponibile: true,
    verificato: true,
    esaminati: 0,
    ritirati: 0,
    fileRimossi: 0,
    fileNonRimossi: 0,
    fileTrattenuti: 0,
  }
  perm.verificaPermanenzaConsenso.mockImplementation(async () => perm.esito)
  supa.createAdminClient.mockResolvedValue(db.client())
})

describe('POST /api/news/cron/run · tick — il consenso si rilegge a ogni giro', () => {
  it('il tick VERIFICA la permanenza del consenso (prima non lo faceva nessuno)', async () => {
    const res = await tick()
    expect(res.status).toBe(200)
    expect(
      perm.verificaPermanenzaConsenso,
      'il tick non rilegge il consenso: una revoca non ha nessun effetto sugli articoli pubblicati',
    ).toHaveBeenCalledTimes(1)
  })

  it('verifica PRIMA di promuovere le programmate (la quarta strada senza gate)', async () => {
    db.state.programmate = [{ id: 'p-1', titolo: 'Festa', scuola_id: null, target_scope: 'globale', invia_notifica: false }]
    await tick()
    expect(ordine.passi[0]).toBe('permanenza')
    expect(ordine.passi).toContain('promozione')
  })

  it('consenso NON riletto (guasto di lettura) → NIENTE si pubblica, e si grida', async () => {
    // Pubblicare al buio è irreversibile: la foto diventa pubblica. Rimandare la
    // promozione di dieci minuti non costa niente a nessuno.
    perm.esito = { ...perm.esito, verificato: false }
    db.state.programmate = [{ id: 'p-1', titolo: 'Festa', scuola_id: null, target_scope: 'globale', invia_notifica: false }]
    const res = await tick()
    expect(res.status).toBe(200)
    expect(db.state.updates, 'una programmata è stata pubblicata senza aver riletto il consenso').toHaveLength(0)
    expect(news.notificaNewsPubblicata).not.toHaveBeenCalled()
    expect(log.logEvento).toHaveBeenCalledWith(
      'cron', 'error', expect.objectContaining({ esito: 'promozione-sospesa-consenso-non-verificato' }),
    )
  })

  it('un file TRATTENUTO dopo il ritiro risale al cron, non resta un `warn` nel modulo', async () => {
    // Il ritiro può non togliere il file: succede quando la foto di un bambino il
    // cui consenso è caduto è nominata anche da un post che quel bambino NON lo
    // dichiara. Si preferisce non rompere l'articolo altrui, e la conseguenza è
    // che una foto resta a un indirizzo PUBBLICO. Fino al 2026-08-03 l'unica
    // traccia era un `warn` dentro il modulo, ripetuto identico a ogni passata —
    // cioè indistinguibile dal rumore, cioè invisibile. Il tick prosegue (non è un
    // guasto della promozione), ma il numero si vede.
    perm.esito = { ...perm.esito, ritirati: 2, fileTrattenuti: 3 }
    const res = await tick()
    expect(res.status).toBe(200)
    expect(log.logEvento).toHaveBeenCalledWith(
      'cron',
      'error',
      expect.objectContaining({ esito: 'file-pubblici-trattenuti', n_file: 3 }),
    )
  })

  it('CONTROLLO POSITIVO — nessun file trattenuto → nessun allarme', async () => {
    // Senza, «l'allarme c'è quando serve» sarebbe verde anche in un tick che grida
    // a ogni giro: un canale d'errore che suona sempre non dice più niente.
    await tick()
    expect(log.logEvento).not.toHaveBeenCalledWith(
      'cron',
      'error',
      expect.objectContaining({ esito: 'file-pubblici-trattenuti' }),
    )
  })

  it('schema assente (DB E2E non migrato) → il tick prosegue e promuove come sempre', async () => {
    // `disponibile: false` non è un guasto: è un ambiente senza la colonna della
    // dichiarazione, quindi senza niente da verificare. Confonderlo con un
    // guasto fermerebbe la promozione in CI a ogni giro.
    perm.esito = { ...perm.esito, disponibile: false }
    db.state.programmate = [{ id: 'p-1', titolo: 'Festa', scuola_id: null, target_scope: 'globale', invia_notifica: false }]
    await tick()
    expect(db.state.updates).toHaveLength(1)
    expect(db.state.updates[0].stato).toBe('pubblicata')
  })
})
