/**
 * `POST`/`PATCH /api/gallery`: i bambini che tagghi devono essere dei tuoi plessi.
 *
 * IL DIFETTO (collaudo privacy del 2026-07-31, rilievo F3 — grave).
 * `alunniSenzaConsenso()` interrogava `alunni` con `.in('id', ids)` **senza alcun
 * filtro di sede**, e veniva chiamata **prima** che la sede di scrittura fosse
 * risolta. Quando due o più minori sono taggati e almeno uno è privo di
 * liberatoria, la route risponde 422 con `nomi: [...]` e `ids: [...]`: nome e
 * cognome completi, più l'informazione — di per sé sensibile — che a quel minore
 * *manca la liberatoria fotografica*.
 *
 * Misurato dal tester, con controprova su tre sedi:
 *   segreteria AVERSA → POST con due uuid di minori di GIUGLIANO
 *     ⇒ 422 con i loro 2 nomi veri, coincidenti con l'anagrafica
 *   segreteria CESA → stesso 422, stessi nomi
 *   segreteria GIUGLIANO (che ne ha titolo) → risposta IDENTICA
 * Cioè: sul tagging non esisteva alcun gate di sede. Basta conoscere gli uuid, e
 * un uuid non è un segreto — una segreteria che cambia plesso se li porta dietro.
 *
 * CAUSA RADICE. Il Privacy Lock (DL-041) è nato mono-sede, quando «un uuid di
 * alunno» implicava «un alunno mio». L'audit del 31/07 ha messo lo scope su GET,
 * PATCH e DELETE di questa stessa route, ma `tag_students` è rimasto l'unico
 * ingresso che accetta identificatori di minori senza chiedersi di chi siano.
 *
 * ─── IL SEGUITO, ED È LA PARTE CHE QUESTO FILE NON RACCONTAVA (2026-08-03) ────
 * L'intestazione qui sopra ha detto «POST/PATCH» per tre giorni, ma il file
 * importava **solo `POST`** e tutte le sue `it` chiamavano solo quello. Il gate
 * di sede era stato scritto dentro l'handler della POST — una copia della regola,
 * non una primitiva — e il `PATCH`, che i tag li accetta esattamente come la
 * POST, non l'ha mai avuto: `PATCH {"id":"<mio media>","tag_students":["<uuid di
 * un minore di un'altra sede>"]}` arrivava dritto al Privacy Lock e ne riceveva
 * il **422 con nome e cognome**. Il test non se n'era accorto perché non ha mai
 * chiamato il PATCH: un'intestazione non è un'asserzione.
 *
 * Da oggi il gate è UNO SOLO (`@/lib/gallery/tag-scope`) e questo file lo prova
 * su ENTRAMBI gli handler, con lo stesso identico elenco di casi — perché è
 * esattamente la simmetria che mancava.
 *
 * ─── E LA PARTE CHE MANCAVA ANCORA (verificatore adversariale, 2026-08-03) ───
 * Il gate c'era su tutti e due gli handler, ma guardava **la cosa sbagliata**:
 * i plessi di CHI OPERA, non il plesso DEL MEDIA. Misurato:
 *
 *   admin con le sedi A+B attive
 *   POST /api/gallery  {"scuola_id":"<A>","tag_students":["<minore della sede B>"]}
 *     ⇒ 201, riga con `scuola_id: A` e dentro `tag_students` l'uuid di un
 *       bambino di B
 *
 * Nessuno eccede il proprio titolo — l'admin le due sedi le ha entrambe — eppure
 * l'uuid di un minore finisce nella galleria di un plesso il cui personale su
 * quel bambino titolo non ne ha (`proiettaPerGenitore` protegge i GENITORI, non
 * i colleghi di sede). La proprietà forte è **«i tag appartengono alla sede DEL
 * MEDIA»**, e i due handler la sede del media ce l'hanno già in mano:
 * `resolveScuolaScrittura` per la POST, `media.scuola_id` per la PATCH.
 *
 * ─── IL TEST «SCOPE VUOTO» ERA UN PASSEGGERO, ed è stato tolto da qui ────────
 * L'`it` che diceva «scope di sede vuoto ⇒ si NEGA» restava verde anche
 * disattivando quel ramo del gate: sul PATCH il 403 lo produceva il controllo
 * `media-fuori-sede` a monte (`route.ts`), non il gate dei tag. Ora il ramo
 * dello scope vuoto è provato dove vive, cioè sulla primitiva
 * (`__tests__/lib/gallery-tag-scope.test.ts`), dove niente lo può mascherare —
 * e qui restano solo asserzioni che gli handler possono davvero far cadere.
 *
 * PROVA DI VALIDITÀ (eseguita, 2026-07-31 e ripetuta il 2026-08-03): togliendo il
 * controllo di scope, il primo caso torna 422 con i nomi — cioè il test diventa
 * rosso sull'asserzione che conta, quella sul corpo, non solo sullo status; e
 * rimettendo la sede di CHI OPERA al posto di quella del media, il caso
 * «sede del media» torna 201 con l'uuid del minore altrui nella riga scritta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'

const DOCENTE = '77777777-7777-4777-8777-777777777777'
const MEDIA = '33333333-3333-4333-8333-333333333333'
const MINORE_ALTRA_SEDE_1 = '44444444-4444-4444-8444-444444444444'
const MINORE_ALTRA_SEDE_2 = '55555555-5555-4555-8555-555555555555'
const MINORE_MIO = '66666666-6666-4666-8666-666666666666'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  scuoleDiUtente: vi.fn(),
  alunniSenzaConsenso: vi.fn(),
  logEvento: vi.fn(),
  db: {} as DBFinto,
  scritture: [] as Scrittura[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireDocente,
  requireDocente: h.requireDocente,
  requireUser: vi.fn(),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: h.resolveScuoleAttive,
  resolveScuolaScrittura: h.resolveScuolaScrittura,
  scuoleDiUtente: h.scuoleDiUtente,
}))
// Finto è SOLO il Privacy Lock, che qui fa da testimone: se viene interpellato
// su bambini altrui, il nome esce. Il gate sotto esame (`@/lib/gallery/tag-scope`)
// resta REALE — mockarlo vorrebbe dire collaudare il mock.
vi.mock('@/lib/gallery/privacy', () => ({ alunniSenzaConsenso: h.alunniSenzaConsenso }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(async () => undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  genitoriDiAlunni: vi.fn(async () => []),
  genitoriDiClassi: vi.fn(async () => []),
  genitoriDiScuola: vi.fn(async () => []),
}))
// Si spia SOLO `logEvento`: il resto del logger resta quello vero (e silenzioso
// sotto VITEST), così la riga di diniego si può leggere per davvero.
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => creaFintoSupabase(h.db, [], { scritture: h.scritture }),
}))

import { POST, PATCH } from '@/app/api/gallery/route'

function postReq(tagStudents: string[], sedeDichiarata: string = SEDE_A) {
  return new NextRequest('http://localhost/api/gallery', {
    method: 'POST',
    body: JSON.stringify({
      uploaded_by: DOCENTE,
      file_url: 'uploads/foto.jpg',
      tag_students: tagStudents,
      scuola_id: sedeDichiarata,
    }),
    headers: { 'content-type': 'application/json' },
  })
}

function patchReq(tagStudents: string[]) {
  return new NextRequest('http://localhost/api/gallery', {
    method: 'PATCH',
    body: JSON.stringify({ id: MEDIA, tag_students: tagStudents }),
    headers: { 'content-type': 'application/json' },
  })
}

/** Le righe DAVVERO scritte in `galleria_media_v2`: l'unica prova che conta. */
const mediaScritti = () => h.scritture.filter((s) => s.tabella === 'galleria_media_v2')
/** Solo gli eventi di dominio della galleria (via il rumore di `withRoute`). */
const eventiGalleria = () => h.logEvento.mock.calls.filter((c) => c[0] === 'galleria')

beforeEach(() => {
  vi.clearAllMocks()
  h.scritture = []
  h.db = {
    alunni: [
      { id: MINORE_ALTRA_SEDE_1, nome: 'Nome', cognome: 'Cognome Uno', consenso_privacy: false, scuola_id: SEDE_B },
      { id: MINORE_ALTRA_SEDE_2, nome: 'Nome', cognome: 'Cognome Due', consenso_privacy: false, scuola_id: SEDE_B },
      { id: MINORE_MIO, nome: 'Nome', cognome: 'Cognome Mio', consenso_privacy: true, scuola_id: SEDE_A },
    ],
    // Il media da modificare è del docente e sta nella SUA sede: il PATCH deve
    // fermarsi sui TAG, non sul media — altrimenti il 403 arriverebbe per il
    // motivo sbagliato e questo test non proverebbe niente.
    galleria_media_v2: [
      {
        id: MEDIA,
        uploaded_by: DOCENTE,
        scuola_id: SEDE_A,
        is_broadcast: false,
        tag_students: [],
        target_classes: null,
        caption: 'originale',
      },
    ],
    utenti: [{ id: DOCENTE, ruolo: 'educator', scuola_id: SEDE_A }],
  }
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE_A } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A])
  h.scuoleDiUtente.mockResolvedValue([SEDE_A])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: SEDE_A })
  // Il Privacy Lock direbbe «manca la liberatoria» e rivelerebbe i nomi: non deve
  // nemmeno essere interpellato su bambini che non sono nei plessi di chi chiede.
  h.alunniSenzaConsenso.mockResolvedValue([
    { id: MINORE_ALTRA_SEDE_1, nome: 'Nome Cognome Uno' },
    { id: MINORE_ALTRA_SEDE_2, nome: 'Nome Cognome Due' },
  ])
})

// La stessa regola, le stesse asserzioni, sulle due strade che accettano tag.
const HANDLER = [
  { nome: 'POST', operazione: 'gallery:POST', invia: (tag: string[]) => POST(postReq(tag)) },
  { nome: 'PATCH', operazione: 'gallery:PATCH', invia: (tag: string[]) => PATCH(patchReq(tag)) },
] as const

for (const { nome, operazione, invia } of HANDLER) {
  describe(`${nome} /api/gallery — tagging di minori fuori dai propri plessi`, () => {
    it('non rivela nomi né id, e il Privacy Lock non viene nemmeno interpellato', async () => {
      const res = await invia([MINORE_ALTRA_SEDE_1, MINORE_ALTRA_SEDE_2])

      expect(res.status).toBe(403)
      const corpo = JSON.stringify(await res.json())
      // L'asserzione che conta: il corpo non dice NIENTE di quei bambini.
      expect(corpo).not.toContain('Nome Cognome Uno')
      expect(corpo).not.toContain('Nome Cognome Due')
      expect(corpo).not.toContain(MINORE_ALTRA_SEDE_1)
      expect(corpo).not.toContain(MINORE_ALTRA_SEDE_2)
      // …e il rifiuto arriva PRIMA del Privacy Lock, che leggerebbe l'anagrafica
      // di minori altrui per costruire la lista dei nomi.
      expect(h.alunniSenzaConsenso).not.toHaveBeenCalled()
      expect(mediaScritti()).toEqual([])
    })

    it('il diniego lascia un log di soli CONTEGGI (né nomi né uuid di minori)', async () => {
      await invia([MINORE_ALTRA_SEDE_1, MINORE_ALTRA_SEDE_2])

      const ev = eventiGalleria()
      expect(ev).toHaveLength(1)
      expect(ev[0][1]).toBe('warn')
      expect(ev[0][2]).toMatchObject({ operazione, esito: 'tag-fuori-sede', taggati: 2, fuoriSede: 2 })
      const campi = JSON.stringify(ev[0][2])
      expect(campi).not.toContain('Cognome')
      expect(campi).not.toContain(MINORE_ALTRA_SEDE_1)
    })

    it('un solo tag estraneo basta a negare: non si pubblica «la parte lecita»', async () => {
      const res = await invia([MINORE_MIO, MINORE_ALTRA_SEDE_1])
      expect(res.status).toBe(403)
      expect(mediaScritti()).toEqual([])
      expect(h.alunniSenzaConsenso).not.toHaveBeenCalled()
    })

    // W3-ter — un id malformato è uno SBAGLIO DI CHI CHIAMA, e si dice con un
    // 400. Prima `tag_students` era `z.array(z.string())`: `'pippo'` passava la
    // validazione, arrivava a `.in('id', ['pippo'])` e Postgres esplodeva sul
    // cast (`22P02`); il gate lo raccoglieva su `{ error }` e rispondeva 500.
    // Fail-closed, quindi non era una fuga — ma un 500 dice «guasto nostro» su
    // una richiesta malformata, e riempie di rumore il segnale che serve a
    // distinguere i guasti veri.
    it('un id taggato malformato ⇒ 400 di validazione (non un 500 dal database)', async () => {
      const res = await invia(['pippo'])
      expect(res.status).toBe(400)
      expect(mediaScritti()).toEqual([])
      expect(h.alunniSenzaConsenso).not.toHaveBeenCalled()
    })

    it('CONTROLLO POSITIVO — tutti i tag nei propri plessi ⇒ si passa al Privacy Lock', async () => {
      h.alunniSenzaConsenso.mockResolvedValue([])
      const res = await invia([MINORE_MIO])
      expect(res.status).not.toBe(403)
      expect(h.alunniSenzaConsenso).toHaveBeenCalledTimes(1)
      // …e il Privacy Lock riceve le SEDI, che è ciò che gli impediva di
      // pronunciare il nome di un minore altrui (terzo argomento obbligatorio).
      expect(h.alunniSenzaConsenso.mock.calls[0][2]).toEqual([SEDE_A])
      expect(mediaScritti()).toHaveLength(1)
    })
  })
}

// =============================================================================
// W3 — LO SCOPE DEI TAG È LA SEDE **DEL MEDIA**, NON I PLESSI DI CHI OPERA.
//
// Qui chi opera non eccede il proprio titolo: è un admin che ha DAVVERO tutte e
// due le sedi. Il difetto non è un privilegio in più, è che il dato finisce nel
// posto sbagliato — l'uuid di un minore di B dentro una riga della galleria di
// A, dove il personale su quel bambino titolo non ne ha. Il gate deve chiedere
// «questo bambino è della sede in cui sto scrivendo?», non «è in una delle mie».
//
// ─── COME ERA SCRITTO PRIMA, E PERCHÉ NON PROVAVA NIENTE (2026-08-03) ────────
// Questo blocco usava UN SOLO valore per DUE grandezze diverse: la sede del
// media (`resolveScuolaScrittura` → SEDE_A) e la sede primaria di chi opera
// (`auth.user.scuola_id` → SEDE_A). Con `scuoleDiUtente` = [SEDE_A, SEDE_B],
// anche `plessi[0]` valeva SEDE_A. Tre grandezze, un valore solo: qualunque
// delle tre il codice avesse guardato, il test restava verde. Misurato —
// sostituendo `[scuolaId]` con `[auth.user.scuola_id]` nella POST restavano
// verdi tutti i 22 test del file e 2295 test di `__tests__/api`; sul PATCH,
// `[sedeMedia]` → `plessi[0]` idem.
//
// Ora le tre grandezze sono TENUTE DIVERSE, e l'ordine è invertito apposta:
//   · il media (POST e PATCH) sta nella sede **B**;
//   · chi opera ha [A, B] — A per PRIMO — e la sua sede primaria è **A**.
// Così il minore ammesso è quello di B e quello vietato è quello di A: il
// contrario di ciò che direbbe qualunque scorciatoia basata su chi opera.
// =============================================================================
describe('/api/gallery — i tag appartengono alla sede DEL MEDIA', () => {
  // Alias locali: qui «altra sede» non vuol dire più niente, perché la sede del
  // media non è quella di chi opera. Conta di CHI è il bambino.
  const MINORE_DI_A = MINORE_MIO
  const MINORE_DI_B = MINORE_ALTRA_SEDE_1

  beforeEach(() => {
    // Admin di DUE plessi: nessuno sconfinamento di ruolo, solo di sede.
    // La sua sede PRIMARIA è A, e A è anche il primo dei suoi plessi: sono i
    // due valori su cui il gate potrebbe scivolare, e stanno dalla parte
    // sbagliata rispetto al media.
    h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'admin', scuola_id: SEDE_A } })
    h.resolveScuoleAttive.mockResolvedValue([SEDE_A, SEDE_B])
    h.scuoleDiUtente.mockResolvedValue([SEDE_A, SEDE_B])
    // La sede DEL MEDIA: B, e solo B.
    h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: SEDE_B })
    h.db.galleria_media_v2[0].scuola_id = SEDE_B
    h.db.utenti = [{ id: DOCENTE, ruolo: 'admin', scuola_id: SEDE_A }]
    // Il Privacy Lock NON blocca: così l'unico rifiuto possibile è quello dei
    // tag, e il rosso di questi casi è un `201`/`200` — non un 422 che a occhio
    // somiglia a un diniego e maschererebbe la fuga.
    h.alunniSenzaConsenso.mockResolvedValue([])
  })

  it('POST: media nella sede B, tag di un minore della sede A (dove chi opera ha la sua sede primaria) ⇒ 403', async () => {
    const res = await POST(postReq([MINORE_DI_A], SEDE_B))

    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('TAG_FUORI_SEDE')
    // L'asserzione che conta: nessuna riga, e nessun uuid di minore altrui in giro.
    expect(mediaScritti()).toEqual([])
    expect(JSON.stringify(h.db.galleria_media_v2)).not.toContain(MINORE_DI_A)
    // Il Privacy Lock nemmeno interpellato: pronuncerebbe il nome di quel bambino.
    expect(h.alunniSenzaConsenso).not.toHaveBeenCalled()
  })

  it('PATCH: media della sede B, tag di un minore della sede A ⇒ 403, riga invariata', async () => {
    const res = await PATCH(patchReq([MINORE_DI_A]))

    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('TAG_FUORI_SEDE')
    expect(h.scritture.filter((s) => s.operazione === 'update')).toEqual([])
    expect(h.db.galleria_media_v2[0].tag_students).toEqual([])
    expect(h.alunniSenzaConsenso).not.toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO — POST: un minore DELLA sede del media passa, anche se non è la sede primaria di chi opera', async () => {
    const res = await POST(postReq([MINORE_DI_B], SEDE_B))
    expect(res.status).toBe(201)
    expect(mediaScritti()).toHaveLength(1)
    expect(mediaScritti()[0].valori[0]).toMatchObject({ scuola_id: SEDE_B, tag_students: [MINORE_DI_B] })
  })

  it('CONTROLLO POSITIVO — PATCH: stesso trattamento sull’altra strada che accetta tag', async () => {
    const res = await PATCH(patchReq([MINORE_DI_B]))
    expect(res.status).toBe(200)
    expect(h.db.galleria_media_v2[0].tag_students).toEqual([MINORE_DI_B])
  })

  it('il Privacy Lock riceve LA SEDE DEL MEDIA, non l’elenco dei plessi di chi opera (POST)', async () => {
    await POST(postReq([MINORE_DI_B], SEDE_B))
    // Se ricevesse [SEDE_A, SEDE_B] — o [SEDE_A], la sede primaria — potrebbe
    // pronunciare il nome di un bambino di un plesso in cui quella foto non
    // finirà mai: è la stessa fuga, un metro più in là.
    expect(h.alunniSenzaConsenso.mock.calls[0][2]).toEqual([SEDE_B])
  })

  it('…e lo stesso vale sul PATCH', async () => {
    await PATCH(patchReq([MINORE_DI_B]))
    expect(h.alunniSenzaConsenso.mock.calls[0][2]).toEqual([SEDE_B])
  })

  it('POST: sede di scrittura non risolta ⇒ si nega PRIMA dei tag e del Privacy Lock', async () => {
    h.resolveScuolaScrittura.mockResolvedValue({
      response: NextResponse.json({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }, { status: 403 }),
    })
    const res = await POST(postReq([MINORE_DI_B], SEDE_B))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(mediaScritti()).toEqual([])
    expect(h.alunniSenzaConsenso).not.toHaveBeenCalled()
  })
})
