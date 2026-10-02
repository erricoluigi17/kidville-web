import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// I CANCELLI DEI DESTINATARI DI UN CONTENUTO DI GALLERIA — in un posto solo.
//
// Le quattro regole che decidono «a chi può andare questo contenuto» stavano dentro
// l'handler `POST /api/gallery`. Ora le attraversano due strade — la POST delle foto e
// la POST dei video — e vivono in `@/lib/gallery/cancelli-destinatari`:
//
//   1. il broadcast è riservato alla Direzione             → 403
//   2. un broadcast non può taggare bambini                → 400
//   3. i bambini taggati sono della SEDE del contenuto     → 403 `TAG_FUORI_SEDE`
//   4. Privacy Lock (DL-041): in un gruppo serve la liberatoria di ognuno → 422 con i nomi
//
// ─── COSA PROVA QUESTO FILE ──────────────────────────────────────────────────
// A. Le risposte sono QUELLE DI SEMPRE, parola per parola: status, chiavi del corpo e
//    testi. Un client che le legge oggi le legge uguali, e il video deve rispondere lo
//    stesso 422. I testi sono scritti qui per esteso: se qualcuno li tocca, il test dice
//    quale.
// B. L'ORDINE: i primi due cancelli rifiutano PRIMA di qualunque lettura; i tag nella sede
//    si guardano PRIMA del Privacy Lock (che pronuncia nomi di minori).
// C. La sede che si dichiara è quella DEL CONTENUTO, mai un elenco di plessi.
// D. I log sono di soli CONTEGGI: mai un nome, mai un uuid di bambino.
//
// I due controlli sulla sede e sul consenso restano REALI (`tag-scope`, `privacy`) sopra un
// finto database che applica davvero i filtri: mockarli vorrebbe dire misurare il mock
// proprio sui presidi che in questo repo sono già stati aggirati. Sono avvolti da una spia
// solo per leggere con che argomenti e in che ordine vengono chiamati.
// =============================================================================

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

const spia = vi.hoisted(() => ({ scope: vi.fn(), consenso: vi.fn() }))
vi.mock('@/lib/gallery/tag-scope', async (originale) => {
  const reale = await originale<typeof import('@/lib/gallery/tag-scope')>()
  spia.scope.mockImplementation(reale.assertTagStudentsInScope)
  return { ...reale, assertTagStudentsInScope: spia.scope }
})
vi.mock('@/lib/gallery/privacy', async (originale) => {
  const reale = await originale<typeof import('@/lib/gallery/privacy')>()
  spia.consenso.mockImplementation(reale.alunniSenzaConsenso)
  return { ...reale, alunniSenzaConsenso: spia.consenso }
})

import {
  cancelliBroadcastGalleria,
  cancelliDestinatariGalleria,
  cancelliSedeGalleria,
} from '@/lib/gallery/cancelli-destinatari'

// ── I TRE TESTI SENZA CATALOGO, com'erano in `POST /api/gallery` ──
const MSG_BROADCAST_NON_CONSENTITO = 'Solo la Direzione (admin o coordinatore) può pubblicare in broadcast.'
const MSG_BROADCAST_CON_TAG =
  'Una foto in broadcast non può taggare bambini: va a tutta la classe o a tutta la sede. Pubblicala senza tag, oppure togli il broadcast e tagga solo chi ha la liberatoria foto.'
const MSG_LIBERATORIA =
  'Foto di gruppo non pubblicabile: alcuni bambini taggati non hanno la liberatoria foto. Rimuovili dai tag oppure pubblica per ognuno una foto singola (visibile solo ai suoi genitori).'

const ADA = 'aaaaaaaa-1111-4111-8111-11111111111a'
const BEA = 'bbbbbbbb-1111-4111-8111-11111111111b'
const CARLO = 'cccccccc-1111-4111-8111-11111111111c'
const ALTRA_SEDE = 'dddddddd-1111-4111-8111-11111111111d'
const ARCHIVIATO = 'eeeeeeee-1111-4111-8111-11111111111e'

let db: DBFinto
let tabelleLette: string[]

/** Il finto database: tre bambini della sede A (uno senza liberatoria), uno di B, uno ritirato. */
function ripristinaDb() {
  db = {
    alunni: [
      { id: ADA, nome: 'Ada', cognome: 'Rossi', consenso_privacy: true, scuola_id: SEDE_A, stato: 'iscritto' },
      { id: BEA, nome: 'Bea', cognome: 'Verdi', consenso_privacy: false, scuola_id: SEDE_A, stato: 'iscritto' },
      { id: CARLO, nome: 'Carlo', cognome: 'Neri', consenso_privacy: true, scuola_id: SEDE_A, stato: 'iscritto' },
      { id: ALTRA_SEDE, nome: 'Dino', cognome: 'Gialli', consenso_privacy: false, scuola_id: SEDE_B, stato: 'iscritto' },
      { id: ARCHIVIATO, nome: 'Elio', cognome: 'Blu', consenso_privacy: true, scuola_id: SEDE_A, stato: 'ritirato' },
    ],
  }
  tabelleLette = []
}
const client = () => creaFintoSupabase(db, tabelleLette)

const eventiGalleria = () => log.logEvento.mock.calls.filter((c) => c[0] === 'galleria')

beforeEach(() => {
  vi.clearAllMocks()
  ripristinaDb()
})

describe('prima metà — broadcast: nessuna lettura, nessuna sede', () => {
  it('un educatore che chiede il broadcast prende 403, col corpo di sempre e nessun log', async () => {
    const esito = cancelliBroadcastGalleria({
      ruolo: 'educator',
      tagAlunni: [],
      broadcast: true,
      classi: ['2 ANNI'],
      operazione: 'gallery:POST',
    })
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.cancello).toBe('broadcast-non-consentito')
    expect(esito.response.status).toBe(403)
    // Le chiavi sono SOLO `error`: nessun `codice` inventato (il debito è dichiarato nella testata).
    expect(await esito.response.json()).toEqual({ error: MSG_BROADCAST_NON_CONSENTITO })
    // La UI lo nasconde già agli educatori: oggi il rifiuto non lascia riga, e non ne lascia ora.
    expect(log.logEvento).not.toHaveBeenCalled()
  })

  it.each(['educator', 'segreteria', 'genitore', 'cuoca', ''])(
    'il ruolo ATTIVO «%s» non è Direzione: 403',
    async (ruolo) => {
      const esito = cancelliBroadcastGalleria({
        ruolo,
        tagAlunni: [],
        broadcast: true,
        classi: [],
        operazione: 'gallery:POST',
      })
      expect(esito.ok).toBe(false)
      if (!esito.ok) expect(esito.response.status).toBe(403)
    },
  )

  it.each(['admin', 'coordinator'])('il ruolo «%s» è Direzione: il broadcast senza tag passa', (ruolo) => {
    const esito = cancelliBroadcastGalleria({
      ruolo,
      tagAlunni: [],
      broadcast: true,
      classi: ['2 ANNI'],
      operazione: 'gallery:POST',
    })
    expect(esito).toEqual({
      ok: true,
      destinatari: { tagAlunni: [], broadcast: true, classi: ['2 ANNI'] },
    })
  })

  it('un broadcast CON bambini taggati prende 400, col testo di sempre e un log di soli conteggi', async () => {
    const esito = cancelliBroadcastGalleria({
      ruolo: 'admin',
      tagAlunni: [ADA, BEA, ADA],
      broadcast: true,
      classi: [],
      operazione: 'gallery:POST',
    })
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.cancello).toBe('broadcast-con-tag')
    expect(esito.response.status).toBe(400)
    expect(await esito.response.json()).toEqual({ error: MSG_BROADCAST_CON_TAG })

    expect(log.logEvento).toHaveBeenCalledTimes(1)
    const [evento, livello, campi] = log.logEvento.mock.calls[0]
    expect(evento).toBe('galleria')
    expect(livello).toBe('warn')
    // `taggati` conta i bambini DISTINTI: due volte lo stesso id è un bambino solo.
    expect(campi).toEqual({
      operazione: 'gallery:POST',
      esito: 'broadcast-con-tag',
      tipo: 'broadcast-con-tag',
      taggati: 2,
    })
    expect(JSON.stringify(log.logEvento.mock.calls)).not.toContain(ADA)
    expect(JSON.stringify(log.logEvento.mock.calls)).not.toContain(BEA)
  })

  it('il 403 viene PRIMA del 400: un educatore con broadcast e tag prende 403', async () => {
    const esito = cancelliBroadcastGalleria({
      ruolo: 'educator',
      tagAlunni: [ADA],
      broadcast: true,
      classi: [],
      operazione: 'gallery:POST',
    })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.cancello).toBe('broadcast-non-consentito')
      expect(esito.response.status).toBe(403)
    }
    // …e il 400 non ha lasciato la sua riga: l'ordine è quello di `POST /api/gallery`.
    expect(log.logEvento).not.toHaveBeenCalled()
  })

  it('senza broadcast i dati escono in forma canonica: tag distinti, classi senza voci vuote né doppioni', () => {
    const esito = cancelliBroadcastGalleria({
      ruolo: 'educator',
      tagAlunni: [BEA, ADA, BEA],
      broadcast: false,
      classi: ['2 ANNI', '', '3 ANNI', '2 ANNI'],
      operazione: 'gallery:POST',
    })
    // L'ordine d'arrivo dei tag si conserva: non c'è un motivo per riordinarli.
    expect(esito).toEqual({
      ok: true,
      destinatari: { tagAlunni: [BEA, ADA], broadcast: false, classi: ['2 ANNI', '3 ANNI'] },
    })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['false', false],
  ])('`broadcast: %s` vale «no», e tag e classi assenti valgono elenchi vuoti', (_nome, valore) => {
    const esito = cancelliBroadcastGalleria({
      ruolo: 'educator',
      tagAlunni: null,
      broadcast: valore,
      classi: undefined,
      operazione: 'gallery:POST',
    })
    expect(esito).toEqual({ ok: true, destinatari: { tagAlunni: [], broadcast: false, classi: [] } })
  })

  it('NON pretende dei destinatari: una foto senza tag e senza classi va a tutta la sede, da sempre', () => {
    // «Almeno un bambino oppure il broadcast» è una regola dei VIDEO, e la applica la POST dei
    // video. Se stesse qui, ogni foto senza tag diventerebbe un 400.
    const esito = cancelliBroadcastGalleria({
      ruolo: 'educator',
      tagAlunni: [],
      broadcast: false,
      classi: [],
      operazione: 'gallery:POST',
    })
    expect(esito.ok).toBe(true)
  })
})

describe('seconda metà — la sede del contenuto: bambini, poi Privacy Lock', () => {
  it('passa la sede DEL CONTENUTO (e solo quella) a tutti e due i controlli, con l’operazione', async () => {
    const supabase = client()
    const esito = await cancelliSedeGalleria(supabase, {
      sedeId: SEDE_A,
      tagAlunni: [ADA, CARLO],
      operazione: 'gallery:POST',
    })
    expect(esito).toEqual({ ok: true })
    expect(spia.scope).toHaveBeenCalledTimes(1)
    expect(spia.scope).toHaveBeenCalledWith(supabase, [ADA, CARLO], [SEDE_A], 'gallery:POST')
    expect(spia.consenso).toHaveBeenCalledTimes(1)
    expect(spia.consenso).toHaveBeenCalledWith(supabase, [ADA, CARLO], [SEDE_A])
  })

  it('i tag si deduplicano prima dei controlli: «due volte lo stesso bambino» non è un gruppo', async () => {
    const esito = await cancelliSedeGalleria(client(), {
      sedeId: SEDE_A,
      tagAlunni: [BEA, BEA],
      operazione: 'gallery:POST',
    })
    // Bea non ha la liberatoria, ma da sola è una foto PRIVATA (solo i suoi genitori la vedono).
    expect(esito).toEqual({ ok: true })
    expect(spia.scope.mock.calls[0][1]).toEqual([BEA])
    expect(spia.consenso.mock.calls[0][1]).toEqual([BEA])
  })

  it('un bambino di un’ALTRA sede: 403 `TAG_FUORI_SEDE`, senza nomi né id, e il Privacy Lock non parte', async () => {
    const esito = await cancelliSedeGalleria(client(), {
      sedeId: SEDE_A,
      tagAlunni: [ADA, ALTRA_SEDE],
      operazione: 'gallery:POST',
    })
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.cancello).toBe('tag-in-sede')
    expect(esito.response.status).toBe(403)
    const corpo = await esito.response.json()
    expect(corpo.codice).toBe('TAG_FUORI_SEDE')
    const testo = JSON.stringify(corpo)
    expect(testo).not.toContain('Dino')
    expect(testo).not.toContain('Gialli')
    expect(testo).not.toContain(ALTRA_SEDE)
    // L'ORDINE È LA CORREZIONE: il Privacy Lock pronuncia nomi di minori e non deve essere
    // interpellato su bambini che chi chiama non ha titolo di conoscere.
    expect(spia.consenso).not.toHaveBeenCalled()
  })

  it('un bambino non più iscritto: 403 col suo codice, e il Privacy Lock non parte', async () => {
    const esito = await cancelliSedeGalleria(client(), {
      sedeId: SEDE_A,
      tagAlunni: [ADA, ARCHIVIATO],
      operazione: 'gallery:POST',
    })
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.response.status).toBe(403)
    expect((await esito.response.json()).codice).toBe('TAG_ALUNNO_NON_ISCRITTO')
    expect(spia.consenso).not.toHaveBeenCalled()
  })

  it('manca la liberatoria in un gruppo: 422 col testo di sempre e i nomi/id di chi manca', async () => {
    const esito = await cancelliSedeGalleria(client(), {
      sedeId: SEDE_A,
      tagAlunni: [ADA, BEA],
      operazione: 'gallery:POST',
    })
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.cancello).toBe('liberatoria')
    expect(esito.response.status).toBe(422)
    // `toEqual` sul corpo INTERO: chiavi e testi, e nessun'altra chiave in più.
    expect(await esito.response.json()).toEqual({
      error: MSG_LIBERATORIA,
      nomi: ['Bea Verdi'],
      ids: [BEA],
    })
  })

  it('il log del Privacy Lock è `info` e di soli CONTEGGI: i nomi vanno al client, mai nel log', async () => {
    await cancelliSedeGalleria(client(), {
      sedeId: SEDE_A,
      tagAlunni: [ADA, BEA],
      operazione: 'gallery:POST',
    })
    const ev = eventiGalleria()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('info')
    expect(ev[0][2]).toEqual({
      operazione: 'gallery:POST',
      esito: 'liberatoria-mancante',
      taggati: 2,
      senzaConsenso: 1,
    })
    const tutto = JSON.stringify(log.logEvento.mock.calls)
    expect(tutto).not.toContain('Bea')
    expect(tutto).not.toContain('Verdi')
    expect(tutto).not.toContain(BEA)
    expect(Object.keys(ev[0][2] as object)).not.toContain('nomi')
    expect(Object.keys(ev[0][2] as object)).not.toContain('ids')
  })

  it('una foto PRIVATA (un solo bambino) passa anche senza liberatoria', async () => {
    const esito = await cancelliSedeGalleria(client(), {
      sedeId: SEDE_A,
      tagAlunni: [BEA],
      operazione: 'gallery:POST',
    })
    expect(esito).toEqual({ ok: true })
  })

  it('senza bambini non si interroga il database: né per la sede né per il consenso', async () => {
    const esito = await cancelliSedeGalleria(client(), {
      sedeId: SEDE_A,
      tagAlunni: [],
      operazione: 'gallery:POST',
    })
    expect(esito).toEqual({ ok: true })
    expect(tabelleLette).toEqual([])
  })

  it('l’etichetta della route che chiede finisce nei log, non nella risposta', async () => {
    const esito = await cancelliSedeGalleria(client(), {
      sedeId: SEDE_A,
      tagAlunni: [ADA, ALTRA_SEDE],
      operazione: 'video-uploads:POST',
    })
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    const ev = eventiGalleria()
    expect(ev[0][2]).toMatchObject({ operazione: 'video-uploads:POST', esito: 'tag-fuori-sede' })
    expect(JSON.stringify(await esito.response.json())).not.toContain('video-uploads')

    log.logEvento.mockClear()
    await cancelliSedeGalleria(client(), {
      sedeId: SEDE_A,
      tagAlunni: [ADA, BEA],
      operazione: 'video-uploads:POST',
    })
    expect(eventiGalleria()[0][2]).toMatchObject({ operazione: 'video-uploads:POST', esito: 'liberatoria-mancante' })
  })

  it('la sede è quella DEL CONTENUTO: lo stesso bambino è «fuori sede» in un altro plesso', async () => {
    // Ada è della sede A. Chiesta come contenuto della sede B (un admin di due plessi, che
    // dichiara B) non passa: i tag appartengono alla sede DEL MEDIA, non ai plessi di chi opera.
    const esito = await cancelliSedeGalleria(client(), {
      sedeId: SEDE_B,
      tagAlunni: [ADA],
      operazione: 'gallery:POST',
    })
    expect(esito.ok).toBe(false)
    if (!esito.ok) expect((await esito.response.json()).codice).toBe('TAG_FUORI_SEDE')
    expect(spia.scope.mock.calls[0][2]).toEqual([SEDE_B])
  })
})

describe('i quattro cancelli di seguito — per chi ha già la sede (la POST dei video)', () => {
  it('un broadcast non consentito si ferma PRIMA di tutto: né sede né consenso, nessuna lettura', async () => {
    const esito = await cancelliDestinatariGalleria(client(), {
      ruolo: 'educator',
      sedeId: SEDE_A,
      tagAlunni: [ADA, BEA],
      broadcast: true,
      classi: [],
      operazione: 'video-uploads:POST',
    })
    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.cancello).toBe('broadcast-non-consentito')
    expect(spia.scope).not.toHaveBeenCalled()
    expect(spia.consenso).not.toHaveBeenCalled()
    expect(tabelleLette).toEqual([])
  })

  it('un broadcast con tag prende 400 senza leggere niente', async () => {
    const esito = await cancelliDestinatariGalleria(client(), {
      ruolo: 'coordinator',
      sedeId: SEDE_A,
      tagAlunni: [ADA],
      broadcast: true,
      classi: [],
      operazione: 'video-uploads:POST',
    })
    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.response.status).toBe(400)
    expect(tabelleLette).toEqual([])
  })

  it('i tag nella sede vengono PRIMA del Privacy Lock (ordine delle chiamate)', async () => {
    await cancelliDestinatariGalleria(client(), {
      ruolo: 'educator',
      sedeId: SEDE_A,
      tagAlunni: [ADA, BEA],
      broadcast: false,
      classi: [],
      operazione: 'video-uploads:POST',
    })
    expect(spia.scope.mock.invocationCallOrder[0]).toBeLessThan(spia.consenso.mock.invocationCallOrder[0])
  })

  it('il 422 di un video è IDENTICO a quello della galleria: stesso testo, stesse chiavi', async () => {
    const esito = await cancelliDestinatariGalleria(client(), {
      ruolo: 'educator',
      sedeId: SEDE_A,
      tagAlunni: [ADA, BEA],
      broadcast: false,
      classi: [],
      operazione: 'video-uploads:POST',
    })
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.response.status).toBe(422)
    expect(await esito.response.json()).toEqual({ error: MSG_LIBERATORIA, nomi: ['Bea Verdi'], ids: [BEA] })
  })

  it('tutto in regola: restituisce i destinatari in forma canonica', async () => {
    const esito = await cancelliDestinatariGalleria(client(), {
      ruolo: 'educator',
      sedeId: SEDE_A,
      tagAlunni: [CARLO, ADA, CARLO],
      broadcast: null,
      classi: ['', '2 ANNI'],
      operazione: 'video-uploads:POST',
    })
    expect(esito).toEqual({
      ok: true,
      destinatari: { tagAlunni: [CARLO, ADA], broadcast: false, classi: ['2 ANNI'] },
    })
    // Il Privacy Lock ha visto i bambini DISTINTI, e la sede.
    expect(spia.consenso).toHaveBeenCalledWith(expect.anything(), [CARLO, ADA], [SEDE_A])
  })

  it('un broadcast della Direzione senza tag passa, e non legge l’anagrafica', async () => {
    const esito = await cancelliDestinatariGalleria(client(), {
      ruolo: 'admin',
      sedeId: SEDE_A,
      tagAlunni: [],
      broadcast: true,
      classi: ['3 ANNI'],
      operazione: 'video-uploads:POST',
    })
    expect(esito).toEqual({
      ok: true,
      destinatari: { tagAlunni: [], broadcast: true, classi: ['3 ANNI'] },
    })
    expect(tabelleLette).toEqual([])
  })
})
