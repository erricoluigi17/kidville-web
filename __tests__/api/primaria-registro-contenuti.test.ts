import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { ErrorePostgrest, Riga, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// L4-b/c/d/f/g — Che cosa scrive davvero una firma, e che cosa dice quando non
// ha potuto leggere.
//
//  b) «chiave assente» ≠ «chiave vuota»: svuotare l'argomento di classe era
//     IMPOSSIBILE (`if (valore)`), mentre `argomento_proprio` si scriveva sempre.
//  c) la firma che non scrive niente rispondeva 200 con la spunta e zero
//     contenuto — compreso il caso «ho scritto per gli alunni selezionati e non
//     ne ho selezionato nessuno», dove il testo appena scritto veniva buttato.
//  d) tre `{ error }` scartati che cambiavano una DECISIONE: 404 al posto di un
//     guasto, 423 su una riga sbloccata, 500 grezzo al posto del 409 leggibile.
//     E la GET, che diceva «Nessuna ora» sia per verità sia per guasto.
//  f) «la classe» per le notifiche non aveva filtro di stato, mentre
//     `primaria/classe/[sectionId]:GET` filtra `stato = 'iscritto'`.
//  g) `oraLezione` senza range, contro un `CHECK (>= 1 AND <= 8)` a database.
//
// Lo scope è mockato QUI di proposito: è coperto per davvero, col modulo vero,
// in `primaria-registro-supplenza.test.ts`. Senza il mock un errore iniettato su
// `sections` verrebbe intercettato dal gate e non arriverebbe mai al ramo della
// route che questo file deve provare.
// =============================================================================

const SEZ = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const MATERIA = '22222222-1111-4111-8111-aaaaaaaaaaaa'
const DOCENTE = '99999999-1111-4111-8111-aaaaaaaaaaaa'
const ISCRITTO = 'a1a11111-1111-4111-8111-aaaaaaaaaaaa'
const SOSPESO = 'a1a11111-2222-4111-8111-aaaaaaaaaaaa'
const RITIRATO = 'a1a11111-3333-4111-8111-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
  logScrittura: vi.fn(),
  enqueue: vi.fn(),
  notificaTitolari: vi.fn(),
  isOltreScadenza: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn().mockResolvedValue(null),
  assertAlunniInSezione: vi.fn().mockResolvedValue(null),
  assertSezionePrimariaFirmabile: vi.fn().mockResolvedValue({ supplenza: false }),
}))
vi.mock('@/lib/auth/require-grado', () => ({ assertGradoDocente: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () =>
    creaFintoSupabase(h.db, h.tabelle, {
      scritture: h.scritture as never,
      errori: h.errori as Record<string, ErrorePostgrest>,
    })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/audit/valutatore', () => ({
  risolviValutatore: vi.fn().mockImplementation(async () => ({ valutatoreId: DOCENTE, response: null })),
}))
vi.mock('@/lib/primaria/timelock', () => ({ isOltreScadenza: h.isOltreScadenza }))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: h.enqueue,
  notificaTitolariScrittura: h.notificaTitolari,
}))

import { GET, POST } from '@/app/api/primaria/registro/route'

const post = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/primaria/registro?userId=' + DOCENTE, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-user-id': DOCENTE },
  })

const get = () =>
  new NextRequest(`http://localhost/api/primaria/registro?sectionId=${SEZ}&data=2026-09-09&userId=${DOCENTE}`)

const BASE = { sectionId: SEZ, data: '2026-09-09', oraLezione: 2, tipoCompresenza: 'principale' }

const scrittureDi = (tabella: string, operazione: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === operazione)
const upsertDi = (tabella: string) => scrittureDi(tabella, 'upsert')[0]?.valori[0]

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelle.length = 0
  h.scritture.length = 0
  h.errori = {}
  h.logScrittura.mockResolvedValue(undefined)
  h.enqueue.mockResolvedValue(undefined)
  h.notificaTitolari.mockResolvedValue(undefined)
  h.isOltreScadenza.mockResolvedValue({ locked: false, giorniLimite: 2 })
  h.requireDocente.mockResolvedValue({
    user: { id: DOCENTE, role: 'educator', scuola_id: SEDE_A }, response: null,
  })
  h.db = {
    sections: [{ id: SEZ, name: '1A', scuola_id: SEDE_A, school_type: 'primaria' }],
    registro_orario: [],
    firme_docenti: [],
    registro_destinatari: [],
    sblocchi_audit: [],
    campanelle: [],
    orario_settimanale: [],
    utenti: [{ id: DOCENTE, nome: 'D', cognome: 'D' }],
    alunni: [
      { id: ISCRITTO, section_id: SEZ, stato: 'iscritto' },
      { id: SOSPESO, section_id: SEZ, stato: 'sospeso' },
      { id: RITIRATO, section_id: SEZ, stato: 'ritirato' },
    ],
  } as Record<string, Riga[]>
})

// ─────────────────────────────────────────────────────────────────────────────
describe('L4-b — chiave assente ≠ chiave vuota', () => {
  it('argomento INVIATO VUOTO in assegnazione di classe → si scrive null (si può cancellare)', async () => {
    const res = await POST(post({ ...BASE, materiaId: MATERIA, argomento: '', compiti: '', destinatariIds: [] }))
    expect(res.status).toBe(200)
    const riga = upsertDi('registro_orario')!
    expect(riga.argomento).toBeNull()
    expect(riga.compiti).toBeNull()
  })

  it('argomento OMESSO → chiave assente dall’upsert (difesa B1: non azzera il titolare)', async () => {
    const res = await POST(post({ ...BASE, materiaId: MATERIA, destinatariIds: [] }))
    expect(res.status).toBe(200)
    const riga = upsertDi('registro_orario')!
    expect('argomento' in riga).toBe(false)
    expect('compiti' in riga).toBe(false)
    expect('data_consegna_compiti' in riga).toBe(false)
  })

  it('SIMMETRIA: argomentoProprio/compitiPropri omessi (coda offline) → chiavi assenti dalla firma', async () => {
    const res = await POST(post({ ...BASE, materiaId: MATERIA, argomento: 'Frazioni', compiti: '' }))
    expect(res.status).toBe(200)
    const firma = upsertDi('firme_docenti')!
    expect('argomento_proprio' in firma).toBe(false)
    expect('compiti_propri' in firma).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('L4-b bis — la CODA OFFLINE non deve cancellare i condivisi di un altro', () => {
  /** La riga che il titolare ha già documentato, e che la coda incrocia al rientro in rete. */
  const rigaDelTitolare = () => {
    h.db.registro_orario = [{
      id: 'reg-esistente', section_id: SEZ, scuola_id: SEDE_A, classe_sezione: '1A',
      data: '2026-09-09', ora_lezione: 2,
      argomento: 'Le frazioni', compiti: 'pag. 10', data_consegna_compiti: '2026-09-12',
      materia_id: null,
    }]
  }

  /**
   * IL CORPO LETTERALE DI `syncPendingRegistro` (`src/lib/offline/syncEngine.ts:635-647`),
   * copiato campo per campo. Non è una parafrasi: la coda spedisce SEMPRE le tre
   * chiavi condivise, perché in `LocalPrimariaRegistro` (`src/lib/offline/db.ts:145-160`)
   * sono `string | null` e vengono serializzate senza condizione. `docenteId`,
   * `destinatariIds`, `argomentoProprio` e `compitiPropri` la coda NON li manda: è
   * per questo che il corpo qui sotto è più corto di quello della modale.
   */
  const corpoDellaCoda = {
    sectionId: SEZ, data: '2026-09-09', oraLezione: 2,
    materiaId: null, argomento: null, compiti: null, dataConsegnaCompiti: null,
    tipoCompresenza: 'principale',
  }

  it('firma accodata con i condivisi VUOTI su un’ora già documentata → NON azzera argomento/compiti/consegna', async () => {
    rigaDelTitolare()
    const res = await POST(post(corpoDellaCoda))
    expect(res.status).toBe(200)
    const riga = upsertDi('registro_orario')!
    // Le chiavi non entrano nemmeno nell'upsert: un `argomento: null` qui
    // cancellerebbe «Le frazioni» del titolare, con 200 e la spunta.
    expect('argomento' in riga).toBe(false)
    expect('compiti' in riga).toBe(false)
    expect('data_consegna_compiti' in riga).toBe(false)
  })

  it('la firma si scrive lo stesso: la coda consegna, non viene respinta', async () => {
    rigaDelTitolare()
    const res = await POST(post(corpoDellaCoda))
    expect(res.status).toBe(200)
    expect(scrittureDi('firme_docenti', 'upsert').length).toBe(1)
  })

  it('CONTRO-PROVA: con `condivisiIdratati: true` l’azzeramento passa (la modale può ancora cancellare)', async () => {
    rigaDelTitolare()
    const res = await POST(post({ ...corpoDellaCoda, condivisiIdratati: true }))
    expect(res.status).toBe(200)
    const riga = upsertDi('registro_orario')!
    expect(riga.argomento).toBeNull()
    expect(riga.compiti).toBeNull()
    expect(riga.data_consegna_compiti).toBeNull()
  })

  it('su un’ora NON documentata il vuoto passa comunque: non c’è niente da cancellare', async () => {
    const res = await POST(post({ ...corpoDellaCoda, materiaId: MATERIA }))
    expect(res.status).toBe(200)
    const riga = upsertDi('registro_orario')!
    expect(riga.argomento).toBeNull()
    expect(riga.compiti).toBeNull()
  })

  it('un valore PIENO si scrive sempre, dichiarazione o no', async () => {
    rigaDelTitolare()
    const res = await POST(post({ ...corpoDellaCoda, argomento: 'Le potenze' }))
    expect(res.status).toBe(200)
    expect(upsertDi('registro_orario')!.argomento).toBe('Le potenze')
    // …e le altre due, vuote e non dichiarate, restano fuori.
    expect('compiti' in upsertDi('registro_orario')!).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('L4-c — la firma che non scrive niente', () => {
  it('contenuti «propri» senza nessun alunno selezionato e senza condivisi → 400, niente scritture', async () => {
    const res = await POST(post({
      ...BASE, argomentoProprio: 'Storia adattata', compitiPropri: 'scheda', destinatariIds: [],
    }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Nessun alunno selezionato')
    expect(scrittureDi('registro_orario', 'upsert')).toEqual([])
    expect(scrittureDi('firme_docenti', 'upsert')).toEqual([])
  })

  it('niente materia, niente argomento, niente compiti, ora non documentata → 400', async () => {
    const res = await POST(post({ ...BASE, argomento: '', compiti: '', destinatariIds: [] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Firma vuota')
    expect(scrittureDi('firme_docenti', 'upsert')).toEqual([])
  })

  /**
   * IL FALSO RIFIUTO. La guardia misurava il PAYLOAD ARRIVATO invece di ciò che
   * sarebbe stato scritto: una firma di sostegno con alunni selezionati e nessun
   * testo — su un'ora che nessuno ha ancora documentato — riceveva 400, benché ci
   * fossero da scrivere una riga in `firme_docenti` e una in `registro_destinatari`.
   * Quelle righe SONO contenuto: dicono «in quest'ora ero con questi bambini», che
   * è esattamente il mestiere del sostegno, e prima della guardia si scrivevano.
   */
  it('sostegno con alunni selezionati e NESSUN testo, ora non documentata → 200 (i destinatari sono contenuto)', async () => {
    const res = await POST(post({
      ...BASE, tipoCompresenza: 'sostegno', materiaId: null,
      argomentoProprio: '', compitiPropri: '', destinatariIds: [ISCRITTO],
    }))
    expect(res.status).toBe(200)
    expect(scrittureDi('firme_docenti', 'upsert').length).toBe(1)
    expect(scrittureDi('registro_destinatari', 'insert').length).toBe(1)
  })

  it('CONTRO-PROVA: la compresenza vuota su un’ora GIÀ documentata dal titolare resta 200', async () => {
    h.db.registro_orario = [{
      id: 'reg-esistente', section_id: SEZ, scuola_id: SEDE_A, classe_sezione: '1A',
      data: '2026-09-09', ora_lezione: 2, argomento: 'Le frazioni', compiti: null, materia_id: null,
    }]
    const res = await POST(post({
      ...BASE, tipoCompresenza: 'compresenza', argomento: '', compiti: '', destinatariIds: [],
    }))
    expect(res.status).toBe(200)
    expect(scrittureDi('firme_docenti', 'upsert').length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('L4-d — i `{ error }` che cambiano una decisione', () => {
  it('lettura della SEZIONE fallita → 500 dichiarato, non 404 «Sezione non trovata»', async () => {
    h.errori = { 'sections:select': { code: '57014', message: 'statement timeout' } }
    const res = await POST(post({ ...BASE, materiaId: MATERIA, argomento: 'x', compiti: '', destinatariIds: [] }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Verifica della sezione non riuscita.')
    expect(body.codice).toBe('LETTURA_FALLITA')
    expect(body.error).not.toContain('statement timeout')
  })

  it('lettura della RIGA esistente fallita con il termine scaduto → 500, non 423 su una riga sbloccata', async () => {
    h.isOltreScadenza.mockResolvedValue({ locked: true, giorniLimite: 2 })
    h.errori = { 'registro_orario:select': { code: '57014', message: 'statement timeout' } }
    const res = await POST(post({ ...BASE, materiaId: MATERIA, argomento: 'x', compiti: '', destinatariIds: [] }))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.error).toBe('Verifica della riga di registro non riuscita.')
    expect(corpo.codice).toBe('LETTURA_FALLITA')
  })

  it('lettura dell’ALTRA firma principale fallita → 500 pulito, e il testo di PostgREST non esce', async () => {
    h.errori = { 'firme_docenti:select': { code: '57014', message: 'relation "firme_docenti" timeout' } }
    const res = await POST(post({ ...BASE, materiaId: MATERIA, argomento: 'x', compiti: '', destinatariIds: [] }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Verifica della firma principale non riuscita.')
    expect(body.codice).toBe('LETTURA_FALLITA')
    expect(body.error).not.toContain('firme_docenti')
  })

  it('GET: una lettura fallita si DICHIARA — 200 con `campanelleLette: false`, non un silenzio', async () => {
    h.errori = { 'campanelle:select': { code: '57014', message: 'statement timeout' } }
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.campanelleLette).toBe(false)
    expect(body.righeLette).toBe(true)
    expect(body.orarioLetto).toBe(true)
  })

  it('GET: tutto letto → i tre campi valgono true (il segnale non è sempre acceso)', async () => {
    const res = await GET(get())
    const body = await res.json()
    expect(body.campanelleLette).toBe(true)
    expect(body.orarioLetto).toBe(true)
    expect(body.righeLette).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('L4-d bis — il `catch` della POST non versa il messaggio grezzo', () => {
  /**
   * È il gemello esatto del `catch` della GET, chiuso nello stesso intervento con
   * un commento che spiega perché («quello di PostgREST riecheggia filtri e nomi di
   * colonna»). Questo era rimasto aperto — ed è quello sulla strada che SCRIVE.
   */
  it('un’eccezione durante la POST → 500 con messaggio fisso e codice, mai il `message` dell’errore', async () => {
    h.logScrittura.mockRejectedValue(new Error('relation "audit_scritture" does not exist'))
    const res = await POST(post({ ...BASE, materiaId: MATERIA, argomento: 'Frazioni', destinatariIds: [] }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Non siamo riusciti a salvare la firma del registro.')
    expect(body.codice).toBe('FIRMA_NON_SALVATA')
    expect(body.error).not.toContain('audit_scritture')
    expect(body.error).not.toContain('relation')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('L4-f — chi è «la classe» per la notifica dei compiti', () => {
  it('il RITIRATO non riceve i compiti, il SOSPESO sì (frequenta)', async () => {
    const res = await POST(post({
      ...BASE, materiaId: MATERIA, argomento: 'Frazioni', compiti: 'pag. 10', destinatariIds: [],
    }))
    expect(res.status).toBe(200)
    const chiamate = h.enqueue.mock.calls.map((c) => c[1] as { alunnoIds: string[] })
    expect(chiamate.length).toBe(1)
    expect([...chiamate[0].alunnoIds].sort()).toEqual([ISCRITTO, SOSPESO].sort())
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('L4-g — `oraLezione` ha il range del database (CHECK 1..8)', () => {
  it('oraLezione 9 → 400 in italiano, e Postgres non viene nemmeno interpellato', async () => {
    const res = await POST(post({ ...BASE, oraLezione: 9, materiaId: MATERIA, argomento: 'x', compiti: '' }))
    expect(res.status).toBe(400)
    const body = await res.json() as { details: { path: string; message: string }[] }
    expect(body.details.some((d) => d.path === 'oraLezione' && /Ora di lezione/.test(d.message))).toBe(true)
    expect(scrittureDi('registro_orario', 'upsert')).toEqual([])
  })

  it('oraLezione 0 → 400 (era il valore che il vecchio `refine(!!v)` già rifiutava)', async () => {
    const res = await POST(post({ ...BASE, oraLezione: 0, materiaId: MATERIA, argomento: 'x', compiti: '' }))
    expect(res.status).toBe(400)
  })

  it("la stringa '3' arriva al database come NUMERO 3", async () => {
    const res = await POST(post({ ...BASE, oraLezione: '3', materiaId: MATERIA, argomento: 'x', compiti: '' }))
    expect(res.status).toBe(200)
    expect(upsertDi('registro_orario')!.ora_lezione).toBe(3)
  })
})
