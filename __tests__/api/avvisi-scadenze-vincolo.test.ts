import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// LE DUE SCADENZE DI UN AVVISO — le tre regole, su ENTRAMBE le strade.
//
// Dal 2026-09-19 un avviso ha due momenti distinti invece di una sola `scadenza`
// a grana giorno:
//
//   · `scadenza_avviso`   — l'istante in cui esce dalla bacheca dei genitori.
//                           OBBLIGATORIO su ogni avviso.
//   · `scadenza_adesione` — l'ultimo istante per aderire. Obbligatorio sugli
//                           avvisi `tipo = 'adesione'`, e mai DOPO l'altro.
//
// ── PERCHÉ IL PUT È LA METÀ CHE CONTA ───────────────────────────────────────
//
// Perché una regola scritta due volte, in questo repo, è già rimasta indietro su
// una delle due strade **due volte su due**: `classiMancantiNellaSede` è nata nel
// POST e il PUT non l'ha mai avuta (10 alunni, 10 genitori, 0 raggiunti), e il
// tetto di lunghezza del titolo è stato chiuso sui promemoria e lasciato aperto
// sugli avvisi. Ogni `describe` qui sotto ha perciò il suo gemello sull'altra
// rotta: un test che prova solo il POST certificherebbe metà del lavoro.
//
// ── E IL PUT HA UNA REGOLA IN PIÙ, CHE È LA CICATRICE DI QUESTO FILE ─────────
//
// 🔴 **Si valuta lo STATO RISULTANTE, mai il corpo della richiesta.** La stessa
// funzione, nello stesso file, il 2026-08-01 leggeva `target_scope` dal BODY e,
// quando il campo mancava, ricadeva su `'globale'` senza pretendere nessuna
// classe — mentre la scrittura azzerava `target_classes`. Un PUT di solo titolo su
// un avviso di classe lo lasciava con ZERO destinatari, rispondendo 200. Le due
// prove che tengono onesta quella regola sono «PUT di solo titolo» e «PUT della
// sola `scadenza_adesione`»: entrambe passano SOLO se la riga già in tabella entra
// nel giudizio.
//
// METODO. Le asserzioni che contano sono sulla MUTAZIONE, non sullo status: un 400
// con l'INSERT già partito sarebbe un falso verde. E ogni diniego ha accanto il suo
// CONTROLLO POSITIVO — un gate che nega tutto passerebbe un test fatto di soli 400,
// e sarebbe il difetto opposto (l'avviso non si pubblica più).
// =============================================================================

const ADMIN = '11111111-1111-4111-8111-111111111111'
const AVVISO_ID = 'cccccccc-0000-4000-8000-00000000000c'
const GENITORE = 'dddddddd-0000-4000-8000-00000000000d'
const CLASSE = 'TEST Infanzia'

/**
 * Le date sono RELATIVE, mai scritte a mano. Un `'2026-12-31'` cablato renderebbe
 * questo file rosso il 1° gennaio per un motivo che non ha niente a che vedere con
 * ciò che prova — e la correzione giusta di un test scaduto col calendario non è
 * congelare l'orologio, è togliere la data.
 */
const fraGiorni = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString()
/** La stessa, nella forma LOCALE `YYYY-MM-DDTHH:MM` che il corpo deve mandare. */
const localeFraGiorni = (n: number) => fraGiorni(n).slice(0, 16)

const FRA_30 = localeFraGiorni(30)
const FRA_20 = localeFraGiorni(20)
const FRA_40 = localeFraGiorni(40)
const IERI = localeFraGiorni(-1)

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  verificaTargetAvvisoDocente: vi.fn(),
  assertAvvisoInScope: vi.fn(),
  notificaEvento: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
  verificaTargetAvvisoDocente: h.verificaTargetAvvisoDocente,
}))
vi.mock('@/lib/avvisi/target-gate', () => ({
  verificaTargetAvvisoDocente: h.verificaTargetAvvisoDocente,
}))
vi.mock('@/lib/auth/scope-avvisi', () => ({ assertAvvisoInScope: h.assertAvvisoInScope }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
// Il logger si spia: il `warn` «tetto sotto l'occupato» è metà della consegna —
// senza di lui quel fatto resterebbe dipinto su una card e non lo saprebbe nessuno.
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        scritture: h.scritture as Scrittura[],
        errori: h.errori,
      }),
  }
})

import { POST } from '@/app/api/avvisi/route'
import { PUT } from '@/app/api/avvisi/[id]/route'

const post = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/avvisi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const put = (body: unknown) =>
  PUT(
    new NextRequest(`http://localhost/api/avvisi/${AVVISO_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: AVVISO_ID }) },
  )

const dbBase = (): DBFinto => ({
  utenti: [{ id: ADMIN, ruolo: 'admin', role: 'admin', scuola_id: SEDE_A }],
  utenti_scuole: [{ utente_id: ADMIN, scuola_id: SEDE_A }],
  sections: [{ id: 'sec-a', scuola_id: SEDE_A, name: CLASSE }],
  alunni: [],
  legame_genitori_alunni: [],
  student_parents: [],
  parents: [],
  admin_settings: [
    { scuola_id: SEDE_A, avvisi_config: { ruoli_pubblicazione: ['admin', 'teacher'] } },
  ],
  avvisi: [
    {
      id: AVVISO_ID,
      author_id: ADMIN,
      titolo: 'Gita al museo',
      contenuto: 'Servono le adesioni entro venerdì.',
      tipo: 'adesione',
      target_scope: 'globale',
      target_classes: null,
      scadenza: null,
      scadenza_avviso: fraGiorni(30),
      scadenza_adesione: fraGiorni(20),
      chiedi_numero: true,
      etichetta_numero: 'Quante persone?',
      numero_min: 1,
      numero_max: 20,
      posti_totali: 50,
      attachment_url: null,
      scuola_id: SEDE_A,
    },
  ],
  // Due famiglie ammesse per 12 persone in tutto: il tetto abbassato a 10 le
  // lascia dentro, e il PUT lo deve REGISTRARE senza toccarle.
  avvisi_risposte: [
    { id: 'r1', avviso_id: AVVISO_ID, parent_id: GENITORE, student_id: 's1', risposta: 'si', letto_il: fraGiorni(-2), stato_adesione: 'ammessa', numero_partecipanti: 4 },
    { id: 'r2', avviso_id: AVVISO_ID, parent_id: 'altro-genitore', student_id: 's2', risposta: 'si', letto_il: fraGiorni(-2), stato_adesione: 'ammessa', numero_partecipanti: 8 },
    { id: 'r3', avviso_id: AVVISO_ID, parent_id: 'terzo-genitore', student_id: 's3', risposta: 'si', letto_il: fraGiorni(-2), stato_adesione: 'in_attesa', numero_partecipanti: 3 },
  ],
  audit_scritture_docente: [],
})

const avvisiInTabella = () => h.db.avvisi ?? []
const rigaAvviso = () => avvisiInTabella().find((a) => a.id === AVVISO_ID)
/** Ogni scrittura registrata dal finto client su una tabella. */
const scrittureSu = (tabella: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)
/** Le righe `warn` con un dato esito, come le ha viste il logger. */
const warn = (esito: string) =>
  h.logEvento.mock.calls
    .filter((c) => c[1] === 'warn' && (c[2] as { esito?: string })?.esito === esito)
    .map((c) => c[2] as Record<string, unknown>)
/** Il `codice` della risposta, che è il canale traducibile (mai la prosa). */
const codice = async (res: Response) => ((await res.json()) as { codice?: string }).codice

const corpoPost = (extra: Record<string, unknown> = {}) => ({
  titolo: 'Gita al museo',
  contenuto: 'Servono le adesioni entro venerdì.',
  target_scope: 'globale',
  scuola_id: SEDE_A,
  scadenza_avviso: FRA_30,
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.requireUser.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.requireDocente.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.verificaTargetAvvisoDocente.mockResolvedValue(null)
  h.assertAvvisoInScope.mockResolvedValue(null)
  h.notificaEvento.mockResolvedValue(undefined)
})

// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/avvisi — le tre regole delle due scadenze', () => {
  it('CONTROLLO POSITIVO: una scadenza sola, nel futuro ⇒ 201 e la riga esiste', async () => {
    const res = await post(corpoPost())
    expect(res.status).toBe(201)
    expect(avvisiInTabella()).toHaveLength(2)
  })

  it('`scadenza_avviso` ASSENTE ⇒ 400: non è più facoltativa', async () => {
    const body = corpoPost()
    delete (body as Record<string, unknown>).scadenza_avviso
    const res = await post(body)
    expect(res.status).toBe(400)
    // Nessuna riga nuova: il rifiuto arriva PRIMA dell'insert.
    expect(avvisiInTabella()).toHaveLength(1)
  })

  it('adesione DOPO l’avviso ⇒ 400 SCADENZE_INCOERENTI, e NESSUN insert', async () => {
    const res = await post(corpoPost({ scadenza_avviso: FRA_30, scadenza_adesione: FRA_40 }))
    expect(res.status).toBe(400)
    expect(await codice(res)).toBe('SCADENZE_INCOERENTI')
    // 🔴 L'asserzione che conta: un 400 con la riga già scritta sarebbe un falso
    // verde, e l'avviso resterebbe in bacheca con due scadenze contraddittorie.
    expect(avvisiInTabella()).toHaveLength(1)
    expect(scrittureSu('avvisi')).toHaveLength(0)
  })

  it('scadenze UGUALI ⇒ ammesse: è la configurazione più naturale che esista', async () => {
    // «Le adesioni si chiudono quando l'avviso sparisce» è ciò che la segreteria
    // ottiene copiando la stessa data nei due campi, e lo farà spesso. Un `>=` al
    // posto del `>` la rifiuterebbe con un messaggio incomprensibile.
    const res = await post(corpoPost({ tipo: 'adesione', scadenza_avviso: FRA_30, scadenza_adesione: FRA_30 }))
    expect(res.status).toBe(201)
    expect(avvisiInTabella()).toHaveLength(2)
  })

  it('`tipo: adesione` SENZA termine per aderire ⇒ 400 SCADENZA_ADESIONE_MANCANTE', async () => {
    // Un avviso di adesione senza termine è un modulo che non si chiude mai: le
    // risposte continuano ad arrivare dopo la gita, e chi conta i posti non ha un
    // momento in cui il numero smette di muoversi.
    const res = await post(corpoPost({ tipo: 'adesione' }))
    expect(res.status).toBe(400)
    expect(await codice(res)).toBe('SCADENZA_ADESIONE_MANCANTE')
    expect(avvisiInTabella()).toHaveLength(1)
  })

  it('una PRESA VISIONE senza termine per aderire resta lecita (il vincolo è condizionato)', async () => {
    const res = await post(corpoPost({ tipo: 'presa_visione' }))
    expect(res.status).toBe(201)
  })

  it('una data che NON esiste sul calendario ⇒ 400 da zod, prima di ogni query', async () => {
    const res = await post(corpoPost({ scadenza_avviso: '2026-02-30T10:00' }))
    expect(res.status).toBe(400)
    expect(avvisiInTabella()).toHaveLength(1)
    // Il 30 febbraio non arriva nemmeno al database: lo ferma la forma.
    expect(scrittureSu('avvisi')).toHaveLength(0)
  })

  it('una scadenza GIÀ PASSATA ⇒ 400 SCADENZA_NEL_PASSATO (solo sul POST)', async () => {
    // Un avviso che nasce già scaduto è sempre uno sbaglio di digitazione: nessuno
    // pubblica qualcosa perché nessuno lo veda.
    const res = await post(corpoPost({ scadenza_avviso: IERI }))
    expect(res.status).toBe(400)
    expect(await codice(res)).toBe('SCADENZA_NEL_PASSATO')
    expect(avvisiInTabella()).toHaveLength(1)
  })

  it('`numero_min` sopra `numero_max` ⇒ 400 NUMERO_INTERVALLO_NON_VALIDO, non un 23514', async () => {
    const res = await post(corpoPost({ chiedi_numero: true, etichetta_numero: 'Persone', numero_min: 10, numero_max: 4 }))
    expect(res.status).toBe(400)
    expect(await codice(res)).toBe('NUMERO_INTERVALLO_NON_VALIDO')
    expect(avvisiInTabella()).toHaveLength(1)
  })

  it('le due scadenze finiscono in tabella come ISTANTI, e `scadenza` non si scrive più', async () => {
    await post(corpoPost({ tipo: 'adesione', scadenza_avviso: FRA_30, scadenza_adesione: FRA_20 }))
    const nuova = avvisiInTabella().find((a) => a.id !== AVVISO_ID) as Record<string, unknown>
    // Istanti assoluti, non le cifre locali arrivate dal client: `istanteDaLocale`
    // le ha ancorate al fuso di Roma. Un ISO dal client porterebbe con sé
    // l'orologio del tablet.
    expect(String(nuova.scadenza_avviso)).toMatch(/\dT\d{2}:\d{2}:\d{2}/)
    expect(Date.parse(String(nuova.scadenza_adesione))).toBeLessThan(Date.parse(String(nuova.scadenza_avviso)))
    // La vecchia colonna la governa il trigger del database: la route non la tocca.
    expect(Object.prototype.hasOwnProperty.call(nuova, 'scadenza')).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('PUT /api/avvisi/[id] — le stesse tre regole, sulla strada accanto', () => {
  it('adesione DOPO l’avviso ⇒ 400 SCADENZE_INCOERENTI e NESSUN update', async () => {
    const res = await put({ titolo: 'Gita al museo', contenuto: 'x', scadenza_avviso: FRA_30, scadenza_adesione: FRA_40 })
    expect(res.status).toBe(400)
    expect(await codice(res)).toBe('SCADENZE_INCOERENTI')
    expect(scrittureSu('avvisi').filter((s) => s.operazione === 'update')).toHaveLength(0)
  })

  it('scadenze UGUALI ⇒ ammesse anche qui', async () => {
    const res = await put({ titolo: 'Gita al museo', contenuto: 'x', scadenza_avviso: FRA_30, scadenza_adesione: FRA_30 })
    expect(res.status).toBe(200)
  })

  it('`tipo: adesione` con il termine per aderire TOLTO esplicitamente ⇒ 400', async () => {
    const res = await put({ titolo: 'Gita al museo', contenuto: 'x', tipo: 'adesione', scadenza_adesione: null })
    expect(res.status).toBe(400)
    expect(await codice(res)).toBe('SCADENZA_ADESIONE_MANCANTE')
  })

  it('una scadenza NEL PASSATO è ammessa: è il gesto con cui si chiude subito un avviso', async () => {
    // 🔴 La differenza voluta col POST. La gita è annullata, le adesioni si fermano
    // adesso: senza questo gesto l'unica alternativa sarebbe cancellare l'avviso,
    // cioè buttare via anche le adesioni già raccolte e le prese visione.
    const res = await put({
      titolo: 'Gita al museo', contenuto: 'x', tipo: 'adesione',
      scadenza_avviso: IERI, scadenza_adesione: IERI,
    })
    expect(res.status).toBe(200)
    expect(Date.parse(String(rigaAvviso()?.scadenza_avviso))).toBeLessThan(Date.now())
  })

  it('…ma la COERENZA vale anche nel passato: solo l’avviso indietro ⇒ 400', async () => {
    // In tabella il termine per aderire è fra 20 giorni. Tirare indietro la sola
    // `scadenza_avviso` lascerebbe un avviso sparito dalla bacheca che accetta
    // ancora adesioni per tre settimane: è di nuovo lo STATO RISULTANTE a decidere,
    // e questa volta a partire dal campo che il corpo NON ha mandato.
    const res = await put({ titolo: 'Gita al museo', contenuto: 'x', scadenza_avviso: IERI })
    expect(res.status).toBe(400)
    expect(await codice(res)).toBe('SCADENZE_INCOERENTI')
  })

  it('`numero_min` sopra `numero_max` ⇒ 400 anche qui, e nessun update', async () => {
    const res = await put({ titolo: 'x', contenuto: 'y', chiedi_numero: true, etichetta_numero: 'P', numero_min: 9, numero_max: 2 })
    expect(res.status).toBe(400)
    expect(await codice(res)).toBe('NUMERO_INTERVALLO_NON_VALIDO')
    expect(scrittureSu('avvisi').filter((s) => s.operazione === 'update')).toHaveLength(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('PUT — SI VALUTA LO STATO RISULTANTE, MAI IL CORPO DELLA RICHIESTA', () => {
  it('REGRESSIONE — un PUT di SOLO TITOLO non sposta nessuna delle due scadenze', async () => {
    // 🔴 Il test che diventa rosso se `risolviScadenze` viene nutrito col BODY
    // invece che con `body ?? riga`: senza la riga, un corpo che non manda scadenze
    // non ne ha nessuna, e questo 200 diventa un 400 su una modifica legittima —
    // la stessa forma esatta del difetto che il 2026-08-01 azzerava i destinatari.
    const prima = { ...(rigaAvviso() as Record<string, unknown>) }
    const res = await put({ titolo: 'Titolo corretto', contenuto: 'Testo nuovo' })

    expect(res.status).toBe(200)
    expect(rigaAvviso()?.titolo).toBe('Titolo corretto')
    expect(rigaAvviso()?.scadenza_avviso).toBe(prima.scadenza_avviso)
    expect(rigaAvviso()?.scadenza_adesione).toBe(prima.scadenza_adesione)
    // Neanche `posti_totali` e `chiedi_numero`: «assente» vuol dire «non toccare».
    expect(rigaAvviso()?.posti_totali).toBe(prima.posti_totali)
    expect(rigaAvviso()?.chiedi_numero).toBe(prima.chiedi_numero)
  })

  it('la sola `scadenza_adesione`, oltre quella IN TABELLA ⇒ 400: la riga entra nel giudizio', async () => {
    // Il corpo non manda `scadenza_avviso`: l'unico modo di accorgersi che le due
    // scadenze sono incoerenti è leggere quella già archiviata (fra 30 giorni).
    const res = await put({ titolo: 'Gita al museo', contenuto: 'x', scadenza_adesione: FRA_40 })
    expect(res.status).toBe(400)
    expect(await codice(res)).toBe('SCADENZE_INCOERENTI')
  })

  it('CONTROLLO POSITIVO: la sola `scadenza_adesione`, PRIMA di quella in tabella ⇒ 200', async () => {
    // Senza questo, il test qui sopra sarebbe verde anche con un gate che nega
    // qualunque modifica della sola scadenza d'adesione.
    const res = await put({ titolo: 'Gita al museo', contenuto: 'x', scadenza_adesione: FRA_20 })
    expect(res.status).toBe(200)
  })

  it('il `tipo` risultante viene dalla riga quando il corpo tace', async () => {
    // La riga è `tipo: 'adesione'`. Togliere il termine senza ridichiarare il tipo
    // deve comunque incontrare il vincolo condizionato.
    const res = await put({ titolo: 'Gita al museo', contenuto: 'x', scadenza_adesione: null })
    expect(res.status).toBe(400)
    expect(await codice(res)).toBe('SCADENZA_ADESIONE_MANCANTE')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('PUT — il tetto abbassato sotto l’occupato: PERMESSO, e REGISTRATO', () => {
  it('tetto 10 con 12 persone ammesse ⇒ 200, warn durevole, e nessuno espulso', async () => {
    const res = await put({ titolo: 'Gita al museo', contenuto: 'x', posti_totali: 10 })

    expect(res.status).toBe(200)
    expect(rigaAvviso()?.posti_totali).toBe(10)

    // Il fatto resta in `app_log`, non solo dipinto su una card: 12 persone in due
    // adesioni ammesse contro un tetto di 10.
    const righe = warn('tetto-sotto-occupato')
    expect(righe).toHaveLength(1)
    expect(righe[0]).toMatchObject({
      operazione: 'avvisi/[id]:PUT',
      posti_totali: 10,
      persone_ammesse: 12,
    })

    // 🔴 L'ASSERZIONE NEGATIVA CHE CONTA: nessuna riga di `avvisi_risposte` viene
    // toccata. Nessuna famiglia esce dalla gita per un campo cambiato in un modulo.
    expect(scrittureSu('avvisi_risposte')).toHaveLength(0)
    expect(h.db.avvisi_risposte).toHaveLength(3)
    expect(h.db.avvisi_risposte.map((r) => r.stato_adesione)).toEqual(['ammessa', 'ammessa', 'in_attesa'])
  })

  it('tetto ALZATO sopra l’occupato ⇒ nessun warn (il fatto non c’è)', async () => {
    const res = await put({ titolo: 'Gita al museo', contenuto: 'x', posti_totali: 90 })
    expect(res.status).toBe(200)
    expect(warn('tetto-sotto-occupato')).toHaveLength(0)
  })

  it('tetto NON toccato ⇒ nessuna lettura in più su `avvisi_risposte`', async () => {
    // La lettura costa: si paga solo quando il tetto cambia davvero, non a ogni
    // salvataggio del titolo.
    await put({ titolo: 'Solo il titolo', contenuto: 'x' })
    expect(h.tabelle.filter((t) => t === 'avvisi_risposte')).toHaveLength(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('PUT — la bandierina del contatore si può spegnere con adesioni già raccolte', () => {
  it('`chiedi_numero: false` ⇒ 200, i numeri restano, e `avvisi_risposte` non si tocca', async () => {
    // Decisione esplicita del committente. Il prossimo che passa penserà di «fare
    // pulizia»: questa è la prova che la pulizia non si fa.
    const res = await put({ titolo: 'Gita al museo', contenuto: 'x', chiedi_numero: false })

    expect(res.status).toBe(200)
    expect(rigaAvviso()?.chiedi_numero).toBe(false)
    expect(scrittureSu('avvisi_risposte')).toHaveLength(0)
    expect(h.db.avvisi_risposte.map((r) => r.numero_partecipanti)).toEqual([4, 8, 3])
  })
})
