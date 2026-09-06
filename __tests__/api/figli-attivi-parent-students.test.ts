import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'

/**
 * GLI ALUNNI SENZA SEZIONE NON DEVONO PIÙ COMPARIRE AI GENITORI.
 *
 * ─── IL DIFETTO, misurato il 2026-09-05 ─────────────────────────────────────
 *
 * `GET /api/parent/students` faceva `.from('alunni').select(…).in('id', ids)` e
 * basta: nessun filtro su `section_id`, `stato`, `archiviato_il`. Da quella
 * risposta esce lo `studentId` di TUTTA l'app di famiglia (`useParentIdentity` →
 * `ChildSwitcher`), quindi un bambino senza classe entrava dappertutto e poi
 * perdeva in silenzio — moduli e avvisi di classe, news di grado, agenda di
 * sezione, materiali dell'armadietto, l'area primaria intera (blocco duro su
 * `section_id` in quattro rotte) e le RETTE, che `genera-rette` non produce per
 * chi non ha classe. Presente e non funzionante.
 *
 * In produzione, contati: 5 alunni non archiviati senza `section_id`, 5
 * archiviati ancora legati a un account, 12 legami sotto il filtro, 4 account che
 * resterebbero senza nessun figlio visibile.
 *
 * ─── IL FINTO CLIENT APPLICA I FILTRI DAVVERO ────────────────────────────────
 *
 * `creaFintoSupabase` non è un mock piatto: `.in('id', …)` filtra come
 * filtrerebbe PostgREST, e le righe tornano intere. Perciò «il fratello senza
 * sezione non esce» è una proprietà VERIFICATA, e la prova negativa in fondo —
 * rimetto `section_id` e lo guardo RICOMPARIRE — è una prova, non un rito.
 */

const GENITORE = '710717f0-d5ae-4f6f-889f-60d167b65a3b'
const CON_SEZIONE = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const SENZA_SEZIONE = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const ARCHIVIATO = 'c3c3c3c3-3333-4333-8333-cccccccccccc'
const RITIRATO = 'd4d4d4d4-4444-4444-8444-dddddddddddd'
const SEDE = 'eeeeeeee-0000-4000-8000-00000000000e'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  logEvento: vi.fn(),
  db: {} as DBFinto,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db),
    createClient: async () => creaFintoSupabase(h.db),
  }
})

import { GET } from '@/app/api/parent/students/route'

const req = () => new Request(`http://localhost/api/parent/students?userId=${GENITORE}`)

/** Il fratello con la classe, quello senza, e i due che hanno lasciato. */
const dbBase = (): DBFinto => ({
  legame_genitori_alunni: [
    { genitore_id: GENITORE, alunno_id: CON_SEZIONE },
    { genitore_id: GENITORE, alunno_id: SENZA_SEZIONE },
  ],
  parents: [],
  student_parents: [],
  scuole: [{ id: SEDE, nome: 'Sede di prova', citta: 'Città', indirizzo: 'Via 1', config: {} }],
  alunni: [
    { id: CON_SEZIONE, nome: 'Primo', cognome: 'Prova', classe_sezione: '3 ANNI A', scuola_id: SEDE, section_id: 'sec-1', stato: 'iscritto', archiviato_il: null },
    { id: SENZA_SEZIONE, nome: 'Secondo', cognome: 'Prova', classe_sezione: null, scuola_id: SEDE, section_id: null, stato: 'iscritto', archiviato_il: null },
  ],
})

const corpo = async () => {
  const res = await GET(req())
  return {
    stato: res.status,
    body: await res.json() as {
      data: { id: string }[]
      in_attesa?: boolean
      motivo_assenza?: string | null
    },
  }
}

const idVisti = async () => (await corpo()).body.data.map((r) => r.id)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.requireUser.mockResolvedValue({ user: { id: GENITORE, role: 'genitore' }, response: null })
})

describe('GET /api/parent/students — i figli che la famiglia deve vedere', () => {
  it('due figli, uno con sezione e uno senza: esce SOLO il primo', async () => {
    const { stato, body } = await corpo()
    expect(stato).toBe(200)
    expect(body.data.map((r) => r.id)).toEqual([CON_SEZIONE])
  })

  it('PROVA NEGATIVA — rimetto `section_id` al secondo e RICOMPARE', async () => {
    // Un filtro mai visto lasciar passare non è un filtro: qui cambia UNA cella
    // del fixture, e l'elenco torna a due. Se questa asserzione passasse anche
    // senza la riga precedente, il filtro non starebbe filtrando niente.
    const prima = await idVisti()
    expect(prima).toEqual([CON_SEZIONE])

    h.db.alunni[1].section_id = 'sec-2'
    h.db.alunni[1].classe_sezione = '4 ANNI B'
    const dopo = await idVisti()
    expect(dopo).toContain(SENZA_SEZIONE)
    expect(dopo).toHaveLength(2)
  })

  it('un figlio ARCHIVIATO non compare, anche se il legame c\'è ancora', async () => {
    h.db.legame_genitori_alunni.push({ genitore_id: GENITORE, alunno_id: ARCHIVIATO })
    h.db.alunni.push({
      id: ARCHIVIATO, nome: 'Terzo', cognome: 'Prova', classe_sezione: null, scuola_id: SEDE,
      // Archiviazione completa: `stato` dice COSA, `archiviato_il` dice QUANDO.
      section_id: null, stato: 'ritirato', archiviato_il: '2026-06-30T10:00:00Z',
    })
    expect(await idVisti()).toEqual([CON_SEZIONE])
  })

  it('un RITIRATO a mano dalla tendina — classe ancora agganciata — non compare', async () => {
    // È il caso che un filtro sul solo `section_id` si lascerebbe sfuggire:
    // `archiviato_il` è NULL e la classe c'è ancora.
    h.db.legame_genitori_alunni.push({ genitore_id: GENITORE, alunno_id: RITIRATO })
    h.db.alunni.push({
      id: RITIRATO, nome: 'Quarto', cognome: 'Prova', classe_sezione: '3 ANNI A', scuola_id: SEDE,
      section_id: 'sec-1', stato: 'ritirato', archiviato_il: null,
    })
    expect(await idVisti()).toEqual([CON_SEZIONE])
  })

  it('un SOSPESO resta visibile: è un bambino che frequenta', async () => {
    // Il confine lo decide `eAncoraIscritto`, non una stringa riscritta qui.
    h.db.alunni[1].section_id = 'sec-2'
    h.db.alunni[1].stato = 'sospeso'
    expect(await idVisti()).toContain(SENZA_SEZIONE)
  })

  it('uno stato SCONOSCIUTO non autorizza a nascondere', async () => {
    h.db.alunni[1].section_id = 'sec-2'
    h.db.alunni[1].stato = 'trasferito'
    expect(await idVisti()).toContain(SENZA_SEZIONE)
  })
})

describe('«non ho figli» e «i miei figli non sono ancora visibili» sono due cose diverse', () => {
  it('unico figlio senza sezione: elenco vuoto MA `in_attesa` vero', async () => {
    h.db.legame_genitori_alunni = [{ genitore_id: GENITORE, alunno_id: SENZA_SEZIONE }]
    const { stato, body } = await corpo()
    expect(stato).toBe(200)
    expect(body.data).toEqual([])
    expect(body.in_attesa, 'senza questo campo la home è quella di chi non ha figli').toBe(true)
  })

  it('nessun legame: elenco vuoto e `in_attesa` FALSO', async () => {
    h.db.legame_genitori_alunni = []
    const { body } = await corpo()
    expect(body.data).toEqual([])
    expect(body.in_attesa).toBe(false)
  })

  it('almeno un figlio visibile: `in_attesa` falso anche se un fratello è nascosto', async () => {
    const { body } = await corpo()
    expect(body.data).toHaveLength(1)
    expect(body.in_attesa).toBe(false)
  })
})

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * IL MOTIVO, E NON SOLO «IN ATTESA» — un booleano diceva il falso a una famiglia
 * su quattro.
 *
 * `in_attesa` collassa i TRE motivi che `@/lib/alunni/attivo` tiene distinti
 * (`archiviato` · `ritirato` · `senza-sezione`), e da un booleano esce UNA frase
 * sola: «Stiamo completando l'iscrizione: appena la classe è assegnata qui
 * compare tutto».
 *
 * Misurato sul database di produzione il 2026-09-06 — conteggi soli, nessuna riga
 * di anagrafica letta: dei 4 account senza figli visibili, 3 hanno l'unico figlio
 * SENZA SEZIONE (per loro la frase è vera) e 1 ce l'ha ARCHIVIATO. A quella
 * famiglia l'app prometteva il completamento di un'iscrizione che non esiste e
 * una classe che non arriverà: la stessa classe di difetto che il filtro doveva
 * chiudere, rimasta aperta su un quarto delle persone.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
describe('«in attesa» non è una causa sola: il motivo esce dalla rotta', () => {
  /** Il fixture con un solo legame, e la riga che si vuole provare. */
  const soloFiglio = (id: string, riga: Record<string, unknown>) => {
    h.db.legame_genitori_alunni = [{ genitore_id: GENITORE, alunno_id: id }]
    h.db.alunni = [{ id, nome: 'Unico', cognome: 'Prova', scuola_id: SEDE, ...riga }]
  }

  it('unico figlio SENZA SEZIONE ⇒ `senza-sezione`: la classe sta davvero arrivando', async () => {
    soloFiglio(SENZA_SEZIONE, { classe_sezione: null, section_id: null, stato: 'iscritto', archiviato_il: null })
    const { body } = await corpo()
    expect(body.in_attesa).toBe(true)
    expect(body.motivo_assenza).toBe('senza-sezione')
  })

  it('unico figlio ARCHIVIATO ⇒ `archiviato`, e NON la promessa di una classe', async () => {
    // È l'account misurato in produzione: 1 su 4. Senza questo ramo legge
    // «appena la classe è assegnata qui compare tutto» — un'attesa che non
    // finirà, su una schermata che è l'unica cosa che la sua app gli mostra.
    soloFiglio(ARCHIVIATO, {
      classe_sezione: null, section_id: null, stato: 'ritirato', archiviato_il: '2026-06-30T10:00:00Z',
    })
    const { body } = await corpo()
    expect(body.in_attesa, 'il campo di ieri non cambia: i chiamanti vecchi non si rompono').toBe(true)
    expect(body.motivo_assenza).toBe('archiviato')
  })

  it('unico figlio RITIRATO a mano (classe ancora agganciata) ⇒ `ritirato`', async () => {
    soloFiglio(RITIRATO, {
      classe_sezione: '3 ANNI A', section_id: 'sec-1', stato: 'ritirato', archiviato_il: null,
    })
    const { body } = await corpo()
    expect(body.motivo_assenza).toBe('ritirato')
  })

  it('nessun legame ⇒ `null`: chi non ha figli non ha nemmeno un motivo', async () => {
    h.db.legame_genitori_alunni = []
    const { body } = await corpo()
    expect(body.in_attesa).toBe(false)
    expect(body.motivo_assenza).toBeNull()
  })

  it('almeno un figlio visibile ⇒ `null` anche col fratello nascosto', async () => {
    // Un motivo che sopravvive a un elenco pieno è solo un campo che aspetta di
    // essere letto per sbaglio: la schermata di cortesia qui non esiste.
    const { body } = await corpo()
    expect(body.data).toHaveLength(1)
    expect(body.motivo_assenza).toBeNull()
  })

  it('motivi MISTI ⇒ vince `senza-sezione`, l\'unica frase che non mente a nessuno', async () => {
    // Precedenza rovesciata rispetto a `motivoNascosto`, e di proposito: là si
    // classifica una riga, qui si sceglie la frase che leggerà una famiglia con
    // più figli nascosti per cause diverse. «L'iscrizione è in lavorazione» è
    // vera appena UNO aspetta la classe; «non è più iscritto» mentirebbe al
    // fratello che invece si sta iscrivendo. In produzione oggi nessun account è
    // in questo caso (misurato: 0 su 4): questo test decide il primo che arriverà.
    h.db.legame_genitori_alunni = [
      { genitore_id: GENITORE, alunno_id: SENZA_SEZIONE },
      { genitore_id: GENITORE, alunno_id: ARCHIVIATO },
    ]
    h.db.alunni = [
      { id: SENZA_SEZIONE, nome: 'Secondo', cognome: 'Prova', classe_sezione: null, scuola_id: SEDE, section_id: null, stato: 'iscritto', archiviato_il: null },
      { id: ARCHIVIATO, nome: 'Terzo', cognome: 'Prova', classe_sezione: null, scuola_id: SEDE, section_id: null, stato: 'ritirato', archiviato_il: '2026-06-30T10:00:00Z' },
    ]
    const { body } = await corpo()
    expect(body.data).toEqual([])
    expect(body.motivo_assenza).toBe('senza-sezione')
  })

  it('legame che punta a una riga di `alunni` che non c\'è: `in_attesa` vero, motivo `null`', async () => {
    // Nessun motivo contato ⇒ nessuna frase nuova da scegliere: il client cade
    // sulla generica, che è il comportamento di ieri. Un campo aggiunto non deve
    // poter svuotare una schermata che oggi funziona.
    h.db.legame_genitori_alunni = [{ genitore_id: GENITORE, alunno_id: SENZA_SEZIONE }]
    h.db.alunni = []
    const { body } = await corpo()
    expect(body.in_attesa).toBe(true)
    expect(body.motivo_assenza).toBeNull()
  })
})

describe('il log che serve ad accorgersi domani che i 5 sono diventati 50', () => {
  const righeNascosti = () =>
    h.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: string })?.esito === 'figli-nascosti-alla-famiglia',
    )

  it('una riga PERSISTITA (`warn`) con il conteggio per motivo', async () => {
    h.db.legame_genitori_alunni.push({ genitore_id: GENITORE, alunno_id: ARCHIVIATO })
    h.db.alunni.push({
      id: ARCHIVIATO, nome: 'Terzo', cognome: 'Prova', classe_sezione: null, scuola_id: SEDE,
      section_id: null, stato: 'ritirato', archiviato_il: '2026-06-30T10:00:00Z',
    })
    await corpo()
    const riga = righeNascosti()[0]
    expect(riga, 'senza riga, «cinque» e «cinquanta» si somigliano').toBeDefined()
    // `warn` e non `info`: `anagrafica` sta fra le deroghe di `eventi-log`, e i
    // suoi `info` non arrivano in `app_log` — cioè non si possono interrogare.
    expect(riga[1]).toBe('warn')
    expect(riga[2]).toMatchObject({
      esito: 'figli-nascosti-alla-famiglia',
      genitore_id: GENITORE,
      n: 2,
      n_visibili: 1,
      n_archiviati: 1,
      n_senza_sezione: 1,
      n_ritirati: 0,
    })
  })

  it('la riga porta SOLO uuid e numeri: mai un nome, mai un id di minore', async () => {
    await corpo()
    const riga = righeNascosti()[0]
    expect(JSON.stringify(riga?.[2])).not.toMatch(/Primo|Secondo|Prova|@/)
    expect(JSON.stringify(riga?.[2])).not.toContain(SENZA_SEZIONE)
  })

  it('nessun figlio nascosto ⇒ nessuna riga: un logger loquace acceca', async () => {
    h.db.alunni[1].section_id = 'sec-2'
    await corpo()
    expect(righeNascosti()).toHaveLength(0)
  })
})

describe('degrado pulito dove lo schema è indietro (DB E2E della CI, non migrato)', () => {
  it('`42703` su una colonna della visibilità: si rilegge senza, e non si nasconde nessuno', async () => {
    // Il DB E2E non è migrato: una colonna assente non deve diventare «tutti i
    // figli spariti». Si degrada APERTI — chiudere svuoterebbe l'app a 662
    // famiglie perché uno schema è indietro.
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    let primoGiro = true
    const finto = creaFintoSupabase(h.db)
    const vero = finto.from.bind(finto)
    // Un solo `42703` su `alunni`, poi la lettura riesce: è la forma esatta del
    // ciclo di degradazione (una colonna alla volta).
    const conErrore = {
      ...finto,
      from: (tabella: string) => {
        if (tabella !== 'alunni' || !primoGiro) return vero(tabella)
        primoGiro = false
        const qb: Record<string, unknown> = {}
        for (const m of ['select', 'in', 'eq', 'order', 'limit']) qb[m] = () => qb
        qb.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({
            data: null,
            error: { code: '42703', message: 'column alunni.archiviato_il does not exist' },
          }).then(res)
        return qb
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient

    const { getFigliAttiviDiGenitore } = await import('@/lib/anagrafiche/legami')
    const esito = await getFigliAttiviDiGenitore(conErrore, GENITORE)
    expect(esito.errore).toBeNull()
    // `section_id` c'è ancora e continua a filtrare: cade solo il criterio della
    // colonna assente.
    expect(esito.righe.map((r) => r.id)).toEqual([CON_SEZIONE])
  })

  it('una lettura FALLITA non diventa «questo genitore non ha figli»: 500', async () => {
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    const rotto = creaFintoSupabase(h.db, [], { errori: { alunni: { code: '08006', message: 'connessione persa' } } })
    const { getFigliAttiviDiGenitore } = await import('@/lib/anagrafiche/legami')
    const esito = await getFigliAttiviDiGenitore(rotto, GENITORE)
    expect(esito.errore).not.toBeNull()
    expect(esito.righe).toEqual([])
    // Il chiamante deve poter distinguere: `totaleLegami` dice che i figli
    // c'erano, `errore` dice che non li si è potuti leggere.
    expect(esito.totaleLegami).toBe(2)
  })
})
