import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * LA MARCA «QUESTO ABBINAMENTO L'HA DECISO LA MACCHINA» — la sonda, e le due
 * porte che la scrivono.
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────
 *
 * `riconciliazione_movimenti.abbinato_auto_il` non è un'etichetta decorativa: è
 * l'UNICO appiglio dell'annullamento in blocco — «disfa tutto ciò che l'import
 * ha deciso da solo». Da qui discendono due cose che non si possono collaudare
 * guardando una schermata:
 *
 *  1. **la degradazione non è «si procede senza marca»**, ed è la decisione più
 *     importante di questa fetta. Il DB E2E della CI non è migrato: là la
 *     colonna non c'è. La regola di casa, per una colonna nuova, sarebbe «si
 *     ritenta senza e si va avanti» — qui no. Senza la marca non esiste
 *     l'annullamento in blocco, e **un automatismo che non si può disfare non è
 *     quello che è stato chiesto**: l'abbinamento automatico si spegne per
 *     intero. Ciò che resta acceso è tutto il percorso MANUALE, che questa
 *     colonna non la scrive e non la legge;
 *  2. **la marca si scrive DENTRO il compare-and-swap**, mai dopo. Un secondo
 *     UPDATE non sarebbe atomico, e l'esito parziale ha un nome preciso: una
 *     riga confermata dalla macchina e NON marcata, cioè una riga che
 *     l'annullamento in blocco non troverà mai più.
 *
 * Nessuno dei due si vede da un test di rotta: oggi nessuna rotta passa
 * `automatico: true` — l'import che lo farà arriva in un'altra fetta — quindi il
 * parametro nasce con un collaudo suo o non ne ha nessuno.
 *
 * Dati SINTETICI: uuid e numeri, nessun nome di famiglie vere (il repo è pubblico).
 */

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
  pagantiAmmessi: vi.fn(),
}))

vi.mock('@/lib/logging/logger', () => ({
  logOk: h.logOk,
  logErrore: h.logErrore,
  logEvento: h.logEvento,
}))
// Il ponte genitore↔alunno ha un motore suo, con i suoi test: qui interessa solo
// che non rifiuti, altrimenti la composizione non arriverebbe mai alla RPC.
vi.mock('@/lib/pagamenti/pagante-ammesso', () => ({
  pagantiAmmessiPerAlunni: h.pagantiAmmessi,
}))

import { marcaAutomaticaDisponibile, MARCA_ASSENTE, COLONNA_MARCA_AUTO } from '@/lib/pagamenti/marca-automatica'
import { confermaSuVoceSingola } from '@/lib/pagamenti/riconciliazione-conferma'
import { registraConciliazione } from '@/lib/pagamenti/conciliazione-registra'

const MID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const ALUNNO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const PARENT = 'ffffffff-ffff-4fff-8fff-fffffffffff5'
const SEDE = 'sc-1'
const ATTORE = '11111111-1111-4111-8111-111111111111'

// ─── IL FINTO: una forma sola per tutte le tabelle, pilotata per NOME ────────
type Errore = { code?: string; message?: string } | null

interface Stato {
  /** Errore della sonda `select('abbinato_auto_il')`. */
  marcaError: Errore
  movimento: Record<string, unknown> | null
  pagamento: Record<string, unknown> | null
  pagamenti: Record<string, unknown>[]
  updateRows: Record<string, unknown>[]
  updates: { table: string; row: Record<string, unknown> }[]
  rpc: { name: string; args: Record<string, unknown> }[]
  rpcEsito: Record<string, { data: unknown; error: Errore }>
}

let s: Stato

function finto(): SupabaseClient {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = (cols?: string) => { b._cols = cols ?? ''; return b }
      b.eq = () => b
      b.in = () => b
      b.limit = () => b
      b.maybeSingle = async () => {
        if (table === 'riconciliazione_movimenti') return { data: s.movimento, error: null }
        if (table === 'pagamenti') return { data: s.pagamento, error: null }
        return { data: null, error: null }
      }
      b.insert = () => ({
        select: () => ({ single: async () => ({ data: { id: 'incasso-nuovo' }, error: null }) }),
      })
      b.update = (row: Record<string, unknown>) => {
        const u: Record<string, unknown> = {}
        u.eq = () => u
        u.select = () => ({
          then: (r: (v: unknown) => unknown) => {
            s.updates.push({ table, row })
            return r({ data: s.updateRows, error: null })
          },
        })
        return u
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        const cols = typeof b._cols === 'string' ? b._cols : ''
        if (table === 'riconciliazione_movimenti' && cols.includes(COLONNA_MARCA_AUTO)) {
          return resolve(s.marcaError ? { data: null, error: s.marcaError } : { data: [], error: null })
        }
        if (table === 'pagamenti') return resolve({ data: s.pagamenti, error: null })
        if (table === 'schools') return resolve({ data: [{ id: SEDE, nome: 'Kidville Prova' }], error: null })
        return resolve({ data: [], error: null })
      }
      return b
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      s.rpc.push({ name, args })
      return s.rpcEsito[name] ?? { data: null, error: null }
    },
  } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.clearAllMocks()
  s = {
    marcaError: null,
    movimento: {
      id: MID, importo: 100, stato: 'da_abbinare', data_operazione: '2026-09-10',
      scuola_id: null, pagamento_id: null, transazione_id: null,
    },
    pagamento: {
      id: PID, scuola_id: SEDE, stato: 'da_pagare', alunno_id: ALUNNO,
      descrizione: 'Retta', importo: 100, importo_pagato: 0, sconto: 0, scadenza: '2026-09-30',
    },
    pagamenti: [{
      id: PID, alunno_id: ALUNNO, scuola_id: SEDE, importo: 100, importo_pagato: 0, sconto: 0,
      stato: 'da_pagare', tipo: 'singolo', scadenza: '2026-09-30', descrizione: 'Retta',
      payment_categories: { slug: 'retta' },
    }],
    updateRows: [{ id: MID }],
    updates: [],
    rpc: [],
    rpcEsito: {
      registra_transazione_contabile: {
        data: { transazione_id: 'tx-1', incassi: 1, movimento_id: MID },
        error: null,
      },
    },
  }
  h.pagantiAmmessi.mockResolvedValue({ completo: true, parentIds: new Set([PARENT]) })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('marcaAutomaticaDisponibile — la domanda che decide se l’automatismo parte', () => {
  it('la colonna c’è: risponde `true`, e non sporca i log', async () => {
    await expect(marcaAutomaticaDisponibile(finto(), 'prova')).resolves.toBe(true)
    // Nessuna riga a ogni giro: il successo lo racconta chi chiama, dentro il
    // proprio log di esito, altrimenti una sonda di schema diventerebbe rumore.
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('⛔ `42703` (SELECT su un DB non migrato): `false`, con un `warn` che lo dice', async () => {
    s.marcaError = { code: '42703', message: 'column ... does not exist' }

    await expect(marcaAutomaticaDisponibile(finto(), 'prova')).resolves.toBe(false)

    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'abbinamento-automatico-spento',
    )
    expect(riga, 'un automatismo spento che nessuno vede').toBeTruthy()
    expect(riga![1], 'su un ambiente non migrato è lo stato ATTESO: `warn`, non `error`').toBe('warn')
    expect((riga![2] as { error_code?: string }).error_code).toBe('42703')
  })

  it('⛔ `PGRST204` conta quanto `42703`: sono due codici per lo stesso fatto', async () => {
    s.marcaError = { code: 'PGRST204', message: 'column not found in schema cache' }
    await expect(marcaAutomaticaDisponibile(finto(), 'prova')).resolves.toBe(false)
    expect(MARCA_ASSENTE.has('PGRST204') && MARCA_ASSENTE.has('42703')).toBe(true)
  })

  it('⛔ un guasto QUALUNQUE è fail-CLOSED, e il livello è `error`', async () => {
    // «Non lo so» non è «sì»: partire lo stesso vorrebbe dire scommettere che la
    // marca si scriverà, e se non si scrive la riga è già confermata e non la
    // ritrova più nessuno.
    s.marcaError = { code: '40001', message: 'deadlock detected' }

    await expect(marcaAutomaticaDisponibile(finto(), 'prova')).resolves.toBe(false)

    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'marca-automatica-non-verificabile',
    )
    expect(riga).toBeTruthy()
    expect(riga![1]).toBe('error')
  })

  it('la sonda LEGGE davvero quella colonna (senza, risponderebbe `true` sul nulla)', async () => {
    // Un finto che ignorasse le colonne chieste risponderebbe sempre `true`, e
    // questo file misurerebbe il finto invece del codice.
    s.marcaError = { code: '42703', message: 'column ... does not exist' }
    await expect(marcaAutomaticaDisponibile(finto(), 'prova')).resolves.toBe(false)
    expect(COLONNA_MARCA_AUTO).toBe('abbinato_auto_il')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('confermaSuVoceSingola — `automatico` scrive la marca DENTRO il CAS', () => {
  const args = {
    movimento: {
      id: MID, importo: 100, data_operazione: '2026-09-10', causale: 'BONIFICO',
      stato: 'da_abbinare', pagamento_id: null,
    },
    pagamentoId: PID,
    sediAmmesse: [SEDE],
    attoreId: ATTORE,
    operazione: 'prova',
  }

  it('`automatico: true` → `abbinato_auto_il` nella stessa `update` del compare-and-swap', async () => {
    const esito = await confermaSuVoceSingola(finto(), { ...args, automatico: true })

    expect(esito.status).toBe(200)
    const upd = s.updates.filter((u) => u.table === 'riconciliazione_movimenti')
    expect(upd, 'la marca in un UPDATE a parte non sarebbe atomica con la conferma').toHaveLength(1)
    expect(upd[0].row.stato).toBe('confermato')
    expect(typeof upd[0].row.abbinato_auto_il).toBe('string')
    expect(
      Date.parse(upd[0].row.abbinato_auto_il as string),
      '`abbinato_auto_il` non è una data leggibile: la colonna è `timestamptz`, e dice ' +
        'insieme SE e QUANDO — un valore non parsabile la riduce a un booleano rotto.',
    ).not.toBeNaN()
  })

  it('🔴 senza `automatico` la chiave NON viaggia affatto (il DB non migrato non deve cadere)', async () => {
    const esito = await confermaSuVoceSingola(finto(), args)

    expect(esito.status).toBe(200)
    const upd = s.updates.filter((u) => u.table === 'riconciliazione_movimenti')
    expect(
      Object.keys(upd[0].row),
      'la conferma MANUALE manda `abbinato_auto_il` a un database che potrebbe non averla: ' +
        'PostgREST risponde `PGRST204` e l’intero UPDATE fallisce, con l’incasso già inserito. ' +
        'Il default è «comportamento di oggi», e comportamento di oggi vuol dire colonna non toccata.',
    ).not.toContain('abbinato_auto_il')
  })

  it('`automatico: false` è identico all’assenza: nessuna chiave, nessuna marca', async () => {
    await confermaSuVoceSingola(finto(), { ...args, automatico: false })
    const upd = s.updates.filter((u) => u.table === 'riconciliazione_movimenti')
    expect(Object.keys(upd[0].row)).not.toContain('abbinato_auto_il')
  })

  it('la firma di chi ha premuto «Importa» resta anche sull’automatico', async () => {
    // `confermato_da` finisce in `incassi.registrato_da`, cioè in un registro
    // contabile: azzerarlo per distinguere la macchina lascerebbe un registro
    // anonimo — e sarebbe falso, perché qualcuno l’import l’ha avviato.
    await confermaSuVoceSingola(finto(), { ...args, automatico: true })
    const upd = s.updates.filter((u) => u.table === 'riconciliazione_movimenti')
    expect(upd[0].row.confermato_da).toBe(ATTORE)
    expect(upd[0].row.stato, 'nessun quinto stato: `confermato` vale per tutt’e due').toBe('confermato')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('registraConciliazione — la marca la scrive la RPC, dentro la sua transazione', () => {
  const composizione = {
    scuola_id: SEDE,
    pagante_parent_id: PARENT,
    voci: [{ pagamento_id: PID, importo: 100 }],
    voci_nuove: [],
    voci_ticket: [],
  }
  const args = {
    movimentoId: MID,
    composizione,
    sediAmmesse: [SEDE],
    attoreId: ATTORE,
    operazione: 'prova',
  }

  const payload = () =>
    (s.rpc.find((c) => c.name === 'registra_transazione_contabile')!.args as { p: Record<string, unknown> }).p

  it('`automatico: true` → `abbinato_auto: true` nel payload, e NESSUN update a mano', async () => {
    const esito = await registraConciliazione(finto(), { ...args, automatico: true })

    expect(esito.status).toBe(200)
    expect(payload().abbinato_auto).toBe(true)
    // ⚠️ E LA FIRMA RESTA. Questa riga non è di contorno: aggiungendo la chiave
    // nuova, `registrato_da: attoreId` è stato cancellato per sbaglio dal
    // payload, e con lui sarebbero rimasti senza firma `pagamenti_transazioni`
    // e ogni `incassi` della composizione — due registri contabili anonimi,
    // con un 200 sopra. L'ha preso `eslint` («assigned a value but never used»),
    // non un test di questo file.
    expect(payload().registrato_da).toBe(ATTORE)
    expect(
      s.updates.filter((u) => u.table === 'riconciliazione_movimenti'),
      'un UPDATE dopo la RPC non sarebbe atomico: una riga confermata dalla macchina e non ' +
        'marcata è una riga che l’annullamento in blocco non troverà mai più.',
    ).toEqual([])
  })

  it('senza `automatico` la chiave c’è ed è `false`: la ricomposizione a mano SPEGNE la marca', async () => {
    // Chiave assente e `false` sono la stessa cosa per la RPC
    // (`COALESCE(…, false)`), che in entrambi i casi scrive `NULL`. Si manda
    // esplicita per la stessa ragione di `ricariche_mensa: []`: nei log «campo
    // assente» e «non è automatica» devono leggersi diversi.
    const esito = await registraConciliazione(finto(), args)

    expect(esito.status).toBe(200)
    expect(payload().abbinato_auto).toBe(false)
  })

  it('il log del SUCCESSO dice chi ha deciso, e non porta niente di personale', async () => {
    await registraConciliazione(finto(), { ...args, automatico: true })

    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'conciliazione_composita_registrata',
    )
    expect(riga, 'l’evento critico non logga il successo').toBeTruthy()
    expect(riga![1]).toBe('info')
    const campi = riga![2] as Record<string, unknown>
    expect(campi.automatico).toBe(true)
    // Booleani, numeri e uuid soltanto: nessuna causale, nessuna descrizione,
    // nessun nome — la causale di un bonifico porta i nomi delle famiglie.
    for (const [k, v] of Object.entries(campi)) {
      expect(
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null,
        `il campo \`${k}\` del log porta un oggetto: gli oggetti collassano in \`[redatto]\` e ` +
          'intanto qualcuno ci ha infilato dentro del testo libero.',
      ).toBe(true)
    }
  })
})
