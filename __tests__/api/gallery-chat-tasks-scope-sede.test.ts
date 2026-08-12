import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// =============================================================================
// W2-K — Galleria fail-closed, e le due derivazioni del nome-classe che restano.
//
//  · gallery GET SENZA parametri (R51): `let plessi = []` veniva riempito SOLO
//    dentro `if (classe)` o `if (studentId)`, e tutti i campi dello schema zod
//    sono opzionali. `GET /api/gallery` nudo passava la validazione, il gate era
//    `requireDocente` (basta un educator), `plessi` restava `[]` e la guardia
//    `if (conScuola && plessi.length > 0)` SALTAVA il filtro: i 30 media più
//    recenti di TUTTE le sedi, con `tag_students` e `caption`. Lo scope non era
//    «vuoto», non era mai stato CALCOLATO.
//  · il degrado su colonna assente (R51/R137) rileggeva senza filtro di sede
//    invece di contare le sedi come fa la modulistica (`degradoSedeLecito`).
//  · gallery DELETE/PATCH (R110): `if (sedeMedia !== null && !plessi.includes(...))`
//    — con `scuola_id` nullo la condizione è falsa e il controllo non scatta,
//    esattamente al contrario del commento che gli sta sopra. Dopo, per
//    l'educator, si torna all'intersezione dei NOMI di classe.
//  · chat/contacts e tasks (R112): l'ultima copia del frammento che deduce la
//    sezione del docente dagli alunni taggati, senza `.in('scuola_id', plessi)`.
//
// Il finto Supabase applica DAVVERO i filtri: qui non si asserisce «non è 403»,
// si asserisce lo stato ESATTO, il contenuto e l'effetto sul database.
// =============================================================================

const ED_A = '11111111-1111-4111-8111-111111111111'
const ED_ALTRO = '99999999-9999-4999-8999-999999999999'
const SEG_A = '22222222-2222-4222-8222-222222222222'
const GEN_A = '33333333-3333-4333-8333-333333333333'

const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const ALU_SENZA_SEDE = 'c3c3c3c3-3333-4333-8333-cccccccccccc'

const MEDIA_MIO = 'd0d0d0d0-0000-4000-8000-dddddddddddd'
/** Lo stesso media, ma senza il tag «di deriva» su un bambino dell'altra sede. */
const MEDIA_MIO_PULITO = 'd5d5d5d5-5555-4555-8555-dddddddddddd'
const MEDIA_ALTRUI_A = 'd1d1d1d1-1111-4111-8111-dddddddddddd'
const MEDIA_SENZA_SEDE = 'd2d2d2d2-2222-4222-8222-dddddddddddd'
const MEDIA_BC_A = 'd3d3d3d3-3333-4333-8333-dddddddddddd'
const MEDIA_BC_B = 'd4d4d4d4-4444-4444-8444-dddddddddddd'

const CLASSE_A = '3 ANNI'
const CLASSE_OMONIMA = '2 ANNI'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireUser: vi.fn(),
  requireParentOfStudent: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/require-staff')>()),
  requireDocente: h.requireDocente,
  requireUser: h.requireUser,
}))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { errori: h.errori }),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle, { errori: h.errori }),
  }
})
// Si spia SOLO `logEvento` (il resto del logger resta reale e silenzioso sotto
// VITEST): serve a provare che il diniego LASCIA UNA TRACCIA, non solo un 4xx.
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn().mockResolvedValue(undefined) }))

import { GET as GALLERY_GET, DELETE as GALLERY_DELETE, PATCH as GALLERY_PATCH } from '@/app/api/gallery/route'
import { GET as CONTACTS_GET } from '@/app/api/chat/contacts/route'
import { GET as TASKS_GET } from '@/app/api/tasks/route'

const req = (url: string, cookie?: string) =>
  new NextRequest(`http://localhost${url}`, cookie ? { headers: { cookie } } : undefined)

const patchReq = (body: unknown) =>
  new NextRequest('http://localhost/api/gallery', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const eventi = (dominio: string) => h.logEvento.mock.calls.filter((c) => c[0] === dominio)
const esiti = (dominio: string) =>
  eventi(dominio).map((c) => (c[2] as { esito?: string; tipo?: string } | undefined))

const dbBase = (): DBFinto => ({
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ],
  scuole: [
    { id: SEDE_A, attiva: true },
    { id: SEDE_B, attiva: true },
  ],
  utenti_scuole: [],
  // Nessun legame: è la condizione che ATTIVA il fallback storico «deduci la
  // sezione dagli alunni taggati» in chat/contacts e in tasks.
  utenti_sezioni: [],
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: CLASSE_A },
    { id: 'sec-b', scuola_id: SEDE_B, name: CLASSE_OMONIMA },
  ],
  utenti: [
    { id: ED_A, ruolo: 'educator', scuola_id: SEDE_A, nome: 'Ada', cognome: 'Edu' },
    { id: ED_ALTRO, ruolo: 'educator', scuola_id: SEDE_A, nome: 'Ivo', cognome: 'Altro' },
    { id: SEG_A, ruolo: 'segreteria', scuola_id: SEDE_A, nome: 'Sara', cognome: 'Segre' },
    { id: GEN_A, ruolo: 'genitore', scuola_id: SEDE_A, nome: 'Gina', cognome: 'Genitore' },
  ],
  // ALU_B (altra sede) è PRIMO di proposito: il frammento storico chiude con
  // `.limit(1)`, quindi senza filtro di sede è la sua classe che vince.
  alunni: [
    { id: ALU_B, nome: 'Bea', cognome: 'Beta', classe_sezione: CLASSE_OMONIMA, section_id: 'sec-b', scuola_id: SEDE_B, stato: 'iscritto' },
    { id: ALU_A, nome: 'Ali', cognome: 'Alfa', classe_sezione: CLASSE_A, section_id: 'sec-a', scuola_id: SEDE_A, stato: 'iscritto' },
    { id: ALU_SENZA_SEDE, nome: 'Nino', cognome: 'Senzasede', classe_sezione: CLASSE_A, section_id: null, scuola_id: null, stato: 'iscritto' },
  ],
  legame_genitori_alunni: [{ genitore_id: GEN_A, alunno_id: ALU_A }],
  student_parents: [],
  parents: [],
  chat_threads: [],
  galleria_media_v2: [],
  task_interni: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.errori = {}
  h.requireDocente.mockResolvedValue({ user: { id: ED_A, role: 'educator', scuola_id: SEDE_A } })
  h.requireUser.mockResolvedValue({ user: { id: ED_A, role: 'educator', scuola_id: SEDE_A } })
  h.requireParentOfStudent.mockResolvedValue({ user: { id: GEN_A, role: 'genitore', scuola_id: null } })
})

// -----------------------------------------------------------------------------
// gallery GET
// -----------------------------------------------------------------------------

describe('GET /api/gallery — lo scope NON calcolato nega, non elenca tutto', () => {
  beforeEach(() => {
    h.db.galleria_media_v2 = [
      { id: MEDIA_MIO, scuola_id: SEDE_A, uploaded_by: ED_A, is_broadcast: false, tag_students: [ALU_B, ALU_A], target_classes: null, created_at: '2026-07-30T10:00:00.000Z' },
      { id: MEDIA_BC_A, scuola_id: SEDE_A, uploaded_by: ED_ALTRO, is_broadcast: true, tag_students: [], target_classes: [CLASSE_A], created_at: '2026-07-29T10:00:00.000Z' },
      { id: MEDIA_BC_B, scuola_id: SEDE_B, uploaded_by: ED_ALTRO, is_broadcast: true, tag_students: [], target_classes: [CLASSE_A], created_at: '2026-07-28T10:00:00.000Z' },
    ]
  })

  it('senza `classe` né `studentId`: 400, e la tabella dei media NON viene nemmeno letta', async () => {
    const res = await GALLERY_GET(req('/api/gallery'))
    expect(res.status).toBe(400)
    // Il 400 da solo non basterebbe: prova che non è uscita NESSUNA query sui
    // media (il difetto era proprio che ne usciva una senza filtri).
    expect(h.tabelle).not.toContain('galleria_media_v2')
  })

  it('scope vuoto (cookie su una sede non accessibile): NESSUN media, mai «allora eccoti tutto»', async () => {
    // È la prova di validità dello step: rimettendo `if (plessi.length > 0)` la
    // classe omonima dell'altra sede rientra e questo test diventa rosso.
    const res = await GALLERY_GET(req(`/api/gallery?classe=${encodeURIComponent(CLASSE_OMONIMA)}`, `sedi_attive=${SEDE_B}`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { media: { id: string }[]; total: number }
    expect(j.media).toEqual([])
    expect(j.total).toBe(0)
  })

  it('alunno senza sede: 403 e nessuna lettura dei media', async () => {
    const res = await GALLERY_GET(req(`/api/gallery?studentId=${ALU_SENZA_SEDE}`))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('galleria_media_v2')
    expect(esiti('galleria')).toContainEqual(
      expect.objectContaining({ esito: 'alunno-senza-sede' }),
    )
  })

  it('percorso felice: il docente vede il broadcast della SUA sede e non l\'omonimo dell\'altra', async () => {
    const res = await GALLERY_GET(req(`/api/gallery?classe=${encodeURIComponent(CLASSE_A)}`, `sedi_attive=${SEDE_A}`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { media: { id: string }[]; total: number }
    expect(j.media.map((m) => m.id).sort()).toEqual([MEDIA_BC_A, MEDIA_MIO].sort())
    expect(j.total).toBe(2)
  })

  it('colonna `scuola_id` assente con DUE sedi reali: 500 esplicito, NON una rilettura senza filtro', async () => {
    h.errori = { galleria_media_v2: { code: '42703', message: 'column "scuola_id" does not exist' } }
    const res = await GALLERY_GET(req(`/api/gallery?classe=${encodeURIComponent(CLASSE_A)}`, `sedi_attive=${SEDE_A}`))
    expect(res.status).toBe(500)
    // Il corpo distingue il diniego dal 500 generico: col vecchio degrado la
    // route rileggeva e restituiva il messaggio PostgREST della colonna.
    expect(await res.json()).toEqual({ error: 'Isolamento per sede non disponibile' })
    expect(esiti('galleria')).toContainEqual(
      expect.objectContaining({ esito: 'colonna-sede-assente-degrado-negato' }),
    )
  })
})

// -----------------------------------------------------------------------------
// gallery DELETE / PATCH
// -----------------------------------------------------------------------------

describe('DELETE/PATCH /api/gallery — un media senza sede non è di nessuno', () => {
  beforeEach(() => {
    h.db.galleria_media_v2 = [
      { id: MEDIA_SENZA_SEDE, scuola_id: null, uploaded_by: ED_ALTRO, is_broadcast: false, tag_students: [], target_classes: [CLASSE_A], caption: 'originale' },
      { id: MEDIA_ALTRUI_A, scuola_id: SEDE_A, uploaded_by: ED_ALTRO, is_broadcast: false, tag_students: [], target_classes: [CLASSE_OMONIMA], caption: 'della sede A' },
      // MEDIA_MIO porta un tag su un bambino della sede B: è la «deriva storica»
      // che serve ai due test sulla derivazione del nome-classe qui sotto.
      { id: MEDIA_MIO, scuola_id: SEDE_A, uploaded_by: ED_A, is_broadcast: false, tag_students: [ALU_B], target_classes: null, caption: 'mio' },
      // …e questo è lo stesso media SENZA quell'anomalia: serve a provare che il
      // gate dei tag (T05-F1) non ha ristretto la modifica legittima.
      { id: MEDIA_MIO_PULITO, scuola_id: SEDE_A, uploaded_by: ED_A, is_broadcast: false, tag_students: [ALU_A], target_classes: null, caption: 'mio pulito' },
    ]
  })

  it('DELETE: 403 sul media con `scuola_id` NULL, e la riga resta al suo posto', async () => {
    // Segreteria di proposito: cade nel ramo `isAdmin`, che autorizza TUTTO —
    // così l'unica cosa che può produrre il 403 è il controllo di sede.
    h.requireDocente.mockResolvedValue({ user: { id: SEG_A, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await GALLERY_DELETE(req(`/api/gallery?id=${MEDIA_SENZA_SEDE}`))
    expect(res.status).toBe(403)
    expect(h.db.galleria_media_v2.map((m) => m.id)).toEqual([MEDIA_SENZA_SEDE, MEDIA_ALTRUI_A, MEDIA_MIO, MEDIA_MIO_PULITO])
  })

  it('PATCH: 403 sul media con `scuola_id` NULL, e la didascalia non cambia', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: SEG_A, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await GALLERY_PATCH(patchReq({ id: MEDIA_SENZA_SEDE, caption: 'manomesso' }))
    expect(res.status).toBe(403)
    expect(h.db.galleria_media_v2.find((m) => m.id === MEDIA_SENZA_SEDE)?.caption).toBe('originale')
  })

  it('DELETE: le classi del docente si deducono SOLO dai suoi alunni in sede', async () => {
    // ED_A ha taggato (deriva storica) un bambino della sede B: senza filtro le
    // «sue» classi diventano ['2 ANNI'] e autorizzano la cancellazione del media
    // altrui che ha ESATTAMENTE quel nome-classe nella sede A.
    const res = await GALLERY_DELETE(req(`/api/gallery?id=${MEDIA_ALTRUI_A}`))
    expect(res.status).toBe(403)
    expect(h.db.galleria_media_v2.map((m) => m.id)).toContain(MEDIA_ALTRUI_A)
  })

  it('PATCH: le classi del docente si deducono SOLO dai suoi alunni in sede', async () => {
    // Gemello esatto del test DELETE qui sopra: la PATCH ha lo stesso frammento
    // copiato, e il 30/07 ne è stato corretto uno solo. Senza il filtro le «sue»
    // classi diventano ['2 ANNI'] (dal tag su un bambino della sede B) e
    // autorizzano la RISCRITTURA del media altrui omonimo della sede A.
    const res = await GALLERY_PATCH(patchReq({ id: MEDIA_ALTRUI_A, caption: 'manomesso' }))
    expect(res.status).toBe(403)
    expect(h.db.galleria_media_v2.find((m) => m.id === MEDIA_ALTRUI_A)?.caption).toBe('della sede A')
  })

  it('DELETE: il proprio media resta cancellabile (controllo positivo)', async () => {
    const res = await GALLERY_DELETE(req(`/api/gallery?id=${MEDIA_MIO}`))
    expect(res.status).toBe(200)
    expect(h.db.galleria_media_v2.map((m) => m.id)).toEqual([MEDIA_SENZA_SEDE, MEDIA_ALTRUI_A, MEDIA_MIO_PULITO])
  })

  it('PATCH: il proprio media resta modificabile (controllo positivo)', async () => {
    const res = await GALLERY_PATCH(patchReq({ id: MEDIA_MIO_PULITO, caption: 'nuova didascalia' }))
    expect(res.status).toBe(200)
    expect(h.db.galleria_media_v2.find((m) => m.id === MEDIA_MIO_PULITO)?.caption).toBe('nuova didascalia')
  })

  // ── Il tag fuori sede CONGELA il media finché c'è (T05-F1, 2026-08-03) ──────
  // Dal gate sui tag EFFETTIVI discende una conseguenza che è giusto mettere
  // nero su bianco: un media che porta ancora un tag su un bambino di un altro
  // plesso — deriva storica, o un bambino trasferito — non si modifica finché
  // quel tag c'è. È fail-closed su un'anomalia, e la via d'uscita è la stessa
  // richiesta: si rimandano i tag corretti e la riga torna modificabile.
  // (In produzione, al 2026-08-03, `galleria_media_v2` è vuota: nessun media
  // storico da sanare.)
  it('PATCH: la sola didascalia su un media con un tag fuori sede → 403 che non nomina nessuno', async () => {
    const res = await GALLERY_PATCH(patchReq({ id: MEDIA_MIO, caption: 'nuova didascalia' }))
    expect(res.status).toBe(403)
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain('Bea')
    expect(corpo).not.toContain('Beta')
    expect(corpo).not.toContain(ALU_B)
    expect(h.db.galleria_media_v2.find((m) => m.id === MEDIA_MIO)?.caption).toBe('mio')
    expect(esiti('galleria')).toContainEqual(
      expect.objectContaining({ operazione: 'gallery:PATCH', esito: 'tag-fuori-sede', taggati: 1, fuoriSede: 1 }),
    )
  })

  it('PATCH: correggendo i tag nella stessa richiesta, la riga torna modificabile', async () => {
    const res = await GALLERY_PATCH(patchReq({ id: MEDIA_MIO, tag_students: [ALU_A], caption: 'sanata' }))
    expect(res.status).toBe(200)
    const riga = h.db.galleria_media_v2.find((m) => m.id === MEDIA_MIO)
    expect(riga?.caption).toBe('sanata')
    expect(riga?.tag_students).toEqual([ALU_A])
  })
})

// -----------------------------------------------------------------------------
// chat/contacts
// -----------------------------------------------------------------------------

describe('GET /api/chat/contacts — la sezione dedotta dai tag resta in sede', () => {
  beforeEach(() => {
    h.db.galleria_media_v2 = [
      { id: MEDIA_MIO, scuola_id: SEDE_A, uploaded_by: ED_A, is_broadcast: false, tag_students: [ALU_B, ALU_A], target_classes: null },
    ]
  })

  it('deduce «3 ANNI» (sede A) e non «2 ANNI» (sede B), e dichiara la sede del contatto', async () => {
    const res = await CONTACTS_GET(req(`/api/chat/contacts?userId=${ED_A}`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as {
      contacts: { user_id: string; student_id: string; sezione: string; scuola_id: string | null }[]
    }
    expect(j.contacts).toEqual([
      expect.objectContaining({
        user_id: GEN_A,
        student_id: ALU_A,
        sezione: CLASSE_A,
        scuola_id: SEDE_A,
      }),
    ])
  })

  it('la maestra NON può scrivere alla famiglia di un RITIRATO della sua sezione (2026-08-13)', async () => {
    // Il gemello lato maestra della rubrica di segreteria, ed è rimasto cieco un
    // giorno in più perché la sua query nomina la CLASSE: il lock la esentava per
    // forma, con la motivazione «tanto un archiviato è sganciato dalla sezione».
    // Vero per l'archiviazione, falso per la TENDINA della scheda alunno — che
    // porta lo `stato` a `'ritirato'` senza toccare `classe_sezione`. Qui il
    // bambino è esattamente così: stessa classe, stessa sede, stato ritirato.
    h.db.alunni = [
      { id: ALU_A, nome: 'Ali', cognome: 'Alfa', classe_sezione: CLASSE_A, section_id: 'sec-a', scuola_id: SEDE_A, stato: 'ritirato' },
    ]
    const res = await CONTACTS_GET(req(`/api/chat/contacts?userId=${ED_A}`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { contacts: unknown[] }
    expect(j.contacts).toEqual([])
  })

  it('un SOSPESO della sezione resta contattabile: frequenta (2026-08-13)', async () => {
    h.db.alunni = [
      { id: ALU_A, nome: 'Ali', cognome: 'Alfa', classe_sezione: CLASSE_A, section_id: 'sec-a', scuola_id: SEDE_A, stato: 'sospeso' },
    ]
    const j = (await (await CONTACTS_GET(req(`/api/chat/contacts?userId=${ED_A}`))).json()) as {
      contacts: { user_id: string }[]
    }
    expect(j.contacts.map((c) => c.user_id)).toEqual([GEN_A])
  })
})

// -----------------------------------------------------------------------------
// tasks
// -----------------------------------------------------------------------------

describe('GET /api/tasks — le sezioni dedotte dai tag restano in sede', () => {
  beforeEach(() => {
    h.db.galleria_media_v2 = [
      { id: MEDIA_MIO, scuola_id: SEDE_A, uploaded_by: ED_A, is_broadcast: false, tag_students: [ALU_B, ALU_A], target_classes: null },
    ]
    h.db.task_interni = [
      { id: 'task-3anni', author_id: ED_ALTRO, assigned_to: null, target_class: CLASSE_A, titolo: 'Compito 3 ANNI', contenuto: null, completato: false, created_at: '2026-07-30T09:00:00.000Z', scuola_id: SEDE_A },
      { id: 'task-2anni', author_id: ED_ALTRO, assigned_to: null, target_class: CLASSE_OMONIMA, titolo: 'Compito 2 ANNI', contenuto: null, completato: false, created_at: '2026-07-29T09:00:00.000Z', scuola_id: SEDE_A },
    ]
  })

  it('l\'educator vede il task della sua classe, non quello della classe omonima dell\'altra sede', async () => {
    const res = await TASKS_GET(req(`/api/tasks?userId=${ED_A}&filter=all`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j.map((t) => t.id)).toEqual(['task-3anni'])
  })
})
