import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * FASE 11 («errori non ignorati») — le route di `src/app/api/admin/**`.
 *
 * PostgREST non lancia: restituisce `{ data: null, error }`. In queste route il `null` di un
 * guasto diventava un valore: un 404 «non trovato», un elenco vuoto, una configurazione vuota
 * su cui poi si FONDEVA il salvataggio, un ordine «creato» senza il suo addebito collegato, un
 * wipe «completed» con righe rimaste. Ogni caso qui sotto rompe UNA sola coppia
 * `tabella:operazione` del finto client e guarda che il guasto si FERMI (500 con codice, o la
 * riga di log del passo accessorio), invece di diventare quel valore.
 *
 * Il finto è uno solo, e non è piatto: risponde per tabella e per operazione, quindi un caso
 * che rompe `divise_ordini:update` lascia funzionare `divise_ordini:insert` — è così che si
 * vede che la route arriva DAVVERO al passo rotto.
 */

type Guasto = { code?: string; message: string }

const h = vi.hoisted(() => ({
  guasti: {} as Record<string, Guasto>,
  dati: {} as Record<string, unknown>,
  rpc: {} as Record<string, { data?: unknown; error?: unknown }>,
  scritture: [] as Array<{ table: string; op: string; row?: unknown }>,
  requireStaff: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  sidiTransmit: vi.fn(),
  registraProtocollo: vi.fn(),
  scaricaDaBucket: vi.fn(),
  registraAccessoVigilanza: vi.fn(),
}))

function finto() {
  return {
    from(table: string) {
      let op = 'select'
      const b: Record<string, unknown> = {}
      const risultato = (singolo: boolean) => {
        const err = h.guasti[`${table}:${op}`]
        if (err) return { data: null, error: err, count: null }
        if (op !== 'select') return { data: singolo ? { id: `${table}-nuovo` } : [], error: null, count: null }
        const d = h.dati[table]
        if (singolo) return { data: (Array.isArray(d) ? d[0] : d) ?? null, error: null }
        const righe = Array.isArray(d) ? d : d ? [d] : []
        return { data: righe, error: null, count: righe.length }
      }
      for (const m of ['eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'ilike', 'gte', 'lte']) b[m] = () => b
      b.select = () => b
      for (const w of ['insert', 'update', 'upsert', 'delete']) {
        b[w] = (row?: unknown) => {
          op = w
          h.scritture.push({ table, op: w, row })
          return b
        }
      }
      b.maybeSingle = async () => risultato(true)
      b.single = async () => risultato(true)
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risultato(false)).then(ok, ko)
      return b
    },
    rpc: async (nome: string) => ({ data: null, error: null, ...(h.rpc[nome] ?? {}) }),
    storage: { from: () => ({ remove: async () => ({ data: [], error: null }) }) },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => finto() }))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireDocente: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({
  scuoleDiUtente: vi.fn(async () => ['sc-1']),
  resolveScuoleAttive: vi.fn(async () => ['sc-1']),
  resolveScuolaScrittura: vi.fn(async () => ({ scuolaId: 'sc-1' })),
  assertAlunnoInScope: vi.fn(async () => null),
  assertSezioneInScope: vi.fn(async () => null),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => {}) }))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
  logEvento: h.logEvento,
}))
vi.mock('@/lib/merch/stati', async (originale) => ({
  ...(await originale<typeof import('@/lib/merch/stati')>()),
  sincronizzaTestata: vi.fn(async () => {}),
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({ alunnoSospeso: vi.fn(async () => false) }))
vi.mock('@/lib/security/seal', () => ({ sealDangerous: vi.fn(async () => null) }))
vi.mock('@/lib/security/require-env', () => ({ requireEnv: vi.fn(() => null) }))
vi.mock('@/lib/sidi/client', () => ({ sidiTransmit: h.sidiTransmit }))
vi.mock('@/lib/sidi/sync-store', () => ({ persistFaseStato: vi.fn(async () => {}) }))
vi.mock('@/lib/chat/vigilanza-audit', () => ({ registraAccessoVigilanza: h.registraAccessoVigilanza }))
vi.mock('@/lib/chat/allegati', () => ({ firmaAllegatiChat: vi.fn(async (_s: unknown, righe: unknown) => righe) }))
vi.mock('@/lib/protocolli/store', () => ({
  registraProtocollo: h.registraProtocollo,
  slugNomeFile: (s: string) => s,
}))
vi.mock('@/lib/protocolli/server', () => ({
  denominazioneScuola: vi.fn(async () => 'Sede'),
  firmaDownload: vi.fn(async () => 'https://x'),
  pareUnPdf: () => true,
  rispostaErroreProtocollo: () => new Response(JSON.stringify({ error: 'x' }), { status: 500 }),
  scaricaDaBucket: h.scaricaDaBucket,
}))
vi.mock('@/lib/alunni/registro-primaria', () => ({
  alunniConRegistroPrimaria: vi.fn(async () => ({ ok: true, conRegistro: new Set() })),
}))

import { POST as cambioTaglia } from '@/app/api/admin/merch/cambio-taglia/route'
import { POST as creaOrdine } from '@/app/api/admin/merch/ordini/route'
import { PATCH as salvaAruba } from '@/app/api/admin/settings/aruba/route'
import { POST as faseA } from '@/app/api/admin/sidi/fase-a/route'
import { POST as wipe } from '@/app/api/admin/wipe/route'
import { GET as messaggiChat } from '@/app/api/admin/chat/messages/route'
import { POST as daDocumento } from '@/app/api/admin/protocolli/da-documento/route'
import { GET as schedaAlunno } from '@/app/api/admin/students/[id]/route'
import { GET as candidatiOblio } from '@/app/api/admin/gdpr/candidates/route'
import { GET as elenchiClassi } from '@/app/api/admin/iscrizioni/elenco/route'

const RIGA = '11111111-1111-4111-8111-111111111111'
const ART = '22222222-2222-4222-8222-222222222222'
const ALUNNO = '33333333-3333-4333-8333-333333333333'
const THREAD = '44444444-4444-4444-8444-444444444444'
const CERT = '55555555-5555-4555-8555-555555555555'
const GUASTO: Guasto = { code: 'XX000', message: 'guasto finto' }

const json = (url: string, metodo: string, corpo?: unknown) =>
  new Request(url, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  })

/** Il log del guasto c'è, e dice quale tabella. */
const loggato = (evento: string) =>
  h.logErrore.mock.calls.some((c) => (c[0] as { evento?: string })?.evento === evento)

beforeEach(() => {
  vi.clearAllMocks()
  h.guasti = {}
  h.dati = {}
  h.rpc = {}
  h.scritture = []
  h.requireStaff.mockResolvedValue({ user: { id: 'op-1', role: 'admin', scuola_id: 'sc-1' } })
  h.sidiTransmit.mockResolvedValue({ ok: true })
  h.registraAccessoVigilanza.mockResolvedValue({ tracciato: true })
  h.scaricaDaBucket.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]))
})

describe('merch — una scrittura principale fallita è 500, e la creazione a metà si disfa', () => {
  it('cambio taglia: l’annullo della riga vecchia fallisce → 500 SCRITTURA_FALLITA e la riga nuova si TOGLIE', async () => {
    h.dati.divise_ordini_righe = { id: RIGA, stato: 'ordinato', articolo_id: ART, articolo_nome: 'Polo', taglia: 'M', quantita: 1, ordine_id: 'o1', ordine: { scuola_id: 'sc-1' } }
    h.dati.divise_articoli = { taglie: ['S', 'M', 'L'] }
    h.guasti['divise_ordini_righe:update'] = GUASTO
    const res = await cambioTaglia(json('http://localhost/api/admin/merch/cambio-taglia', 'POST', { riga_id: RIGA, nuova_taglia: 'L' }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('SCRITTURA_FALLITA')
    // Prima: 201 con due righe attive (un capo ordinato due volte).
    expect(h.scritture.some((s) => s.table === 'divise_ordini_righe' && s.op === 'delete')).toBe(true)
  })

  it('cambio taglia: il catalogo non letto → 500, nessuna riga creata (la taglia non era validata)', async () => {
    h.dati.divise_ordini_righe = { id: RIGA, stato: 'ordinato', articolo_id: ART, articolo_nome: 'Polo', taglia: 'M', quantita: 1, ordine_id: 'o1', ordine: { scuola_id: 'sc-1' } }
    h.guasti['divise_articoli:select'] = GUASTO
    const res = await cambioTaglia(json('http://localhost/api/admin/merch/cambio-taglia', 'POST', { riga_id: RIGA, nuova_taglia: 'XXL' }))
    expect(res.status).toBe(500)
    expect(h.scritture.filter((s) => s.op === 'insert')).toEqual([])
    expect(loggato('db:divise_articoli')).toBe(true)
  })

  const preparaOrdine = () => {
    h.dati.alunni = { scuola_id: 'sc-1' }
    h.dati.divise_articoli = [{ id: ART, nome: 'Polo', prezzo: 10, taglie: [], attivo: true, scuola_id: 'sc-1' }]
    h.dati.payment_categories = []
  }
  const corpoOrdine = { alunno_id: ALUNNO, righe: [{ articolo_id: ART, taglia: '', quantita: 1 }] }

  it('ordine: il collegamento ordine→addebito fallisce → 500, e addebito, righe e ordine si disfano', async () => {
    preparaOrdine()
    h.guasti['divise_ordini:update'] = GUASTO
    const res = await creaOrdine(json('http://localhost/api/admin/merch/ordini', 'POST', corpoOrdine))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('SCRITTURA_FALLITA')
    const cancellate = h.scritture.filter((s) => s.op === 'delete').map((s) => s.table)
    expect(cancellate).toEqual(['pagamenti', 'divise_ordini_righe', 'divise_ordini'])
  })

  it('ordine: la categoria dell’addebito non letta → 500 PRIMA di scrivere qualunque cosa', async () => {
    preparaOrdine()
    h.guasti['payment_categories:select'] = GUASTO
    const res = await creaOrdine(json('http://localhost/api/admin/merch/ordini', 'POST', corpoOrdine))
    expect(res.status).toBe(500)
    expect(h.scritture).toEqual([])
    expect(loggato('db:payment_categories')).toBe(true)
  })

  it('ordine: gli articoli non letti → 500, non «articolo non disponibile» (400)', async () => {
    preparaOrdine()
    h.guasti['divise_articoli:select'] = GUASTO
    const res = await creaOrdine(json('http://localhost/api/admin/merch/ordini', 'POST', corpoOrdine))
    expect(res.status).toBe(500)
  })
})

describe('impostazioni — il salvataggio è un merge: non si fonde su una lettura fallita', () => {
  it('Aruba: la configurazione attuale non letta → 500 e NESSUN upsert (non si cancellano utente e dati fiscali)', async () => {
    h.guasti['admin_settings:select'] = GUASTO
    const res = await salvaAruba(json('http://localhost/api/admin/settings/aruba', 'PATCH', { abilitato: true }) as never)
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(h.scritture.filter((s) => s.op === 'upsert')).toEqual([])
  })
})

describe('SIDI — un flusso verso il Ministero non parte con un pezzo letto vuoto', () => {
  it('fase A: le sezioni non lette → 500, e niente trasmissione', async () => {
    h.dati.schools = { id: 'sc-1', nome: 'Sede' }
    h.guasti['sections:select'] = GUASTO
    const res = await faseA(json('http://localhost/api/admin/sidi/fase-a', 'POST') as never)
    expect(res.status).toBe(500)
    expect(h.sidiTransmit).not.toHaveBeenCalled()
    expect(loggato('db:sections')).toBe(true)
  })
})

describe('manutenzione — anche qui un risultato non si butta', () => {
  it('wipe: una tabella che non si svuota → 500 con il suo NOME, non «Wipe completed»', async () => {
    h.guasti['pagamenti:delete'] = { code: '23503', message: 'violazione di chiave esterna' }
    const res = await wipe(json('http://localhost/api/admin/wipe', 'POST'))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('SCRITTURA_FALLITA')
    expect(corpo.tabelle).toEqual(['pagamenti'])
  })

  it('wipe: una tabella ASSENTE (elenco storico) resta «saltata» a livello info, e il wipe riesce', async () => {
    h.guasti['locker_requests:delete'] = { code: '42P01', message: 'relation does not exist' }
    const res = await wipe(json('http://localhost/api/admin/wipe', 'POST'))
    expect(res.status).toBe(200)
    expect(h.logEvento.mock.calls.some((c) => c[0] === 'db' && c[1] === 'info' && (c[2] as { esito?: string }).esito === 'tabella-saltata')).toBe(true)
  })
})

describe('letture che decidono — un guasto non è «non trovato» né «nessuno»', () => {
  it('chat (vigilanza): il thread non letto → 500, non 404 «conversazione non trovata»', async () => {
    h.guasti['chat_threads:select'] = GUASTO
    const res = await messaggiChat(json(`http://localhost/api/admin/chat/messages?thread_id=${THREAD}`, 'GET') as never)
    expect(res.status).toBe(500)
    expect(h.registraAccessoVigilanza).not.toHaveBeenCalled()
  })

  it('protocollo da documento: il nome dell’alunno non letto → 500, e NON si registra un protocollo «alunno/a»', async () => {
    h.dati.certificati_competenze = { scuola_id: 'sc-1', alunno_id: ALUNNO, stato: 'generato', file_url: 'p.pdf' }
    h.guasti['alunni:select'] = GUASTO
    const res = await daDocumento(json('http://localhost/api/admin/protocolli/da-documento', 'POST', { sorgente: 'certificato_competenze', id: CERT }) as never)
    expect(res.status).toBe(500)
    expect(h.registraProtocollo).not.toHaveBeenCalled()
  })

  it('scheda alunno: i fratelli non letti → 500, non una scheda senza fratelli (la tendina «la paga il fratello»)', async () => {
    h.dati.alunni = { id: ALUNNO, scuola_id: 'sc-1', student_parents: [{ parents: { id: 'p1' } }] }
    h.guasti['student_parents:select'] = GUASTO
    const res = await schedaAlunno(json(`http://localhost/api/admin/students/${ALUNNO}`, 'GET') as never, { params: Promise.resolve({ id: ALUNNO }) })
    expect(res.status).toBe(500)
  })

  it('oblio: i genitori del candidato non letti → 500 col codice che il pannello sa dire', async () => {
    h.dati.alunni = [{ id: ALUNNO, nome: 'A', cognome: 'B', classe_sezione: null, stato: 'ritirato', scuola_id: 'sc-1' }]
    h.guasti['student_parents:select'] = GUASTO
    const res = await candidatiOblio(json('http://localhost/api/admin/gdpr/candidates', 'GET') as never)
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('GDPR_CANDIDATI_NON_LETTI')
  })
})

describe('letture accessorie — la risposta esce col ripiego, e la riga lo dice', () => {
  it('elenchi delle classi: il conteggio per classe non letto → 200 con perClasse vuoto, e una riga `error`', async () => {
    h.dati.iscrizioni_elenco_caricamenti = [{ id: 'c1', scuola_id: 'sc-1', nome_file: 'x.xlsx', righe_totali: 3, anomalie: [], caricato_il: '2026-10-19T08:00:00Z' }]
    h.guasti['iscrizioni_elenco_righe:select'] = GUASTO
    const res = await elenchiClassi(json('http://localhost/api/admin/iscrizioni/elenco', 'GET') as never)
    expect(res.status).toBe(200)
    expect((await res.json()).elenchi[0].perClasse).toEqual([])
    expect(
      h.logEvento.mock.calls.some(
        (c) => c[0] === 'iscrizione' && c[1] === 'error' && (c[2] as { esito?: string }).esito === 'conteggio-per-classe-non-letto',
      ),
    ).toBe(true)
  })
})
