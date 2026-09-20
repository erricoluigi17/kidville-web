import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * RIAPRIRE UN MOVIMENTO GIÀ CONFERMATO — `PATCH … { azione: 'riapri' }`.
 *
 * ─── CHE COSA CAMBIA ─────────────────────────────────────────────────────────
 * Fino a oggi `riapri` sapeva fare una cosa sola: riportare in coda un movimento
 * `ignorato`. Su un `confermato` rispondeva **409 «stornare prima l'incasso»** —
 * cioè mandava l'operatrice a cercare a mano, nel registro incassi, la riga che
 * quel bonifico aveva creato. Adesso la riapertura fa da sé lo storno: una
 * transazione composita si annulla per intero (RPC `annulla_transazione_contabile`),
 * un abbinamento a voce singola storna il suo incasso.
 *
 * ─── LE TRE DECISIONI DEL TITOLARE, che questi test bloccano ─────────────────
 *  1. **Si riapre SEMPRE**, anche con fatture vive: si risponde 200 con un AVVISO
 *     che ne elenca i numeri, non 409. Il 409 sarebbe stato un divieto quasi
 *     totale: al 2026-09-13, in produzione, **167 movimenti confermati su 174**
 *     hanno una fattura viva sul pagamento abbinato — il 96%. Una riapertura che
 *     rifiuta il 96% dei casi non è una riapertura.
 *  2. **Nessuna notifica al genitore** per lo storno: la conferma avvisa, la
 *     riapertura no. È il motivo per cui `notificaEvento` compare qui come
 *     asserzione NEGATIVA su ogni percorso.
 *  3. **Le voci create restano**: non si cancella niente. Dopo lo storno ci pensa
 *     il trigger su `incassi` a riportarle nello stato giusto.
 *
 * ─── COME MORDONO QUESTI TEST ───────────────────────────────────────────────
 * Il finto Supabase distingue per TABELLA e registra ogni lettura, ogni insert,
 * ogni update e ogni `rpc`. «Non ha scritto niente» è un'asserzione sulle liste,
 * non una speranza: un rifiuto che arriva dopo aver stornato non è un rifiuto.
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
  /** Errore iniettabile sulla PRIMA lettura del movimento (il ramo `42703`). */
  movimentoError: null as { code: string; message: string } | null,
  /** L'incasso originale che `eseguiStornoIncasso` va a leggere. */
  incasso: null as Record<string, unknown> | null,
  /** La transazione letta dal gate di sede (null = non esiste). */
  transazione: null as Record<string, unknown> | null,
  transazioneError: null as { code: string; message: string } | null,
  /** La risposta del gate `assertPagamentoInScope` (null = dentro il perimetro). */
  fuoriScopePagamento: null as Response | null,
  fatture: [] as Record<string, unknown>[],
  fattureError: null as { code: string; message: string } | null,
  letture: [] as { table: string; cols: string; filtri: Record<string, unknown> }[],
  inserts: [] as { table: string; row: Record<string, unknown> | Record<string, unknown>[] }[],
  updates: [] as { table: string; row: Record<string, unknown>; filtri: Record<string, unknown> }[],
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  /** Esito pilotabile della RPC, per nome. */
  rpcEsito: {} as Record<string, { data: unknown; error: { code?: string; message?: string } | null }>,
  /** Quante righe risponde l'UPDATE del movimento (0 = corsa persa). */
  updateRows: [{ id: 'mov-upd' }] as Record<string, unknown>[],
  updateError: null as { code: string; message: string } | null,
  /**
   * Il CONTRO-INCASSO già a registro per `incasso_id` — cioè la prova che lo
   * storno di un giro precedente È avvenuto, letta con `.eq('storno_di', …)`.
   *
   * Esiste perché l'idempotenza della riapertura NON può poggiare su
   * `incassi.stornato_il`: quella marcatura, dentro `eseguiStornoIncasso`, è un
   * `.then(()=>{},()=>{})` — best-effort MUTO. Se fallisce, l'originale resta
   * «vivo» e un ritentativo lo stornerebbe una seconda volta.
   */
  controIncasso: [] as Record<string, unknown>[],
  controIncassoError: null as { code: string; message: string } | null,
  /**
   * Errore restituito dall'INSERT su `incassi` — cioè dal contro-incasso, che è
   * la scrittura PRIMARIA di `eseguiStornoIncasso` e l'unica il cui errore
   * risalga al chiamante (`stornato_il`, `ricalcola_stato_pagamento` e
   * `registro_modifiche` sono tutti `.then(()=>{},()=>{})`). È perciò il solo
   * modo di far fallire uno storno dall'esterno, e serve a provare il ramo che
   * su quel fallimento RIFIUTA di riaprire.
   */
  incassoInsertError: null as { code: string; message: string } | null,
  /**
   * Errore iniettabile sulla lettura che chiede `abbinato_auto_il`, la marca
   * «abbinato dalla macchina».
   *
   * `null` = la colonna c'è (produzione dopo `20260920124742`). Con `42703` si
   * riproduce il DB E2E della CI, che non è migrato: lì la riapertura NON deve
   * scrivere quella chiave, perché una colonna sconosciuta farebbe fallire
   * l'UPDATE con `PGRST204` — e fallirebbe DOPO lo storno, lasciando una riga
   * confermata sopra un incasso che non esiste più.
   *
   * ⚠️ CON UN CODICE QUALUNQUE (`40001`, un timeout) la risposta attesa NON è
   * più «si procede senza marca»: è 500 PRIMA dello storno. Fino al giro
   * precedente questa chiave pilotava una sonda a parte, fail-closed, e un
   * guasto transitorio faceva proseguire la riapertura lasciando ACCESA la marca
   * che mente — cioè proprio ciò che questa fetta esiste per impedire.
   */
  marcaError: null as { code: string; message: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: h.verificaRevoca }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => ['sc-1'],
  assertPagamentoInScope: async () => h.fuoriScopePagamento,
}))
vi.mock('@/lib/logging/logger', () => ({
  logOk: h.logOk,
  logErrore: h.logErrore,
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => finto(),
}))

/** Il finto: una sola forma per tutte le tabelle, pilotata per NOME. */
function finto() {
  return {
    from: (table: string) => {
      const filtri: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      b.select = (cols?: string) => { b._cols = cols ?? ''; return b }
      b.eq = (c: string, v: unknown) => { filtri[c] = v; return b }
      b.in = (c: string, v: unknown) => { filtri[c] = v; return b }
      b.order = () => b
      b.limit = () => b
      const registra = () => {
        h.letture.push({ table, cols: typeof b._cols === 'string' ? b._cols : '', filtri: { ...filtri } })
      }
      b.maybeSingle = async () => {
        registra()
        if (table === 'riconciliazione_movimenti') {
          const cols = typeof b._cols === 'string' ? b._cols : ''
          // Le due colonne nate dopo si chiedono nella STESSA lettura, e l'ordine
          // di questi due `if` non è cosmetico: è l'ordine delle migrazioni.
          // `abbinato_auto_il` (20260920124742) arriva DOPO `transazione_id`
          // (20260912180100), quindi un database a cui manchi la seconda non può
          // avere la prima: le colonne presenti sono sempre un PREFISSO. Un finto
          // che permettesse lo stato impossibile — marca presente, transazione
          // assente — farebbe collaudare un ramo che nessun database può produrre.
          if (cols.includes('transazione_id') && h.movimentoError) {
            return { data: null, error: h.movimentoError }
          }
          if (cols.includes('abbinato_auto_il') && h.marcaError) {
            return { data: null, error: h.marcaError }
          }
          return { data: h.movimento, error: null }
        }
        if (table === 'incassi') return { data: h.incasso, error: null }
        if (table === 'pagamenti_transazioni') {
          return { data: h.transazioneError ? null : h.transazione, error: h.transazioneError }
        }
        return { data: null, error: null }
      }
      b.single = async () => {
        registra()
        return { data: null, error: null }
      }
      b.insert = (row: Record<string, unknown> | Record<string, unknown>[]) => {
        h.inserts.push({ table, row })
        // Solo l'insert su `incassi` è pilotabile in errore: è l'unico di cui il
        // chiamante veda l'esito. Gli altri (`registro_modifiche`) restano muti,
        // com'è nel codice vero.
        const errore = table === 'incassi' ? h.incassoInsertError : null
        return {
          select: () => ({
            single: async () => ({ data: errore ? null : { id: `${table}-new` }, error: errore }),
          }),
          then: (r: (v: unknown) => unknown) => r({ data: null, error: null }),
        }
      }
      b.update = (row: Record<string, unknown>) => {
        const uf: Record<string, unknown> = {}
        const u: Record<string, unknown> = {}
        u.eq = (c: string, v: unknown) => { uf[c] = v; return u }
        const spingi = () => h.updates.push({ table, row, filtri: { ...uf } })
        u.select = () => ({
          then: (r: (v: unknown) => unknown) => {
            spingi()
            return r({ data: h.updateError ? null : h.updateRows, error: h.updateError })
          },
        })
        u.then = (r: (v: unknown) => unknown) => {
          spingi()
          return r({ data: null, error: null })
        }
        return u
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        registra()
        // ⚠️ QUI NON C'È PIÙ UNA SONDA DELLA MARCA da riconoscere, e l'assenza è
        // il punto: `abbinato_auto_il` si chiede nella lettura del movimento
        // (`maybeSingle`, qui sopra), non in una `select(…).limit(1)` a parte. Una
        // sonda separata rispondeva «non disponibile» anche sui guasti
        // transitori, e la riapertura proseguiva lasciando accesa la marca.
        if (table === 'fatture_emesse') {
          return resolve({ data: h.fattureError ? null : h.fatture, error: h.fattureError })
        }
        // La ricerca del contro-incasso già a registro: `storno_di` = l'incasso
        // che la conferma aveva creato.
        if (table === 'incassi' && 'storno_di' in filtri) {
          return resolve({ data: h.controIncassoError ? null : h.controIncasso, error: h.controIncassoError })
        }
        return resolve({ data: [], error: null })
      }
      return b
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args })
      return h.rpcEsito[name] ?? { data: null, error: null }
    },
  }
}

import { PATCH } from '@/app/api/pagamenti/riconciliazione/[id]/route'
// La vera `messaggioDaCorpo` (NON mockata): è la sola cosa che dica che cosa
// l'operatrice legge davvero. Un `codice` che non è in `CODICI_CON_DETTAGLIO`
// fa SCARTARE la prosa del server, e un 409 che «dichiara lo storno» nella
// prosa può arrivare a schermo dicendo tutt'altro.
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch'

const MID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const TXID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
const INCID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4'

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/pagamenti/riconciliazione/${MID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: MID }) },
  )

const letteDa = (tabella: string) => h.letture.filter((l) => l.table === tabella)
const updateDi = (tabella: string) => h.updates.filter((u) => u.table === tabella)

/** Nessuna traccia lasciata da un percorso d'errore: nessuno storno, nessuna riapertura. */
function nessunaScrittura() {
  expect(h.inserts, 'una riga è stata inserita prima del rifiuto').toEqual([])
  expect(h.updates, 'una riga è stata aggiornata prima del rifiuto').toEqual([])
  expect(h.logScrittura).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  h.letture = []
  h.inserts = []
  h.updates = []
  h.rpcCalls = []
  h.fatture = []
  h.fattureError = null
  h.movimentoError = null
  h.updateRows = [{ id: 'mov-upd' }]
  h.updateError = null
  h.controIncasso = []
  h.controIncassoError = null
  h.incassoInsertError = null
  h.marcaError = null
  h.rpcEsito = {}
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  h.movimento = {
    id: MID, scuola_id: 'sc-1', importo: 150, data_operazione: '2026-09-05',
    causale: 'BONIFICO', stato: 'confermato', suggerimenti: null,
    pagamento_id: PID, incasso_id: INCID, transazione_id: null,
  }
  h.incasso = { id: INCID, pagamento_id: PID, importo: 150, metodo: 'bonifico', storno_di: null, stornato_il: null }
  h.transazione = { id: TXID, scuola_id: 'sc-1', annullata_il: null }
  h.transazioneError = null
  h.fuoriScopePagamento = null
})

/** Una riga viva: presa in carico dallo SDI, nessuno scarto. */
const fatturaViva = { numero: 2328, anno: 2026, sezionale: 'Asilo', sdi_stato: 1 }

describe('PATCH riapri — un movimento CONFERMATO torna in coda, con lo storno', () => {
  it('senza fatture: storna l’incasso, riapre la riga e risponde 200 SENZA avviso', async () => {
    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(200)
    const j = (await res.json()) as { success?: boolean; data?: Record<string, unknown>; avviso?: unknown }
    expect(j.success).toBe(true)
    expect(j.avviso, 'un avviso senza nessuna fattura viva').toBeUndefined()
    expect(j.data?.stato).toBe('da_abbinare')

    // Lo storno: un contro-incasso NEGATIVO, non una cancellazione.
    const contro = h.inserts.find((i) => i.table === 'incassi')
    expect(contro, 'l’incasso non è stato stornato').toBeTruthy()
    expect((contro!.row as Record<string, unknown>).importo).toBe(-150)
    expect((contro!.row as Record<string, unknown>).storno_di).toBe(INCID)

    // La riapertura: legami MORTI azzerati, `pagamento_id` CONSERVATO.
    const upd = updateDi('riconciliazione_movimenti')
    expect(upd).toHaveLength(1)
    expect(upd[0].row.stato).toBe('da_abbinare')
    expect(upd[0].row.incasso_id).toBeNull()
    expect(upd[0].row.confermato_da).toBeNull()
    expect(upd[0].row.confermato_il).toBeNull()
    // 🔴 E IL QUINTO LEGAME MORTO: la marca «abbinato dalla macchina». Senza
    // questa riga la marca MENTE — la riga torna in coda ancora «automatica»,
    // un'operatrice la riconferma A MANO e l'annullamento in blocco, che cerca
    // esattamente quella marca, disfa il lavoro di una persona.
    expect(
      upd[0].row.abbinato_auto_il,
      'la riapertura non spegne `abbinato_auto_il`: la riga torna in coda dicendo di essere ' +
        'stata abbinata dalla macchina, e un annullamento in blocco la disferà anche dopo una ' +
        'riconferma fatta a mano.',
    ).toBeNull()
    expect(
      Object.keys(upd[0].row),
      '`pagamento_id` azzerato: è la memoria su cui poggia la guardia BONIFICO_GIA_FATTURATO',
    ).not.toContain('pagamento_id')
    // CAS ottimistico: si riapre solo se la riga è ancora quella letta.
    expect(upd[0].filtri.stato).toBe('confermato')
  })

  it('NESSUNA notifica al genitore parte dallo storno (decisione del titolare)', async () => {
    expect((await patch({ azione: 'riapri' })).status).toBe(200)
    expect(h.notificaEvento, 'un avviso al genitore su una riapertura').not.toHaveBeenCalled()
  })

  it('con una fattura VIVA: 200 lo stesso, con un avviso che porta il NUMERO', async () => {
    h.fatture = [fatturaViva]

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(200)
    const j = (await res.json()) as { avviso?: { codice?: string; messaggio?: string; numeri?: string[] } }
    expect(j.avviso?.codice).toBe('RIAPERTURA_CON_FATTURA_VIVA')
    // I numeri in un campo LORO, non solo dentro la frase: chi disegna il pannello
    // deve poterli elencare senza fare il parsing di una prosa.
    expect(j.avviso?.numeri).toEqual(['Asilo 2328/2026'])
    expect(j.avviso?.messaggio).toContain('Asilo 2328/2026')
    // E la riapertura è avvenuta davvero: l'avviso non è un rifiuto travestito.
    expect(updateDi('riconciliazione_movimenti')).toHaveLength(1)
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeTruthy()
  })

  it('una fattura SCARTATA non è viva: 200 senza avviso', async () => {
    // Uno scarto si ripara riemettendo: trattarlo come un documento vivo
    // avviserebbe di un problema che non c'è su quasi ogni riapertura.
    h.fatture = [{ numero: 2329, anno: 2026, sezionale: 'Asilo', sdi_stato: 4 }]

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { avviso?: unknown }).avviso).toBeUndefined()
  })

  it('una riga di TRASPORTO FALLITO (`sdi_stato` nullo) conta come viva', async () => {
    h.fatture = [{ numero: 2330, anno: 2026, sezionale: null, sdi_stato: null }]

    const res = await patch({ azione: 'riapri' })

    const j = (await res.json()) as { avviso?: { numeri?: string[] } }
    expect(res.status).toBe(200)
    expect(j.avviso?.numeri).toEqual(['2330/2026'])
  })

  it('lettura di `fatture_emesse` fallita: si riapre lo stesso, ma l’avviso lo DICE', async () => {
    // «Non lo so» non è «nessuna fattura». La riapertura non si ferma (decisione
    // del titolare), ma tacere trasformerebbe un guasto di lettura in un
    // «nessuna fattura viva» che nessuno ha verificato.
    h.fattureError = { code: '42501', message: 'permission denied for table fatture_emesse' }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(200)
    const j = (await res.json()) as { avviso?: { codice?: string } }
    expect(j.avviso?.codice).toBe('RIAPERTURA_FATTURE_NON_VERIFICATE')
    expect(updateDi('riconciliazione_movimenti')).toHaveLength(1)
    expect(h.logErrore, 'un guasto di lettura senza una riga di log').toHaveBeenCalled()
  })

  it('con una TRANSAZIONE: chiama la RPC di annullo e NON aggiorna il movimento a mano', async () => {
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    h.rpcEsito.annulla_transazione_contabile = {
      data: { incassi_stornati: 3, ricariche_stornate: 1, credito_stornato: 0, movimenti_riaperti: 1 },
      error: null,
    }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(200)
    const chiamata = h.rpcCalls.find((c) => c.name === 'annulla_transazione_contabile')
    expect(chiamata, 'la transazione composita è stata sciolta a mano invece che con la RPC').toBeTruthy()
    const p = chiamata!.args.p as Record<string, unknown>
    expect(p.transazione_id).toBe(TXID)
    expect(String(p.motivo).length).toBeGreaterThanOrEqual(3)
    expect(p.annullato_da).toBe('staff-1')

    const j = (await res.json()) as { data?: Record<string, unknown> }
    expect(j.data?.transazione_annullata).toBe(true)
    expect(j.data?.movimenti_riaperti).toBe(1)
    expect(j.data?.incassi_stornati).toBe(3)

    // La RPC riapre il movimento da sé: un secondo UPDATE sarebbe una scrittura
    // di troppo su una riga che è già tornata in coda.
    expect(updateDi('riconciliazione_movimenti'), 'doppia riapertura: RPC + UPDATE').toEqual([])
    expect(h.inserts.find((i) => i.table === 'incassi'), 'storno a mano oltre alla RPC').toBeFalsy()
  })

  it('RPC VECCHIA (nessun `movimenti_riaperti`): la riapertura la fa la route, e lo dice', async () => {
    // Stato reale durante un rilascio: la colonna c'è, la funzione è ancora quella
    // di prima. Senza questa rete il bonifico resterebbe `confermato` con l'incasso
    // stornato — cioè una riga che mente, che è il difetto che la migrazione chiude.
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    h.rpcEsito.annulla_transazione_contabile = {
      data: { incassi_stornati: 2, ricariche_stornate: 0, credito_stornato: 0 },
      error: null,
    }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(200)
    const upd = updateDi('riconciliazione_movimenti')
    expect(upd, 'la RPC non ha riaperto e nessuno l’ha fatto al posto suo').toHaveLength(1)
    expect(upd[0].row.stato).toBe('da_abbinare')
    expect(upd[0].row.transazione_id).toBeNull()
  })

  it('⛔ RPC ASSENTE (PGRST202) → 503 con `codice`, e NESSUNA scrittura parziale', async () => {
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    h.rpcEsito.annulla_transazione_contabile = {
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(503)
    expect(((await res.json()) as { codice?: string }).codice).toBe('RIAPERTURA_NON_DISPONIBILE')
    nessunaScrittura()
  })

  it('⛔ RPC 42883 (funzione inesistente sul DB non migrato) → 503, nessuna scrittura', async () => {
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    h.rpcEsito.annulla_transazione_contabile = { data: null, error: { code: '42883', message: 'function does not exist' } }

    expect((await patch({ azione: 'riapri' })).status).toBe(503)
    nessunaScrittura()
  })

  it('⛔ credito eccedenza già speso (KV410) → 409, nessuna scrittura', async () => {
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    h.rpcEsito.annulla_transazione_contabile = { data: null, error: { code: 'KV410', message: 'credito speso' } }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(409)
    // ⚠️ Il 409 da solo non distingue questo rifiuto da quello di PRIMA di questo
    // lavoro, quando `riapri` su un confermato rispondeva 409 comunque: senza le
    // due righe qui sotto il test sarebbe verde anche a funzionalità assente.
    expect(h.rpcCalls.map((c) => c.name)).toContain('annulla_transazione_contabile')
    expect(((await res.json()) as { codice?: string }).codice).toBe('RIAPERTURA_CREDITO_GIA_SPESO')
    nessunaScrittura()
  })

  it('⛔ RPC fallita con un codice QUALUNQUE (deadlock 40001) → 500, e la riga resta confermata', async () => {
    // ⚠️ IL GEMELLO COMPOSITO del presidio qui sotto, sul percorso nuovo di questa
    // fetta, e fino al 2026-09-13 senza un test suo: sostituendo `code !== 'KV409'`
    // con `false` — si prosegue e si riapre lo stesso — restavano verdi tutti gli
    // altri 32 test di questo file, e in tutta la suite cadeva SOLO questo: un
    // fallimento in più del giro senza mutante, nessuno in meno (due giri sullo
    // stesso albero congelato, le due liste di falliti a confronto).
    // Qui c'era un totale d'insieme — «restavano N test verdi su M file» — ed è il
    // tipo di numero che questo file punisce. Ne è stato riscritto tre volte in un
    // giorno, ogni volta sbagliato in un modo nuovo: contava i test di una fetta
    // che questa rotta non importa nemmeno, poi contava file che non la importano,
    // e intanto il totale della suite cambiava a ogni misura. Un totale d'insieme
    // invecchia da solo, e riscriverlo lo fa solo invecchiare più tardi; «ne cadeva
    // uno solo, nessuno in meno» no: non dipende da quanti test ci sono accanto.
    // Col presidio tolto la rotta risponde `200 {"success":true,"data":{"stato":
    // "da_abbinare","transazione_annullata":true,"movimenti_riaperti":1,
    // "incassi_stornati":0}}` e scrive l'UPDATE `{stato:'da_abbinare',
    // incasso_id:null, confermato_da:null, confermato_il:null, transazione_id:null}`,
    // con ZERO righe di `logErrore` (misurato, non dedotto): la riga viene liberata e
    // si fa riabbinare mentre incassi, ricariche mensa e credito di quella
    // transazione sono ANCORA VIVI — lo stesso denaro incassato due volte — e
    // all'operatrice si dichiara `transazione_annullata: true` su una RPC **fallita**.
    //
    // `40001` è un deadlock: il codice che una RPC restituisce quando non ha fatto
    // niente e non lo dice con un `KV…`. Vale identico per `57014` (timeout) e per
    // una connessione caduta. Solo `KV409` — «già annullata», cioè gli storni ci
    // sono — autorizza a proseguire.
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    h.rpcEsito.annulla_transazione_contabile = { data: null, error: { code: '40001', message: 'deadlock detected' } }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(500)
    expect(((await res.json()) as { codice?: string }).codice).toBe('RIAPERTURA_NON_RIUSCITA')
    // ⚠️ `500 RIAPERTURA_NON_RIUSCITA` è la risposta di altri DUE rami — il
    // fail-closed di `stornoGiaRegistrato` e lo storno a voce singola fallito — e a
    // nessuno dei due si arriva chiamando la RPC. Senza questa riga il test
    // resterebbe verde anche arrivando al 500 per la strada sbagliata.
    expect(
      h.rpcCalls.filter((c) => c.name === 'annulla_transazione_contabile'),
      'la RPC non è stata chiamata: questo 500 viene da un altro ramo',
    ).toHaveLength(1)
    // LA riga che conta.
    expect(
      updateDi('riconciliazione_movimenti'),
      'riaperto sopra una transazione NON annullata: incassi, ricariche e credito restano vivi',
    ).toEqual([])
    // L'evento è ciò che, nei log, distingue questo 500 dagli altri due: senza
    // questa riga i tre rifiuti sarebbero indistinguibili anche a posteriori.
    expect(
      h.logErrore.mock.calls.find((c) => (c[0] as { evento?: string })?.evento === 'riapertura_rpc_fallita'),
      'una RPC fallita senza una riga di log che lo dica',
    ).toBeTruthy()
    nessunaScrittura()
  })

  it('la colonna `transazione_id` non esiste (42703): si ritenta senza, e si storna a mano', async () => {
    // DB E2E della CI, mai migrato. La rotta non può cadere: ricade
    // sull'abbinamento a voce singola, che è ciò che quel database contiene.
    h.movimentoError = { code: '42703', message: 'column riconciliazione_movimenti.transazione_id does not exist' }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(200)
    expect(h.rpcCalls.filter((c) => c.name === 'annulla_transazione_contabile')).toEqual([])
    expect(updateDi('riconciliazione_movimenti')).toHaveLength(1)
    // TRE letture del movimento, e si scala di UNA colonna alla volta: le colonne
    // nate dopo sono un prefisso (`abbinato_auto_il` dopo `transazione_id`), e
    // togliere tutt'e due insieme al primo `42703` lascerebbe sulla riga riaperta
    // un `transazione_id` che punta a una transazione annullata — un legame morto
    // in meno di quelli che si azzerano oggi.
    const lette = letteDa('riconciliazione_movimenti')
    expect(lette.length).toBeGreaterThanOrEqual(3)
    expect(lette[0].cols).toContain('abbinato_auto_il')
    expect(lette[1].cols).toContain('transazione_id')
    expect(lette[1].cols).not.toContain('abbinato_auto_il')
    expect(lette[2].cols).not.toContain('transazione_id')
    // Su questo database non esiste NESSUNA delle due: nessuna delle due chiavi
    // viaggia nell'UPDATE, o PostgREST risponde `PGRST204` DOPO lo storno.
    const chiavi = Object.keys(updateDi('riconciliazione_movimenti')[0].row)
    expect(chiavi).not.toContain('transazione_id')
    expect(chiavi).not.toContain('abbinato_auto_il')
  })

  it('⛔ lo STORNO NON RIESCE → 500, e la riga NON torna in coda', async () => {
    // ⚠️ IL PRESIDIO PIÙ DIRETTO CONTRO IL DOPPIO INCASSO: cancellandolo — si
    // prosegue e si riapre lo stesso — in tutta la suite cadeva SOLO questo test,
    // uno in più del giro senza mutante e nessuno in meno, come per il gemello qui
    // sopra. Qui c'era «67 test verdi su due file»: un totale rimasto senza una
    // misura che lo confermi, tolto invece che riscritto — un numero che non si
    // può ricontare vale meno del nulla.
    // ⚠️ Questo commento ha detto il falso fino al 2026-09-13: diceva «l'unico
    // rifiuto di questa rotta senza un test suo», e ne erano ALMENO due. Il secondo
    // è il gemello composito qui sopra (RPC fallita con un codice non previsto),
    // coperto nella stessa giornata. «ALMENO» perché un terzo è tuttora scoperto:
    // `MOVIMENTO_NON_LETTO`, che ha DUE bracci (`route.ts:330` e `:341`) e in
    // `__tests__/` compare soltanto dentro un commento. Rifiuta in lettura e
    // risponde prima di qualunque scrittura — fra l'inizio del PATCH e quel `return`
    // non c'è una `insert`, una `update` né una `rpc` — quindi non muove denaro; ma
    // «erano DUE» è lo stesso conteggio chiuso troppo presto che aveva lasciato
    // scoperto il secondo credendolo già coperto.
    // Un movimento rimesso in coda con l'incasso ANCORA VIVO si fa riabbinare a
    // un'altra voce: lo stesso bonifico incassato due volte, con un 200 sopra.
    //
    // Lo storno si fa fallire dall'unico punto da cui sia possibile — il
    // contro-incasso, la sola scrittura di `eseguiStornoIncasso` il cui errore
    // risalga fin qui.
    h.incassoInsertError = { code: '42501', message: 'permission denied for table incassi' }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(500)
    expect(((await res.json()) as { codice?: string }).codice).toBe('RIAPERTURA_NON_RIUSCITA')
    // Lo storno è stato TENTATO: senza questa riga il test resterebbe verde anche
    // fermandosi molto prima, perché `RIAPERTURA_NON_RIUSCITA` è la risposta di
    // altri due rami — fra cui il fail-closed che rifiuta senza scrivere niente.
    expect(
      h.inserts.filter((i) => i.table === 'incassi'),
      'lo storno non è stato nemmeno tentato: il rifiuto viene da un altro ramo',
    ).toHaveLength(1)
    // LA riga che conta.
    expect(
      updateDi('riconciliazione_movimenti'),
      'riaperto sopra un incasso vivo: lo stesso denaro si fa incassare una seconda volta',
    ).toEqual([])
    expect(
      h.logErrore.mock.calls.find((c) => (c[0] as { evento?: string })?.evento === 'riapertura_storno_fallito'),
      'uno storno fallito senza una riga di log che lo dica',
    ).toBeTruthy()
  })

  it('⛔ corsa persa (l’UPDATE non tocca nessuna riga) → 409 che DICE dello storno', async () => {
    // L'ordine è storno → riapertura, ed è scelto: nel verso opposto un movimento
    // libero con l'incasso ancora vivo si fa riabbinare, cioè incassare due volte.
    // Qui invece resta uno storno senza riapertura — recuperabile ritentando — e
    // la risposta lo dichiara invece di tacerlo.
    h.updateRows = []

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(409)
    const j = (await res.json()) as { codice?: string; data?: Record<string, unknown> }
    // ⚠️ NON è `CONCILIAZIONE_MOVIMENTO_CAMBIATO`, e fino al 2026-09-13 lo era.
    // Quel codice NON sta in `CODICI_CON_DETTAGLIO`: `messaggioDaCorpo` scartava
    // quindi la prosa — l'unica riga che dicesse «lo storno è stato registrato» —
    // e a schermo usciva «un altro operatore ha appena modificato questo bonifico:
    // ricarica l'elenco e ricomponi il pagamento», cioè l'esatto contrario. Il 409
    // progettato per DICHIARARE lo storno dichiarava il suo opposto.
    expect(j.codice).toBe('RIAPERTURA_STORNATA_NON_RIAPERTA')
    expect(j.data?.incassi_stornati, 'lo storno c’è stato e la risposta non lo dice').toBe(1)
    expect(h.inserts.find((i) => i.table === 'incassi'), 'nessuno storno: il 409 è quello di prima').toBeTruthy()
    expect(h.logErrore, 'uno storno senza riapertura senza una riga di log').toHaveBeenCalled()
  })

  it('⛔ corsa persa: la frase che ARRIVA A SCHERMO dice del denaro restituito', async () => {
    // La misura, non la deduzione: si esegue la vera `messaggioDaCorpo` sul corpo
    // vero della risposta. È il solo modo di sapere che cosa legge l'operatrice —
    // fra il `codice` scritto nella route e il testo a schermo c'è una regola
    // (`CODICI_CON_DETTAGLIO`) che può buttare via tutta la prosa.
    h.updateRows = []

    const aSchermo = messaggioDaCorpo(await (await patch({ azione: 'riapri' })).json(), 'Errore')

    expect(aSchermo.toLowerCase(), 'la frase a schermo non nomina lo storno').toContain('stornat')
    expect(aSchermo, 'a schermo esce l’invito a ricomporre, che del denaro non dice niente').not.toContain(
      'ricomponi il pagamento',
    )
  })

  it('le VOCI create restano: nessuna `delete` su `pagamenti`', async () => {
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    h.rpcEsito.annulla_transazione_contabile = { data: { incassi_stornati: 1, movimenti_riaperti: 1 }, error: null }

    expect((await patch({ azione: 'riapri' })).status).toBe(200)
    // Nessun ramo della route cancella una voce: dopo lo storno ci pensa il
    // trigger a riportarle nello stato giusto.
    expect(h.updates.filter((u) => u.table === 'pagamenti')).toEqual([])
  })

  it('il SUCCESSO è loggato, con uuid e numeri soltanto', async () => {
    h.fatture = [fatturaViva]

    expect((await patch({ azione: 'riapri' })).status).toBe(200)

    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'movimento-riaperto',
    )
    expect(riga, 'una riapertura che non lascia nessuna riga di successo').toBeTruthy()
    expect(riga![0]).toBe('pagamento')
    expect(riga![1]).toBe('info')
    const campi = riga![2] as Record<string, unknown>
    expect(campi.operazione).toBe('pagamenti/riconciliazione/[id]:PATCH')
    expect(campi.movimento_id).toBe(MID)
    // `marca_disponibile` è un BOOLEANO, e `redact` lascia in chiaro i booleani
    // come già fa per `transazione_annullata`: dice se la marca «abbinato dalla
    // macchina» si poteva spegnere, e senza di lui «nessun log» tornerebbe a non
    // distinguere «spenta» da «non è mai partito niente».
    expect(campi.marca_disponibile).toBe(true)
    // Nessuna causale, nessun nome: la causale di un bonifico porta i nomi delle famiglie.
    for (const k of Object.keys(campi)) {
      expect(['operazione', 'esito', 'movimento_id', 'pagamento_id', 'transazione_annullata', 'incassi_stornati', 'fatture_vive', 'marca_disponibile']).toContain(k)
    }
  })

  it('⛔ transazione di UN’ALTRA SEDE → 404, e la RPC non viene nemmeno chiamata', async () => {
    // Uno storno è un movimento contabile definitivo, non una lettura: una
    // segreteria di Cesa non deve poter annullare la transazione di Giugliano. La
    // RPC gira a service-role e nessun filtro le arriva addosso — se non la ferma
    // questa riga, non la ferma niente.
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    h.transazione = { id: TXID, scuola_id: 'sc-99', annullata_il: null }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(404)
    expect(h.rpcCalls.filter((c) => c.name === 'annulla_transazione_contabile')).toEqual([])
    nessunaScrittura()
  })

  it('⛔ a voce singola, il gate sul PAGAMENTO ferma lo storno fuori sede', async () => {
    h.fuoriScopePagamento = new Response(JSON.stringify({ error: 'Sede non accessibile' }), { status: 403 })

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(403)
    nessunaScrittura()
  })

  it('l’audit in `registro_modifiche` porta chi ha riaperto (la firma di conferma si perde)', async () => {
    expect((await patch({ azione: 'riapri' })).status).toBe(200)
    expect(h.logScrittura, 'nessuna traccia di CHI ha riaperto').toHaveBeenCalled()
  })
})

/**
 * ─── IL RITENTATIVO ─────────────────────────────────────────────────────────
 *
 * «Ritentando si ripara» è scritto in due commenti della route, ed è la sola cosa
 * che renda accettabile l'ordine storno → riapertura. Per il ramo a voce singola
 * era vero; per il ramo COMPOSITO era falso, e questi test lo bloccano da tutte
 * e due le parti.
 *
 * Il difetto, misurato: primo giro corsa persa → 409; secondo giro → **409 di
 * nuovo**, zero UPDATE sul movimento. Il gate leggeva `pagamenti_transazioni.annullata_il`
 * — ormai valorizzato dalla RPC del primo giro — e rifiutava PRIMA di poter
 * riaprire. Restava una riga `confermato` sopra incassi stornati e transazione
 * annullata: esattamente il difetto che questa fetta esiste per chiudere,
 * ricreato in un percorso d'errore e non riparabile nemmeno dall'interfaccia
 * (anche «annulla transazione» risponde 409 su una transazione già annullata).
 */
describe('PATCH riapri — il RITENTATIVO ripara davvero (due giri di fila)', () => {
  it('🔁 COMPOSITO: 1° giro corsa persa → 409; 2° giro → 200 e la riga torna in coda', async () => {
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    // RPC VECCHIA (quella viva in produzione, misurata): annulla e storna, ma NON
    // riapre il movimento — la riapertura la deve fare la route.
    h.rpcEsito.annulla_transazione_contabile = { data: { incassi_stornati: 2 }, error: null }

    // ── 1° GIRO: la corsa sull'UPDATE è persa ─────────────────────────────────
    h.updateRows = []
    const primo = await patch({ azione: 'riapri' })
    expect(primo.status, 'il primo giro non ha perso la corsa: il caso non è quello').toBe(409)
    expect(h.rpcCalls.filter((c) => c.name === 'annulla_transazione_contabile')).toHaveLength(1)

    // ── LO STATO DEL MONDO DOPO IL PRIMO GIRO ─────────────────────────────────
    // La RPC ha committato: la transazione È annullata, gli incassi SONO stornati,
    // il movimento è rimasto `confermato`. È esattamente ciò che l'operatrice si
    // ritrova davanti quando ripreme il pulsante.
    h.transazione = { id: TXID, scuola_id: 'sc-1', annullata_il: '2026-09-13T10:00:00.000Z' }
    h.updateRows = [{ id: 'mov-upd' }]
    h.rpcCalls = []
    h.updates = []
    h.inserts = []

    // ── 2° GIRO ───────────────────────────────────────────────────────────────
    const secondo = await patch({ azione: 'riapri' })

    expect(secondo.status, 'il secondo giro rifiuta di nuovo: il movimento resta inchiodato').toBe(200)
    const upd = updateDi('riconciliazione_movimenti')
    expect(upd, 'nessun UPDATE: la riga non è tornata in coda nemmeno al secondo giro').toHaveLength(1)
    expect(upd[0].row.stato).toBe('da_abbinare')
    expect(upd[0].row.transazione_id, 'il legame morto resta appeso').toBeNull()
    // La RPC NON si richiama: gli storni sono già stati fatti e commessi, e una
    // seconda chiamata risponderebbe comunque KV409.
    expect(
      h.rpcCalls.filter((c) => c.name === 'annulla_transazione_contabile'),
      'la RPC è stata richiamata su una transazione già annullata',
    ).toEqual([])
    const j = (await secondo.json()) as { data?: Record<string, unknown> }
    // Questo giro non ha stornato NIENTE: dire il contrario gonfierebbe un
    // conteggio che l'operatrice usa per sapere quante righe rilavorare.
    expect(j.data?.incassi_stornati).toBe(0)
    expect(j.data?.transazione_annullata).toBe(true)
  })

  it('🔁 COMPOSITO: la RPC risponde KV409 in gara → si riapre lo stesso, non si rifiuta', async () => {
    // Stessa causa radice del test qui sopra, per l'altra strada: la transazione
    // viene annullata FRA il pre-check e la RPC. `KV409` = «già annullata», cioè
    // gli storni ci sono. Rifiutare qui lascerebbe la riga confermata su incassi
    // che non esistono più.
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    h.rpcEsito.annulla_transazione_contabile = {
      data: null,
      error: { code: 'KV409', message: 'transazione già annullata' },
    }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(200)
    expect(updateDi('riconciliazione_movimenti')).toHaveLength(1)
    expect(updateDi('riconciliazione_movimenti')[0].row.stato).toBe('da_abbinare')
  })

  it('⛔ COMPOSITO: KV404 (la transazione non esiste) NON riapre — gli incassi sono vivi', async () => {
    // Qui il ritentativo non deve funzionare, ed è voluto: se la transazione non
    // esiste, i suoi incassi non sono stati stornati (la RPC li trova PER
    // `transazione_id`). Riaprire libererebbe un bonifico con l'incasso ancora
    // vivo, cioè lo stesso denaro incassato due volte.
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    h.rpcEsito.annulla_transazione_contabile = {
      data: null,
      error: { code: 'KV404', message: 'transazione non trovata' },
    }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(409)
    nessunaScrittura()
  })

  it('🔁 VOCE SINGOLA: il contro-incasso c’è già ma la MARCATURA è fallita → niente secondo storno', async () => {
    // ⚠️ `eseguiStornoIncasso` marca `incassi.stornato_il` con un
    // `.then(()=>{},()=>{})`: best-effort MUTO, codice di un'altra rotta che qui
    // non si riscrive. Ma la riapertura ne diventa un chiamante che DIPENDE da
    // quella marcatura per la propria idempotenza — e se fallisce in silenzio, il
    // ritentativo storna due volte lo stesso denaro.
    //
    // Perciò l'idempotenza NON poggia su `stornato_il`: poggia sul CONTRO-INCASSO,
    // che è la scrittura primaria di quella funzione — l'unica il cui errore viene
    // restituito invece che inghiottito. Qui l'originale è ancora «vivo» in ogni
    // campo e lo storno va riconosciuto lo stesso.
    h.incasso = { id: INCID, pagamento_id: PID, importo: 150, metodo: 'bonifico', storno_di: null, stornato_il: null }
    h.controIncasso = [{ id: 'contro-1' }]

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(200)
    expect(
      h.inserts.filter((i) => i.table === 'incassi'),
      'lo stesso incasso è stato stornato una seconda volta',
    ).toEqual([])
    expect(updateDi('riconciliazione_movimenti'), 'la riga non è tornata in coda').toHaveLength(1)
    const j = (await res.json()) as { data?: Record<string, unknown> }
    expect(j.data?.incassi_stornati, 'questo giro non ha stornato niente').toBe(0)
  })

  it('🔁 VOCE SINGOLA: senza contro-incasso lo storno si fa (il controllo non è un blocco)', async () => {
    // La rete di sicurezza qui sopra deve riconoscere uno storno già fatto, non
    // impedire il primo: senza questo test basterebbe rispondere «già stornato»
    // sempre per farla passare.
    h.controIncasso = []

    expect((await patch({ azione: 'riapri' })).status).toBe(200)
    expect(h.inserts.find((i) => i.table === 'incassi'), 'il primo storno non è avvenuto').toBeTruthy()
  })

  it('⛔ VOCE SINGOLA: se il contro-incasso non si può LEGGERE non si storna alla cieca', async () => {
    // Fail-closed, come la guardia del riabbinamento poche righe più in là: se non
    // si può sapere se lo storno sia già avvenuto, farlo comunque è la strada che
    // porta a due contro-incassi sullo stesso denaro.
    h.controIncassoError = { code: '42501', message: 'permission denied for table incassi' }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(500)
    expect(((await res.json()) as { codice?: string }).codice).toBe('RIAPERTURA_NON_RIUSCITA')
    nessunaScrittura()
  })

  it('la colonna `storno_di` non esiste (42703): si storna lo stesso, il DB non migrato non si blocca', async () => {
    // DB E2E della CI: là `storno_di` può non esserci. Un 500 su quell'ambiente
    // trasformerebbe una rete di sicurezza in un guasto.
    h.controIncassoError = { code: '42703', message: 'column incassi.storno_di does not exist' }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(200)
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeTruthy()
  })

  it('🔁 VOCE SINGOLA: l’incasso risulta GIÀ stornato (409) → si prosegue, non si rifiuta', async () => {
    // ⚠️ LA RETE SECONDA dell'idempotenza — quella che scatta quando `stornato_il`
    // è stato marcato DAVVERO, e che fino al 2026-09-13 nessun test faceva
    // scattare: disattivandola (`else if (esitoStorno.status === 404 || … === 409)`
    // → `else if (false)`) cadeva SOLO questo test, in tutto il file e in tutta la
    // suite — un fallimento in più del giro senza mutante, nessuno in meno, liste
    // dei falliti a confronto. Qui c'era un conto dei test rimasti verdi accanto a
    // questo: invecchiava a ogni test aggiunto al file, ed era già vecchio quando
    // l'hanno scritto. «Ne cadeva uno solo, nessuno in meno» no.
    //
    // Ci si arriva per la strada che il DB non migrato rende ordinaria: là
    // `storno_di` non esiste (42703), quindi la rete PRIMA (`stornoGiaRegistrato`)
    // degrada a «non lo so» per non bloccare la CI, e l'unica cosa che riconosca
    // lo storno di un giro precedente è il 409 di `eseguiStornoIncasso`.
    // Senza questo ramo si risponderebbe 500 lasciando la riga `confermato` sopra
    // un incasso che non è più vivo: non denaro raddoppiato, ma un movimento
    // inchiodato che nessun ritentativo può più liberare.
    h.controIncassoError = { code: '42703', message: 'column incassi.storno_di does not exist' }
    h.incasso = { ...h.incasso!, stornato_il: '2026-09-13T09:00:00.000Z' }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(200)
    expect(
      h.inserts.filter((i) => i.table === 'incassi'),
      'un secondo contro-incasso sullo stesso denaro',
    ).toEqual([])
    const upd = updateDi('riconciliazione_movimenti')
    expect(upd, 'la riga resta confermata sopra un incasso già stornato: inchiodata').toHaveLength(1)
    expect(upd[0].row.stato).toBe('da_abbinare')
    const j = (await res.json()) as { data?: Record<string, unknown> }
    expect(j.data?.incassi_stornati, 'questo giro non ha stornato niente').toBe(0)
    // Una rete che scatta in silenzio è una rete che nessuno vede scattare.
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'riapertura-incasso-gia-non-vivo',
    )
    expect(riga, 'la rete è scattata senza lasciare una riga di log').toBeTruthy()
    expect((riga![2] as { stato?: number }).stato, 'il log non dice QUALE dei due esiti è scattato').toBe(409)
  })
})

describe('PATCH riapri — le frasi che l’operatrice legge davvero', () => {
  it('⛔ la transazione non si LEGGE → 503 con un codice suo, non quello del movimento', async () => {
    // `MOVIMENTO_NON_LETTO` è documentato 500 e parla di «questa riga dell'estratto
    // conto»: qui la cosa che non si è potuta leggere è la TRANSAZIONE, e la
    // risposta è 503. Codice, stato e testo dicevano tre cose che non combaciavano.
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    h.transazioneError = { code: '57014', message: 'canceling statement due to statement timeout' }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(503)
    expect(((await res.json()) as { codice?: string }).codice).toBe('RIAPERTURA_SEDE_NON_VERIFICATA')
    expect(h.rpcCalls.filter((c) => c.name === 'annulla_transazione_contabile')).toEqual([])
    nessunaScrittura()
  })

  it('`RIAPERTURA_NON_RIUSCITA` non promette più «nulla è cambiato»', () => {
    // Su un timeout di rete la RPC può aver GIÀ committato: lo storno c'è e la
    // route risponde 500 con questo codice. Promettere che nulla sia cambiato è
    // falso, e manda a cercare un denaro che è già tornato indietro. Ora la frase
    // dice l'unica cosa vera e utile: ritenta, il secondo giro non raddoppia.
    const testo = messaggioDaCorpo({ error: 'x', codice: 'RIAPERTURA_NON_RIUSCITA' }, 'ripiego')

    expect(testo).not.toContain('nulla è cambiato')
    expect(testo.toLowerCase()).toContain('riprova')
  })
})

// ─── LA MARCA «ABBINATO DALLA MACCHINA», E IL DB CHE NON CE L'HA ────────────
//
// `abbinato_auto_il` (migrazione `20260920124742`) è l'unico appiglio
// dell'annullamento in blocco: «disfa tutto ciò che l'import ha deciso da solo».
// La riapertura deve SPEGNERLA insieme agli altri legami morti, o la marca mente.
//
// Ma il database E2E della CI è un progetto separato e NON è migrato: lì quella
// colonna non esiste. La degradazione qui non è un dettaglio di stile — è la
// differenza fra una riapertura che riesce e una che fallisce DOPO lo storno,
// lasciando una riga `confermato` sopra un incasso che non esiste più. Cioè
// esattamente la riga che mente da cui è nata tutta questa fetta.
describe('PATCH riapri — la marca dell’abbinamento automatico', () => {
  it('la colonna c’è: la riapertura la SPEGNE, dentro lo stesso UPDATE del CAS', async () => {
    expect((await patch({ azione: 'riapri' })).status).toBe(200)

    const upd = updateDi('riconciliazione_movimenti')
    expect(upd).toHaveLength(1)
    expect(Object.keys(upd[0].row)).toContain('abbinato_auto_il')
    expect(upd[0].row.abbinato_auto_il).toBeNull()
    // Dentro la STESSA scrittura del CAS, non in un UPDATE dopo: una marca
    // spenta fuori dal compare-and-swap è una marca che una corsa persa lascia
    // accesa su una riga che nessuno ha riaperto.
    expect(upd[0].filtri.stato).toBe('confermato')
  })

  it('⛔ colonna ASSENTE (42703): la chiave NON si scrive, e la riapertura riesce lo stesso', async () => {
    h.marcaError = { code: '42703', message: 'column riconciliazione_movimenti.abbinato_auto_il does not exist' }

    const res = await patch({ azione: 'riapri' })

    expect(res.status, 'il DB non migrato non deve far fallire una riapertura').toBe(200)
    const upd = updateDi('riconciliazione_movimenti')
    expect(upd).toHaveLength(1)
    expect(
      Object.keys(upd[0].row),
      'la chiave viaggia lo stesso su un DB che non ha la colonna: PostgREST risponde PGRST204 ' +
        'e l’UPDATE fallisce DOPO lo storno — una riga confermata sopra un incasso che non c’è più.',
    ).not.toContain('abbinato_auto_il')
    // E lo storno è avvenuto davvero: la degradazione non deve trasformarsi in
    // un ramo che non fa niente e risponde 200.
    expect(h.inserts.find((i) => i.table === 'incassi'), 'nessuno storno').toBeTruthy()
    expect(upd[0].row.stato).toBe('da_abbinare')
    // 🔴 E `transazione_id` SI AZZERA LO STESSO: qui manca solo la colonna più
    // recente. È la finestra fra il merge della migrazione e il deploy del
    // codice, ed è l'asserzione che distingue una catena che scala di UNA
    // colonna alla volta da una che al primo `42703` le abbandona tutt'e due —
    // la seconda lascerebbe sulla riga riaperta un puntatore a una transazione
    // annullata, cioè un legame morto in meno di quelli che si azzerano oggi.
    expect(Object.keys(upd[0].row)).toContain('transazione_id')
    expect(upd[0].row.transazione_id).toBeNull()
    // Due letture sole, non tre: la seconda variante risponde.
    expect(letteDa('riconciliazione_movimenti')).toHaveLength(2)
  })

  it('⛔ colonna ASSENTE: lo dice un `warn`, e il log del successo lo riporta', async () => {
    h.marcaError = { code: '42703', message: 'column ... does not exist' }

    expect((await patch({ azione: 'riapri' })).status).toBe(200)

    const spento = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'movimento-letto-in-degradazione',
    )
    expect(
      spento,
      'un ramo di degradazione che nessuno vede è la prima metà di ogni guasto lungo di questo repo',
    ).toBeTruthy()
    expect(spento![1]).toBe('warn')
    expect((spento![2] as { tipo?: string }).tipo).toBe('colonna-marca-assente')
    expect((spento![2] as { error_code?: string }).error_code).toBe('42703')

    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'movimento-riaperto',
    )
    expect((riga![2] as { marca_disponibile?: boolean }).marca_disponibile).toBe(false)
  })

  it('⛔ `PGRST204` conta come colonna assente quanto `42703`', async () => {
    // Sono due codici per lo stesso fatto: `42703` lo dà una SELECT, `PGRST204`
    // una scrittura. Guardarne uno solo lascerebbe cadere l’altro ramo invece
    // di spegnerlo.
    h.marcaError = { code: 'PGRST204', message: 'column not found in schema cache' }

    expect((await patch({ azione: 'riapri' })).status).toBe(200)
    expect(Object.keys(updateDi('riconciliazione_movimenti')[0].row)).not.toContain('abbinato_auto_il')
  })

  it('🔴 la lettura fallisce per un ALTRO motivo: 500 PRIMA dello storno, non «si procede senza marca»', async () => {
    // ⚠️ QUESTO TEST DICEVA L'OPPOSTO FINO AL 2026-09-20, e cementava un difetto.
    // Pretendeva 200 e «la chiave non si scrive»: cioè su un guasto transitorio
    // (deadlock, timeout, 5xx di PostgREST, pool esaurito) la riapertura andava
    // avanti — STORNO COMPRESO — e la riga tornava in coda `da_abbinare` ANCORA
    // marcata «automatica». Poi un'operatrice la riconferma a mano da
    // `confermaSuVoceSingola`, che con `automatico = false` non scrive mai
    // `abbinato_auto_il: null`: la marca sopravvive, e l'annullamento in blocco
    // disfa il lavoro di una persona. È esattamente lo scenario che la testata
    // della migrazione `20260920124742` descrive come da evitare.
    //
    // Il fail-closed è il verso giusto per «l'automatismo deve PARTIRE?» — là
    // «non lo so» trattato come «no» lascia il lavoro a una persona, che è
    // l'errore recuperabile. Qui la domanda è opposta — «posso SPEGNERE la
    // marca?» — e «non lo so» trattato come «no» lascia accesa la marca che
    // mente. Perciò un codice che non sia `42703`/`PGRST204` non degrada: rifiuta
    // in lettura, prima di toccare un centesimo.
    h.marcaError = { code: '40001', message: 'deadlock detected' }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(500)
    expect(((await res.json()) as { codice?: string }).codice).toBe('MOVIMENTO_NON_LETTO')
    expect(
      h.logErrore.mock.calls.find((c) => (c[0] as { evento?: string })?.evento === 'movimento_non_letto'),
      'un rifiuto in lettura senza una riga di log che lo dica',
    ).toBeTruthy()
    // E NIENTE si è mosso: né lo storno, né la riapertura. È la differenza fra
    // un rifiuto e un guasto a metà.
    nessunaScrittura()
  })

  it('il ramo COMPOSITO non scrive la marca a mano: la spegne la RPC dentro la sua transazione', async () => {
    // Quando ad annullare è `annulla_transazione_contabile` la riapertura la fa
    // lei, atomica (migrazione `20260920124743`): la route non deve aggiungere
    // un UPDATE suo, o la marca si spegnerebbe fuori dalla transazione — e un
    // rollback la resusciterebbe su una riga già riaperta.
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    h.rpcEsito.annulla_transazione_contabile = { data: { incassi_stornati: 1, movimenti_riaperti: 1 }, error: null }

    expect((await patch({ azione: 'riapri' })).status).toBe(200)
    expect(updateDi('riconciliazione_movimenti'), 'un UPDATE a mano dopo la RPC').toEqual([])
  })
})

describe('PATCH riapri — ciò che NON cambia', () => {
  it('su un movimento IGNORATO resta la riapertura di sempre: nessuno storno, nessuna fattura letta', async () => {
    h.movimento = { ...h.movimento!, stato: 'ignorato' }

    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(200)
    expect(letteDa('fatture_emesse'), 'una query in più su ogni riapertura banale').toEqual([])
    expect(h.inserts, 'uno storno su un movimento che non aveva incassato niente').toEqual([])
    expect(updateDi('riconciliazione_movimenti')).toHaveLength(1)
    expect(updateDi('riconciliazione_movimenti')[0].row.stato).toBe('da_abbinare')
  })

  it('`ignora` su un CONFERMATO resta un 409: si riapre, non si scarta', async () => {
    const res = await patch({ azione: 'ignora' })
    expect(res.status).toBe(409)
    nessunaScrittura()
  })
})
