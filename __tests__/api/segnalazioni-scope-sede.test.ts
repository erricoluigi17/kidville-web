/**
 * `POST /api/segnalazioni` — si segnala solo ciò che si ha titolo di vedere.
 *
 * ─── IL DIFETTO (verificatore adversariale, 2026-08-03 — W4) ────────────────
 * `verificaAccesso` sembrava avere un controllo per i media di galleria. La
 * condizione REALE era:
 *
 *     if (isGenitore && media.is_broadcast !== true) { …figli taggati… }
 *
 * cioè: per un **NON-genitore** — docente, segreteria, coordinatore, admin —
 * non c'era **ALCUN** controllo. Broadcast o no, taggato o no, sede o no. Una
 * maestra di Aversa poteva aprire una segnalazione su qualunque foto di
 * Giugliano conoscendone l'uuid: la riga nasceva con la `scuola_id` DEL MEDIA —
 * cioè di un plesso non suo — e la notifica «Nuova segnalazione da moderare»
 * partiva verso la Direzione di quel plesso. Non è (solo) rumore: è un canale
 * scritto e notificato dentro una sede in cui chi scrive non ha titolo.
 *
 * Lo stesso valeva per `voce_diario`: il ramo `if (isGenitore)` verificava il
 * legame di famiglia, e per tutti gli altri la voce del diario di QUALUNQUE
 * bambino delle tre sedi era segnalabile.
 *
 * E per il GENITORE il buco era il broadcast: `is_broadcast === true` saltava
 * ogni verifica, quindi una foto istituzionale di un plesso dove non ha figli
 * era segnalabile lo stesso — mentre in `gallery:GET` quella foto non gliela
 * mostra nessuno, perché lì lo scope è la sede del FIGLIO.
 *
 * ─── IL CONTRATTO ──────────────────────────────────────────────────────────
 * L'oggetto segnalato deve stare in una sede del segnalante:
 *   · staff/docente → `scuoleDiUtente` (i plessi dell'utente);
 *   · genitore      → le sedi dei propri FIGLI (`parents` non ha una sede, e non
 *                     deve averla: un genitore può avere figli in due plessi).
 * `messaggio_chat` e `utente` restano scoped dall'IDENTITÀ (partecipazione al
 * thread / contatto legittimo), che è un vincolo più stretto della sede: qui si
 * prova che continua a negare.
 *
 * ─── E LA RIGA DEVE NASCERE IN UN PLESSO (2026-08-03, secondo giro) ──────────
 * Lo scope per identità dice CHI può segnalare e non dice DOVE archiviare.
 * `acc.scuolaId` restava `undefined` proprio per `messaggio_chat` e `utente`, e
 * il ripiego «l'unica sede del segnalante» non scatta per un genitore con figli
 * in due plessi: `sedi.length === 1` falso, `utenti.scuola_id` nullo (i genitori
 * non hanno un plesso proprio), `scuolaUnicaReale()` nullo perché le sedi reali
 * sono tre ⇒ `scuola_id: null`. Da lì, due effetti che si sommano:
 * `staffScuola(null)` non avvisa NESSUNA Direzione, e `admin/segnalazioni:PATCH`
 * rifiuta esplicitamente le righe senza plesso. La segnalazione c'era, la
 * moderazione non l'ha mai vista — e a chi segnalava era stato risposto
 * «inviata».
 *
 * I casi qui sotto tengono ferme tre cose, e ognuna sa diventare rossa da sola:
 *   · la sede viene dall'OGGETTO, non dal primo plesso di chi segnala (le due
 *     grandezze sono tenute DIVERSE apposta: il media sta in B, il segnalante ha
 *     [A, B] — se il codice prendesse `sedi[0]` la riga finirebbe in A);
 *   · quando l'oggetto non ha un plesso e il segnalante ne ha uno solo, è quello
 *     (l'unico caso in cui non si sta indovinando);
 *   · quando non ha un plesso e il segnalante ne ha due, NON si scrive niente:
 *     503, `error` nel log, nessuna riga. Meglio un rifiuto che una riga muta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'

const DOCENTE_A = 'aaaaaaaa-1111-4111-8111-111111111111'
/**
 * Una SECONDA maestra, che insegna nella sede B.
 *
 * Non è simmetria decorativa: con una maestra sola la sezione che fa da ponte e
 * il primo plesso del segnalante finivano per essere lo stesso valore, e i casi
 * «la sede viene dal ponte» restavano verdi anche sostituendo il ponte con
 * `sedi[0]`. Due maestre in due plessi sono il modo più economico di tenere
 * DIVERSE due grandezze che il codice non deve confondere.
 */
const DOCENTE_B = 'aaaaaaaa-2222-4222-8222-222222222222'
const GENITORE_A = 'bbbbbbbb-1111-4111-8111-111111111111'
const ALUNNO_A = 'cccccccc-1111-4111-8111-111111111111'
const ALUNNO_B = 'dddddddd-1111-4111-8111-111111111111'
const MEDIA_A = 'eeeeeeee-1111-4111-8111-111111111111'
const MEDIA_B = 'ffffffff-1111-4111-8111-111111111111'
const VOCE_A = '11111111-1111-4111-8111-111111111111'
const VOCE_B = '22222222-1111-4111-8111-111111111111'
const SEZIONE_A = '33333333-1111-4111-8111-111111111111'
/** La sezione del bambino della sede B: è lei a fare da ponte, ed è in B. */
const SEZIONE_B = '99999999-1111-4111-8111-111111111111'
/** Nessun figlio, nessun thread, nessuna sezione: il controllo negativo di `utente`. */
const ESTRANEO = '55555555-1111-4111-8111-111111111111'
/** Un bambino la cui anagrafica NON dice il plesso: esiste, in produzione. */
const ALUNNO_SENZA_SEDE = '66666666-1111-4111-8111-111111111111'
const THREAD = '77777777-1111-4111-8111-111111111111'
const MESSAGGIO = '88888888-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  scuoleDiUtente: vi.fn(),
  notificaEvento: vi.fn(),
  staffScuola: vi.fn(),
  scuolaUnicaReale: vi.fn(),
  logEvento: vi.fn(),
  db: {} as DBFinto,
  scritture: [] as Scrittura[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
}))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: h.scuoleDiUtente }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: h.staffScuola,
  scuolaUnicaReale: h.scuolaUnicaReale,
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => creaFintoSupabase(h.db, [], { scritture: h.scritture }),
}))

import { POST } from '@/app/api/segnalazioni/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/segnalazioni', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Le righe DAVVERO inserite in `segnalazioni`: l'unica prova che conta. */
const segnalazioniScritte = () => h.scritture.filter((s) => s.tabella === 'segnalazioni')

beforeEach(() => {
  vi.clearAllMocks()
  h.scritture = []
  h.db = {
    alunni: [
      { id: ALUNNO_A, scuola_id: SEDE_A, section_id: SEZIONE_A, classe_sezione: '3 ANNI' },
      // Sezione PROPRIA, in SEDE_B: senza, il ramo «sezione in comune» aveva un
      // solo ponte possibile e quel ponte stava nel primo plesso del segnalante.
      { id: ALUNNO_B, scuola_id: SEDE_B, section_id: SEZIONE_B, classe_sezione: '3 ANNI' },
      // Anagrafica incompleta: c'è il bambino, non c'è il plesso. Non è un caso
      // di laboratorio — `gallery:GET` ha un ramo apposta per «alunno senza
      // plesso» — ed è l'unico modo di far restare `acc.scuolaId` nullo dopo la
      // correzione, cioè di provare i rami di ripiego per quello che fanno.
      { id: ALUNNO_SENZA_SEDE, scuola_id: null, section_id: null, classe_sezione: '3 ANNI' },
    ],
    galleria_media_v2: [
      { id: MEDIA_A, scuola_id: SEDE_A, is_broadcast: true, tag_students: [] },
      { id: MEDIA_B, scuola_id: SEDE_B, is_broadcast: true, tag_students: [] },
    ],
    eventi_diario: [
      { id: VOCE_A, alunno_id: ALUNNO_A },
      { id: VOCE_B, alunno_id: ALUNNO_B },
    ],
    // Il genitore è collegato al SOLO bambino della sede A.
    legame_genitori_alunni: [{ genitore_id: GENITORE_A, alunno_id: ALUNNO_A }],
    parents: [],
    student_parents: [],
    chat_threads: [],
    chat_messages: [],
    // Ogni maestra insegna nel PROPRIO plesso: A in SEDE_A, B in SEDE_B. Chi
    // segnala per «sezione in comune» sceglie così quale ponte attraversare, e
    // il ponte non coincide più per forza col primo plesso del segnalante.
    utenti_sezioni: [
      { utente_id: DOCENTE_A, section_id: SEZIONE_A },
      { utente_id: DOCENTE_B, section_id: SEZIONE_B },
    ],
    // ⚠️ `utenti` DEVE esistere in ogni caso, non solo in quello del ripiego.
    // Finché la tabella era vuota, `sedeDiUtente()` rispondeva sempre `null` e
    // l'ordine dichiarato in `route.ts` («prima il bambino del thread, poi il
    // docente») non era provato da niente: invertendo i due `??` restava tutto
    // verde, perché il secondo termine non portava mai un valore. Qui le due
    // sedi sono INCROCIATE apposta nei due casi di chat (bambino in B con
    // maestra in A, bambino in A con maestra in B), così l'inversione fa rosso
    // in tutti e due i versi.
    utenti: [
      { id: DOCENTE_A, scuola_id: SEDE_A },
      { id: DOCENTE_B, scuola_id: SEDE_B },
    ],
    segnalazioni: [],
  }
  h.requireUser.mockResolvedValue({ user: { id: DOCENTE_A, role: 'educator', scuola_id: SEDE_A } })
  h.scuoleDiUtente.mockResolvedValue([SEDE_A])
  h.notificaEvento.mockResolvedValue(undefined)
  h.staffScuola.mockResolvedValue([])
  h.scuolaUnicaReale.mockResolvedValue(null)
})

const comeGenitore = () =>
  h.requireUser.mockResolvedValue({ user: { id: GENITORE_A, role: 'genitore', scuola_id: null } })

/**
 * Lo stesso genitore, ma con DUE figli in DUE plessi — il caso che ha prodotto
 * il guasto. `utenti.scuola_id` resta nullo: un genitore non ha un plesso
 * proprio, e le sue sedi sono soltanto quelle dei figli.
 */
const comeGenitoreDiDuePlessi = () => {
  comeGenitore()
  h.db.legame_genitori_alunni = [
    { genitore_id: GENITORE_A, alunno_id: ALUNNO_A },
    { genitore_id: GENITORE_A, alunno_id: ALUNNO_B },
  ]
}

/** Una conversazione fra il genitore e la maestra, su un bambino preciso. */
const conThreadSu = (alunnoId: string, teacherId: string = DOCENTE_A) => {
  h.db.chat_messages = [{ id: MESSAGGIO, thread_id: THREAD }]
  h.db.chat_threads = [
    { id: THREAD, teacher_id: teacherId, parent_id: GENITORE_A, student_id: alunnoId },
  ]
}

/**
 * Nessuna delle due maestre ha un plesso in anagrafica.
 *
 * Serve ai casi che provano i RIPIEGHI a valle: da quando `utenti` è popolato
 * nel `beforeEach`, `sedeDiUtente()` risponde e la catena si ferma prima —
 * quindi «né bambino né docente con plesso» va DETTO, altrimenti quei casi
 * resterebbero verdi misurando un'altra cosa.
 */
const conDocenteSenzaPlesso = () => {
  h.db.utenti = [
    { id: DOCENTE_A, scuola_id: null },
    { id: DOCENTE_B, scuola_id: null },
  ]
}

/** La riga scritta in `segnalazioni` (una sola, in questi casi). */
const rigaScritta = () => segnalazioniScritte()[0]?.valori[0]

describe('POST /api/segnalazioni — isolamento fra sedi (staff/docente)', () => {
  it('media di un ALTRO plesso ⇒ 403, nessuna riga, nessuna notifica', async () => {
    const res = await POST(req({ tipo_oggetto: 'media_galleria', oggetto_id: MEDIA_B, categoria: 'spam' }))

    expect(res.status).toBe(403)
    expect(segnalazioniScritte()).toEqual([])
    expect(h.notificaEvento.mock.calls.length).toBe(0)
  })

  it('voce di diario di un bambino di un ALTRO plesso ⇒ 403, nessuna riga', async () => {
    const res = await POST(req({ tipo_oggetto: 'voce_diario', oggetto_id: VOCE_B, categoria: 'informazione_falsa' }))

    expect(res.status).toBe(403)
    expect(segnalazioniScritte()).toEqual([])
  })

  it('il 403 non nomina nessuno: né il bambino, né la sede, né l’uuid dell’oggetto', async () => {
    const res = await POST(req({ tipo_oggetto: 'media_galleria', oggetto_id: MEDIA_B, categoria: 'spam' }))
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain(MEDIA_B)
    expect(corpo).not.toContain(SEDE_B)
    expect(corpo).not.toContain(ALUNNO_B)
  })

  it('CONTROLLO POSITIVO — media del PROPRIO plesso ⇒ 201, riga con la sede del media', async () => {
    const res = await POST(req({ tipo_oggetto: 'media_galleria', oggetto_id: MEDIA_A, categoria: 'spam' }))

    expect(res.status).toBe(201)
    expect(segnalazioniScritte()).toHaveLength(1)
    expect(segnalazioniScritte()[0].valori[0]).toMatchObject({
      scuola_id: SEDE_A,
      segnalante_id: DOCENTE_A,
      tipo_oggetto: 'media_galleria',
    })
  })

  it('CONTROLLO POSITIVO — voce di diario del proprio plesso ⇒ 201, e la riga porta un plesso', async () => {
    const res = await POST(req({ tipo_oggetto: 'voce_diario', oggetto_id: VOCE_A, categoria: 'spam' }))
    expect(res.status).toBe(201)
    expect(segnalazioniScritte()).toHaveLength(1)
    // Fino al 2026-08-03 questo caso asseriva solo status e conteggio: la
    // `scuola_id` di una segnalazione su `voce_diario` non era guardata da
    // NESSUN caso del file, e `scuolaId: sedi[0]` al posto della sede
    // dell'alunno sarebbe passato liscio. Qui le due grandezze coincidono
    // ancora (il docente ha un plesso solo, ed è quello del bambino): è un
    // controllo di presenza, non di provenienza — quella la separa il caso
    // «voce di diario del figlio dell'ALTRO plesso», più sotto.
    expect(rigaScritta().scuola_id).toBe(SEDE_A)
  })

  it('scope di sede VUOTO ⇒ si nega (nessun plesso, nessuna segnalazione)', async () => {
    h.scuoleDiUtente.mockResolvedValue([])
    const res = await POST(req({ tipo_oggetto: 'media_galleria', oggetto_id: MEDIA_A, categoria: 'spam' }))
    expect(res.status).toBe(403)
    expect(segnalazioniScritte()).toEqual([])
  })

  // ⚠️ L'ALTRA METÀ DEL GUASTO «la riga esiste, nessuno la vede».
  //
  // Fino al 2026-08-03 nessun caso di questo file legava i DESTINATARI della
  // notifica alla sede della RIGA: nei 201 con staff `segnalante.scuola_id`
  // coincideva sempre con la sede dell'oggetto, e i casi bi-sede usavano un
  // genitore, che una sede primaria non ce l'ha (`null`). Con quelle fixture
  // `staffScuola(supabase, segnalante.scuola_id ?? scuolaId, …)` restava verde:
  // una segreteria di Aversa che segnala una foto di Giugliano avrebbe
  // archiviato la riga a Giugliano e avvisato la Direzione di Aversa — che su
  // quel contenuto non ha titolo, mentre chi ce l'ha non lo sa. È lo stesso
  // fallimento della riga senza plesso, con un passaggio in più.
  it('operatore BI-SEDE: la riga E la notifica seguono la sede del MEDIA, non la sua sede primaria', async () => {
    // Sede primaria SEDE_A, scope [SEDE_A, SEDE_B]: le due grandezze sono
    // separate, e la seconda non è nemmeno la prima dell'elenco.
    h.requireUser.mockResolvedValue({ user: { id: DOCENTE_A, role: 'segreteria', scuola_id: SEDE_A } })
    h.scuoleDiUtente.mockResolvedValue([SEDE_A, SEDE_B])

    const res = await POST(req({ tipo_oggetto: 'media_galleria', oggetto_id: MEDIA_B, categoria: 'spam' }))

    expect(res.status).toBe(201)
    expect(rigaScritta().scuola_id).toBe(SEDE_B)
    expect(h.staffScuola.mock.calls[0][1]).toBe(SEDE_B)
    expect(h.notificaEvento.mock.calls[0][1]).toMatchObject({ scuolaId: SEDE_B })
  })
})

describe('POST /api/segnalazioni — isolamento fra sedi (genitore)', () => {
  it('foto BROADCAST di un plesso dove non ha figli ⇒ 403 (il broadcast non è un lasciapassare)', async () => {
    comeGenitore()
    const res = await POST(req({ tipo_oggetto: 'media_galleria', oggetto_id: MEDIA_B, categoria: 'contenuto_inappropriato' }))

    expect(res.status).toBe(403)
    expect(segnalazioniScritte()).toEqual([])
  })

  it('CONTROLLO POSITIVO — foto broadcast della sede del proprio figlio ⇒ 201', async () => {
    comeGenitore()
    const res = await POST(req({ tipo_oggetto: 'media_galleria', oggetto_id: MEDIA_A, categoria: 'contenuto_inappropriato' }))

    expect(res.status).toBe(201)
    expect(segnalazioniScritte()).toHaveLength(1)
  })

  // ⚠️ Questo caso, fino al 2026-08-03, si chiamava «la sede della riga NON
  // resta nulla» e usava un genitore MONO-sede: la sede del media e l'unico
  // plesso del segnalante erano lo stesso valore, quindi il test non sapeva
  // dire da quale dei due venisse la riga — e restava verde anche togliendo il
  // ripiego che diceva di proteggere. Qui le due grandezze sono DIVERSE: il
  // media sta in B, il segnalante ha [A, B] con A per primo. Se il codice
  // prendesse `sedi[0]` la riga finirebbe in A, e questo caso diventerebbe
  // rosso — che è l'unico modo di sapere che sta misurando qualcosa.
  it('la sede della riga è quella DEL MEDIA, non il primo plesso di chi segnala', async () => {
    comeGenitoreDiDuePlessi()
    await POST(req({ tipo_oggetto: 'media_galleria', oggetto_id: MEDIA_B, categoria: 'spam' }))

    expect(rigaScritta().scuola_id).toBe(SEDE_B)
    // …e la Direzione avvisata è quella di B: la notifica segue la riga.
    expect(h.staffScuola.mock.calls[0][1]).toBe(SEDE_B)
  })

  it('voce di diario di un bambino non suo ⇒ 403 (il legame di famiglia resta)', async () => {
    comeGenitore()
    const res = await POST(req({ tipo_oggetto: 'voce_diario', oggetto_id: VOCE_B, categoria: 'spam' }))
    expect(res.status).toBe(403)
    expect(segnalazioniScritte()).toEqual([])
  })

  // Il gemello del caso sui media, sul ramo `voce_diario` — che fino al
  // 2026-08-03 non aveva NESSUN caso che ne guardasse la sede. Qui il bambino
  // sta in B e il primo plesso del genitore è A: se la riga prendesse `sedi[0]`
  // la voce del diario di un bambino di Aversa finirebbe da moderare a
  // Giugliano, e questo caso diventa rosso.
  it('voce di diario del figlio dell’ALTRO plesso ⇒ la riga nasce in QUEL plesso', async () => {
    comeGenitoreDiDuePlessi()
    const res = await POST(req({ tipo_oggetto: 'voce_diario', oggetto_id: VOCE_B, categoria: 'informazione_falsa' }))

    expect(res.status).toBe(201)
    expect(rigaScritta().scuola_id).toBe(SEDE_B)
    // …e la Direzione avvisata è la sua: la notifica segue la riga.
    expect(h.staffScuola.mock.calls[0][1]).toBe(SEDE_B)
  })
})

describe('POST /api/segnalazioni — i tipi scoped dall’IDENTITÀ continuano a negare', () => {
  it('messaggio_chat di un thread di cui non si è partecipanti ⇒ 403', async () => {
    h.db.chat_messages = [{ id: VOCE_A, thread_id: '44444444-1111-4111-8111-111111111111' }]
    h.db.chat_threads = [
      { id: '44444444-1111-4111-8111-111111111111', teacher_id: ALUNNO_B, parent_id: ALUNNO_A },
    ]
    const res = await POST(req({ tipo_oggetto: 'messaggio_chat', oggetto_id: VOCE_A, categoria: 'spam' }))
    expect(res.status).toBe(403)
    expect(segnalazioniScritte()).toEqual([])
  })

  it('utente senza nessun rapporto ⇒ 403', async () => {
    // `ESTRANEO` non ha figli, né thread, né sezioni in comune col docente.
    const res = await POST(req({ tipo_oggetto: 'utente', segnalato_id: ESTRANEO, categoria: 'spam' }))
    expect(res.status).toBe(403)
    expect(segnalazioniScritte()).toEqual([])
  })

  it('CONTROLLO POSITIVO — utente con cui esiste una sezione in comune ⇒ 201', async () => {
    const res = await POST(req({ tipo_oggetto: 'utente', segnalato_id: GENITORE_A, categoria: 'spam' }))
    expect(res.status).toBe(201)
    expect(segnalazioniScritte()).toHaveLength(1)
  })

  it('gate anonimo ⇒ 401 prima di qualunque lettura', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) })
    const res = await POST(req({ tipo_oggetto: 'media_galleria', oggetto_id: MEDIA_A, categoria: 'spam' }))
    expect(res.status).toBe(401)
    expect(segnalazioniScritte()).toEqual([])
  })
})

// =============================================================================
// LA SEGNALAZIONE NASCE IN UN PLESSO, SEMPRE — altrimenti non nasce.
//
// È il guasto vero: per `messaggio_chat` e `utente` la sede non veniva dedotta
// da nessuna parte, e per un genitore con figli in due plessi TUTTI i ripieghi
// mancavano il bersaglio (`sedi.length === 1` falso, `utenti.scuola_id` nullo,
// `scuolaUnicaReale()` nullo con tre sedi). La riga nasceva con `scuola_id:
// null`, `staffScuola(null)` non avvisava nessuno e la moderazione la
// rifiutava: una segnalazione che esiste, che nessuno vede, che nessuno può
// chiudere.
// =============================================================================
describe('POST /api/segnalazioni — la riga nasce in un plesso, e la moderazione la vede', () => {
  it('messaggio_chat, genitore con figli in DUE plessi ⇒ la sede è quella del bambino DI QUEL thread', async () => {
    comeGenitoreDiDuePlessi()
    // Il thread parla del bambino della sede B: non è il primo plesso del
    // genitore (che è A) né la sua sede primaria (che è nulla). Se il codice
    // ricadesse su uno dei due ripieghi, qui si vedrebbe.
    //
    // E la maestra del thread è DOCENTE_A, che insegna in SEDE_A: le due sedi
    // sono INCROCIATE, così l'ordine dichiarato in `route.ts` («prima il
    // bambino, poi il docente») è misurato e non solo scritto. Invertire i due
    // `??` fa rosso qui.
    conThreadSu(ALUNNO_B)

    const res = await POST(req({ tipo_oggetto: 'messaggio_chat', oggetto_id: MESSAGGIO, categoria: 'molestie_bullismo' }))

    expect(res.status).toBe(201)
    expect(rigaScritta().scuola_id).toBe(SEDE_B)
    // La riga senza plesso era invisibile in due modi: nessuna Direzione
    // avvisata, e `admin/segnalazioni:PATCH` che la rifiuta. Qui si prova il
    // primo, che è quello che si può osservare da questo lato.
    expect(h.staffScuola.mock.calls[0][1]).toBe(SEDE_B)
    expect(h.notificaEvento.mock.calls[0][1]).toMatchObject({ scuolaId: SEDE_B })
  })

  it('lo stesso genitore, thread sull’ALTRO figlio ⇒ l’altro plesso (non è una costante)', async () => {
    comeGenitoreDiDuePlessi()
    // Incrocio SPECULARE al caso precedente: bambino in A, maestra in B. Così
    // l'inversione dei due `??` fa rosso in tutti e due i versi, e non solo in
    // quello che capita di aver scritto per primo.
    conThreadSu(ALUNNO_A, DOCENTE_B)

    await POST(req({ tipo_oggetto: 'messaggio_chat', oggetto_id: MESSAGGIO, categoria: 'spam' }))

    expect(rigaScritta().scuola_id).toBe(SEDE_A)
  })

  it('utente, contatto per THREAD condiviso ⇒ la sede è quella del bambino del thread', async () => {
    comeGenitoreDiDuePlessi()
    conThreadSu(ALUNNO_B)

    const res = await POST(req({ tipo_oggetto: 'utente', segnalato_id: DOCENTE_A, categoria: 'molestie_bullismo' }))

    expect(res.status).toBe(201)
    expect(rigaScritta().scuola_id).toBe(SEDE_B)
    expect(h.staffScuola.mock.calls[0][1]).toBe(SEDE_B)
  })

  it('utente, contatto per SEZIONE in comune ⇒ la sede è quella del bambino che fa da ponte', async () => {
    // Nessun thread: il rapporto passa dalla sezione, e il ponte è ALUNNO_B —
    // sezione B, sede B — perché si segnala DOCENTE_B, che insegna solo lì.
    //
    // ⚠️ Fino al 2026-08-03 questo caso segnalava DOCENTE_A e il ponte era
    // ALUNNO_A: la sede del ponte (SEDE_A) e il primo plesso del segnalante
    // (SEDE_A) erano lo STESSO valore, quindi il caso non sapeva dire da quale
    // dei due venisse la riga — e restava verde sostituendo
    // `sedePerSezione.get(…)` con `sedi[0]`. Ora le due grandezze sono diverse
    // (ponte in B, `sedi[0]` in A) e quella sostituzione fa rosso.
    comeGenitoreDiDuePlessi()

    const res = await POST(req({ tipo_oggetto: 'utente', segnalato_id: DOCENTE_B, categoria: 'spam' }))

    expect(res.status).toBe(201)
    expect(rigaScritta().scuola_id).toBe(SEDE_B)
    expect(h.staffScuola.mock.calls[0][1]).toBe(SEDE_B)
  })

  it('bambino del thread SENZA plesso ⇒ ripiego sulla sede del DOCENTE del thread', async () => {
    comeGenitoreDiDuePlessi()
    h.db.legame_genitori_alunni.push({ genitore_id: GENITORE_A, alunno_id: ALUNNO_SENZA_SEDE })
    conThreadSu(ALUNNO_SENZA_SEDE)
    // La maestra di quel thread insegna nella sede B: è lei a dire dove va
    // moderata la conversazione, quando l'anagrafica del bambino tace.
    // Si SOVRASCRIVE la sede del `beforeEach` (dove DOCENTE_A sta in SEDE_A)
    // apposta: qui il ripiego deve portare a un plesso che NON è né il primo
    // del segnalante (SEDE_A) né quello che la maestra ha di solito, altrimenti
    // il caso non saprebbe dire da dove viene il valore che asserisce.
    h.db.utenti = [{ id: DOCENTE_A, scuola_id: SEDE_B }]

    const res = await POST(req({ tipo_oggetto: 'messaggio_chat', oggetto_id: MESSAGGIO, categoria: 'spam' }))

    expect(res.status).toBe(201)
    expect(rigaScritta().scuola_id).toBe(SEDE_B)
  })

  it('né bambino né docente con plesso, ma il segnalante ne ha UNO SOLO ⇒ quello (non si indovina niente)', async () => {
    // Genitore mono-sede (solo ALUNNO_A, sede A) con un secondo figlio la cui
    // anagrafica non dice il plesso: `sedi` resta [SEDE_A]. Togliendo il ramo
    // `sedi.length === 1` questo caso diventa 503 — è la prova che quel ramo
    // serve davvero, che il test precedente non sapeva dare.
    comeGenitore()
    // …e il titolo del caso va reso VERO: da quando `utenti` è popolato nel
    // `beforeEach`, senza questa riga la sede arriverebbe dalla maestra e il
    // ramo `sedi.length === 1` non verrebbe nemmeno raggiunto.
    conDocenteSenzaPlesso()
    h.db.legame_genitori_alunni.push({ genitore_id: GENITORE_A, alunno_id: ALUNNO_SENZA_SEDE })
    conThreadSu(ALUNNO_SENZA_SEDE)

    const res = await POST(req({ tipo_oggetto: 'messaggio_chat', oggetto_id: MESSAGGIO, categoria: 'spam' }))

    expect(res.status).toBe(201)
    expect(rigaScritta().scuola_id).toBe(SEDE_A)
    expect(h.staffScuola.mock.calls[0][1]).toBe(SEDE_A)
  })

  it('plesso non attribuibile e segnalante con DUE sedi ⇒ 503, nessuna riga, nessuna notifica', async () => {
    comeGenitoreDiDuePlessi()
    conDocenteSenzaPlesso()
    h.db.legame_genitori_alunni.push({ genitore_id: GENITORE_A, alunno_id: ALUNNO_SENZA_SEDE })
    conThreadSu(ALUNNO_SENZA_SEDE)

    const res = await POST(req({ tipo_oggetto: 'messaggio_chat', oggetto_id: MESSAGGIO, categoria: 'spam' }))

    // Meglio un rifiuto che una riga che nessuno può moderare: chi segnala vede
    // l'errore e può riprovare, la riga muta non la vedeva nessuno.
    expect(res.status).toBe(503)
    expect(segnalazioniScritte()).toEqual([])
    expect(h.notificaEvento.mock.calls.length).toBe(0)
  })

  it('…e quel rifiuto lascia un log di livello `error`, con soli conteggi', async () => {
    comeGenitoreDiDuePlessi()
    conDocenteSenzaPlesso()
    h.db.legame_genitori_alunni.push({ genitore_id: GENITORE_A, alunno_id: ALUNNO_SENZA_SEDE })
    conThreadSu(ALUNNO_SENZA_SEDE)

    await POST(req({ tipo_oggetto: 'messaggio_chat', oggetto_id: MESSAGGIO, categoria: 'spam' }))

    // `error` e non `warn`: un bambino senza plesso è un guasto dell'anagrafica,
    // non una richiesta sbagliata dell'utente.
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'sede-non-attribuibile',
    )
    expect(riga).toBeDefined()
    expect(riga![1]).toBe('error')
    expect(riga![2]).toMatchObject({ operazione: 'segnalazioni:POST', tipo: 'messaggio_chat', sedi: 2 })
    // Mai gli id: sono di minori.
    const campi = JSON.stringify(riga![2])
    expect(campi).not.toContain(ALUNNO_SENZA_SEDE)
    expect(campi).not.toContain(GENITORE_A)
  })

  it('CONTROLLO NEGATIVO — il 503 non è una scorciatoia: chi non partecipa al thread resta 403', async () => {
    comeGenitoreDiDuePlessi()
    // Thread fra due estranei, su un bambino senza plesso: prima si nega per
    // identità, e il ramo della sede non si raggiunge nemmeno.
    h.db.chat_messages = [{ id: MESSAGGIO, thread_id: THREAD }]
    h.db.chat_threads = [
      { id: THREAD, teacher_id: DOCENTE_A, parent_id: ESTRANEO, student_id: ALUNNO_SENZA_SEDE },
    ]

    const res = await POST(req({ tipo_oggetto: 'messaggio_chat', oggetto_id: MESSAGGIO, categoria: 'spam' }))

    expect(res.status).toBe(403)
    expect(segnalazioniScritte()).toEqual([])
  })
})
