/**
 * `api/primaria/appello` — RITARDO / USCITA ANTICIPATA GIUSTIFICATI (compito A3).
 *
 * Richiesta del titolare (26/09/2026): un ritardo o un'uscita anticipata per una
 * terapia non devono contare nelle ore di assenza. Lo stato resta quello vero
 * (l'alunno NON era in classe): cambia solo il conteggio, e a dirlo è la colonna
 * `presenze.assenza_oraria_giustificata`, con il motivo in `note_appello`
 * (migrazione 20260926100000, che ha anche il CHECK «flag ⇒ nota non vuota»).
 *
 * Che cosa lega questo file:
 *  (a) flag acceso senza nota (o con sola spaziatura) → 422, e NIENTE si scrive;
 *  (b) flag acceso su uno stato che non è ritardo/uscita_anticipata → 422;
 *  (c) nel blocco basta UN record sbagliato perché non si scriva nessuno;
 *  (d) flag + nota su ritardo/uscita → l'upsert scrive `true` e la nota;
 *  (e) la colonna si scrive SEMPRE: un corpo che non la nomina, o uno stato diverso,
 *      scrive `false` anche se prima era `true` (la correzione la spegne);
 *  (f) il salvataggio di una giustificazione si logga con uuid e stato, MAI col
 *      testo della nota (è un dato sanitario di un minore);
 *  (g) la GET chiede la colonna a PostgREST e restituisce, per alunno,
 *      `assenza_oraria_giustificata` e `note_appello`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  presenzePrima: [] as Array<Record<string, unknown>>,
  upsertate: [] as Array<Record<string, unknown>>,
  colonnePresenze: [] as string[],
  presenzeGet: [] as Array<Record<string, unknown>>,
  logEvento: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn(async () => ({ user: { id: 'd0000000-0000-4000-8000-0000000000d1', role: 'educator', scuola_id: 's1' } })),
}))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  assertSezioneInScope: vi.fn(async () => null),
  assertAlunniInSezione: vi.fn(async () => null),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(async () => undefined) }))
// Il logger vero resta (lo usa anche `withRoute`): si osserva solo `logEvento`.
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (...a: Parameters<typeof vero.logEvento>) => {
      h.logEvento(...a)
      return vero.logEvento(...a)
    },
  }
})

// Come PostgREST, `presenze` restituisce SOLO le colonne chieste: una colonna che la
// GET non chiede non può uscire dalla risposta.
function proietta(r: Record<string, unknown>, colonne: string) {
  const chieste = colonne.split(',').map((c) => c.trim())
  return Object.fromEntries(Object.entries(r).filter(([k]) => chieste.includes(k)))
}

function chain(table: string) {
  let colonne = '*'
  const risolvi = () => {
    if (table === 'presenze') {
      const righe = h.presenzeGet.length > 0 ? h.presenzeGet : h.presenzePrima
      return { data: righe.map((r) => proietta(r, colonne)), error: null }
    }
    if (table === 'sections') return { data: { scuola_id: 's1' }, error: null }
    if (table === 'alunni') return { data: [{ id: A1, nome: 'Primo', cognome: 'Alunno' }, { id: A2, nome: 'Secondo', cognome: 'Bimbo' }], error: null }
    return { data: [], error: null }
  }
  const b: Record<string, unknown> = {}
  b.select = (c: string) => {
    colonne = c
    if (table === 'presenze') h.colonnePresenze.push(c)
    return b
  }
  for (const m of ['eq', 'in', 'order', 'limit', 'is']) b[m] = () => b
  b.upsert = (rows: Array<Record<string, unknown>>) => {
    h.upsertate.push(...rows)
    return { select: async () => ({ data: rows, error: null }) }
  }
  b.delete = () => b
  b.maybeSingle = async () => risolvi()
  b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risolvi()).then(ok, ko)
  return b
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({ from: (t: string) => chain(t) })),
}))

import { GET, POST } from '@/app/api/primaria/appello/route'

const SEZIONE = 'bbbb0000-0000-4000-8000-00000000b001'
const A1 = '11111111-1111-4111-8111-111111111111'
const A2 = '22222222-2222-4222-8222-222222222222'
const DATA = '2026-09-26'
// Il motivo: in un test è finto, ma è ESATTAMENTE il genere di testo che non deve
// finire nei log.
const NOTA = 'Seduta di logopedia fino alle 10'

function req(corpo: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/primaria/appello', {
    method: 'POST',
    body: JSON.stringify({ sectionId: SEZIONE, data: DATA, ...corpo }),
    headers: { 'Content-Type': 'application/json' },
  })
}

const rigaScritta = (id = A1) => h.upsertate.find((r) => r.alunno_id === id)!

beforeEach(() => {
  h.presenzePrima = []
  h.presenzeGet = []
  h.upsertate = []
  h.colonnePresenze = []
  h.logEvento.mockClear()
})

describe('POST /api/primaria/appello — il flag «ore giustificate»', () => {
  it.each([
    ['senza nota', {}],
    ['con nota vuota', { noteAppello: '' }],
    ['con nota di soli spazi', { noteAppello: '   \n ' }],
    ['con nota null', { noteAppello: null }],
  ])('flag acceso %s → 422 con messaggio italiano, e non si scrive niente', async (_n, extra) => {
    const res = await POST(req({ alunnoId: A1, stato: 'ritardo', orarioEntrata: '10:05', assenzaOrariaGiustificata: true, ...extra }))
    expect(res.status).toBe(422)
    const corpo = (await res.json()) as { error: string; codice: string }
    expect(corpo.codice).toBe('GIUSTIFICAZIONE_SENZA_NOTA')
    expect(corpo.error).toMatch(/nota/i)
    expect(h.upsertate).toHaveLength(0)
  })

  it('una nota GIÀ salvata non basta: il flag acceso vuole la nota nello STESSO corpo (contratto A3)', async () => {
    // Il ramo singolo conserva la nota che il corpo non nomina (`prec.note_appello`):
    // questo test impedisce che quella «comodità» risalga fino al controllo della
    // giustificazione. Il motivo va confermato insieme al flag, altrimenti una spunta
    // accesa per sbaglio erediterebbe il motivo di un altro momento.
    h.presenzePrima = [{ alunno_id: A1, stato: 'ritardo', note_appello: NOTA, assenza_oraria_giustificata: false }]
    const res = await POST(req({ alunnoId: A1, stato: 'ritardo', assenzaOrariaGiustificata: true }))
    expect(res.status).toBe(422)
    const corpo = (await res.json()) as { error: string; codice: string }
    expect(corpo.codice).toBe('GIUSTIFICAZIONE_SENZA_NOTA')
    expect(h.upsertate).toHaveLength(0)
  })

  it.each([['presente'], ['assente']])('flag acceso su «%s» → 422, anche con la nota', async (stato) => {
    const res = await POST(req({ alunnoId: A1, stato, noteAppello: NOTA, assenzaOrariaGiustificata: true }))
    expect(res.status).toBe(422)
    const corpo = (await res.json()) as { error: string; codice: string }
    expect(corpo.codice).toBe('GIUSTIFICAZIONE_STATO_NON_AMMESSO')
    expect(corpo.error).toMatch(/ritardo|uscita anticipata/i)
    expect(h.upsertate).toHaveLength(0)
  })

  it('nel blocco basta UN record sbagliato: 422 e nessuna riga scritta', async () => {
    const res = await POST(req({
      records: [
        { alunnoId: A1, stato: 'presente' },
        { alunnoId: A2, stato: 'uscita_anticipata', assenzaOrariaGiustificata: true },
      ],
    }))
    expect(res.status).toBe(422)
    expect(h.upsertate).toHaveLength(0)
  })

  it('un flag che non è booleano è un errore del client: 400, non un «vero»', async () => {
    const res = await POST(req({ alunnoId: A1, stato: 'ritardo', noteAppello: NOTA, assenzaOrariaGiustificata: 'si' }))
    expect(res.status).toBe(400)
    expect(h.upsertate).toHaveLength(0)
  })

  it.each([['ritardo'], ['uscita_anticipata']])('flag + nota su «%s» → l\'upsert scrive true e la nota', async (stato) => {
    const res = await POST(req({ alunnoId: A1, stato, noteAppello: NOTA, assenzaOrariaGiustificata: true }))
    expect(res.status).toBe(200)
    expect(rigaScritta()).toMatchObject({ stato, assenza_oraria_giustificata: true, note_appello: NOTA })
  })

  it('funziona anche nel blocco, record per record', async () => {
    const res = await POST(req({
      records: [
        { alunnoId: A1, stato: 'ritardo', noteAppello: NOTA, assenzaOrariaGiustificata: true },
        { alunnoId: A2, stato: 'ritardo', noteAppello: 'Traffico' },
      ],
    }))
    expect(res.status).toBe(200)
    expect(rigaScritta(A1).assenza_oraria_giustificata).toBe(true)
    expect(rigaScritta(A2).assenza_oraria_giustificata).toBe(false)
  })

  it('un corpo che NON nomina il flag lo scrive false: la correzione spegne una giustifica precedente', async () => {
    h.presenzePrima = [{ alunno_id: A1, stato: 'ritardo', note_appello: NOTA, assenza_oraria_giustificata: true }]
    const res = await POST(req({ alunnoId: A1, stato: 'ritardo', orarioEntrata: '10:10' }))
    expect(res.status).toBe(200)
    // La chiave c'è, e vale false: non «assente» (che l'upsert lascerebbe al DEFAULT
    // solo in inserimento, e in aggiornamento lascerebbe il vecchio true).
    expect(rigaScritta()).toHaveProperty('assenza_oraria_giustificata', false)
  })

  it.each([['presente'], ['assente']])('stato «%s» senza flag → la colonna si scrive false anche se prima era true', async (stato) => {
    h.presenzePrima = [{ alunno_id: A1, stato: 'uscita_anticipata', note_appello: NOTA, assenza_oraria_giustificata: true }]
    const res = await POST(req({ alunnoId: A1, stato }))
    expect(res.status).toBe(200)
    expect(rigaScritta()).toHaveProperty('assenza_oraria_giustificata', false)
  })

  it('«Tutti presenti» (solo alunnoId e stato, in blocco) scrive false per ognuno', async () => {
    h.presenzePrima = [{ alunno_id: A1, stato: 'ritardo', note_appello: NOTA, assenza_oraria_giustificata: true }]
    await POST(req({ records: [{ alunnoId: A1, stato: 'presente' }, { alunnoId: A2, stato: 'presente' }] }))
    expect(h.upsertate.map((r) => r.assenza_oraria_giustificata)).toEqual([false, false])
  })

  it('il salvataggio di una giustificazione si logga con uuid e stato, MAI col testo della nota', async () => {
    await POST(req({ alunnoId: A1, stato: 'uscita_anticipata', noteAppello: NOTA, assenzaOrariaGiustificata: true }))
    const chiamate = h.logEvento.mock.calls.filter(([, , campi]) =>
      (campi as Record<string, unknown>)?.esito === 'assenza-oraria-giustificata-salvata',
    )
    expect(chiamate).toHaveLength(1)
    const [evento, livello, campi] = chiamate[0]
    // `registro`: nel vocabolario chiuso (`EVENTI_NOTI`) e fra i PERSISTITI, così il
    // successo arriva in `app_log` e non solo su Vercel.
    expect(evento).toBe('registro')
    expect(livello).toBe('info')
    expect(campi).toMatchObject({ operazione: 'primaria/appello:POST', alunno: A1, sezione: SEZIONE, stato: 'uscita_anticipata' })
    // In NESSUNA chiamata al logger compare il motivo.
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain('logopedia')
  })

  it('senza giustificazione non si logga nessun salvataggio di giustificazione', async () => {
    await POST(req({ alunnoId: A1, stato: 'ritardo', noteAppello: 'Traffico' }))
    const salvate = h.logEvento.mock.calls.filter(([, , campi]) =>
      (campi as Record<string, unknown>)?.esito === 'assenza-oraria-giustificata-salvata',
    )
    expect(salvate).toHaveLength(0)
  })

  it('spegnere una giustificazione che c\'era si logga anche quello', async () => {
    h.presenzePrima = [{ alunno_id: A1, stato: 'ritardo', note_appello: NOTA, assenza_oraria_giustificata: true }]
    await POST(req({ alunnoId: A1, stato: 'presente' }))
    const rimosse = h.logEvento.mock.calls.filter(([, , campi]) =>
      (campi as Record<string, unknown>)?.esito === 'assenza-oraria-giustificata-rimossa',
    )
    expect(rimosse).toHaveLength(1)
    expect(rimosse[0][2]).toMatchObject({ alunno: A1, stato: 'presente' })
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain('logopedia')
  })

  it('la lettura dello stato PRIMA chiede la colonna (serve al diff d\'audit e al log di rimozione)', async () => {
    await POST(req({ alunnoId: A1, stato: 'presente' }))
    expect(h.colonnePresenze[0].split(',').map((c) => c.trim())).toContain('assenza_oraria_giustificata')
  })
})

describe('GET /api/primaria/appello — flag e nota per alunno', () => {
  const richiesta = () =>
    new NextRequest(`http://localhost/api/primaria/appello?sectionId=${SEZIONE}&data=${DATA}`)

  it('chiede `assenza_oraria_giustificata` e `note_appello`, e li restituisce per ogni alunno', async () => {
    h.presenzeGet = [
      {
        id: 'cccc0000-0000-4000-8000-000000000001',
        alunno_id: A1,
        stato: 'ritardo',
        note_appello: NOTA,
        orario_entrata: '2026-09-26T08:05:00.000Z',
        orario_uscita: null,
        giustificata: false,
        giust_vista_il: null,
        giust_vista_da: null,
        registrato_da: 'd0000000-0000-4000-8000-0000000000d1',
        assenza_oraria_giustificata: true,
      },
    ]
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    expect(h.colonnePresenze.at(-1)!.split(',').map((c) => c.trim())).toEqual(
      expect.arrayContaining(['assenza_oraria_giustificata', 'note_appello']),
    )
    const corpo = (await res.json()) as { data: Array<Record<string, unknown>> }
    const per = new Map(corpo.data.map((r) => [r.id, r]))
    expect(per.get(A1)).toMatchObject({ stato: 'ritardo', note_appello: NOTA, assenza_oraria_giustificata: true })
    // Senza riga: falso, non `undefined` — la finestra (A4) parte da una spunta spenta.
    expect(per.get(A2)).toMatchObject({ stato: null, note_appello: null, assenza_oraria_giustificata: false })
  })
})
