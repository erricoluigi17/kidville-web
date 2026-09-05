import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * UN BONIFICO NON SI FATTURA DUE VOLTE — la guardia alla CONFERMA.
 *
 * ─── COSA PROTEGGE, e perché sta qui e non nel motore ────────────────────────
 * La fattura si emette per `pagamento_id` (`pagamenti/fattura/route.ts`): del
 * MOVIMENTO bancario il motore non sa niente. La guardia contro il secondo
 * documento vive dentro `emettiFatturaPagamento` e confronta le righe vive di
 * `fatture_emesse` **dello stesso pagamento** — quindi non vede nulla quando è il
 * BONIFICO a cambiare pagamento sotto di lei: il movimento che aveva pagato la
 * retta P1 (già fatturata) viene riabbinato a P2, e P2 nasce libero da fatture.
 * Il risultato è una retta incassata due volte a registro, con una fattura viva
 * intestata a un pagamento che quel bonifico non paga più.
 *
 * ─── È UNA GUARDIA DIFENSIVA, e va detto ─────────────────────────────────────
 * Oggi dall'interfaccia quello stato NON è raggiungibile: `pagamento_id` lo scrive
 * solo la conferma, e un movimento `confermato` non torna indietro (`ignora` e
 * `riapri` rispondono 409, lo storno dell'incasso non tocca questa tabella). Ma
 * «non raggiungibile oggi» non è una difesa: basta una riapertura fatta a mano
 * dopo uno storno — che è la cosa naturale da chiedere — perché la strada si
 * apra, e si aprirebbe **in silenzio**, con un 200 e una notifica «Pagamento
 * registrato» al genitore. La guardia costa una lettura e chiude la strada prima
 * che qualcuno la costruisca.
 *
 * ─── COME MORDE ──────────────────────────────────────────────────────────────
 * Il finto Supabase distingue per TABELLA e REGISTRA le letture: «`fatture_emesse`
 * non è stata nemmeno interrogata» è un'asserzione, non una speranza — un mock
 * che rispondesse `[]` a ogni tabella renderebbe verde anche un codice che non
 * legge niente. E il rifiuto si misura sulle SCRITTURE: zero insert in `incassi`,
 * zero update, zero storni. Un 409 che arriva dopo aver creato l'incasso non è un
 * rifiuto, è un incasso con un messaggio d'errore sopra.
 *
 * Dati SINTETICI: uuid e numeri, nessun nome di famiglie vere (il repo è pubblico).
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  notificaEvento: vi.fn(),
  verificaRevoca: vi.fn(),
  logOk: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  movimento: null as Record<string, unknown> | null,
  pagamento: null as Record<string, unknown> | null,
  /** Le righe di `fatture_emesse` del pagamento interrogato: pilotate per TABELLA. */
  fatture: [] as Record<string, unknown>[],
  /** Errore iniettabile sulla lettura di `fatture_emesse` (il ramo fail-closed). */
  fattureError: null as { code: string; message: string } | null,
  /** Ogni lettura che arriva a RISOLVERSI, con tabella, colonne e filtri. */
  letture: [] as { table: string; cols: string; filtri: Record<string, unknown> }[],
  inserts: [] as { table: string; row: Record<string, unknown> | Record<string, unknown>[] }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  deletes: [] as string[],
  updateRows: [{ id: 'mov-upd' }] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: h.verificaRevoca }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => ['sc-1'],
}))
// `withRoute` importa questi tre e nient'altro: il finto qui non spegne il wrapper,
// lo rende osservabile — il log del percorso d'errore è parte di ciò che si collauda.
vi.mock('@/lib/logging/logger', () => ({
  logOk: h.logOk,
  logErrore: h.logErrore,
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const filtri: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      b.select = (cols?: string) => { b._cols = cols ?? ''; return b }
      b.eq = (c: string, v: unknown) => { filtri[c] = v; return b }
      b.in = (c: string, v: unknown) => { filtri[c] = v; return b }
      b.gte = () => b
      b.lte = () => b
      b.order = () => b
      b.limit = () => b
      b.range = () => b
      const registra = () => {
        h.letture.push({ table, cols: typeof b._cols === 'string' ? b._cols : '', filtri: { ...filtri } })
      }
      b.maybeSingle = async () => {
        registra()
        return {
          data: table === 'riconciliazione_movimenti' ? h.movimento : table === 'pagamenti' ? h.pagamento : null,
          error: null,
        }
      }
      b.insert = (row: Record<string, unknown> | Record<string, unknown>[]) => {
        h.inserts.push({ table, row })
        return {
          select: () => ({ single: async () => ({ data: { id: `${table}-new`, ...(Array.isArray(row) ? {} : row) }, error: null }) }),
          then: (r: (v: unknown) => unknown) => r({ data: null, error: null }),
        }
      }
      b.delete = () => {
        h.deletes.push(table)
        return b
      }
      b.update = (row: Record<string, unknown>) => {
        h.updates.push({ table, row })
        const u: Record<string, unknown> = {}
        u.eq = () => u
        u.select = () => ({ then: (r: (v: unknown) => unknown) => r({ data: h.updateRows, error: null }) })
        u.then = (r: (v: unknown) => unknown) => r({ data: null, error: null })
        return u
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        registra()
        // La tabella nuova si pilota per NOME: un finto che rispondesse `[]` a ogni
        // tabella sconosciuta sarebbe verde anche senza la lettura che si collauda.
        if (table === 'fatture_emesse') {
          return resolve({ data: h.fattureError ? null : h.fatture, error: h.fattureError })
        }
        return resolve({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/pagamenti/riconciliazione/[id]/route'

const MID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
/** Il pagamento a cui il bonifico era abbinato, e che è GIÀ stato fatturato. */
const PID_VECCHIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
/** Il pagamento verso cui si sta riabbinando lo stesso bonifico. */
const PID_NUOVO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/pagamenti/riconciliazione/${MID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: MID }) },
  )

const letteDa = (tabella: string) => h.letture.filter((l) => l.table === tabella)

/** Nessuna traccia lasciata: né incassi, né update, né storni, né avvisi al genitore. */
function nessunaScrittura() {
  expect(h.inserts, 'una riga è stata inserita prima del rifiuto').toEqual([])
  expect(h.updates, 'una riga è stata aggiornata prima del rifiuto').toEqual([])
  expect(h.deletes, 'c’è stato uno storno: vuol dire che prima si era scritto').toEqual([])
  expect(h.logScrittura).not.toHaveBeenCalled()
  expect(h.notificaEvento).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  h.letture = []
  h.inserts = []
  h.updates = []
  h.deletes = []
  h.fatture = []
  h.fattureError = null
  h.updateRows = [{ id: 'mov-upd' }]
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  // Il movimento riaperto a mano dopo uno storno: porta ancora il pagamento di prima.
  h.movimento = {
    id: MID, scuola_id: 'sc-1', importo: 150, data_operazione: '2026-09-05',
    causale: 'BONIFICO RETTA', stato: 'da_abbinare', suggerimenti: null,
    pagamento_id: PID_VECCHIO,
  }
  h.pagamento = {
    id: PID_NUOVO, scuola_id: 'sc-1', stato: 'scaduto', alunno_id: 'al-1',
    descrizione: 'Retta Ottobre', importo: 150, importo_pagato: 0, sconto: 0, scadenza: '2026-10-01',
  }
})

/** Una riga viva: presa in carico dallo SDI, nessuno scarto. */
const fatturaViva = { numero: 2328, anno: 2026, sezionale: 'Asilo', sdi_stato: 1 }

describe('PATCH conferma — un bonifico già fatturato non si riabbina a un altro pagamento', () => {
  it('⛔ vecchio pagamento con una fattura VIVA → 409 con `codice`, il numero nel messaggio e NESSUNA scrittura', async () => {
    h.fatture = [fatturaViva]

    const res = await patch({ azione: 'conferma', pagamento_id: PID_NUOVO })

    expect(res.status).toBe(409)
    const j = (await res.json()) as { error?: string; codice?: string }
    expect(j.codice).toBe('BONIFICO_GIA_FATTURATO')
    // Il NUMERO, non solo lo status: senza, la segreteria non sa quale documento guardare.
    expect(j.error).toContain('Asilo 2328/2026')
    nessunaScrittura()
    // La lettura è quella del VECCHIO pagamento, e chiede le colonne che servono a decidere.
    const [lettura] = letteDa('fatture_emesse')
    expect(lettura, 'la guardia non ha nemmeno letto `fatture_emesse`').toBeTruthy()
    expect(lettura.filtri.pagamento_id).toBe(PID_VECCHIO)
    for (const col of ['numero', 'anno', 'sezionale', 'sdi_stato']) {
      expect(lettura.cols, `la select non chiede \`${col}\``).toContain(col)
    }
  })

  it('il rifiuto arriva PRIMA di ogni altra lettura: `pagamenti` non viene nemmeno interrogata', async () => {
    // Non è un dettaglio d'ordine: finché la guardia sta in fondo, tutto ciò che le
    // sta davanti ha già letto, scritto o notificato quando lei dice di no.
    h.fatture = [fatturaViva]

    expect((await patch({ azione: 'conferma', pagamento_id: PID_NUOVO })).status).toBe(409)
    expect(letteDa('pagamenti'), 'la guardia scatta dopo la lettura del pagamento').toEqual([])
  })

  it('la riga di TRASPORTO FALLITO (`sdi_stato` nullo) conta come VIVA: 409, non si riabbina', async () => {
    // `sdi_stato` nullo e nessun nome file è la firma di un rifiuto di trasporto:
    // nessuno sa se quel documento sia partito. Trattarla come «non emessa» sarebbe
    // il verso sbagliato in cui sbagliare — è la stessa regola di `emissione.ts`.
    h.fatture = [{ numero: 2329, anno: 2026, sezionale: 'Asilo', sdi_stato: null }]

    const res = await patch({ azione: 'conferma', pagamento_id: PID_NUOVO })

    expect(res.status).toBe(409)
    expect(((await res.json()) as { error?: string }).error).toContain('Asilo 2329/2026')
    nessunaScrittura()
  })

  it('una riga STORICA senza sezionale si nomina lo stesso: `2330/2026`, non «undefined»', async () => {
    h.fatture = [{ numero: 2330, anno: 2026, sezionale: null, sdi_stato: 7 }]

    const res = await patch({ azione: 'conferma', pagamento_id: PID_NUOVO })

    expect(res.status).toBe(409)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toContain('2330/2026')
    expect(j.error).not.toContain('undefined')
    expect(j.error).not.toContain('null')
  })

  it('solo SCARTI (sdi_stato 2/4/9) → la conferma PROSEGUE: uno scarto non blocca il riabbinamento', async () => {
    // Senza questo caso, «non si riabbina mai un bonifico fatturato» sarebbe
    // soddisfatto anche da «non si riabbina mai niente», e una fattura scartata
    // — che si ripara solo riemettendo — bloccherebbe il bonifico per sempre.
    h.fatture = [
      { numero: 2328, anno: 2026, sezionale: 'Asilo', sdi_stato: 2 },
      { numero: 2329, anno: 2026, sezionale: 'Asilo', sdi_stato: 4 },
      { numero: 2330, anno: 2026, sezionale: 'Asilo', sdi_stato: 9 },
    ]

    const res = await patch({ azione: 'conferma', pagamento_id: PID_NUOVO })

    expect(res.status).toBe(200)
    expect(h.inserts.find((i) => i.table === 'incassi'), 'l’incasso non è stato registrato').toBeTruthy()
    expect(h.updates.find((u) => u.table === 'riconciliazione_movimenti')!.row.pagamento_id).toBe(PID_NUOVO)
  })

  it('stesso pagamento → prosegue, e `fatture_emesse` non viene nemmeno LETTA', async () => {
    // Riconfermare lo stesso abbinamento non è un secondo documento: è la stessa
    // riga. Una lettura in più qui sarebbe una query per ogni conferma.
    h.fatture = [fatturaViva]
    h.pagamento = { ...h.pagamento!, id: PID_VECCHIO }

    const res = await patch({ azione: 'conferma', pagamento_id: PID_VECCHIO })

    expect(res.status).toBe(200)
    expect(letteDa('fatture_emesse'), 'letta `fatture_emesse` su un abbinamento che non cambia').toEqual([])
  })

  it('nessun pagamento precedente → prosegue, e `fatture_emesse` non viene nemmeno LETTA', async () => {
    // Il caso normale, cioè quasi tutti: un movimento appena importato.
    h.movimento = { ...h.movimento!, pagamento_id: null, suggerimenti: [{ pagamento_id: PID_NUOVO }] }
    h.fatture = [fatturaViva]

    const res = await patch({ azione: 'conferma' })

    expect(res.status).toBe(200)
    expect(letteDa('fatture_emesse'), 'una query in più su ogni conferma normale').toEqual([])
  })

  it('⛔ lettura di `fatture_emesse` FALLITA → 503 fail-closed con `codice`, e nessuna scrittura', async () => {
    // PostgREST non lancia: ritorna `{ error }`. Chi non lo controlla legge `data`
    // nullo, lo scambia per «nessuna fattura» e riabbina — cioè trasforma un guasto
    // di lettura in un secondo incasso. Qui si dice «non lo so» e ci si ferma.
    h.fattureError = { code: '42501', message: 'permission denied for table fatture_emesse' }

    const res = await patch({ azione: 'conferma', pagamento_id: PID_NUOVO })

    expect(res.status).toBe(503)
    expect(((await res.json()) as { codice?: string }).codice).toBe('BONIFICO_FATTURA_NON_VERIFICABILE')
    nessunaScrittura()
    expect(h.logErrore, 'un guasto che ferma un’operazione e non lascia un log').toHaveBeenCalled()
  })

  it('il 409 lascia un log con l’ESITO, il numero e l’anno — e nessun dato di persona', async () => {
    h.fatture = [fatturaViva]

    expect((await patch({ azione: 'conferma', pagamento_id: PID_NUOVO })).status).toBe(409)

    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'bonifico-gia-fatturato-fermato',
    )
    expect(riga, 'nessuna riga di log dice che una rifatturazione è stata fermata').toBeTruthy()
    expect(riga![0]).toBe('pagamento')
    expect(riga![1]).toBe('warn')
    const campi = riga![2] as Record<string, unknown>
    expect(campi.operazione).toBe('pagamenti/riconciliazione/[id]:PATCH')
    expect(campi.pagamento_id).toBe(PID_VECCHIO)
    expect(campi.numero).toBe(2328)
    expect(campi.anno).toBe(2026)
    // Solo uuid e numeri: la causale del bonifico porta i nomi delle famiglie.
    expect(Object.keys(campi).sort()).toEqual(['anno', 'esito', 'numero', 'operazione', 'pagamento_id'])
  })

  it('la guardia riguarda SOLO la conferma: `ignora` e `riapri` non leggono `fatture_emesse`', async () => {
    h.fatture = [fatturaViva]

    expect((await patch({ azione: 'ignora' })).status).toBe(200)
    h.movimento = { ...h.movimento!, stato: 'ignorato' }
    expect((await patch({ azione: 'riapri' })).status).toBe(200)

    expect(letteDa('fatture_emesse')).toEqual([])
  })
})
