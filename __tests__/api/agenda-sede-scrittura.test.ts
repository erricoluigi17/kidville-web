import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { dataCivile } from '@/i18n/config'

// =============================================================================
// W2-M — `/api/agenda`: il risolutore nome→sezione non «ne prende una».
//
// Difetto chiuso qui (rilievo R7 dell'audit 2026-07-31): `sezionePerNomeInScope`
// faceva `.eq('name', nome).in('scuola_id', plessi).limit(1)` — LIMIT senza
// ORDER BY — partendo da `scuoleDiUtente`, che IGNORA il SedeSelector. Scenario
// verificato in produzione: l'admin seleziona solo Cesa, clicca la chip «2 ANNI»
// (di Cesa) e l'evento — con la sua notifica alle famiglie — viene archiviato
// ad AVERSA. Nessun errore, e nemmeno un sospetto: anche la GET risolveva la
// stessa sezione sbagliata, quindi l'evento compariva in lista.
//
// Secondo difetto (R114): l'evento di PLESSO prendeva `user.scuola_id ?? plessi[0]`,
// cioè finiva SEMPRE nella sede primaria dell'operatore.
//
// Finto client che filtra e scrive davvero: si asserisce lo stato esatto E che
// cosa è finito in `eventi_agenda`, mai una negazione.
// =============================================================================

const OMONIMA = '2 ANNI'
const SOLO_A = '3 ANNI A'
const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const SEC_A = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEC_B = 'bbbb2222-0000-4000-8000-0000000000b2'
const SEC_SOLO_A = 'aaaa3333-0000-4000-8000-0000000000a3'
/**
 * Il giorno degli eventi di prova è OGGI, calcolato con la stessa funzione che usa la
 * route (`dataCivile`, nel fuso della scuola) — non una data scritta a mano.
 *
 * ⚠️ PERCHÉ, e non è una raffinatezza: `GET /api/agenda` filtra `.gte('data', from)`
 * con `from = dataCivile()`. Finché qui c'era la costante `'2026-08-10'`, questo file
 * ha collaudato davvero l'isolamento fra sedi soltanto **il 10 agosto 2026**: a
 * mezzanotte gli eventi di prova sono finiti nel passato, la GET ha restituito un
 * elenco vuoto e due asserzioni sono diventate rosse — misurato, alle 00:01 dell'11
 * agosto, mentre girava un lavoro che con l'agenda non c'entrava niente.
 *
 * È la stessa lezione già pagata in questo repo il 2026-08-09 con il fuso orario del
 * banco di prova: un test legato al calendario non è un test, è una scadenza. E qui
 * il danno era doppio, perché ciò che smetteva di essere collaudato — che una sede
 * non veda gli eventi di un'altra — è esattamente la garanzia che vale di più.
 */
const GIORNO = dataCivile()

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireUser: vi.fn(),
  enqueue: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  /**
   * Errori PostgREST iniettati per tabella (chiavi validate dal finto client).
   *
   * ⚠️ `code` è OBBLIGATORIO, e non è pignoleria: `ErrorePostgrest`
   * (`__tests__/fixtures/finto-supabase.ts`) lo dichiara richiesto perché il finto ci
   * costruisce sopra lo stato HTTP (`statoDiPostgrest(errore.code)`). Con `code?` qui,
   * `npx tsc --noEmit` era ROSSO su questa riga — e `tsc` è un gate dichiarato che la
   * CI esegue anche sui `__tests__`.
   */
  erroriTabella: {} as Record<string, { code: string; message?: string }>,
}))

// Solo `logEvento` è sostituito: il resto del modulo resta REALE, perché
// `withRoute` ne usa altri pezzi e un mock totale collauderebbe l'impalcatura
// invece della route.
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: (...a: unknown[]) => h.logEvento(...a) }
})

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
  requireUser: h.requireUser,
}))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: (...a: unknown[]) => h.enqueue(...a),
}))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfterMs: 0 }),
  clientIp: () => 'test',
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.erroriTabella }),
  }
})

import { GET, POST } from '@/app/api/agenda/route'

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_A, scuola_id: SEDE_A, name: OMONIMA },
    { id: SEC_B, scuola_id: SEDE_B, name: OMONIMA },
    { id: SEC_SOLO_A, scuola_id: SEDE_A, name: SOLO_A },
  ],
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  utenti_sezioni: [],
  eventi_agenda: [
    { id: 'ev-a', scuola_id: SEDE_A, section_id: SEC_A, titolo: 'FESTA-SEDE-A', tipo: 'evento', data: GIORNO, visibile_genitori: true, creato_da: ID_ADMIN },
    { id: 'ev-b', scuola_id: SEDE_B, section_id: SEC_B, titolo: 'FESTA-SEDE-B', tipo: 'evento', data: GIORNO, visibile_genitori: true, creato_da: ID_ADMIN },
  ],
  alunni: [],
})

function richiesta(url: string, body?: Record<string, unknown>, cookie?: string): NextRequest {
  return {
    url,
    method: body ? 'POST' : 'GET',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body ?? {},
    cookies: {
      get: (nome: string) =>
        nome === 'sedi_attive' && cookie !== undefined ? { name: nome, value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

const postReq = (body: Record<string, unknown>, cookie?: string) =>
  richiesta('http://localhost/api/agenda', body, cookie)
const getReq = (qs = '', cookie?: string) =>
  richiesta(`http://localhost/api/agenda${qs ? `?${qs}` : ''}`, undefined, cookie)

const evento = (extra: Record<string, unknown>) => ({
  titolo: 'Uscita al parco',
  tipo: 'uscita',
  data: GIORNO,
  ...extra,
})

const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.erroriTabella = {}
  h.enqueue.mockResolvedValue(undefined)
  const utente = { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A }
  h.requireDocente.mockResolvedValue({ user: utente })
  h.requireUser.mockResolvedValue({ user: utente })
})

describe('POST /api/agenda — nome-sezione omonimo', () => {
  it('due sezioni omonime nel perimetro ⇒ 400 e NESSUN evento creato', async () => {
    const res = await POST(postReq(evento({ sezione: OMONIMA })))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/sede/i)
    expect(scrittureSu('eventi_agenda')).toEqual([])
    expect(h.db.eventi_agenda).toHaveLength(2) // solo le due righe di partenza
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  it('SedeSelector su UNA sede ⇒ 201 nella sezione di QUELLA sede', async () => {
    const res = await POST(postReq(evento({ sezione: OMONIMA }), SEDE_B))

    expect(res.status).toBe(201)
    const scritte = scrittureSu('eventi_agenda')
    expect(scritte).toHaveLength(1)
    expect(scritte[0].valori[0]).toMatchObject({
      scuola_id: SEDE_B,
      section_id: SEC_B,
      titolo: 'Uscita al parco',
    })
  })

  it('nome presente in una sola sede ⇒ 201 senza dichiarare nulla', async () => {
    const res = await POST(postReq(evento({ sezione: SOLO_A })))

    expect(res.status).toBe(201)
    expect(scrittureSu('eventi_agenda')[0].valori[0]).toMatchObject({
      scuola_id: SEDE_A,
      section_id: SEC_SOLO_A,
    })
  })

  it('`section_id` esplicito ⇒ 201 con la sede della sezione, non quella dell\'autore', async () => {
    const res = await POST(postReq(evento({ section_id: SEC_B })))

    expect(res.status).toBe(201)
    expect(scrittureSu('eventi_agenda')[0].valori[0]).toMatchObject({
      scuola_id: SEDE_B,
      section_id: SEC_B,
    })
  })
})

describe('POST /api/agenda — evento di PLESSO: la sede si dichiara', () => {
  it('admin multi-sede senza `scuola_id` ⇒ 400 e nessuna scrittura', async () => {
    const res = await POST(postReq(evento({ titolo: 'Chiusura estiva' })))

    expect(res.status).toBe(400)
    expect(scrittureSu('eventi_agenda')).toEqual([])
  })

  it('`scuola_id` dichiarato ⇒ 201 in QUELLA sede (non nella primaria dell\'autore)', async () => {
    const res = await POST(postReq(evento({ titolo: 'Chiusura estiva', scuola_id: SEDE_B })))

    expect(res.status).toBe(201)
    expect(scrittureSu('eventi_agenda')[0].valori[0]).toMatchObject({
      scuola_id: SEDE_B,
      section_id: null,
    })
  })

  it('l’evento di PLESSO non arriva alle famiglie degli ARCHIVIATI (2026-08-12)', async () => {
    // Senza `sectionId` questa è una lettura di SEDE INTERA: la classe non la
    // nomina, quindi lo sganciamento — la leva su cui si regge l'archiviazione —
    // qui non arriva. Il finto client FILTRA davvero, quindi «l'archiviato resta
    // fuori» è una proprietà verificata e non asserita: togliendo
    // `.eq('stato', …)` dalla route questo test diventa rosso.
    h.db.alunni = [
      { id: 'al-isc', scuola_id: SEDE_A, stato: 'iscritto' },
      { id: 'al-rit', scuola_id: SEDE_A, stato: 'ritirato' },
      { id: 'al-altra-sede', scuola_id: SEDE_B, stato: 'iscritto' },
    ]
    const res = await POST(postReq(evento({ scuola_id: SEDE_A, visibile_genitori: true })))
    expect(res.status).toBe(201)
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    expect((h.enqueue.mock.calls[0][1] as { alunnoIds: string[] }).alunnoIds).toEqual(['al-isc'])
  })

  it('l’evento di PLESSO raggiunge anche un SOSPESO: frequenta (2026-08-13)', async () => {
    h.db.alunni = [
      { id: 'al-isc', scuola_id: SEDE_A, stato: 'iscritto' },
      { id: 'al-sos', scuola_id: SEDE_A, stato: 'sospeso' },
      { id: 'al-rit', scuola_id: SEDE_A, stato: 'ritirato' },
    ]
    const res = await POST(postReq(evento({ scuola_id: SEDE_A, visibile_genitori: true })))
    expect(res.status).toBe(201)
    expect((h.enqueue.mock.calls[0][1] as { alunnoIds: string[] }).alunnoIds).toEqual(['al-isc', 'al-sos'])
  })

  it('lettura alunni FALLITA ⇒ 201 ma una riga `error`: la scrittura persa si vede (2026-08-13)', async () => {
    // REGOLA 7 DI AGENTS.md, sulla riga che il lavoro del 12/08 aveva riscritto
    // senza toccare il difetto. `const { data: alunni } = await alunniQuery`
    // buttava via l'`{ error }`, e PostgREST NON lancia: la catena era
    // `data = null` → `(alunni ?? [])` = `[]` → `enqueueNotifichePerAlunni` esce
    // alla prima riga → il `catch` sotto non scatta mai → **201, zero notifiche
    // in coda, ZERO righe di log**. Cioè esattamente lo scenario che il commento
    // di quel `catch` dichiara di esistere per impedire: «non è saltato un
    // dettaglio, è una SCRITTURA PERSA».
    //
    // L'evento resta salvo e la risposta resta 201 — la creazione è andata a
    // buon fine davvero — ma l'annuncio mancato smette di essere invisibile.
    h.db.alunni = [{ id: 'al-isc', scuola_id: SEDE_A, stato: 'iscritto' }]
    h.erroriTabella.alunni = { code: '42703', message: 'column alunni.stato does not exist' }
    const res = await POST(postReq(evento({ scuola_id: SEDE_A, visibile_genitori: true })))

    expect(res.status).toBe(201)
    // `.mock.calls.length` e non `not.toHaveBeenCalled()`: in caso di rosso
    // vitest stampa gli argomenti, e fra questi c'è il finto client — il cui
    // proxy solleva su ogni membro che non emula, sostituendo il fallimento vero
    // con un errore del formattatore.
    expect(h.enqueue.mock.calls.length).toBe(0)
    const riga = h.logEvento.mock.calls.find(
      (c: unknown[]) => (c[2] as { esito?: string })?.esito === 'destinatari-non-letti',
    )
    expect(riga?.[1]).toBe('error')
    expect((riga?.[2] as { operazione?: string })?.operazione).toBe('agenda:POST')
  })

  it('SedeSelector su una sola sede ⇒ 201 in quella sede', async () => {
    const res = await POST(postReq(evento({ titolo: 'Chiusura estiva' }), SEDE_B))

    expect(res.status).toBe(201)
    expect(scrittureSu('eventi_agenda')[0].valori[0]).toMatchObject({ scuola_id: SEDE_B })
  })
})

describe('GET /api/agenda — lo staff legge nel perimetro del SedeSelector', () => {
  it('cookie su una sede ⇒ solo gli eventi di quella sede', async () => {
    const res = await GET(getReq('', SEDE_B))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.map((e: { titolo: string }) => e.titolo)).toEqual(['FESTA-SEDE-B'])
  })

  it('senza cookie ⇒ tutte le sedi accessibili', async () => {
    const res = await GET(getReq())

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.map((e: { titolo: string }) => e.titolo).sort()).toEqual([
      'FESTA-SEDE-A',
      'FESTA-SEDE-B',
    ])
  })

  it('filtro ?sezione= su nome omonimo ⇒ 400, non una sezione a caso', async () => {
    const res = await GET(getReq(`sezione=${encodeURIComponent(OMONIMA)}`))

    expect(res.status).toBe(400)
  })
})
