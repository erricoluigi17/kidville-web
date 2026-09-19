import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// =============================================================================
// PATCH /api/avvisi/[id]/risposte/[rispostaId] — CHI VA IN GITA LO DECIDE LA
// SEGRETERIA.
//
// 🔴 `requireStaff` e NON `requireDocente`. La differenza è l'`educator`:
// `requireDocente` lo comprende, e la decisione del committente è che i docenti
// restino in SOLA LETTURA sulle adesioni. Con il gate sbagliato un'insegnante
// potrebbe ammettere dalla coda — cioè scegliere quale famiglia entra — e
// nessuna schermata lo segnalerebbe.
//
// ⚠️ Il finto di `requireStaff` qui sotto fa il controllo VERO sui ruoli, non
// risponde sempre la stessa cosa: un finto piatto sarebbe verde con e senza il
// gate, che è la prima delle cinque forme di verde falso.
// =============================================================================

const AVVISO_ID = '11111111-1111-1111-1111-111111111111'
const RISPOSTA_ID = '44444444-4444-4444-4444-444444444444'
const PARENT_ID = '33333333-3333-3333-3333-333333333333'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
  assertAvvisoInScope: vi.fn(),
  notificaEvento: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  utente: { id: 'u-1', role: 'admin', scuola_id: 'sc-1' } as { id: string; role: string; scuola_id: string },
  esitoRpc: null as unknown,
  lastRpc: null as { nome: string; args: Record<string, unknown> } | null,
  nRpc: 0,
  rispostaPrima: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  // Il controllo VERO: `allowed` è l'elenco che la route dichiara.
  requireStaff: (...a: unknown[]) => h.requireStaff(...a),
  // Mockato apposta perché sia PERMISSIVO con l'`educator`: se qualcuno
  // sostituisse il gate con `requireDocente`, il caso «educator → 403» qui sotto
  // diventerebbe 200 e il test rosso direbbe esattamente cos'è cambiato.
  requireDocente: (...a: unknown[]) => h.requireDocente(...a),
}))
vi.mock('@/lib/auth/scope-avvisi', () => ({ assertAvvisoInScope: (...a: unknown[]) => h.assertAvvisoInScope(...a) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notificaEvento(...a) }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: (...a: unknown[]) => h.logScrittura(...a) }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc(nome: string, args: Record<string, unknown>) {
      if (nome !== 'avviso_adesione_gestisci') throw new Error(`rpc non emulata in questo finto: ${nome}`)
      h.nRpc += 1
      h.lastRpc = { nome, args }
      return Promise.resolve({ data: h.esitoRpc, error: null })
    },
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => {
        if (table === 'avvisi') return { data: { id: AVVISO_ID, scuola_id: 'sc-1' }, error: null }
        if (table === 'avvisi_risposte') return { data: h.rispostaPrima, error: null }
        return { data: null, error: null }
      }
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/avvisi/[id]/risposte/[rispostaId]/route'

const ctx = (id = AVVISO_ID, rispostaId = RISPOSTA_ID) => ({ params: Promise.resolve({ id, rispostaId }) })
const req = (body: unknown) => ({
  url: `http://test/api/avvisi/${AVVISO_ID}/risposte/${RISPOSTA_ID}`,
  method: 'PATCH',
  headers: new Headers(),
  json: async () => body,
}) as never

const negato = () => ({ response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) })

beforeEach(() => {
  vi.clearAllMocks()
  h.lastRpc = null
  h.nRpc = 0
  h.utente = { id: 'u-1', role: 'admin', scuola_id: 'sc-1' }
  h.rispostaPrima = {
    id: RISPOSTA_ID, parent_id: PARENT_ID, student_id: 'al-1',
    risposta: 'si', numero_partecipanti: 2, stato_adesione: 'in_attesa',
  }
  h.esitoRpc = {
    ok: true, stato: 'ammessa', numero: 2, occupati: 8, posti_totali: 10,
    sopra_capienza: false, risposta_allineata: false, risposta_precedente: 'si',
    riga: { id: RISPOSTA_ID, stato_adesione: 'ammessa', numero_partecipanti: 2 },
  }
  h.requireStaff.mockImplementation(async (_r: unknown, allowed?: readonly string[]) => {
    const ammessi = allowed ?? ['admin', 'coordinator', 'segreteria']
    return ammessi.includes(h.utente.role) ? { user: h.utente } : negato()
  })
  // Permissivo con l'educator, come il vero `requireDocente`.
  h.requireDocente.mockImplementation(async () => ({ user: h.utente }))
  h.assertAvvisoInScope.mockResolvedValue(null)
})

describe('PATCH /api/avvisi/[id]/risposte/[rispostaId] — gate', () => {
  it('403 per l’EDUCATOR: i docenti restano in sola lettura sulle adesioni', async () => {
    h.utente = { id: 'u-doc', role: 'educator', scuola_id: 'sc-1' }
    const res = await PATCH(req({ stato: 'ammessa' }), ctx())
    expect(res.status).toBe(403)
    expect(h.nRpc, 'il gate è stato saltato: la funzione di scrittura è partita').toBe(0)
  })

  it('403 per un admin di UN’ALTRA SEDE (tre plessi, un solo database)', async () => {
    h.assertAvvisoInScope.mockResolvedValue(NextResponse.json({ error: 'fuori plesso' }, { status: 403 }))
    const res = await PATCH(req({ stato: 'ammessa' }), ctx())
    expect(res.status).toBe(403)
    expect(h.nRpc, 'lo scope è stato saltato: si stava scrivendo su un altro plesso').toBe(0)
  })

  it('400 quando non si dice NÉ lo stato NÉ il numero (non c’è niente da cambiare)', async () => {
    const res = await PATCH(req({ forza: true }), ctx())
    expect(res.status).toBe(400)
    expect(h.nRpc).toBe(0)
  })
})

describe('PATCH /api/avvisi/[id]/risposte/[rispostaId] — i tre gesti', () => {
  it('ammettere dalla coda: 200, audit scritto e UNA SOLA notifica alla famiglia', async () => {
    const res = await PATCH(req({ stato: 'ammessa' }), ctx())
    expect(res.status).toBe(200)

    expect(h.lastRpc?.nome).toBe('avviso_adesione_gestisci')
    expect(h.lastRpc?.args.p_avviso_id).toBe(AVVISO_ID)
    expect(h.lastRpc?.args.p_risposta_id).toBe(RISPOSTA_ID)
    expect(h.lastRpc?.args.p_stato).toBe('ammessa')

    // Ammettere qualcuno cambia CHI VA IN GITA: sta nel registro immodificabile.
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const audit = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(audit.entitaTipo).toBe('avviso_risposta')
    expect(audit.azione).toBe('update')
    expect(audit.entitaId).toBe(RISPOSTA_ID)
    expect(audit.scuolaId).toBe('sc-1')

    // UNA SOLA. Due notifiche per la stessa ammissione sono la forma del guasto
    // del debounce, e una famiglia che ne riceve due non sa se sono due cose.
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    expect((h.notificaEvento.mock.calls[0][1] as Record<string, unknown>).tipo).toBe('adesione_ammessa')
    expect((h.notificaEvento.mock.calls[0][1] as Record<string, unknown>).utenteIds).toEqual([PARENT_ID])
  })

  it('correggere solo il NUMERO non notifica nessuno (era già dentro)', async () => {
    h.rispostaPrima = { ...(h.rispostaPrima as Record<string, unknown>), stato_adesione: 'ammessa' }
    h.esitoRpc = { ...(h.esitoRpc as Record<string, unknown>), stato: 'ammessa', numero: 3 }

    const res = await PATCH(req({ numero_partecipanti: 3 }), ctx())
    expect(res.status).toBe(200)
    expect(h.lastRpc?.args.p_stato, '«non parlo dello stato» è `null`, non un valore inventato').toBeNull()
    expect(h.lastRpc?.args.p_numero).toBe(3)
    expect(h.notificaEvento, '«sei stato ammesso» a chi era già dentro').not.toHaveBeenCalled()
  })

  it('RIMUOVERE: `stato: nessuna` libera il posto, e non si notifica un’ammissione', async () => {
    h.rispostaPrima = { ...(h.rispostaPrima as Record<string, unknown>), stato_adesione: 'ammessa' }
    h.esitoRpc = {
      ok: true, stato: null, numero: 2, occupati: null, posti_totali: 10,
      sopra_capienza: false, risposta_allineata: false, risposta_precedente: 'si',
      riga: { id: RISPOSTA_ID, stato_adesione: null },
    }

    const res = await PATCH(req({ stato: 'nessuna' }), ctx())
    expect(res.status).toBe(200)
    expect(h.lastRpc?.args.p_stato).toBe('nessuna')
    expect(h.notificaEvento).not.toHaveBeenCalled()
    expect(h.logScrittura, 'togliere qualcuno da una gita non è tracciato').toHaveBeenCalledTimes(1)

    // `occupati` NULL significa «non misurato» (nessun conteggio è stato fatto),
    // NON zero: scriverlo 0 direbbe alla segreteria che l'avviso è vuoto.
    expect((await res.json()).occupati).toBeNull()
  })

  it('`forza` e `ignora_rifiuto` NON partono come `null` quando non sono stati mandati', async () => {
    // ⚠️ Nella funzione sono difesi da `COALESCE`, ma il `{"p_forza": null}` di un
    // form vuoto è la trappola che quella difesa chiude: `NOT NULL AND NOT false`
    // è `NULL`, e un `IF` con condizione `NULL` non scatta — il rifiuto per
    // capienza sparirebbe e si scriverebbe sopra il tetto senza che nessuno
    // l'abbia chiesto. La seconda riga di difesa è che il client non lo produca.
    await PATCH(req({ stato: 'ammessa' }), ctx())
    const chiavi = Object.keys(h.lastRpc?.args ?? {})
    expect(chiavi).not.toContain('p_forza')
    expect(chiavi).not.toContain('p_ignora_rifiuto')
  })
})

describe('PATCH — RISPOSTA_CONTRARIA è una domanda, non un errore', () => {
  it('409 col valore trovato, poi passa con `ignora_rifiuto: true`', async () => {
    // Primo giro: la famiglia aveva detto NO. La funzione si ferma invece di
    // riscriverle quel «no», che è un dato suo — sovrascriverlo lo farebbe
    // sparire dal database, non «mostrarlo».
    h.esitoRpc = { ok: false, code: 'RISPOSTA_CONTRARIA', risposta_precedente: 'no' }

    const primo = await PATCH(req({ stato: 'ammessa' }), ctx())
    expect(primo.status).toBe(409)
    const corpo = await primo.json()
    expect(corpo.codice).toBe('RISPOSTA_CONTRARIA')
    expect(corpo.risposta_precedente, 'senza questo l’interfaccia non può CHIEDERE niente').toBe('no')
    expect(h.logScrittura, 'niente è stato scritto: era una domanda').not.toHaveBeenCalled()
    expect(h.notificaEvento).not.toHaveBeenCalled()

    // Secondo giro: la segreteria ha confermato. Solo ora la riscrittura avviene.
    h.esitoRpc = {
      ok: true, stato: 'ammessa', numero: 2, occupati: 8, posti_totali: 10,
      sopra_capienza: false, risposta_allineata: true, risposta_precedente: 'no',
      riga: { id: RISPOSTA_ID, stato_adesione: 'ammessa', risposta: 'si' },
    }

    const secondo = await PATCH(req({ stato: 'ammessa', ignora_rifiuto: true }), ctx())
    expect(secondo.status).toBe(200)
    expect(h.lastRpc?.args.p_ignora_rifiuto).toBe(true)
    // L'interfaccia deve poter DIRE che la risposta è stata sostituita: una
    // riscrittura in silenzio sarebbe il rimedio peggiore della malattia.
    expect((await secondo.json()).risposta_allineata).toBe(true)
  })

  it('POSTI_ESAURITI verso la SEGRETERIA porta i numeri (qui il lettore è un altro)', async () => {
    h.esitoRpc = { ok: false, code: 'POSTI_ESAURITI', occupati: 10, posti_totali: 10, numero: 3 }

    const res = await PATCH(req({ stato: 'ammessa' }), ctx())
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('POSTI_ESAURITI')
    // È la segreteria a dover scegliere se forzare: senza i numeri sceglierebbe
    // al buio. Al genitore, sull'altra strada, il residuo non si mostra mai.
    expect(corpo.occupati).toBe(10)
    expect(corpo.posti_totali).toBe(10)
    expect(corpo.richiesti).toBe(3)
  })

  it('l’esito finisce nel campo `esito` del log, mai in un campo `stato`', async () => {
    // `stato` in `logErrore` significa già lo status HTTP: due tassonomie sulla
    // stessa colonna spezzano la query in silenzio.
    await PATCH(req({ stato: 'ammessa' }), ctx())
    const righe = h.logEvento.mock.calls.filter((c) => c[0] === 'avvisi')
    expect(righe).toHaveLength(1)
    const campi = righe[0][2] as Record<string, unknown>
    expect(campi.esito).toBe('adesione-ammessa-a-mano')
    expect(campi.avviso).toBe(AVVISO_ID)
    expect(campi).not.toHaveProperty('stato')
  })
})
