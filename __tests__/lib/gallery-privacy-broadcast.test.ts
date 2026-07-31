/**
 * Galleria: il consenso NON lo applica il client.
 *
 * IL DIFETTO (collaudo privacy del 2026-07-31, rilievo F5 — dati di minori).
 * `alunniSenzaConsenso()` usciva con `[]` **prima ancora di interrogare il
 * database** appena `is_broadcast` era vero:
 *
 *     if (isBroadcast || uniqueTags.length <= 1) return []
 *
 * Il vincolo «broadcast ⇒ nessun tag» era imposto SOLO dall'interfaccia
 * (`src/app/(dashboard)/teacher/gallery/page.tsx:304`,
 * `tag_students: f.is_broadcast ? [] : f.tag_students`). Chi chiamava l'API
 * direttamente lo aggirava: `POST /api/gallery` con `is_broadcast: true` e tre
 * bambini taggati senza liberatoria rispondeva **201**, e la foto di gruppo
 * partiva verso l'intera sede — il canale con la platea più ampia, cioè quello
 * che del consenso ha più bisogno.
 *
 * Una regola di privacy applicata dal client non è una regola: è un
 * suggerimento.
 *
 * LE DUE DIFESE, e sono volutamente due:
 *  1. la route rifiuta **400** la combinazione `is_broadcast === true` +
 *     almeno un tag: è la regola che il client già rispettava, ora imposta dal
 *     server (POST e PATCH);
 *  2. `studentiSenzaConsenso`/`alunniSenzaConsenso` applicano il consenso
 *     **anche** al ramo broadcast: se domani la primitiva viene chiamata da
 *     un'altra route, il presidio viaggia con lei e non con chi la invoca.
 *
 * COSA NON CAMBIA: la «foto privata» (≤1 bambino taggato) resta pubblicabile
 * anche senza liberatoria, perché è visibile ai soli genitori di quel bambino.
 * È una scelta dichiarata (DL-041), non una svista.
 *
 * Le asserzioni che contano sono sulla MUTAZIONE (nessuna riga in
 * `galleria_media_v2`), non sullo status: uno status si sbaglia a leggere, una
 * riga scritta no. E ogni negazione ha accanto il suo controllo positivo — il
 * broadcast legittimo e la foto di gruppo con le liberatorie devono continuare
 * a passare, altrimenti un filtro che blocca tutto supererebbe il test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { studentiSenzaConsenso, alunniSenzaConsenso } from '@/lib/gallery/privacy'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'

const SEDE = '11111111-1111-4111-8111-111111111111'
const ADMIN = '22222222-2222-4222-8222-222222222222'
const MEDIA = '33333333-3333-4333-8333-333333333333'
const ALU_1 = '44444444-4444-4444-8444-444444444444'
const ALU_2 = '55555555-5555-4555-8555-555555555555'
const ALU_3 = '66666666-6666-4666-8666-666666666666'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  scuoleDiUtente: vi.fn(),
  logEvento: vi.fn(),
  db: {} as DBFinto,
  scritture: [] as Scrittura[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
  requireStaff: h.requireDocente,
  requireUser: vi.fn(),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: h.resolveScuoleAttive,
  resolveScuolaScrittura: h.resolveScuolaScrittura,
  scuoleDiUtente: h.scuoleDiUtente,
}))
// Il recapito della notifica non è oggetto di questo test: qui si guarda il
// consenso. Restano finti solo i destinatari, non la regola sotto esame.
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(async () => undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  genitoriDiAlunni: vi.fn(async () => []),
  genitoriDiClassi: vi.fn(async () => []),
  genitoriDiScuola: vi.fn(async () => []),
}))
// Si spia SOLO `logEvento`; il resto del logger resta quello vero (e silenzioso
// sotto VITEST).
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => creaFintoSupabase(h.db, [], { scritture: h.scritture }),
}))

import { POST, PATCH } from '@/app/api/gallery/route'

const postReq = (body: unknown) =>
  new NextRequest('http://localhost/api/gallery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const patchReq = (body: unknown) =>
  new NextRequest('http://localhost/api/gallery', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Le righe DAVVERO finite in `galleria_media_v2`: l'unica prova che conta. */
const mediaScritti = () => h.scritture.filter((s) => s.tabella === 'galleria_media_v2')
/** Solo gli eventi di dominio della galleria (via il rumore di `withRoute`). */
const eventiGalleria = () => h.logEvento.mock.calls.filter((c) => c[0] === 'galleria')

/** `consenso_privacy` per i tre bambini del fixture. */
function alunni(consenso: boolean) {
  return [
    { id: ALU_1, nome: 'Uno', cognome: 'Prova', consenso_privacy: consenso, scuola_id: SEDE },
    { id: ALU_2, nome: 'Due', cognome: 'Prova', consenso_privacy: consenso, scuola_id: SEDE },
    { id: ALU_3, nome: 'Tre', cognome: 'Prova', consenso_privacy: consenso, scuola_id: SEDE },
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  h.scritture = []
  h.db = { alunni: alunni(false), galleria_media_v2: [], utenti: [{ id: ADMIN, ruolo: 'admin', scuola_id: SEDE }] }
  // Il broadcast è riservato alla Direzione: senza un admin la route si ferma
  // al 403 di ruolo e il consenso non verrebbe nemmeno interpellato.
  h.requireDocente.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: SEDE })
  h.scuoleDiUtente.mockResolvedValue([SEDE])
})

// -----------------------------------------------------------------------------
// 1. La primitiva pura
// -----------------------------------------------------------------------------
describe('studentiSenzaConsenso — il broadcast non è un lasciapassare', () => {
  const senzaLiberatoria = { [ALU_1]: false, [ALU_2]: false, [ALU_3]: false }
  const conLiberatoria = { [ALU_1]: true, [ALU_2]: true, [ALU_3]: true }

  // Il terzo argomento è stato TOLTO dalla firma, ma TypeScript non gira a
  // runtime: in JavaScript un argomento in più si passa comunque, e il difetto
  // F5 nasceva proprio da lì. Questo alias chiama la funzione come la chiamava
  // il codice di ieri — se un giorno tornasse un parametro che spegne il
  // controllo, questi casi lo raccontano invece di ignorarlo.
  const conCanale = studentiSenzaConsenso as unknown as (
    tag: string[] | null | undefined,
    consensi: Record<string, boolean>,
    broadcast?: boolean,
  ) => string[]

  it('broadcast + tre bambini senza liberatoria → li segnala tutti e tre', () => {
    expect(conCanale([ALU_1, ALU_2, ALU_3], senzaLiberatoria, true)).toEqual([ALU_1, ALU_2, ALU_3])
  })

  it('CONTROLLO POSITIVO — broadcast + gli stessi tre CON liberatoria → []', () => {
    expect(conCanale([ALU_1, ALU_2, ALU_3], conLiberatoria, true)).toEqual([])
  })

  it('la «foto privata» resta una scelta dichiarata: un solo taggato passa anche in broadcast', () => {
    expect(conCanale([ALU_1], senzaLiberatoria, true)).toEqual([])
    expect(conCanale([ALU_1, ALU_1], senzaLiberatoria, true)).toEqual([])
  })

  it('nessun tag → niente da controllare, in broadcast e fuori', () => {
    expect(conCanale([], senzaLiberatoria, true)).toEqual([])
    expect(studentiSenzaConsenso(null, senzaLiberatoria)).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// 2. La primitiva che legge il DB — il difetto stava qui: usciva PRIMA della query
// -----------------------------------------------------------------------------
describe('alunniSenzaConsenso — in broadcast interroga davvero l’anagrafica', () => {
  // Come sopra: si chiama col terzo argomento di ieri, che a runtime esiste
  // ancora eccome. Prima usciva `[]` PRIMA della query — `lette` non conteneva
  // nemmeno `alunni`, cioè il consenso non veniva neanche guardato.
  const conCanale = alunniSenzaConsenso as unknown as (
    db: unknown,
    tag: string[] | null | undefined,
    broadcast?: boolean,
  ) => Promise<{ id: string; nome: string }[]>

  it('broadcast + due bambini senza liberatoria → li restituisce, e ha letto `alunni`', async () => {
    const lette: string[] = []
    const db: DBFinto = { alunni: alunni(false) }
    const senza = await conCanale(creaFintoSupabase(db, lette), [ALU_1, ALU_2], true)
    expect(senza.map((s) => s.id).sort()).toEqual([ALU_1, ALU_2].sort())
    expect(lette).toContain('alunni')
  })

  it('CONTROLLO POSITIVO — broadcast + due bambini CON liberatoria → []', async () => {
    const db: DBFinto = { alunni: alunni(true) }
    const senza = await conCanale(creaFintoSupabase(db, []), [ALU_1, ALU_2], true)
    expect(senza).toEqual([])
  })

  it('lettura dell’anagrafica fallita → fail-CLOSED e un log `error` che lo dice', async () => {
    const db: DBFinto = { alunni: alunni(true) }
    const senza = await alunniSenzaConsenso(
      creaFintoSupabase(db, [], { errori: { alunni: { code: '42703', message: 'column does not exist' } } }),
      [ALU_1, ALU_2],
    )
    // Nessun consenso leggibile ⇒ si nega (e i «nomi» sono gli id, non
    // inventati): la pubblicazione si blocca, non passa per default.
    expect(senza.map((s) => s.id).sort()).toEqual([ALU_1, ALU_2].sort())
    const ev = eventiGalleria()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(ev[0][2]).toMatchObject({ esito: 'lettura-consensi-fallita', taggati: 2 })
    // Nel log solo conteggi: niente nomi di bambini.
    expect(JSON.stringify(ev[0][2])).not.toContain('Prova')
  })
})

// -----------------------------------------------------------------------------
// 3. La route: l'ingresso che il collaudo ha misurato
// -----------------------------------------------------------------------------
describe('POST /api/gallery — broadcast con bambini taggati', () => {
  it('tre bambini senza liberatoria in broadcast → rifiutato e NESSUNA riga scritta', async () => {
    const res = await POST(
      postReq({
        file_url: 'uploads/x.jpg',
        is_broadcast: true,
        target_classes: ['TEST Infanzia'],
        tag_students: [ALU_1, ALU_2, ALU_3],
        scuola_id: SEDE,
      }),
    )
    expect([400, 422]).toContain(res.status)
    // L'asserzione che conta: la foto non è stata pubblicata.
    expect(mediaScritti()).toEqual([])
    // …e il log non porta nomi di bambini, solo conteggi.
    const ev = eventiGalleria()
    expect(ev).toHaveLength(1)
    expect(JSON.stringify(ev[0][2])).not.toContain('Prova')
  })

  it('anche CON le liberatorie, broadcast + tag resta rifiutato: la platea è la sede intera', async () => {
    h.db.alunni = alunni(true)
    const res = await POST(
      postReq({
        file_url: 'uploads/x.jpg',
        is_broadcast: true,
        target_classes: ['TEST Infanzia'],
        tag_students: [ALU_1, ALU_2, ALU_3],
        scuola_id: SEDE,
      }),
    )
    expect(res.status).toBe(400)
    expect(mediaScritti()).toEqual([])
  })

  it('CONTROLLO POSITIVO — il broadcast SENZA tag continua a pubblicarsi (201, riga scritta)', async () => {
    const res = await POST(
      postReq({
        file_url: 'uploads/x.jpg',
        is_broadcast: true,
        target_classes: ['TEST Infanzia'],
        tag_students: [],
        scuola_id: SEDE,
      }),
    )
    expect(res.status).toBe(201)
    expect(mediaScritti()).toHaveLength(1)
    expect(mediaScritti()[0].valori[0]).toMatchObject({ is_broadcast: true, scuola_id: SEDE })
  })

  it('CONTROLLO POSITIVO — foto di gruppo NON broadcast con tutte le liberatorie: 201 e i tre tag in tabella', async () => {
    h.db.alunni = alunni(true)
    const res = await POST(
      postReq({
        file_url: 'uploads/x.jpg',
        is_broadcast: false,
        tag_students: [ALU_1, ALU_2, ALU_3],
        scuola_id: SEDE,
      }),
    )
    expect(res.status).toBe(201)
    expect(mediaScritti()).toHaveLength(1)
    expect(mediaScritti()[0].valori[0]).toMatchObject({
      is_broadcast: false,
      tag_students: [ALU_1, ALU_2, ALU_3],
    })
  })

  it('foto di gruppo NON broadcast senza liberatorie → 422 e nessuna riga (regola invariata)', async () => {
    const res = await POST(
      postReq({
        file_url: 'uploads/x.jpg',
        is_broadcast: false,
        tag_students: [ALU_1, ALU_2],
        scuola_id: SEDE,
      }),
    )
    expect(res.status).toBe(422)
    expect(mediaScritti()).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// 4. La stessa porta, dall'altro lato: la modifica di un media già pubblicato
// -----------------------------------------------------------------------------
describe('PATCH /api/gallery — non si taggano bambini su un media broadcast', () => {
  beforeEach(() => {
    h.db.galleria_media_v2 = [
      {
        id: MEDIA,
        uploaded_by: ADMIN,
        scuola_id: SEDE,
        is_broadcast: true,
        tag_students: [],
        target_classes: ['TEST Infanzia'],
        caption: 'originale',
      },
    ]
  })

  it('aggiungere tre bambini a un media broadcast → rifiutato e NESSUN update', async () => {
    const res = await PATCH(patchReq({ id: MEDIA, tag_students: [ALU_1, ALU_2, ALU_3] }))
    expect([400, 422]).toContain(res.status)
    expect(mediaScritti()).toEqual([])
    expect(h.db.galleria_media_v2[0].tag_students).toEqual([])
  })

  it('CONTROLLO POSITIVO — togliendo il broadcast nella stessa richiesta i tag (con liberatoria) passano', async () => {
    h.db.alunni = alunni(true)
    const res = await PATCH(
      patchReq({ id: MEDIA, is_broadcast: false, tag_students: [ALU_1, ALU_2, ALU_3] }),
    )
    expect(res.status).toBe(200)
    expect(mediaScritti()).toHaveLength(1)
    expect(h.db.galleria_media_v2[0].tag_students).toEqual([ALU_1, ALU_2, ALU_3])
  })

  it('CONTROLLO POSITIVO — la sola didascalia di un broadcast si modifica ancora', async () => {
    const res = await PATCH(patchReq({ id: MEDIA, caption: 'nuova' }))
    expect(res.status).toBe(200)
    expect(h.db.galleria_media_v2[0].caption).toBe('nuova')
  })
})
