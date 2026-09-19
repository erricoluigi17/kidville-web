import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// GET /api/avvisi (ramo GENITORE) — gli scaduti escono dal feed, e a deciderlo è
// un CONFRONTO FRA ISTANTI fatto dal database.
//
// ── IL DIFETTO CHIUSO ───────────────────────────────────────────────────────
//
// Fino al 2026-09-19 la route filtrava così:
//
//     const oggi = new Date().toISOString().split('T')[0]   // ← il giorno UTC
//     if (a.scadenza && a.scadenza < oggi) return false     // ← fra STRINGHE
//
// Fra le 00:00 e le 02:00 italiane il server è ancora «ieri»: un avviso scaduto
// restava in bacheca un giorno in più. È la stessa famiglia di difetti che il
// 2026-08-01 alle 01:08 ha fatto sparire un incasso vero da un KPI, ed è la
// ragione per cui in questo repo esistono `dataCivile()` e `confini-giorno.ts`.
//
// ── LA DECISIONE ARBITRATA CHE QUESTO FILE PINNA: `.gte`, NON `.gt` ─────────
//
// 🔴 **La scadenza è l'ultimo istante valido, INCLUSO.** `fineGiornoCivile`
// restituisce `23:59:59.999` proprio perché è l'ultimo istante VIVO del giorno, e
// `avvisoScaduto` (`@/lib/avvisi/scadenze`) usa `adesso > scadenza`. Con un `.gt`
// nel filtro, un avviso sparirebbe dalla bacheca nel millisecondo esatto in cui il
// server che raccoglie le adesioni lo considera ancora valido: due regole a un
// millisecondo di distanza, cioè il difetto meno riproducibile che si possa
// scrivere. Il caso di confine qui sotto è l'unico che distingue le due.
//
// ── PERCHÉ L'OROLOGIO È CONGELATO QUI, E NON ALTROVE ────────────────────────
//
// Perché la proprietà da provare è un'UGUAGLIANZA esatta fra l'istante della
// richiesta e quello in colonna: senza un orologio fermo quel caso non è
// scrivibile. Non è la correzione sbagliata del «test scaduto col calendario» —
// lì si congelava l'orologio per nascondere una data cablata; qui la data non è
// cablata affatto, è derivata dall'istante finto.
// =============================================================================

const PARENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ADESSO = '2026-09-19T12:00:00.000Z'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getFigliDiGenitore: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: vi.fn(),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getFigliDiGenitore: (...a: unknown[]) => h.getFigliDiGenitore(...a),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
  resolveScuolaScrittura: vi.fn(),
}))
// La firma degli allegati ha il suo test e parla col bucket: qui deve solo
// restituire le righe com'erano.
vi.mock('@/lib/allegati/storage', () => ({
  firmaAllegatiAvvisi: async (_s: unknown, righe: unknown) => righe,
  normalizzaAllegatoAvviso: (v: unknown) => v,
}))
// Il logger si spia: il warn del degrado è la METÀ che conta di quel ramo — un
// feed che mostra tutto in silenzio è il guasto, non il ripiego.
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { errori: h.errori }),
  }
})

import { GET } from '@/app/api/avvisi/route'

const req = (qs = '') => ({
  url: `http://test/api/avvisi${qs ? `?${qs}` : ''}`,
  method: 'GET',
  headers: new Headers(),
  nextUrl: { searchParams: new URLSearchParams(qs) },
  cookies: { get: () => undefined },
}) as never

const avviso = (id: string, scadenzaAvviso: string) => ({
  id,
  author_id: 'aut-1',
  titolo: id,
  contenuto: 'c',
  tipo: 'presa_visione',
  target_scope: 'globale',
  target_classes: null,
  scadenza: null,
  scadenza_avviso: scadenzaAvviso,
  scadenza_adesione: null,
  chiedi_numero: false,
  etichetta_numero: null,
  numero_min: 1,
  numero_max: 20,
  posti_totali: null,
  attachment_url: null,
  created_at: '2026-08-01T00:00:00.000Z',
  scuola_id: SEDE_A,
})

const dbBase = (): DBFinto => ({
  alunni: [{ id: 's1', nome: 'Bruna', classe_sezione: '1A', scuola_id: SEDE_A }],
  utenti: [{ id: 'aut-1', first_name: 'Anna', last_name: 'Bianchi', role: 'educator', nome: null, cognome: null, ruolo: null }],
  avvisi_risposte: [],
  avvisi: [
    // L'ISTANTE ESATTO della richiesta: è il caso che distingue `.gte` da `.gt`.
    avviso('al-limite', ADESSO),
    // Un solo millisecondo dopo: vivo con entrambi gli operatori.
    avviso('vivo', '2026-09-19T12:00:00.001Z'),
    // Un solo millisecondo prima: scaduto con entrambi.
    avviso('scaduto-per-un-ms', '2026-09-19T11:59:59.999Z'),
    avviso('scaduto-da-giorni', '2026-09-10T23:59:59.999Z'),
  ],
})

const idsDelFeed = async (): Promise<string[]> => {
  const res = await GET(req())
  expect(res.status).toBe(200)
  const j = (await res.json()) as Array<{ id: string }>
  return j.map((a) => a.id).sort()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(ADESSO))
  h.db = dbBase()
  h.tabelle = []
  h.errori = {}
  h.logEvento.mockReset()
  h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: SEDE_A } })
  h.getFigliDiGenitore.mockResolvedValue(['s1'])
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/avvisi — il feed del genitore filtra su ISTANTI, non su stringhe', () => {
  it('gli avvisi scaduti non compaiono, quelli vivi sì', async () => {
    const ids = await idsDelFeed()
    // CONTROLLO POSITIVO del degrado: sul percorso felice NON si dichiara niente.
    expect(h.logEvento.mock.calls.filter((c) => c[1] === 'warn')).toHaveLength(0)
    expect(ids).not.toContain('scaduto-da-giorni')
    expect(ids).toContain('vivo')
  })

  it('🔴 CONFINE: l’avviso che scade nell’ISTANTE ESATTO della richiesta è ANCORA nel feed', async () => {
    // È l'unico caso che distingue `.gte` da `.gt`. Con `.gt` questo id sparisce, e
    // la bacheca dice «scaduto» mentre la RPC dell'adesione accetterebbe ancora una
    // risposta — le due metà sono coerenti ciascuna con sé stessa, e nessun altro
    // test se ne accorgerebbe.
    expect(await idsDelFeed()).toContain('al-limite')
  })

  it('CONTROLLO POSITIVO ALL’INCONTRARIO: un millisecondo PRIMA è già fuori', async () => {
    // Senza questo, il test qui sopra sarebbe verde anche con NESSUN filtro: «tutto
    // compare» e «l'estremo compare» hanno lo stesso colore.
    expect(await idsDelFeed()).not.toContain('scaduto-per-un-ms')
  })

  it('il filtro è una `gte` sulla colonna, non un confronto fra date in memoria', async () => {
    // La prova che il DATABASE sta filtrando: se il filtro fosse in memoria su
    // `scadenza` (la vecchia `date`, qui `null` su tutte le righe) passerebbero
    // tutte e quattro.
    expect(await idsDelFeed()).toEqual(['al-limite', 'vivo'])
  })
})

describe('GET /api/avvisi — i due booleani li calcola il SERVER', () => {
  it('`scaduto` e `adesioni_chiuse` arrivano nel payload, senza far confrontare niente al client', async () => {
    // `AvvisoCard.tsx:91` faceva `new Date(avviso.scadenza) < new Date()`, cioè
    // mezzanotte UTC misurata sull'orologio del tablet: dalle 02:00 italiane dava
    // per scaduto un avviso valido per altre ventidue ore.
    h.db.avvisi = [
      avviso('aperto', '2026-09-30T10:00:00.000Z'),
      // Adesioni chiuse ieri, ma l'avviso resta in bacheca: è l'INTERA ragione per
      // cui le scadenze sono due.
      { ...avviso('sola-lettura', '2026-09-30T10:00:00.000Z'), tipo: 'adesione', scadenza_adesione: '2026-09-18T10:00:00.000Z' },
    ]
    const res = await GET(req())
    const j = (await res.json()) as Array<{ id: string; scaduto: boolean; adesioni_chiuse: boolean }>

    const aperto = j.find((a) => a.id === 'aperto')!
    expect(aperto.scaduto).toBe(false)
    expect(aperto.adesioni_chiuse).toBe(false)

    const solaLettura = j.find((a) => a.id === 'sola-lettura')!
    expect(solaLettura.scaduto, 'resta in bacheca').toBe(false)
    expect(solaLettura.adesioni_chiuse, 'ma non si aderisce più').toBe(true)
  })
})

describe('GET /api/avvisi — il degrado a DUE passi si DICHIARA', () => {
  // ⚠️ ERA «A TRE PASSI», E IL TERZO NON ESISTEVA. Il gradino di mezzo —
  // proiezione nuova, filtro tolto — non poteva riuscire mai: il filtro gira su
  // `scadenza_avviso`, che sta DENTRO la proiezione, quindi toglierlo lasciava in
  // piedi la stessa `SELECT` che aveva appena prodotto il `42703`. Un round-trip
  // garantito a vuoto su ogni richiesta di un ambiente non migrato, e un commento
  // che lo giustificava con un fatto falso. Il riquadro in
  // `src/app/api/avvisi/route.ts` racconta perché il gradino è stato tolto invece
  // che annotato, e a quale condizione tornerebbe utile.
  it('senza la colonna `scadenza_avviso` il feed mostra tutto, MA lascia il suo warn', async () => {
    // Sul DB E2E della CI — progetto separato, non migrato — la colonna non c'è.
    // Il feed non può più filtrare, e quella è una degradazione che, se capitasse
    // in produzione, farebbe restare in bacheca gli avvisi vecchi PER SEMPRE senza
    // un solo errore da guardare. Perciò si dichiara.
    h.errori = { avvisi: { code: '42703', message: 'column avvisi.scadenza_avviso does not exist' } }

    // Il terzo passo legge le colonne storiche: qui il finto client risponde con
    // l'errore su OGNI lettura di `avvisi`, quindi la route arriva al 500 — ma il
    // warn del degrado deve essere già partito.
    await GET(req())

    const righe = h.logEvento.mock.calls
      .filter((c) => c[1] === 'warn')
      .map((c) => c[2] as { operazione?: string; esito?: string })
    expect(righe).toContainEqual({
      operazione: 'avvisi:GET',
      esito: 'degrado-filtro-scadenza-assente',
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// I POSTI LIBERI NON ARRIVANO AL GENITORE — NEMMENO PER SOTTRAZIONE.
//
// 🔴 DECISIONE n. 17 DEL COMMITTENTE: al genitore non si mostra quanti posti
// restano. Vede che i posti sono esauriti, e vede se LUI è in lista d'attesa.
// Il motivo non è estetico: una famiglia che legge «restano 3 posti» non decide
// con più calma, corre — ed è la corsa all'ultimo posto che la lista d'attesa
// esiste per evitare.
//
// ── IL DIFETTO ERA UNA SOTTRAZIONE, NON UN CAMPO ────────────────────────────
//
// Nessuno aveva scritto `posti_liberi` da nessuna parte. Il payload portava
// `posti_totali` (dentro `AVVISO_COLS_SCADENZE`) accanto a `stats.persone_ammesse`
// (da `autoriEStatistiche`): due numeri leciti presi da soli, il residuo esatto
// messi vicini. È la forma di fuga che nessuna ricerca per NOME trova, perché il
// dato vietato non è scritto — si ricava. Le quattro statistiche di capienza
// (`persone_ammesse`, `persone_in_attesa`, `adesioni_ammesse`, `adesioni_in_attesa`)
// sono lì per la stessa ragione: ognuna, con il tetto accanto, è una sottrazione.
//
// ⚠️ E SUL RAMO STAFF DEVONO RESTARCI. Sono i numeri con cui la segreteria decide
// quante telefonate fare, e sono gli argomenti di `sopraCapienza`. Perciò si pota
// il PAYLOAD del solo ramo genitore, e non la proiezione della query — che è
// condivisa, e mutilarla spegnerebbe l'indicatore della segreteria. I due `it`
// qui sotto sono speculari apposta: il secondo è il controllo positivo del primo,
// e senza di lui «il genitore non li vede» sarebbe verde anche se non li vedesse
// più nessuno.
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/avvisi — il feed del genitore non lascia calcolare i posti liberi', () => {
  /** I cinque campi da cui il residuo si ricava. Elencati per NOME: è il genere di
   *  campo che rientra da solo la prossima volta che qualcuno allarga una proiezione. */
  const VIETATI_AL_GENITORE = [
    'posti_totali', 'persone_ammesse', 'persone_in_attesa', 'adesioni_ammesse', 'adesioni_in_attesa',
  ]

  const conPosti = () => {
    h.db.avvisi = [{ ...avviso('gita', '2026-09-30T10:00:00.000Z'), tipo: 'adesione', posti_totali: 20 }]
    h.db.avvisi_risposte = [
      { id: 'r1', avviso_id: 'gita', parent_id: 'p1', student_id: 's9', risposta: 'si', letto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 4 },
      { id: 'r2', avviso_id: 'gita', parent_id: 'p2', student_id: 's8', risposta: 'si', letto_il: 'x', stato_adesione: 'in_attesa', numero_partecipanti: 3 },
    ]
  }

  it('🔴 nessuno dei cinque campi da cui si ricava il residuo arriva al genitore', async () => {
    conPosti()

    const res = await GET(req())
    expect(res.status).toBe(200)
    const [riga] = (await res.json()) as Array<Record<string, unknown>>

    // L'asserzione è per NOME, uno per uno: un `toEqual` sull'intero oggetto
    // direbbe «è cambiato qualcosa» senza dire CHE COSA, e il giorno in cui il
    // payload cresce nessuno saprebbe quale delle due metà guardare.
    for (const campo of VIETATI_AL_GENITORE) {
      expect(riga, `«${campo}» è tornato nel payload del genitore`).not.toHaveProperty(campo)
      expect(riga.stats as Record<string, unknown>, `«${campo}» è tornato dentro stats`).not.toHaveProperty(campo)
    }

    // …e ciò che resta è quello che serve davvero a una famiglia: l'avviso, i
    // campi del modulo di adesione, e lo stato della PROPRIA riga.
    expect(riga).toHaveProperty('titolo')
    expect(riga).toHaveProperty('chiedi_numero')
    expect(riga).toHaveProperty('numero_max')
    expect(riga).toHaveProperty('adesioni_chiuse')
    expect(riga).toHaveProperty('my_response')
  })

  it('🔴 …e `my_response` porta i due campi della PROPRIA riga, che non sono una capienza', async () => {
    // Senza questi due il genitore non ha modo di sapere «sei in lista d'attesa»:
    // la card gli direbbe «Hai aderito ✓» mentre il database lo tiene in coda — un
    // posto annunciato che non c'è.
    //
    // La differenza con i cinque campi vietati qui sopra non è sottile:
    // `posti_totali` e `persone_ammesse` dicono quanto spazio resta AGLI ALTRI, e
    // accostati sono una sottrazione; `stato_adesione` e `numero_partecipanti`
    // dicono dove sta QUESTA famiglia. Il primo è vietato, il secondo è il motivo
    // per cui la lista d'attesa esiste.
    conPosti()
    h.db.avvisi_risposte.push({
      id: 'mia', avviso_id: 'gita', parent_id: PARENT_ID, student_id: 's1',
      risposta: 'si', letto_il: 'x', risposto_il: 'x',
      stato_adesione: 'in_attesa', numero_partecipanti: 2,
    })

    const res = await GET(req())
    const [riga] = (await res.json()) as Array<{ my_response: Record<string, unknown> | null }>

    expect(riga.my_response).toEqual({
      letto_il: 'x',
      risposta: 'si',
      risposto_il: 'x',
      stato_adesione: 'in_attesa',
      numero_partecipanti: 2,
    })
  })

  it('CONTROLLO POSITIVO ALL’INCONTRARIO: lo stato è il PROPRIO, non quello di un’altra famiglia', async () => {
    // Senza questo, il test qui sopra passerebbe anche con un `stato_adesione`
    // preso dalla prima riga che capita: nella fixture `conPosti()` c'è
    // un'adesione `ammessa` di un ALTRO genitore, ed è esattamente il valore
    // sbagliato che una query senza filtro restituirebbe — «sei dentro» letto da
    // chi è in coda.
    conPosti()
    h.db.avvisi_risposte.push({
      id: 'mia', avviso_id: 'gita', parent_id: PARENT_ID, student_id: 's1',
      risposta: 'si', letto_il: 'x', risposto_il: 'x',
      stato_adesione: 'in_attesa', numero_partecipanti: 2,
    })

    const res = await GET(req())
    const [riga] = (await res.json()) as Array<{ my_response: { stato_adesione: string | null } | null }>

    expect(riga.my_response?.stato_adesione).not.toBe('ammessa')
  })

  it('due figli che NON concordano non hanno uno stato di famiglia: `null`', async () => {
    // Un genitore con Marco ammesso e Giulia in coda non HA uno stato: ce l'hanno
    // i suoi figli. Sceglierne uno dei due — il primo? il migliore? — direbbe alla
    // famiglia una cosa vera per metà, ed è la stessa regola con cui `risposta` è
    // già `null` quando i figli rispondono diversamente.
    h.db.alunni = [
      { id: 's1', nome: 'Bruna', classe_sezione: '1A', scuola_id: SEDE_A },
      { id: 's2', nome: 'Carlo', classe_sezione: '1A', scuola_id: SEDE_A },
    ]
    h.getFigliDiGenitore.mockResolvedValue(['s1', 's2'])
    h.db.avvisi = [{ ...avviso('gita', '2026-09-30T10:00:00.000Z'), tipo: 'adesione', posti_totali: 20 }]
    h.db.avvisi_risposte = [
      { id: 'r1', avviso_id: 'gita', parent_id: PARENT_ID, student_id: 's1', risposta: 'si', letto_il: 'x', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 2 },
      { id: 'r2', avviso_id: 'gita', parent_id: PARENT_ID, student_id: 's2', risposta: 'si', letto_il: 'x', risposto_il: 'x', stato_adesione: 'in_attesa', numero_partecipanti: 3 },
    ]

    const res = await GET(req())
    const [riga] = (await res.json()) as Array<{ my_response: Record<string, unknown> | null }>

    expect(riga.my_response?.stato_adesione).toBeNull()
    expect(riga.my_response?.numero_partecipanti).toBeNull()
    // Controllo positivo accanto: `risposta` invece CONCORDA (entrambi «sì») e
    // resta valorizzata. Senza, «tutto null» sarebbe verde anche con
    // l'aggregazione rotta per intero.
    expect(riga.my_response?.risposta).toBe('si')
  })

  it('due figli che CONCORDANO hanno uno stato solo (controllo positivo)', async () => {
    // Senza questo, la regola «null quando non concordano» sarebbe verde anche con
    // un campo che è sempre `null`, cioè con la correzione mai arrivata.
    h.db.alunni = [
      { id: 's1', nome: 'Bruna', classe_sezione: '1A', scuola_id: SEDE_A },
      { id: 's2', nome: 'Carlo', classe_sezione: '1A', scuola_id: SEDE_A },
    ]
    h.getFigliDiGenitore.mockResolvedValue(['s1', 's2'])
    h.db.avvisi = [{ ...avviso('gita', '2026-09-30T10:00:00.000Z'), tipo: 'adesione', posti_totali: 20 }]
    h.db.avvisi_risposte = [
      { id: 'r1', avviso_id: 'gita', parent_id: PARENT_ID, student_id: 's1', risposta: 'si', letto_il: 'x', risposto_il: 'x', stato_adesione: 'in_attesa', numero_partecipanti: 2 },
      { id: 'r2', avviso_id: 'gita', parent_id: PARENT_ID, student_id: 's2', risposta: 'si', letto_il: 'x', risposto_il: 'x', stato_adesione: 'in_attesa', numero_partecipanti: 2 },
    ]

    const res = await GET(req())
    const [riga] = (await res.json()) as Array<{ my_response: Record<string, unknown> | null }>

    expect(riga.my_response?.stato_adesione).toBe('in_attesa')
    expect(riga.my_response?.numero_partecipanti).toBe(2)
  })

  it('CONTROLLO POSITIVO: sul ramo STAFF quegli stessi campi CI SONO, e con i valori veri', async () => {
    // Senza questo, il test qui sopra sarebbe verde anche se le colonne fossero
    // state tolte dalla query — cioè se avessimo spento anche l'indicatore della
    // segreteria per proteggere il genitore.
    conPosti()
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })

    const res = await GET(req())
    const [riga] = (await res.json()) as Array<{ posti_totali: number; stats: Record<string, number>; sopra_capienza: boolean }>

    expect(riga.posti_totali).toBe(20)
    expect(riga.stats.persone_ammesse).toBe(4)
    expect(riga.stats.persone_in_attesa).toBe(3)
    expect(riga.stats.adesioni_ammesse).toBe(1)
    expect(riga.stats.adesioni_in_attesa).toBe(1)
    expect(riga.sopra_capienza).toBe(false)
  })

  it('le tre statistiche STORICHE restano al genitore (non è una potatura a caso)', async () => {
    // `letti`, `adesioni_si`, `adesioni_no` non permettono nessuna sottrazione
    // senza il tetto, e la card del genitore le mostra da sempre. Toglierle
    // sarebbe cambiare il prodotto invece di chiudere una fuga.
    conPosti()

    const res = await GET(req())
    const [riga] = (await res.json()) as Array<{ stats: Record<string, number> }>

    expect(Object.keys(riga.stats).sort()).toEqual(['adesioni_no', 'adesioni_senza_numero', 'adesioni_si', 'letti'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Il ramo STAFF: gli scaduti NON si nascondono, ma il cockpit può chiederli.
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/avvisi — ramo staff: nessun filtro, e un interruttore per il cockpit', () => {
  const comeSegreteria = () =>
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })

  const idsStaff = async (qs = ''): Promise<string[]> => {
    const res = await GET(req(qs))
    expect(res.status).toBe(200)
    const j = (await res.json()) as Array<{ id: string }>
    return j.map((a) => a.id).sort()
  }

  it('SENZA parametri lo staff vede TUTTO, scaduti compresi', async () => {
    // Decisione del committente: il cockpit è anche l'archivio di ciò che è stato
    // pubblicato, e «sparito dalla bacheca delle famiglie» non vuol dire «sparito
    // dal lavoro della segreteria».
    comeSegreteria()
    expect(await idsStaff()).toEqual([
      'al-limite', 'scaduto-da-giorni', 'scaduto-per-un-ms', 'vivo',
    ])
  })

  it('`?scaduti=si` e `?scaduti=no` partizionano l’elenco, sullo stesso istante', async () => {
    comeSegreteria()
    const scaduti = await idsStaff('scaduti=si')
    const vivi = await idsStaff('scaduti=no')
    expect(scaduti).toEqual(['scaduto-da-giorni', 'scaduto-per-un-ms'])
    // `al-limite` sta fra i VIVI anche qui: la stessa regola del feed, lo stesso
    // istante, un solo `avvisoScaduto`. Se le due metà divergessero, il cockpit
    // direbbe «scaduto» di un avviso che le famiglie vedono ancora.
    expect(vivi).toEqual(['al-limite', 'vivo'])
    expect([...scaduti, ...vivi].sort()).toEqual(await idsStaff())
  })

  it('`sopra_capienza` nasce dal confronto fra persone ammesse e tetto', async () => {
    comeSegreteria()
    h.db.avvisi = [
      { ...avviso('pieno', '2026-09-30T10:00:00.000Z'), posti_totali: 5 },
      { ...avviso('capiente', '2026-09-30T10:00:00.000Z'), posti_totali: 50 },
      // Nessun tetto: `sopra_capienza` resta falso qualunque cosa succeda.
      avviso('senza-tetto', '2026-09-30T10:00:00.000Z'),
    ]
    h.db.avvisi_risposte = [
      { id: 'r1', avviso_id: 'pieno', parent_id: 'p1', student_id: 's1', risposta: 'si', letto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 4 },
      { id: 'r2', avviso_id: 'pieno', parent_id: 'p2', student_id: 's2', risposta: 'si', letto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 3 },
      { id: 'r3', avviso_id: 'capiente', parent_id: 'p1', student_id: 's1', risposta: 'si', letto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 4 },
      { id: 'r4', avviso_id: 'senza-tetto', parent_id: 'p1', student_id: 's1', risposta: 'si', letto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 99 },
    ]

    const res = await GET(req())
    const j = (await res.json()) as Array<{ id: string; sopra_capienza: boolean; stats: { persone_ammesse: number } }>
    const di = (id: string) => j.find((a) => a.id === id)!

    // Sette PERSONE in due adesioni contro un tetto di 5: contare le righe direbbe
    // «2 su 5» ed è il modo di riempire un pullman da 50 con 120 persone.
    expect(di('pieno').stats.persone_ammesse).toBe(7)
    expect(di('pieno').sopra_capienza).toBe(true)
    expect(di('capiente').sopra_capienza).toBe(false)
    expect(di('senza-tetto').sopra_capienza).toBe(false)
  })
})
