import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── P7/B1 — Compiti/argomenti assegnabili a TUTTA la classe o ad ALUNNI SELEZIONATI. ──
// Nella POST /api/primaria/registro:
//   · haDestinatari     → scrive argomento_proprio/compiti_propri + registro_destinatari
//                         (per QUALSIASI tipo firma, non solo il sostegno);
//   · sopprimeCondivisi = haDestinatari → QUALSIASI assegnazione mirata NON tocca i campi
//                         CONDIVISI di classe (argomento/compiti/materia della riga condivisa
//                         registro_orario). REGRESSIONE ciclo-1 (B1): un docente non-titolare
//                         che assegnava ai soli alunni selezionati mandava i condivisi VUOTI e
//                         AZZERAVA argomento/compiti del titolare. Il sostegno è un caso
//                         particolare del generale: comportamento invariato.

const SECTION = '0e20e2e2-0e2e-40e2-8e2e-0e2e2e2e2e21'
const A1 = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
const MATERIA = '3a73a73a-3a7a-43a7-8a73-a73a73a73a71'

const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data?: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
    captured: { insert: [] as Array<{ table: string; v: unknown }>, upsert: [] as Array<{ table: string; v: unknown }> },
  }
  function take(table: string) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    return q[i] ?? { data: null, error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        // `delete` incluso: il ramo destinatari fa delete().eq() prima dell'insert.
        for (const m of ['select', 'eq', 'order', 'limit', 'in', 'not', 'gte', 'lte', 'is', 'neq', 'delete']) qb[m] = () => qb
        qb.insert = (v: unknown) => { state.captured.insert.push({ table, v }); return qb }
        qb.upsert = (v: unknown) => { state.captured.upsert.push({ table, v }); return qb }
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

const authMock = vi.hoisted(() => ({ requireDocente: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: authMock.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn().mockResolvedValue(null),
  assertAlunniInSezione: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/audit/valutatore', () => ({
  risolviValutatore: vi.fn().mockResolvedValue({ valutatoreId: 'maestra-1', response: null }),
}))
vi.mock('@/lib/primaria/timelock', () => ({ isOltreScadenza: vi.fn().mockResolvedValue({ locked: false }) }))
const notificheMock = vi.hoisted(() => ({ enqueueNotifichePerAlunni: vi.fn(), notificaTitolariScrittura: vi.fn() }))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: notificheMock.enqueueNotifichePerAlunni,
  notificaTitolariScrittura: notificheMock.notificaTitolariScrittura,
}))

import { POST } from '@/app/api/primaria/registro/route'
import { NextRequest } from 'next/server'

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/primaria/registro?userId=doc-1', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

const BASE = { sectionId: SECTION, data: '2026-07-14', oraLezione: 2, materiaId: MATERIA }

// Seed della sequenza di query. `conAltraPrincipale=false` per il sostegno, che NON
// esegue il controllo della firma principale duplicata (una sola presa su firme_docenti).
function seedBase({ conAltraPrincipale }: { conAltraPrincipale: boolean }) {
  h.state.queues.sections = [{ data: { id: SECTION, name: '1A', scuola_id: 'sc-1' }, error: null }]
  h.state.queues.registro_orario = [
    { data: null, error: null },              // esistente?
    { data: { id: 'reg-1' }, error: null },   // upsert riga
  ]
  h.state.queues.firme_docenti = conAltraPrincipale
    ? [{ data: null, error: null }, { data: { id: 'firma-1' }, error: null }]
    : [{ data: { id: 'firma-1' }, error: null }]
  h.state.queues.registro_destinatari = [{ error: null }, { error: null }] // delete + insert
  h.state.queues.alunni = [{ data: [{ id: A1 }, { id: 'a2' }], error: null }] // notifica classe
}

const upsertDi = (table: string) => h.state.captured.upsert.find((c) => c.table === table)?.v as Record<string, unknown> | undefined
const insertDi = (table: string) => h.state.captured.insert.find((c) => c.table === table)?.v

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.captured = { insert: [], upsert: [] }
  notificheMock.enqueueNotifichePerAlunni.mockResolvedValue(undefined)
  notificheMock.notificaTitolariScrittura.mockResolvedValue(undefined)
  authMock.requireDocente.mockResolvedValue({
    user: { id: 'doc-1', role: 'educator', scuola_id: 'sc-1' }, response: null,
  })
})

describe('POST /api/primaria/registro — destinatari (P7/B1)', () => {
  // (a) Firma di classe senza destinatari: nessun campo proprio, nessun destinatario.
  it('classe intera senza destinatari → campi condivisi scritti, nessun campo proprio, nessun registro_destinatari', async () => {
    seedBase({ conAltraPrincipale: true })
    const res = await POST(req({
      ...BASE, tipoCompresenza: 'principale',
      argomento: 'Frazioni', compiti: 'pag 10',
      argomentoProprio: '', compitiPropri: '', destinatariIds: [],
    }))
    expect(res.status).toBe(200)

    const riga = upsertDi('registro_orario')!
    expect(riga.argomento).toBe('Frazioni')
    expect(riga.compiti).toBe('pag 10')

    const firma = upsertDi('firme_docenti')!
    expect(firma.argomento_proprio).toBeNull()
    expect(firma.compiti_propri).toBeNull()

    expect(insertDi('registro_destinatari')).toBeUndefined()
  })

  // (b) Docente NON sostegno con destinatari — PAYLOAD REALE del client in modalità «Alunni
  //     selezionati»: i textarea condivisi non sono mostrati, quindi argomento/compiti arrivano
  //     VUOTI (''). Il server NON deve scriverli nell'upsert (né valorizzati né come null): la
  //     riga registro_orario è condivisa e un UPDATE con argomento:null AZZERAREBBE i contenuti
  //     del titolare (regressione B1). I campi propri + registro_destinatari vengono comunque scritti.
  it('docente NON sostegno con destinatari e condivisi VUOTI → condivisi NON scritti, propri + destinatari scritti', async () => {
    seedBase({ conAltraPrincipale: true })
    const res = await POST(req({
      ...BASE, tipoCompresenza: 'principale',
      argomento: '', compiti: '',
      argomentoProprio: 'Storia adattata', compitiPropri: 'scheda facilitata',
      destinatariIds: [A1],
    }))
    expect(res.status).toBe(200)

    // I campi condivisi NON compaiono nell'upsert: la chiave è OMESSA, quindi l'UPDATE della
    // riga condivisa non tocca argomento/compiti/materia scritti dal titolare.
    const riga = upsertDi('registro_orario')!
    expect('argomento' in riga).toBe(false)
    expect('compiti' in riga).toBe(false)
    expect('materia_id' in riga).toBe(false)

    // Campi propri scritti sulla firma.
    const firma = upsertDi('firme_docenti')!
    expect(firma.argomento_proprio).toBe('Storia adattata')
    expect(firma.compiti_propri).toBe('scheda facilitata')

    // registro_destinatari popolato con l'alunno selezionato.
    const dest = insertDi('registro_destinatari') as Array<{ alunno_id: string; firma_id: string }>
    expect(dest).toBeTruthy()
    expect(dest.map((d) => d.alunno_id)).toContain(A1)
    expect(dest[0].firma_id).toBe('firma-1')
  })

  // (b-regr) REGRESSIONE B1 esplicita: riga condivisa GIÀ firmata dal titolare con
  //          argomento 'Le frazioni' / compiti 'Studiare pag. 10'. Un docente non-titolare
  //          assegna ai soli alunni selezionati (condivisi vuoti, come manda il client). L'upsert
  //          non deve portare argomento/compiti → l'UPDATE lascia INTATTI i contenuti del titolare.
  it('REGRESSIONE B1: riga condivisa preesistente del titolare + assegnazione mirata → condivisi INTATTI', async () => {
    seedBase({ conAltraPrincipale: true })
    // La riga esiste già (firmata dal titolare, con 'Le frazioni' / 'Studiare pag. 10' a DB):
    // il primo take su registro_orario risponde all'esistenza, il secondo all'upsert.
    h.state.queues.registro_orario = [
      { data: { id: 'reg-1' }, error: null }, // esistente? → SÌ (riga del titolare)
      { data: { id: 'reg-1' }, error: null }, // upsert riga
    ]
    const res = await POST(req({
      ...BASE, tipoCompresenza: 'principale',
      argomento: '', compiti: '',
      argomentoProprio: 'Percorso mirato', compitiPropri: 'Esercizi su misura',
      destinatariIds: [A1],
    }))
    expect(res.status).toBe(200)

    // L'upsert non scrive i condivisi: nessuna chiave argomento/compiti → 'Le frazioni' e
    // 'Studiare pag. 10' del titolare NON vengono azzerati dall'UPDATE.
    const riga = upsertDi('registro_orario')!
    expect(riga.argomento).toBeUndefined()
    expect(riga.compiti).toBeUndefined()
    expect('argomento' in riga).toBe(false)
    expect('compiti' in riga).toBe(false)
  })

  // (b-bis) In assegnazione mirata i condivisi NON esistono (client non li invia): solo i
  //         selezionati ricevono la notifica del testo proprio; il resto della classe NON riceve
  //         nulla (nessun compito condiviso da recapitare) → nessun invio spurio.
  it('non sostegno con destinatari → notifica proprio SOLO ai selezionati, nessun invio al resto', async () => {
    seedBase({ conAltraPrincipale: true })
    await POST(req({
      ...BASE, tipoCompresenza: 'principale',
      argomento: '', compiti: '',
      argomentoProprio: 'Storia adattata', compitiPropri: 'scheda facilitata',
      destinatariIds: [A1],
    }))
    const calls = notificheMock.enqueueNotifichePerAlunni.mock.calls.map((c) => c[1] as { alunnoIds: string[]; corpo?: string })
    const proprio = calls.find((c) => c.corpo === 'scheda facilitata')
    expect(proprio?.alunnoIds).toEqual([A1])
    // Nessun compito condiviso → una sola notifica (ai selezionati), niente invio al resto classe.
    expect(calls.length).toBe(1)
  })

  // (c) REGRESSIONE sostegno: con destinatari i campi condivisi restano SOPPRESSI come oggi.
  it('sostegno con destinatari → campi condivisi soppressi (regressione), propri + destinatari scritti', async () => {
    seedBase({ conAltraPrincipale: false })
    const res = await POST(req({
      ...BASE, tipoCompresenza: 'sostegno',
      argomento: 'NON deve finire in classe', compiti: 'NEMMENO questo',
      argomentoProprio: 'attività su misura', compitiPropri: 'scheda dedicata',
      destinatariIds: [A1],
    }))
    expect(res.status).toBe(200)

    // Campi condivisi soppressi: la riga NON riporta argomento/compiti/materia.
    const riga = upsertDi('registro_orario')!
    expect(riga.argomento).toBeUndefined()
    expect(riga.compiti).toBeUndefined()
    expect('materia_id' in riga).toBe(false)

    const firma = upsertDi('firme_docenti')!
    expect(firma.argomento_proprio).toBe('attività su misura')
    expect(firma.compiti_propri).toBe('scheda dedicata')

    expect(insertDi('registro_destinatari')).toBeTruthy()
  })

  // (d) Toggle "alunni selezionati" ma NESSUN destinatario → comportamento di classe:
  //     i campi propri NON vengono scritti e non nasce alcun registro_destinatari.
  it('destinatari vuoti (toggle alunni senza selezione) → comportamento classe, campi propri ignorati', async () => {
    seedBase({ conAltraPrincipale: true })
    const res = await POST(req({
      ...BASE, tipoCompresenza: 'principale',
      argomento: 'Geografia', compiti: 'ripassa le regioni',
      argomentoProprio: 'testo proprio orfano', compitiPropri: 'compiti propri orfani',
      destinatariIds: [],
    }))
    expect(res.status).toBe(200)

    const riga = upsertDi('registro_orario')!
    expect(riga.argomento).toBe('Geografia')
    expect(riga.compiti).toBe('ripassa le regioni')

    const firma = upsertDi('firme_docenti')!
    expect(firma.argomento_proprio).toBeNull()
    expect(firma.compiti_propri).toBeNull()

    expect(insertDi('registro_destinatari')).toBeUndefined()
  })
})
