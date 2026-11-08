import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { applicaPr2, creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_BASE, SCHEMA_GALLERIA_GENITORE, SCHEMA_LEGAMI_GENITORE } from '../helpers/schema-anno-pglite'

/**
 * PR 4.4 · CHE COSA VEDE UNA FAMIGLIA. Una regola sola, in SQL.
 *
 * Compito 4.4.1 · `figli_attivi`: un figlio è attivo se la sua frequenza sta nell'anno attivo della sede, è
 * `in_attesa` o `iscritto`, e oggi (giorno di Roma) cade fra `data_ingresso` e `data_uscita`. `sospeso` è un flag.
 *
 * Compito 4.4.2 · `media_visibili_genitore`: figlio per figlio, le foto vive della sede della frequenza attiva, dal
 * giorno da cui il figlio frequenta senza interruzioni, se è taggato, o se la foto è per tutta la sede e lui quel giorno
 * c'era, o se quel giorno stava in una sezione destinataria.
 *
 * Compito 4.4.3 · `avvisi_visibili_genitore`, `thread_visibili`, `thread_e_visibile`, `voci_visibili_genitore`: gli avvisi
 * non scaduti della sede o della sezione attuale del figlio attivo; le conversazioni del figlio attivo, con la manopola che
 * decide se un docente non più assegnato toglie la scrittura; le voci di tutti i figli collegati, senza quelle di un anno futuro.
 *
 * Calendario di prova fisso (`creaAnniFissi`): 2025/26 chiuso, 2026/27 corrente, 2027/28 in_preparazione. L'anno
 * attivo dipende dallo stato e non dalla data, ma il confronto con OGGI sì: le prove che ne dipendono allargano
 * l'anno attorno a oggi in una transazione che si annulla (`giorni`), così non scadono mai. Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const SEDE_B = '22222222-2222-4222-8222-222222222223'
const SEZ_1 = '55555555-5555-4555-8555-555555555551'
const SEZ_2 = '55555555-5555-4555-8555-555555555552'
const SEZ_B = '55555555-5555-4555-8555-555555555553'
/** Le sezioni della prima sede nell'anno prima: i destinatari di una foto del 2025/26 sono queste. */
const SEZ_PRIMA = '55555555-5555-4555-8555-555555555554'

const GEN_DUE_FIGLI = '99999999-9999-4999-8999-999999999991'
const GEN_RITIRATO = '99999999-9999-4999-8999-999999999992'
const GEN_IN_ATTESA = '99999999-9999-4999-8999-999999999993'
const GEN_TRASFERITO = '99999999-9999-4999-8999-999999999994'
const GEN_PONTE = '99999999-9999-4999-8999-999999999995'
const GEN_DOPPIO = '99999999-9999-4999-8999-999999999996'
const GEN_ALTRI_ANNI = '99999999-9999-4999-8999-999999999997'
const GEN_SENZA_SEZIONE = '99999999-9999-4999-8999-999999999998'

const FIGLIO_1 = '11111111-1111-4111-8111-111111111111'
const FIGLIO_2 = '11111111-1111-4111-8111-111111111112'
const FIGLIO_RITIRATO = '11111111-1111-4111-8111-111111111113'
const FIGLIO_IN_ATTESA = '11111111-1111-4111-8111-111111111114'
const FIGLIO_TRASFERITO = '11111111-1111-4111-8111-111111111115'
const FIGLIO_PONTE = '11111111-1111-4111-8111-111111111116'
const FIGLIO_DOPPIO = '11111111-1111-4111-8111-111111111117'
const FIGLIO_ALTRI_ANNI = '11111111-1111-4111-8111-111111111118'
const FIGLIO_SENZA_SEZIONE = '11111111-1111-4111-8111-11111111111a'

const PONTE_1 = '88888888-8888-4888-8888-888888888881'
const PONTE_2 = '88888888-8888-4888-8888-888888888882'

const DOC_SEZ_1 = '77777777-7777-4777-8777-777777777771'
const DOC_SEZ_2 = '77777777-7777-4777-8777-777777777772'
/** Ha sulla sezione 1 solo la riga per materia: dice quali materie, non che la classe è sua. */
const DOC_MATERIA = '77777777-7777-4777-8777-777777777773'
const SEGRETERIA = '77777777-7777-4777-8777-777777777774'
const DIREZIONE = '77777777-7777-4777-8777-777777777775'
const AMMINISTRATORE = '77777777-7777-4777-8777-777777777776'
const CUOCA = '77777777-7777-4777-8777-777777777777'

type Riga = { alunno_id: string; frequenza_id: string; section_id: string | null; scuola_id: string }

let db: PGlite
/** `anni_sede.id` di ogni anno della sede principale, e l'anno attivo della seconda. */
const ANNO: Record<number, string> = {}
let ATTIVO_B: string
let PRIMA_B: string
let ANNO_2627: string
let FREQ_1: string
let FREQ_2: string
let FREQ_RITIRATO: string
let FREQ_SENZA_SEZIONE: string

const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 30_000)

async function inRollback(fn: () => Promise<void>) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}

/** Il codice dell'errore, dentro una transazione: un savepoint, così l'errore non la rovina. */
async function codiceErrore(sql: string, params: unknown[] = []): Promise<string> {
  await db.exec('SAVEPOINT prima_dell_errore')
  try {
    await db.query(sql, params)
  } catch (e) {
    await db.exec('ROLLBACK TO SAVEPOINT prima_dell_errore')
    return (e as { code?: string }).code ?? 'senza-codice'
  }
  await db.exec('RELEASE SAVEPOINT prima_dell_errore')
  return 'nessun-errore'
}

async function comeUtente(ruolo: string, sub: string | null) {
  await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(sub ? { sub, role: ruolo } : { role: ruolo })])
  await db.exec(`SET LOCAL ROLE ${ruolo}`)
}

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}

const COLONNE = 'alunno_id, frequenza_id, section_id, scuola_id'

async function figliDi(genitore: string | null): Promise<Riga[]> {
  const r = await db.query<Riga>(`SELECT ${COLONNE} FROM public.figli_attivi($1) ORDER BY alunno_id`, [genitore])
  return r.rows
}

const soliId = (righe: Riga[]) => righe.map((x) => x.alunno_id)

type DatiFrequenza = {
  alunno: string
  annoSede: string
  sezione?: string | null
  stato?: string
  ingresso?: string
  uscita?: string | null
  origine?: string
  tipo?: string | null
  continuaDa?: string | null
  /** Di partenza il giorno del riempimento, come tutte quelle di produzione; per una riga nata dopo, `NATA_ORA`. */
  creataIl?: string
}

/** Tutte le frequenze del riempimento sono nate quel giorno: per loro `data_ingresso` è una stima. */
const NATA_COL_RIEMPIMENTO = '2026-11-07T10:00:00+01:00'
/** Una riga nata dopo il riempimento: `now` è un valore che Postgres capisce, ed è l'istante della transazione. */
const NATA_ORA = 'now'

/** Di partenza una frequenza `recupero` e `iscritto`, come tutte quelle di produzione. */
async function frequenza(d: DatiFrequenza): Promise<string> {
  return una<string>(
    `INSERT INTO public.frequenze (alunno_id, anno_sede_id, section_id, stato, data_ingresso, data_uscita, origine, tipo, continua_da, creata_il)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [d.alunno, d.annoSede, d.sezione ?? null, d.stato ?? 'iscritto', d.ingresso ?? '2026-09-01', d.uscita ?? null,
      d.origine ?? 'recupero', d.tipo ?? null, d.continuaDa ?? null, d.creataIl ?? NATA_COL_RIEMPIMENTO])
}

/** Una frequenza venuta da una domanda: `data_ingresso` è vera, e non serve la quota per essere attiva (`in_attesa`). */
const nuovaIscrizione = (d: DatiFrequenza) =>
  frequenza({ stato: 'in_attesa', origine: 'domanda', tipo: 'nuova', ...d })

/** Una conferma dell'anno dopo, che si aggancia alla frequenza dell'anno prima. */
const conferma = (d: DatiFrequenza) =>
  frequenza({ stato: 'in_attesa', origine: 'conferma', tipo: 'conferma', ...d })

type DatiFoto = {
  sede?: string
  tag?: string[]
  broadcast?: boolean
  target?: string[] | null
  classi?: string[] | null
  /** Il giorno di caricamento (a metà giornata), oppure un istante intero con `il`. */
  giorno?: string
  il?: string
  competenza?: string | null
  eliminata?: boolean
}

/** Di partenza una foto del 20/10/2026 nella prima sede, senza tag e senza destinatari. */
async function foto(d: DatiFoto): Promise<string> {
  return una<string>(
    `INSERT INTO public.galleria_media_v2
       (scuola_id, tag_students, is_broadcast, target_section_ids, target_classes, created_at, giorno_competenza, eliminato_il)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [d.sede ?? SEDE, d.tag ?? [], d.broadcast ?? false, d.target ?? null, d.classi ?? null,
      d.il ?? `${d.giorno ?? '2026-10-20'}T12:00:00+02:00`, d.competenza ?? null, d.eliminata ? '2026-10-30T10:00:00Z' : null])
}

/** Una riga dello storico delle classi, `[dal, al)`. */
async function storico(alunno: string, sezione: string, dal: string, al: string | null = null, fonte = 'attuale', sede = SEDE) {
  await db.query(
    `INSERT INTO public.alunni_classi_storico (alunno_id, scuola_id, section_id, dal, al, fonte) VALUES ($1, $2, $3, $4, $5, $6)`,
    [alunno, sede, sezione, dal, al, fonte])
}

type Coppia = { media_id: string; alunno_id: string }

async function coppieDi(genitore: string | null): Promise<Coppia[]> {
  const r = await db.query<Coppia>(`SELECT media_id, alunno_id FROM public.media_visibili_genitore($1)`, [genitore])
  return r.rows
}

/** Le foto che un genitore vede, ognuna una volta sola per ogni figlio. */
async function fotoDi(genitore: string): Promise<string[]> {
  return (await coppieDi(genitore)).map((x) => x.media_id).sort()
}

const ordinate = (...id: string[]) => [...id].sort()

/**
 * Oggi secondo il database, con l'anno attivo allargato attorno a oggi perché le date relative ci stiano dentro
 * qualunque sia il giorno della prova. Va chiamata DENTRO `inRollback`: `now()` è quello della transazione, e i due
 * vincoli che l'allargamento urterebbe (periodi e continuità) sono differiti alla COMMIT, che qui non arriva mai.
 */
async function giorni(): Promise<{ oggi: string; ieri: string; domani: string; settimanaScorsa: string }> {
  await db.query(
    `UPDATE public.anni_sede
        SET inizio = least(inizio, public.giorno_roma(now()) - 30), fine = greatest(fine, public.giorno_roma(now()) + 30)
      WHERE id = ANY ($1::uuid[])`, [[ANNO_2627, ATTIVO_B]])
  const r = await db.query<{ oggi: string; ieri: string; domani: string; settimana: string }>(
    `SELECT public.giorno_roma(now())::text AS oggi, (public.giorno_roma(now()) - 1)::text AS ieri,
            (public.giorno_roma(now()) + 1)::text AS domani, (public.giorno_roma(now()) - 7)::text AS settimana`)
  const { oggi, ieri, domani, settimana } = r.rows[0]
  return { oggi, ieri, domani, settimanaScorsa: settimana }
}

/**
 * Il passaggio all'anno dopo, dentro `inRollback`: il 2026/27 si chiude e il 2027/28 diventa l'anno attivo, anticipato
 * attorno a oggi perché una frequenza possa entrarci oggi, qualunque sia il giorno della prova. Restituisce oggi.
 */
async function passaAl2027(): Promise<string> {
  const { ieri, oggi, domani } = await giorni()
  await db.query(`UPDATE public.anni_sede SET stato = 'chiuso' WHERE id = $1`, [ANNO_2627])
  await db.query(
    `UPDATE public.anni_sede
        SET stato = 'corrente', inizio = $2, fine = $3, prepara_successivo_dal = $2, ultimo_giorno_aperto = $3
      WHERE id = $1`, [ANNO[2027], ieri, domani])
  return oggi
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE, SEDE_B], fino: 'M44a', codaPrima: SCHEMA_GALLERIA_GENITORE })
  await db.exec(SCHEMA_LEGAMI_GENITORE)

  const anni = await db.query<{ anno_inizio: number; id: string; anno_id: string; scuola_id: string }>(
    `SELECT y.anno_inizio, s.id, s.anno_id, s.scuola_id
       FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id`)
  const riga = (sede: string, n: number) => anni.rows.find((x) => x.scuola_id === sede && x.anno_inizio === n)!
  for (const n of [2025, 2026, 2027]) ANNO[n] = riga(SEDE, n).id
  ANNO_2627 = ANNO[2026]
  ATTIVO_B = riga(SEDE_B, 2026).id
  PRIMA_B = riga(SEDE_B, 2025).id

  const sezione = (id: string, sede: string, nome: string) =>
    db.query(`INSERT INTO public.sections (id, scuola_id, name, anno_id) VALUES ($1, $2, $3, $4)`,
      [id, sede, nome, riga(sede, 2026).anno_id])
  await sezione(SEZ_1, SEDE, 'Girasoli')
  await sezione(SEZ_2, SEDE, 'Margherite')
  await sezione(SEZ_B, SEDE_B, 'Tulipani')
  await db.query(`INSERT INTO public.sections (id, scuola_id, name, anno_id) VALUES ($1, $2, $3, $4)`,
    [SEZ_PRIMA, SEDE, 'Girasoli', riga(SEDE, 2025).anno_id])

  // Le frequenze le scrive la prova, una per una: lo specchio, che per ogni alunno nuovo ne fa nascere una dell'anno
  // attivo, resta spento solo mentre nascono gli alunni del seme.
  await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
  const alunno = (id: string, sede: string) =>
    db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [id, sede])
  for (const id of [FIGLIO_1, FIGLIO_2, FIGLIO_RITIRATO, FIGLIO_IN_ATTESA, FIGLIO_PONTE, FIGLIO_DOPPIO, FIGLIO_ALTRI_ANNI, FIGLIO_SENZA_SEZIONE]) {
    await alunno(id, SEDE)
  }
  await alunno(FIGLIO_TRASFERITO, SEDE_B)
  await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = true`)

  const legame = (genitore: string, figlio: string) =>
    db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [genitore, figlio])
  await legame(GEN_DUE_FIGLI, FIGLIO_1)
  await legame(GEN_DUE_FIGLI, FIGLIO_2)
  await legame(GEN_RITIRATO, FIGLIO_RITIRATO)
  await legame(GEN_IN_ATTESA, FIGLIO_IN_ATTESA)
  await legame(GEN_TRASFERITO, FIGLIO_TRASFERITO)
  await legame(GEN_DOPPIO, FIGLIO_DOPPIO)
  await legame(GEN_ALTRI_ANNI, FIGLIO_ALTRI_ANNI)
  await legame(GEN_SENZA_SEZIONE, FIGLIO_SENZA_SEZIONE)

  // Il ponte anagrafico: `parents.auth_user_id` → `student_parents`.
  await db.query(`INSERT INTO public.parents (id, auth_user_id) VALUES ($1, $2), ($3, $4)`,
    [PONTE_1, GEN_PONTE, PONTE_2, GEN_DOPPIO])
  await db.query(`INSERT INTO public.student_parents (student_id, parent_id) VALUES ($1, $2), ($3, $4)`,
    [FIGLIO_PONTE, PONTE_1, FIGLIO_DOPPIO, PONTE_2])

  FREQ_1 = await frequenza({ alunno: FIGLIO_1, annoSede: ANNO_2627, sezione: SEZ_1 })
  FREQ_2 = await frequenza({ alunno: FIGLIO_2, annoSede: ANNO_2627, sezione: SEZ_2 })
  FREQ_RITIRATO = await frequenza({
    alunno: FIGLIO_RITIRATO, annoSede: ANNO_2627, sezione: SEZ_1, stato: 'ritirato', uscita: '2026-10-01',
  })
  await frequenza({ alunno: FIGLIO_PONTE, annoSede: ANNO_2627, sezione: SEZ_2 })
  await frequenza({ alunno: FIGLIO_DOPPIO, annoSede: ANNO_2627, sezione: SEZ_1 })
  FREQ_SENZA_SEZIONE = await frequenza({ alunno: FIGLIO_SENZA_SEZIONE, annoSede: ANNO_2627 })

  await db.exec(SCHEMA_AVVISI_CHAT_VOCI_GENITORE)
  const persone: Array<[string, string]> = [
    [DOC_SEZ_1, 'educator'], [DOC_SEZ_2, 'educator'], [DOC_MATERIA, 'educator'],
    [SEGRETERIA, 'segreteria'], [DIREZIONE, 'coordinator'], [AMMINISTRATORE, 'admin'], [CUOCA, 'cuoca'],
  ]
  for (const [id, ruolo] of persone) await db.query(`INSERT INTO public.utenti (id, ruolo) VALUES ($1, $2)`, [id, ruolo])
  await db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2), ($3, $4)`,
    [DOC_SEZ_1, SEZ_1, DOC_SEZ_2, SEZ_2])
  await db.query(`INSERT INTO public.utenti_sezioni_materie (utente_id, section_id, materia_id) VALUES ($1, $2, gen_random_uuid())`,
    [DOC_MATERIA, SEZ_1])
}, 120_000)
afterAll(async () => { await db.close() })

describe('figli_attivi', () => {
  prova('un genitore con due figli iscritti li ha entrambi attivi', async () => {
    expect(await figliDi(GEN_DUE_FIGLI)).toEqual([
      { alunno_id: FIGLIO_1, frequenza_id: FREQ_1, section_id: SEZ_1, scuola_id: SEDE },
      { alunno_id: FIGLIO_2, frequenza_id: FREQ_2, section_id: SEZ_2, scuola_id: SEDE },
    ])
  })

  prova('un figlio ritirato non è attivo', async () => {
    const st = await una<string>(`SELECT stato FROM public.frequenze WHERE id = $1`, [FREQ_RITIRATO])
    expect(st).toBe('ritirato')
    expect(await figliDi(GEN_RITIRATO)).toEqual([])
  })

  // Da solo il seme non prova lo stato: la sua `data_uscita` è passata, e basterebbe la data. Qui la data lo lascerebbe dentro.
  for (const stato of ['ritirato', 'trasferito', 'uscito']) {
    prova(`un figlio ${stato} non è attivo, anche senza data di uscita o con l’uscita oggi`, async () => {
      await inRollback(async () => {
        const { oggi } = await giorni()
        await db.query(`UPDATE public.frequenze SET stato = $2, data_uscita = NULL WHERE id = $1`, [FREQ_2, stato])
        expect(soliId(await figliDi(GEN_DUE_FIGLI))).toEqual([FIGLIO_1])
        await db.query(`UPDATE public.frequenze SET data_uscita = $2 WHERE id = $1`, [FREQ_2, oggi])
        expect(soliId(await figliDi(GEN_DUE_FIGLI))).toEqual([FIGLIO_1])
      })
    })
  }

  prova('un figlio sospeso è attivo', async () => {
    await inRollback(async () => {
      await db.query(`UPDATE public.frequenze SET sospeso = true, sospeso_causa = 'morosita' WHERE id = $1`, [FREQ_1])
      expect(await una<boolean>(`SELECT sospeso FROM public.frequenze WHERE id = $1`, [FREQ_1])).toBe(true)
      expect(soliId(await figliDi(GEN_DUE_FIGLI))).toEqual([FIGLIO_1, FIGLIO_2])
    })
  })

  prova('un figlio in attesa con ingresso futuro non è attivo', async () => {
    await inRollback(async () => {
      const { oggi, domani } = await giorni()
      const f = await frequenza({
        alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, sezione: SEZ_1, stato: 'in_attesa', ingresso: domani,
        origine: 'domanda', tipo: 'nuova',
      })
      expect(await una<string>(`SELECT stato FROM public.frequenze WHERE id = $1`, [f])).toBe('in_attesa')
      expect(await figliDi(GEN_IN_ATTESA)).toEqual([])
      // Il giorno dell'ingresso, invece, è attivo: lo stato `in_attesa` non lo esclude.
      await db.query(`UPDATE public.frequenze SET data_ingresso = $2 WHERE id = $1`, [f, oggi])
      expect(soliId(await figliDi(GEN_IN_ATTESA))).toEqual([FIGLIO_IN_ATTESA])
    })
  })

  prova('il legame via student_parents + parents.auth_user_id conta come il legame diretto', async () => {
    expect(soliId(await figliDi(GEN_PONTE))).toEqual([FIGLIO_PONTE])
  })

  prova('con due figli, uno che lascia: resta solo l’altro', async () => {
    await inRollback(async () => {
      await db.query(`UPDATE public.frequenze SET stato = 'ritirato', data_uscita = '2026-10-01' WHERE id = $1`, [FREQ_2])
      expect(soliId(await figliDi(GEN_DUE_FIGLI))).toEqual([FIGLIO_1])
    })
  })

  prova('un trasferito fra sedi vede solo la sede e la classe nuova', async () => {
    await inRollback(async () => {
      // Il giorno del trasferimento, com'è in produzione: oggi cade dentro tutte e due le frequenze, e decide lo stato.
      const { oggi } = await giorni()
      await frequenza({
        alunno: FIGLIO_TRASFERITO, annoSede: ANNO_2627, sezione: SEZ_1, stato: 'trasferito', uscita: oggi,
      })
      const nuova = await frequenza({ alunno: FIGLIO_TRASFERITO, annoSede: ATTIVO_B, sezione: SEZ_B, ingresso: oggi })
      expect(await figliDi(GEN_TRASFERITO)).toEqual([
        { alunno_id: FIGLIO_TRASFERITO, frequenza_id: nuova, section_id: SEZ_B, scuola_id: SEDE_B },
      ])
    })
  })

  prova('un figlio collegato per tutte e due le strade compare una volta sola', async () => {
    expect(soliId(await figliDi(GEN_DOPPIO))).toEqual([FIGLIO_DOPPIO])
  })

  // Il contratto è una riga per FREQUENZA viva, non una per bambino. `frequenze_una_viva_per_anno` copre solo lo stesso
  // `anno_id` e `anno_attivo` è per sede: con due sedi su anni attivi diversi le righe sono due, tutte e due vere.
  prova('un bambino vivo in due sedi con anni attivi diversi dà due righe, una per frequenza', async () => {
    await inRollback(async () => {
      // La seconda sede non è ancora passata al 2026/27: il suo anno attivo è il 2025/26.
      await db.query(`UPDATE public.anni_sede SET stato = 'in_preparazione' WHERE id = $1`, [ATTIVO_B])
      const inB = await frequenza({ alunno: FIGLIO_PONTE, annoSede: PRIMA_B, sezione: null, ingresso: '2025-09-01' })
      const righe = await figliDi(GEN_PONTE)
      expect(righe.map((x) => [x.frequenza_id, x.scuola_id]).filter(([f]) => f === inB)).toEqual([[inB, SEDE_B]])
      expect(righe.map((x) => x.alunno_id)).toEqual([FIGLIO_PONTE, FIGLIO_PONTE])
      expect(new Set(righe.map((x) => x.scuola_id))).toEqual(new Set([SEDE, SEDE_B]))
    })
  })

  // In produzione i bambini così sono 5, e la riscrittura di `getFigliAttiviDiGenitore` conta su questa forma.
  prova('un figlio attivo senza sezione torna con section_id NULL', async () => {
    expect(await figliDi(GEN_SENZA_SEZIONE)).toEqual([
      { alunno_id: FIGLIO_SENZA_SEZIONE, frequenza_id: FREQ_SENZA_SEZIONE, section_id: null, scuola_id: SEDE },
    ])
  })

  prova('il giorno dell’uscita è ancora attivo, il giorno dopo no, anche se lo stato è rimasto iscritto', async () => {
    await inRollback(async () => {
      const { oggi, ieri, settimanaScorsa } = await giorni()
      await db.query(`UPDATE public.frequenze SET data_ingresso = $2, data_uscita = $3 WHERE id = $1`,
        [FREQ_1, settimanaScorsa, oggi])
      expect(soliId(await figliDi(GEN_DUE_FIGLI))).toEqual([FIGLIO_1, FIGLIO_2])
      await db.query(`UPDATE public.frequenze SET data_uscita = $2 WHERE id = $1`, [FREQ_1, ieri])
      expect(soliId(await figliDi(GEN_DUE_FIGLI))).toEqual([FIGLIO_2])
    })
  })

  // Il confine dell'anno per le frequenze di recupero riguarda le foto (compito 4.4.2). Qui il recupero è come le altre:
  // in produzione un recupero con ingresso futuro non esiste, e se ci fosse il figlio non sarebbe ancora attivo.
  prova('una frequenza di recupero con ingresso futuro non è attiva', async () => {
    await inRollback(async () => {
      const { domani } = await giorni()
      await frequenza({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, sezione: SEZ_1, origine: 'recupero', ingresso: domani })
      expect(await figliDi(GEN_IN_ATTESA)).toEqual([])
    })
  })

  prova('una frequenza viva in un anno diverso da quello attivo non rende attivo il figlio', async () => {
    await inRollback(async () => {
      await frequenza({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2025], ingresso: '2025-09-01' })
      await frequenza({
        alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2027], stato: 'in_attesa', ingresso: '2027-09-01',
        origine: 'domanda', tipo: 'conferma',
      })
      expect(await figliDi(GEN_ALTRI_ANNI)).toEqual([])
    })
  })

  prova('quando l’anno attivo della sede cambia, la frequenza dell’anno lasciato non conta più', async () => {
    await inRollback(async () => {
      await db.query(`UPDATE public.anni_sede SET stato = 'chiuso' WHERE id = $1`, [ANNO_2627])
      await db.query(`UPDATE public.anni_sede SET stato = 'corrente' WHERE id = $1`, [ANNO[2027]])
      expect(await figliDi(GEN_DUE_FIGLI)).toEqual([])
    })
  })

  prova('un alunno nuovo, con la frequenza fatta nascere dallo specchio, è attivo dal primo giorno', async () => {
    await inRollback(async () => {
      const nuovo = '11111111-1111-4111-8111-111111111119'
      await db.query(`INSERT INTO public.alunni (id, scuola_id, section_id) VALUES ($1, $2, $3)`, [nuovo, SEDE, SEZ_1])
      await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [GEN_IN_ATTESA, nuovo])
      const r = await figliDi(GEN_IN_ATTESA)
      expect(r.map((x) => [x.alunno_id, x.section_id, x.scuola_id])).toEqual([[nuovo, SEZ_1, SEDE]])
    })
  })

  prova('un utente senza legami, o nullo, non ha figli attivi', async () => {
    expect(await figliDi('99999999-9999-4999-8999-999999999990')).toEqual([])
    expect(await figliDi(null)).toEqual([])
  })

  describe('schema indietro: una tabella dei legami può mancare (to_regclass)', () => {
    prova('senza student_parents resta il legame diretto', async () => {
      await inRollback(async () => {
        await db.exec(`DROP TABLE public.student_parents`)
        expect(soliId(await figliDi(GEN_DOPPIO))).toEqual([FIGLIO_DOPPIO])
        expect(await figliDi(GEN_PONTE)).toEqual([])
      })
    })

    prova('senza parents resta il legame diretto', async () => {
      await inRollback(async () => {
        await db.exec(`DROP TABLE public.parents`)
        expect(soliId(await figliDi(GEN_DOPPIO))).toEqual([FIGLIO_DOPPIO])
        expect(await figliDi(GEN_PONTE)).toEqual([])
      })
    })

    prova('senza legame_genitori_alunni resta il ponte anagrafico', async () => {
      await inRollback(async () => {
        await db.exec(`DROP TABLE public.legame_genitori_alunni`)
        expect(soliId(await figliDi(GEN_PONTE))).toEqual([FIGLIO_PONTE])
        expect(await figliDi(GEN_DUE_FIGLI)).toEqual([])
      })
    })
  })

  describe('chi può chiamarla', () => {
    const miei = async () =>
      (await db.query<Riga>(`SELECT ${COLONNE} FROM public.figli_attivi_miei() ORDER BY alunno_id`)).rows

    prova('authenticated non può chiamare figli_attivi(uuid), può chiamare figli_attivi_miei()', async () => {
      await inRollback(async () => {
        await comeUtente('authenticated', GEN_DUE_FIGLI)
        // La funzione col parametro permetterebbe di enumerare i figli altrui.
        expect(await codiceErrore(`SELECT * FROM public.figli_attivi($1)`, [GEN_RITIRATO])).toBe('42501')
        expect(soliId(await miei())).toEqual([FIGLIO_1, FIGLIO_2])
      })
    })

    prova('anon non può chiamare nessuna delle due', async () => {
      await inRollback(async () => {
        await comeUtente('anon', null)
        expect(await codiceErrore(`SELECT * FROM public.figli_attivi($1)`, [GEN_DUE_FIGLI])).toBe('42501')
        expect(await codiceErrore(`SELECT * FROM public.figli_attivi_miei()`)).toBe('42501')
      })
    })

    prova('service_role chiama figli_attivi(uuid) per conto di un genitore', async () => {
      await inRollback(async () => {
        await comeUtente('service_role', null)
        expect(soliId(await figliDi(GEN_DUE_FIGLI))).toEqual([FIGLIO_1, FIGLIO_2])
      })
    })

    prova('figli_attivi_miei() dà esattamente le righe di chi chiama, e niente a chi non ha claim', async () => {
      const attese = await figliDi(GEN_PONTE)
      expect(attese).toHaveLength(1)
      await inRollback(async () => {
        await comeUtente('authenticated', GEN_PONTE)
        expect(await miei()).toEqual(attese)
      })
      await inRollback(async () => {
        await comeUtente('authenticated', null)
        expect(await miei()).toEqual([])
      })
    })
  })
})

describe('media_visibili_genitore', () => {
  describe('la regola del figlio attivo', () => {
    prova('la foto taggata del proprio figlio attivo è visibile', async () => {
      await inRollback(async () => {
        const m = await foto({ tag: [FIGLIO_1] })
        expect(await coppieDi(GEN_DUE_FIGLI)).toEqual([{ media_id: m, alunno_id: FIGLIO_1 }])
      })
    })

    prova('la foto del figlio di un altro non è visibile', async () => {
      await inRollback(async () => {
        await foto({ tag: [FIGLIO_PONTE] })
        expect(await coppieDi(GEN_DUE_FIGLI)).toEqual([])
      })
    })

    prova('un ritirato non vede niente, nemmeno le foto in cui è taggato', async () => {
      await inRollback(async () => {
        await foto({ tag: [FIGLIO_RITIRATO] })
        await foto({ tag: [FIGLIO_RITIRATO], giorno: '2026-09-15' })
        await foto({ broadcast: true })
        await storico(FIGLIO_RITIRATO, SEZ_1, '2026-09-01')
        await foto({ target: [SEZ_1] })
        expect(await coppieDi(GEN_RITIRATO)).toEqual([])
      })
    })

    prova('con due figli, quando uno lascia si perdono solo le foto che arrivavano da lui', async () => {
      await inRollback(async () => {
        const insieme = await foto({ tag: [FIGLIO_1, FIGLIO_2] })
        const soloUno = await foto({ tag: [FIGLIO_1] })
        const soloAltro = await foto({ tag: [FIGLIO_2] })
        expect(await fotoDi(GEN_DUE_FIGLI)).toEqual(ordinate(insieme, insieme, soloUno, soloAltro))

        await db.query(`UPDATE public.frequenze SET stato = 'ritirato', data_uscita = '2026-10-01' WHERE id = $1`, [FREQ_2])
        const dopo = await coppieDi(GEN_DUE_FIGLI)
        expect(dopo.every((x) => x.alunno_id === FIGLIO_1)).toBe(true)
        expect(dopo.map((x) => x.media_id).sort()).toEqual(ordinate(insieme, soloUno))
      })
    })

    prova('un trasferito vede solo le foto della sede nuova', async () => {
      await inRollback(async () => {
        const { oggi } = await giorni()
        const vecchia = await frequenza({
          alunno: FIGLIO_TRASFERITO, annoSede: ANNO_2627, sezione: SEZ_1, stato: 'trasferito', uscita: oggi,
        })
        await frequenza({ alunno: FIGLIO_TRASFERITO, annoSede: ATTIVO_B, sezione: SEZ_B, continuaDa: vecchia })
        await storico(FIGLIO_TRASFERITO, SEZ_1, '2026-09-01', oggi)
        await storico(FIGLIO_TRASFERITO, SEZ_B, oggi, null, 'trasferimento', SEDE_B)
        await foto({ tag: [FIGLIO_TRASFERITO] })
        await foto({ broadcast: true })
        await foto({ target: [SEZ_1] })
        const nuova = await foto({ sede: SEDE_B, tag: [FIGLIO_TRASFERITO] })
        expect(await coppieDi(GEN_TRASFERITO)).toEqual([{ media_id: nuova, alunno_id: FIGLIO_TRASFERITO }])
      })
    })

    prova('una foto eliminata non è mai visibile', async () => {
      await inRollback(async () => {
        await storico(FIGLIO_DOPPIO, SEZ_1, '2026-10-15')
        await foto({ tag: [FIGLIO_DOPPIO], eliminata: true })
        await foto({ broadcast: true, eliminata: true })
        await foto({ target: [SEZ_1], eliminata: true })
        expect(await coppieDi(GEN_DOPPIO)).toEqual([])
      })
    })

    prova('l’output contiene alunno_id: serve all’invariante 7', async () => {
      await inRollback(async () => {
        const m = await foto({ tag: [FIGLIO_1, FIGLIO_2] })
        const r = await db.query<Coppia>(
          `SELECT media_id, alunno_id FROM public.media_visibili_genitore($1) ORDER BY alunno_id`, [GEN_DUE_FIGLI])
        expect(r.fields.map((c) => c.name)).toEqual(['media_id', 'alunno_id'])
        expect(r.rows).toEqual([{ media_id: m, alunno_id: FIGLIO_1 }, { media_id: m, alunno_id: FIGLIO_2 }])
      })
    })

    prova('un utente senza figli, o nullo, non vede niente', async () => {
      await inRollback(async () => {
        await foto({ broadcast: true })
        expect(await coppieDi('99999999-9999-4999-8999-999999999990')).toEqual([])
        expect(await coppieDi(null)).toEqual([])
      })
    })
  })

  describe('da quando', () => {
    prova('una famiglia nuova vede le foto solo dall’ingresso', async () => {
      await inRollback(async () => {
        await nuovaIscrizione({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, sezione: SEZ_1, ingresso: '2026-10-15' })
        await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-10-14' })
        const dallIngresso = await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-10-15' })
        expect(await fotoDi(GEN_IN_ATTESA)).toEqual([dallIngresso])
      })
    })

    // Le 811 frequenze del riempimento sono recuperi con una `data_ingresso` stimata (il primo `dal` dello storico): 175 coppie
    // foto-figlio di 64 bambini vivi hanno la foto prima di quella data, e non devono sparire.
    describe('una riga del riempimento', () => {
      prova('la stessa foto prima di data_ingresso: invisibile con origine domanda, visibile con origine recupero', async () => {
        await inRollback(async () => {
          const m = await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-10-14' })
          const f = await nuovaIscrizione({
            alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, ingresso: '2026-10-15', creataIl: NATA_COL_RIEMPIMENTO,
          })
          expect(await fotoDi(GEN_IN_ATTESA)).toEqual([])
          await db.query(`UPDATE public.frequenze SET origine = 'recupero' WHERE id = $1`, [f])
          expect(await fotoDi(GEN_IN_ATTESA)).toEqual([m])
        })
      })

      prova('nata il 07/11 alle 23:30 di Roma è del riempimento', async () => {
        await inRollback(async () => {
          await frequenza({
            alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, ingresso: '2026-10-15', creataIl: '2026-11-07T23:30:00+01:00',
          })
          const m = await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-10-14' })
          expect(await fotoDi(GEN_IN_ATTESA)).toEqual([m])
        })
      })

      prova('nata l’08/11 alle 00:30 di Roma non lo è, anche se in UTC è ancora il 07/11', async () => {
        await inRollback(async () => {
          // Le sessioni di produzione sono in UTC; PGlite prende il fuso della macchina, e un `::date` qui non si vedrebbe.
          await db.exec(`SET LOCAL TimeZone = 'UTC'`)
          await frequenza({
            alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, ingresso: '2026-10-15', creataIl: '2026-11-08T00:30:00+01:00',
          })
          await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-10-14' })
          const dallIngresso = await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-10-15' })
          expect(await fotoDi(GEN_IN_ATTESA)).toEqual([dallIngresso])
        })
      })

      prova('limite dichiarato: una correzione della segreteria su una riga del riempimento non sposta il confine', async () => {
        await inRollback(async () => {
          const f = await frequenza({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, ingresso: '2026-10-15' })
          const primoGiorno = await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-09-01' })
          await db.query(`UPDATE public.frequenze SET data_ingresso = '2026-10-20' WHERE id = $1`, [f])
          expect(await fotoDi(GEN_IN_ATTESA)).toEqual([primoGiorno])
        })
      })
    })

    // Lo specchio scrive `recupero` anche per ogni bambino nuovo e per il trasferito nella sede nuova, e la segreteria può
    // scegliere o correggere la data: dopo il riempimento `data_ingresso` è sempre vera, anche se è prima di `creata_il`.
    describe('un recupero nato dopo il riempimento', () => {
      prova('una data scelta all’indietro vale per quello che dice', async () => {
        await inRollback(async () => {
          await frequenza({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, ingresso: '2026-11-01', creataIl: NATA_ORA })
          await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-10-31' })
          await foto({ broadcast: true, giorno: '2026-10-31' })
          const dallIngresso = await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-11-01' })
          expect(await fotoDi(GEN_IN_ATTESA)).toEqual([dallIngresso])
        })
      })

      prova('una data spostata di un giorno sposta il confine di un giorno solo', async () => {
        await inRollback(async () => {
          const { ieri, oggi } = await giorni()
          const f = await frequenza({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, ingresso: oggi, creataIl: NATA_ORA })
          await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-10-10' })
          const diIeri = await foto({ tag: [FIGLIO_IN_ATTESA], giorno: ieri })
          const diOggi = await foto({ tag: [FIGLIO_IN_ATTESA], giorno: oggi })
          expect(await fotoDi(GEN_IN_ATTESA)).toEqual([diOggi])
          await db.query(`UPDATE public.frequenze SET data_ingresso = $2 WHERE id = $1`, [f, ieri])
          expect(await fotoDi(GEN_IN_ATTESA)).toEqual(ordinate(diIeri, diOggi))
        })
      })

      prova('nella catena vale la stessa regola: la conferma vede dalla data vera del recupero', async () => {
        await inRollback(async () => {
          const oggi = await passaAl2027()
          const recupero = await frequenza({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627, ingresso: '2026-11-01', creataIl: NATA_ORA })
          await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2027], ingresso: oggi, continuaDa: recupero })
          await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-10-31' })
          const dallIngresso = await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-11-01' })
          expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual([dallIngresso])
        })
      })

      // Lo specchio porta l'ingresso a `fine` quando l'anno è finito e la sede non è ancora passata.
      prova('un bambino nato dopo la fine dell’anno, con la sede non ancora passata, non vede le foto di prima', async () => {
        await inRollback(async () => {
          const date = await db.query<{ fine: string; vecchia: string }>(
            `SELECT (public.giorno_roma(now()) - 3)::text AS fine, (public.giorno_roma(now()) - 60)::text AS vecchia`)
          const { fine, vecchia } = date.rows[0]
          await db.query(
            `UPDATE public.anni_sede
                SET inizio = least(inizio, $2::date - 90), fine = $2, ultimo_giorno_aperto = $2, prepara_successivo_dal = $2
              WHERE id = $1`, [ANNO_2627, fine])
          const nuovo = '11111111-1111-4111-8111-11111111111c'
          const genitore = '99999999-9999-4999-8999-99999999999b'
          await db.query(`INSERT INTO public.alunni (id, scuola_id, section_id) VALUES ($1, $2, $3)`, [nuovo, SEDE, SEZ_1])
          await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [genitore, nuovo])
          const nata = await db.query<{ origine: string; ingresso: string }>(
            `SELECT origine, data_ingresso::text AS ingresso FROM public.frequenze WHERE alunno_id = $1`, [nuovo])
          expect(nata.rows).toEqual([{ origine: 'recupero', ingresso: fine }])

          await storico(nuovo, SEZ_1, vecchia)
          await foto({ tag: [nuovo], giorno: vecchia })
          await foto({ broadcast: true, giorno: vecchia })
          await foto({ target: [SEZ_1], giorno: vecchia })
          expect(await coppieDi(genitore)).toEqual([])

          const dallIngresso = await foto({ tag: [nuovo], giorno: fine })
          expect(await coppieDi(genitore)).toEqual([{ media_id: dallIngresso, alunno_id: nuovo }])
        })
      })

      // Con il trigger vero, non con una riga scritta dalla prova: è così che nasce oggi ogni frequenza nuova.
      prova('un bambino nato dallo specchio non vede le foto di prima, da nessuna delle tre strade', async () => {
        await inRollback(async () => {
          const { ieri, oggi } = await giorni()
          const nuovo = '11111111-1111-4111-8111-11111111111b'
          const genitore = '99999999-9999-4999-8999-99999999999a'
          await db.query(`INSERT INTO public.alunni (id, scuola_id, section_id) VALUES ($1, $2, $3)`, [nuovo, SEDE, SEZ_1])
          await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [genitore, nuovo])
          const nata = await db.query<{ origine: string; ingresso: string }>(
            `SELECT origine, data_ingresso::text AS ingresso FROM public.frequenze WHERE alunno_id = $1`, [nuovo])
          expect(nata.rows).toEqual([{ origine: 'recupero', ingresso: oggi }])

          await foto({ tag: [nuovo], giorno: ieri })
          await foto({ broadcast: true, giorno: ieri })
          // Prima del 15/10/2026, dove lo storico tace e deciderebbe la sezione della frequenza.
          await foto({ target: [SEZ_1], giorno: '2026-10-01' })
          expect(await coppieDi(genitore)).toEqual([])

          const diOggi = await foto({ tag: [nuovo], giorno: oggi })
          expect(await coppieDi(genitore)).toEqual([{ media_id: diOggi, alunno_id: nuovo }])
        })
      })

      prova('un trasferito dallo specchio non vede le foto della sede nuova di prima del trasferimento', async () => {
        await inRollback(async () => {
          const { ieri, oggi } = await giorni()
          await db.query(`UPDATE public.alunni SET scuola_id = $2, section_id = $3 WHERE id = $1`, [FIGLIO_DOPPIO, SEDE_B, SEZ_B])
          const vive = await db.query<{ scuola_id: string; origine: string; ingresso: string }>(
            `SELECT scuola_id, origine, data_ingresso::text AS ingresso FROM public.frequenze
              WHERE alunno_id = $1 AND stato IN ('in_attesa', 'iscritto')`, [FIGLIO_DOPPIO])
          expect(vive.rows).toEqual([{ scuola_id: SEDE_B, origine: 'recupero', ingresso: oggi }])

          await foto({ sede: SEDE_B, tag: [FIGLIO_DOPPIO], giorno: ieri })
          await foto({ sede: SEDE_B, broadcast: true, giorno: ieri })
          await foto({ sede: SEDE_B, target: [SEZ_B], giorno: '2026-10-01' })
          await foto({ tag: [FIGLIO_DOPPIO], giorno: ieri })
          expect(await coppieDi(GEN_DOPPIO)).toEqual([])

          const diOggi = await foto({ sede: SEDE_B, tag: [FIGLIO_DOPPIO], giorno: oggi })
          expect(await coppieDi(GEN_DOPPIO)).toEqual([{ media_id: diOggi, alunno_id: FIGLIO_DOPPIO }])
        })
      })
    })

    prova('un recupero vede dall’inizio dell’anno della sede, non da prima', async () => {
      await inRollback(async () => {
        await frequenza({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, ingresso: '2026-10-15' })
        await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-08-31' })
        const primoGiorno = await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-09-01' })
        expect(await fotoDi(GEN_IN_ATTESA)).toEqual([primoGiorno])
      })
    })

    prova('chi continua dall’anno prima vede anche le foto dell’anno prima', async () => {
      await inRollback(async () => {
        const prima = await frequenza({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2025], ingresso: '2025-09-01' })
        await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627, continuaDa: prima })
        const annoPrima = await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-03-10' })
        const annoOra = await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-10-20' })
        expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual(ordinate(annoPrima, annoOra))
      })
    })

    prova('senza continua_da le foto dell’anno prima non si vedono, anche se la frequenza vecchia c’è', async () => {
      await inRollback(async () => {
        await frequenza({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2025], ingresso: '2025-09-01' })
        await nuovaIscrizione({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627 })
        await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-03-10' })
        const annoOra = await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-10-20' })
        expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual([annoOra])
      })
    })

    // Il passaggio vero: tutte le frequenze di oggi sono recuperi, e la prima conferma si aggancerà a uno di loro.
    prova('una conferma che continua da un recupero vede dall’inizio dell’anno del recupero, non dalla sua stima', async () => {
      await inRollback(async () => {
        const oggi = await passaAl2027()
        const recupero = await frequenza({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627, ingresso: '2026-10-15' })
        await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2027], ingresso: oggi, continuaDa: recupero })
        await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-08-31' })
        const primoGiorno = await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-09-01' })
        expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual([primoGiorno])
      })
    })

    prova('una conferma che continua da una domanda vede dal suo ingresso vero', async () => {
      await inRollback(async () => {
        const prima = await nuovaIscrizione({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2025], ingresso: '2026-02-01' })
        await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627, continuaDa: prima })
        await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-01-31' })
        const dallIngresso = await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-02-01' })
        expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual([dallIngresso])
      })
    })

    prova('la catena si risale fino in fondo', async () => {
      await inRollback(async () => {
        const oggi = await passaAl2027()
        const a = await nuovaIscrizione({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2025], ingresso: '2025-10-01' })
        const b = await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627, continuaDa: a })
        await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2027], ingresso: oggi, continuaDa: b })
        await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2025-09-20' })
        const dueAnniPrima = await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2025-10-01' })
        expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual([dueAnniPrima])
      })
    })

    // Le decisioni dello stato vecchio: al passaggio chi continua resta com'era, chi esce diventa `uscito` (§4.9).
    for (const [stato, come] of [['ritirato', 'un ritiro'], ['uscito', 'un’uscita'], ['trasferito', 'un trasferimento']]) {
      prova(`chi rientra dopo ${come} vede dal giorno della conferma`, async () => {
        await inRollback(async () => {
          const prima = await frequenza({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2025], ingresso: '2025-09-01', stato, uscita: '2026-03-01' })
          await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627, ingresso: '2026-10-15', continuaDa: prima })
          await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-02-10' })
          await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-10-14' })
          const dallaConferma = await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-10-15' })
          expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual([dallaConferma])
        })
      })
    }

    prova('continua_da verso la frequenza di un altro bambino non apre le foto di prima', async () => {
      await inRollback(async () => {
        const altrui = await frequenza({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO[2025], ingresso: '2025-09-01' })
        await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627, continuaDa: altrui })
        await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-03-10' })
        const annoOra = await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-10-20' })
        expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual([annoOra])
      })
    })

    prova('la catena non passa per un’altra sede: conta l’ingresso nella sede della frequenza attiva', async () => {
      await inRollback(async () => {
        const inB = await frequenza({ alunno: FIGLIO_ALTRI_ANNI, annoSede: PRIMA_B, ingresso: '2025-09-01' })
        await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627, continuaDa: inB })
        await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-03-10' })
        const annoOra = await foto({ tag: [FIGLIO_ALTRI_ANNI], giorno: '2026-10-20' })
        expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual([annoOra])
      })
    })

    prova('un continua_da che gira su se stesso non blocca la funzione', async () => {
      await inRollback(async () => {
        const f = await frequenza({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627 })
        await db.query(`UPDATE public.frequenze SET continua_da = $1 WHERE id = $1`, [f])
        const m = await foto({ tag: [FIGLIO_ALTRI_ANNI] })
        expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual([m])
      })
    })
  })

  // `giorno_competenza` è quello che decide l'anno della riga nel registro (`anno_tabelle`: data `giorno_competenza`, riserva
  // `created_at`): la segreteria può pubblicare oggi una foto di un altro giorno, e quel giorno è il suo.
  describe('il giorno della foto', () => {
    prova('una foto caricata dopo l’ingresso ma di un giorno prima resta invisibile', async () => {
      await inRollback(async () => {
        await nuovaIscrizione({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, ingresso: '2026-10-15' })
        await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-10-16', competenza: '2026-10-14' })
        expect(await fotoDi(GEN_IN_ATTESA)).toEqual([])
      })
    })

    prova('una foto caricata prima dell’ingresso ma di un giorno dopo è visibile', async () => {
      await inRollback(async () => {
        await nuovaIscrizione({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, ingresso: '2026-10-15' })
        const m = await foto({ tag: [FIGLIO_IN_ATTESA], giorno: '2026-10-14', competenza: '2026-10-15' })
        expect(await fotoDi(GEN_IN_ATTESA)).toEqual([m])
      })
    })

    prova('senza giorno_competenza vale il giorno di Roma, non quello UTC', async () => {
      await inRollback(async () => {
        await nuovaIscrizione({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, ingresso: '2026-10-15' })
        // Il 14 alle 22:30 UTC a Roma è già il 15, a mezzanotte e mezza. Il 14 alle 21:30 UTC è ancora il 14.
        const giaIl15 = await foto({ tag: [FIGLIO_IN_ATTESA], il: '2026-10-14T22:30:00Z' })
        await foto({ tag: [FIGLIO_IN_ATTESA], il: '2026-10-14T21:30:00Z' })
        expect(await fotoDi(GEN_IN_ATTESA)).toEqual([giaIl15])
      })
    })

    // Il confine ha già le sue prove qui sopra; queste guardano il giorno che decide il periodo e la sezione, fra i quali il
    // confine non distingue: la catena parte molto prima.
    describe('dentro la catena', () => {
      const conBuco = async () => {
        const prima = await frequenza({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2025], ingresso: '2025-09-01', uscita: '2026-06-30' })
        await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627, ingresso: '2026-09-15', continuaDa: prima })
      }

      prova('il broadcast caricato nel buco ma di un giorno di frequenza arriva; il contrario no', async () => {
        await inRollback(async () => {
          await conBuco()
          const m = await foto({ broadcast: true, giorno: '2026-08-10', competenza: '2026-06-30' })
          await foto({ broadcast: true, giorno: '2026-10-20', competenza: '2026-08-10' })
          expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual([m])
        })
      })

      prova('per il broadcast fa fede il giorno di Roma, non quello UTC', async () => {
        await inRollback(async () => {
          await conBuco()
          // Il 30/06 alle 21:30 UTC a Roma è ancora il 30; alle 22:30 UTC è già il 01/07, nel buco.
          const m = await foto({ broadcast: true, il: '2026-06-30T21:30:00Z' })
          await foto({ broadcast: true, il: '2026-06-30T22:30:00Z' })
          expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual([m])
        })
      })

      prova('la sezione è quella del giorno di competenza, non di quando la foto è stata caricata', async () => {
        await inRollback(async () => {
          await storico(FIGLIO_DOPPIO, SEZ_1, '2026-10-15', '2026-11-02')
          await storico(FIGLIO_DOPPIO, SEZ_2, '2026-11-02', null, 'trasferimento')
          const m = await foto({ target: [SEZ_1], giorno: '2026-11-03', competenza: '2026-11-01' })
          await foto({ target: [SEZ_2], giorno: '2026-11-03', competenza: '2026-11-01' })
          expect(await fotoDi(GEN_DOPPIO)).toEqual([m])
        })
      })

      prova('la sezione è quella del giorno di Roma, non di quello UTC', async () => {
        await inRollback(async () => {
          await storico(FIGLIO_DOPPIO, SEZ_1, '2026-10-15', '2026-11-02')
          await storico(FIGLIO_DOPPIO, SEZ_2, '2026-11-02', null, 'trasferimento')
          // Dopo il 25/10 Roma è a UTC+1: il 01/11 alle 23:30 UTC a Roma è già il 02/11.
          const m = await foto({ target: [SEZ_2], il: '2026-11-01T23:30:00Z' })
          await foto({ target: [SEZ_1], il: '2026-11-01T23:30:00Z' })
          expect(await fotoDi(GEN_DOPPIO)).toEqual([m])
        })
      })
    })
  })

  describe('la foto per tutta la sede', () => {
    prova('il broadcast con target vuoto arriva a chi era iscritto in quella sede quel giorno', async () => {
      await inRollback(async () => {
        const m = await foto({ broadcast: true })
        const conVuoto = await foto({ broadcast: true, target: [], classi: [] })
        expect(await fotoDi(GEN_DOPPIO)).toEqual(ordinate(m, conVuoto))
        expect(await fotoDi(GEN_PONTE)).toEqual(ordinate(m, conVuoto))
      })
    })

    prova('non arriva a chi sta in un’altra sede', async () => {
      await inRollback(async () => {
        await frequenza({ alunno: FIGLIO_TRASFERITO, annoSede: ATTIVO_B, sezione: SEZ_B })
        await foto({ broadcast: true })
        const inB = await foto({ broadcast: true, sede: SEDE_B })
        expect(await fotoDi(GEN_TRASFERITO)).toEqual([inB])
      })
    })

    prova('non arriva a chi quel giorno non c’era ancora', async () => {
      await inRollback(async () => {
        await nuovaIscrizione({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, ingresso: '2026-10-15' })
        await foto({ broadcast: true, giorno: '2026-10-14' })
        const dallIngresso = await foto({ broadcast: true, giorno: '2026-10-15' })
        expect(await fotoDi(GEN_IN_ATTESA)).toEqual([dallIngresso])
      })
    })

    prova('la catena viva porta i broadcast dell’anno prima, ma non quelli dei giorni in cui il bambino non c’era', async () => {
      await inRollback(async () => {
        const prima = await frequenza({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2025], ingresso: '2025-09-01', uscita: '2026-06-30' })
        await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627, ingresso: '2026-09-15', continuaDa: prima })
        const annoPrima = await foto({ broadcast: true, giorno: '2026-03-10' })
        const ultimoGiorno = await foto({ broadcast: true, giorno: '2026-06-30' })
        await foto({ broadcast: true, giorno: '2026-07-01' })
        await foto({ broadcast: true, giorno: '2026-09-14' })
        const ingresso = await foto({ broadcast: true, giorno: '2026-09-15' })
        expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual(ordinate(annoPrima, ultimoGiorno, ingresso))
      })
    })

    prova('un anno prima senza uscita finisce con il suo anno: nel buco prima della conferma i broadcast non arrivano', async () => {
      await inRollback(async () => {
        const prima = await frequenza({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2025], ingresso: '2025-09-01' })
        await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627, ingresso: '2026-09-15', continuaDa: prima })
        const ultimoGiorno = await foto({ broadcast: true, giorno: '2026-08-31' })
        await foto({ broadcast: true, giorno: '2026-09-01' })
        const ingresso = await foto({ broadcast: true, giorno: '2026-09-15' })
        expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual(ordinate(ultimoGiorno, ingresso))
      })
    })

    // `figli_attivi` guarda lo stato dell'anno, non il calendario: finché la sede non passa, il figlio frequenta ancora.
    prova('dopo la fine dell’anno, finché la sede non passa, i broadcast continuano ad arrivare', async () => {
      await inRollback(async () => {
        await db.query(
          `UPDATE public.anni_sede SET fine = '2026-10-31', ultimo_giorno_aperto = '2026-10-31', prepara_successivo_dal = '2026-10-31'
            WHERE id = $1`, [ANNO_2627])
        await db.query(`UPDATE public.anni_sede SET inizio = '2026-11-01' WHERE id = $1`, [ANNO[2027]])
        const dopo = await foto({ broadcast: true, giorno: '2026-11-01' })
        expect(await fotoDi(GEN_DOPPIO)).toEqual([dopo])
      })
    })

    prova('un recupero riceve i broadcast dall’inizio dell’anno, anche prima della sua data_ingresso', async () => {
      await inRollback(async () => {
        await frequenza({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, ingresso: '2026-10-15' })
        await foto({ broadcast: true, giorno: '2026-08-31' })
        const primoGiorno = await foto({ broadcast: true, giorno: '2026-09-01' })
        expect(await fotoDi(GEN_IN_ATTESA)).toEqual([primoGiorno])
      })
    })

    // Il trigger traduce i nomi in uuid: un nome che nessuna sezione ha resta nei nomi e lascia gli uuid vuoti. Quella foto
    // HA dei destinatari, solo che non si sa quali: non è «per tutta la sede». Un guasto non deve aprire dati.
    prova('un broadcast verso nomi di classe che nessuna sezione ha non arriva a nessuno', async () => {
      await inRollback(async () => {
        const m = await foto({ broadcast: true, classi: ['Classe che non esiste'] })
        const r = await db.query<{ target_section_ids: string[] }>(
          `SELECT target_section_ids FROM public.galleria_media_v2 WHERE id = $1`, [m])
        expect(r.rows[0].target_section_ids).toEqual([])
        expect(await coppieDi(GEN_DOPPIO)).toEqual([])
      })
    })

    prova('senza is_broadcast, senza tag e senza destinatari una foto non arriva a nessuno', async () => {
      await inRollback(async () => {
        await foto({})
        expect(await coppieDi(GEN_DOPPIO)).toEqual([])
      })
    })
  })

  describe('la foto di una sezione', () => {
    prova('una foto della sezione A non arriva alla famiglia della sezione B', async () => {
      await inRollback(async () => {
        await storico(FIGLIO_DOPPIO, SEZ_1, '2026-10-15')
        await storico(FIGLIO_PONTE, SEZ_2, '2026-10-15')
        const m = await foto({ target: [SEZ_1] })
        expect(await coppieDi(GEN_PONTE)).toEqual([])
        expect(await coppieDi(GEN_DOPPIO)).toEqual([{ media_id: m, alunno_id: FIGLIO_DOPPIO }])
      })
    })

    prova('una foto con is_broadcast e destinatari arriva solo ai destinatari', async () => {
      await inRollback(async () => {
        await storico(FIGLIO_PONTE, SEZ_2, '2026-10-15')
        await foto({ broadcast: true, target: [SEZ_1] })
        expect(await coppieDi(GEN_PONTE)).toEqual([])
      })
    })

    prova('vale la sezione di quel giorno, con la semantica [dal, al) dello storico', async () => {
      await inRollback(async () => {
        await storico(FIGLIO_DOPPIO, SEZ_1, '2026-10-15', '2026-11-02')
        await storico(FIGLIO_DOPPIO, SEZ_2, '2026-11-02', null, 'trasferimento')
        const ultimoInA = await foto({ target: [SEZ_1], giorno: '2026-11-01' })
        await foto({ target: [SEZ_2], giorno: '2026-11-01' })
        await foto({ target: [SEZ_1], giorno: '2026-11-02' })
        const primoInB = await foto({ target: [SEZ_2], giorno: '2026-11-02' })
        expect(await fotoDi(GEN_DOPPIO)).toEqual(ordinate(ultimoInA, primoInB))
      })
    })

    prova('una foto con più destinatari arriva se uno solo è la sezione del figlio', async () => {
      await inRollback(async () => {
        await storico(FIGLIO_DOPPIO, SEZ_1, '2026-10-15')
        const m = await foto({ target: [SEZ_2, SEZ_1] })
        expect(await fotoDi(GEN_DOPPIO)).toEqual([m])
      })
    })

    prova('chi continua vede le foto della sua sezione dell’anno prima, chi è nuovo no', async () => {
      await inRollback(async () => {
        const prima = await frequenza({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2025], sezione: SEZ_PRIMA, ingresso: '2025-09-01' })
        await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627, sezione: SEZ_1, continuaDa: prima })
        await nuovaIscrizione({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, sezione: SEZ_1 })
        await storico(FIGLIO_ALTRI_ANNI, SEZ_PRIMA, '2026-01-10', '2026-01-11', 'presenza')
        await storico(FIGLIO_IN_ATTESA, SEZ_PRIMA, '2026-01-10', '2026-01-11', 'presenza')
        const m = await foto({ target: [SEZ_PRIMA], giorno: '2026-01-10' })
        expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual([m])
        expect(await fotoDi(GEN_IN_ATTESA)).toEqual([])
      })
    })

    prova('la riga dello storico di un’altra sede non conta', async () => {
      await inRollback(async () => {
        await storico(FIGLIO_DOPPIO, SEZ_B, '2026-10-15', null, 'attuale', SEDE_B)
        await foto({ target: [SEZ_B], sede: SEDE })
        expect(await coppieDi(GEN_DOPPIO)).toEqual([])
      })
    })

    // Lo storico è nato il 15/10/2026: da quel giorno ha ogni cambio di classe, prima ha solo i giorni con una presenza.
    // Per quei giorni, se lo storico tace, si guarda la sezione della frequenza; se parla, vale lui.
    describe('prima del 15/10/2026', () => {
      prova('se lo storico tace vale la sezione della frequenza di quel giorno', async () => {
        await inRollback(async () => {
          const m = await foto({ target: [SEZ_1], giorno: '2026-10-14' })
          await foto({ target: [SEZ_2], giorno: '2026-10-14' })
          expect(await coppieDi(GEN_DOPPIO)).toEqual([{ media_id: m, alunno_id: FIGLIO_DOPPIO }])
        })
      })

      prova('se lo storico parla vale lui, non la frequenza', async () => {
        await inRollback(async () => {
          // Quel giorno c'era la presenza in A; oggi la frequenza dice B.
          await storico(FIGLIO_PONTE, SEZ_1, '2026-10-01', '2026-10-02', 'presenza')
          const inA = await foto({ target: [SEZ_1], giorno: '2026-10-01' })
          await foto({ target: [SEZ_2], giorno: '2026-10-01' })
          expect(await fotoDi(GEN_PONTE)).toEqual([inA])
        })
      })

      prova('il ripiego non apre le foto di prima dell’ingresso', async () => {
        await inRollback(async () => {
          await nuovaIscrizione({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, sezione: SEZ_1, ingresso: '2026-10-10' })
          await foto({ target: [SEZ_1], giorno: '2026-10-09' })
          const dallIngresso = await foto({ target: [SEZ_1], giorno: '2026-10-10' })
          expect(await fotoDi(GEN_IN_ATTESA)).toEqual([dallIngresso])
        })
      })

      prova('il ripiego guarda la frequenza dell’anno della foto, non quella di oggi', async () => {
        await inRollback(async () => {
          const prima = await frequenza({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO[2025], sezione: SEZ_PRIMA, ingresso: '2025-09-01' })
          await conferma({ alunno: FIGLIO_ALTRI_ANNI, annoSede: ANNO_2627, sezione: SEZ_1, continuaDa: prima })
          const annoPrima = await foto({ target: [SEZ_PRIMA], giorno: '2026-03-10' })
          await foto({ target: [SEZ_1], giorno: '2026-03-10' })
          await foto({ target: [SEZ_PRIMA], giorno: '2026-10-01' })
          const annoOra = await foto({ target: [SEZ_1], giorno: '2026-10-01' })
          expect(await fotoDi(GEN_ALTRI_ANNI)).toEqual(ordinate(annoPrima, annoOra))
        })
      })
    })

    describe('dal 15/10/2026', () => {
      prova('se lo storico tace la sezione della frequenza non basta', async () => {
        await inRollback(async () => {
          await foto({ target: [SEZ_1], giorno: '2026-10-15' })
          await foto({ target: [SEZ_1], giorno: '2026-11-01' })
          expect(await coppieDi(GEN_DOPPIO)).toEqual([])
        })
      })
    })
  })

  // Una riga per coppia foto-figlio: è la chiave che usano la route (un insieme di foto) e l'invariante 7 (le righe di un figlio).
  describe('niente doppioni', () => {
    prova('una foto che arriva per più strade esce una volta sola', async () => {
      await inRollback(async () => {
        await storico(FIGLIO_DOPPIO, SEZ_1, '2026-10-15')
        const tagEDestinatari = await foto({ tag: [FIGLIO_DOPPIO], target: [SEZ_1] })
        const tagEBroadcast = await foto({ tag: [FIGLIO_DOPPIO], broadcast: true })
        expect(await coppieDi(GEN_DOPPIO)).toHaveLength(2)
        expect(await fotoDi(GEN_DOPPIO)).toEqual(ordinate(tagEDestinatari, tagEBroadcast))
      })
    })

    prova('un figlio collegato per tutte e due le strade non raddoppia le foto', async () => {
      await inRollback(async () => {
        const m = await foto({ tag: [FIGLIO_DOPPIO] })
        expect(await coppieDi(GEN_DOPPIO)).toEqual([{ media_id: m, alunno_id: FIGLIO_DOPPIO }])
      })
    })

    prova('un bambino vivo in due sedi: ogni foto esce una volta, attraverso la frequenza della sua sede', async () => {
      await inRollback(async () => {
        // La seconda sede non è ancora passata al 2026/27: `figli_attivi` dà due righe per lo stesso bambino.
        await db.query(`UPDATE public.anni_sede SET stato = 'in_preparazione' WHERE id = $1`, [ATTIVO_B])
        await frequenza({ alunno: FIGLIO_PONTE, annoSede: PRIMA_B, sezione: null, ingresso: '2025-09-01' })
        expect(await figliDi(GEN_PONTE)).toHaveLength(2)
        const inA = await foto({ tag: [FIGLIO_PONTE] })
        const inB = await foto({ tag: [FIGLIO_PONTE], sede: SEDE_B, giorno: '2026-03-10' })
        const perTuttaB = await foto({ broadcast: true, sede: SEDE_B, giorno: '2026-03-10' })
        // Una foto ha una sede sola, quindi passa da una riga sola di `figli_attivi`.
        const r = await coppieDi(GEN_PONTE)
        expect(r.map((x) => x.media_id).sort()).toEqual(ordinate(inA, inB, perTuttaB))
        expect(new Set(r.map((x) => x.alunno_id))).toEqual(new Set([FIGLIO_PONTE]))
      })
    })
  })

  prova('un figlio attivo senza sezione vede le foto taggate e quelle per la sede, non quelle di una sezione', async () => {
    await inRollback(async () => {
      const taggata = await foto({ tag: [FIGLIO_SENZA_SEZIONE] })
      const perTutti = await foto({ broadcast: true })
      await foto({ target: [SEZ_1], giorno: '2026-10-01' })
      await foto({ target: [SEZ_1], giorno: '2026-10-20' })
      expect(await fotoDi(GEN_SENZA_SEZIONE)).toEqual(ordinate(taggata, perTutti))
    })
  })

  describe('schema indietro', () => {
    prova('senza alunni_classi_storico restano i tag, i broadcast e il ripiego prima del 15/10/2026', async () => {
      await inRollback(async () => {
        const taggata = await foto({ tag: [FIGLIO_DOPPIO] })
        const perTutti = await foto({ broadcast: true })
        const ripiego = await foto({ target: [SEZ_1], giorno: '2026-10-01' })
        await foto({ target: [SEZ_1], giorno: '2026-10-20' })
        await db.exec(`DROP TABLE public.alunni_classi_storico`)
        expect(await fotoDi(GEN_DOPPIO)).toEqual(ordinate(taggata, perTutti, ripiego))
      })
    })

    prova('senza galleria_media_v2 nessuna riga e nessun errore', async () => {
      await inRollback(async () => {
        await db.exec(`DROP TABLE public.galleria_media_v2 CASCADE`)
        expect(await coppieDi(GEN_DOPPIO)).toEqual([])
      })
    })

    prova('su una galleria vecchia, senza target_section_ids, M44a non si ferma e non crea gli indici nuovi', async () => {
      const vecchio = new PGlite()
      try {
        await vecchio.exec(SCHEMA_BASE)
        await vecchio.exec(SCHEMA_GALLERIA_GENITORE)
        await applicaPr2(vecchio, 'M44a')
        const r = await vecchio.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE tablename = 'galleria_media_v2' AND indexname IN ('idx_galleria_v2_broadcast_vive', 'idx_galleria_v2_destinatari_vive')`)
        expect(r.rows).toEqual([])
      } finally {
        await vecchio.close()
      }
    })
  })

  describe('gli indici', () => {
    prova('ci sono i due nuovi, parziali sulle foto vive', async () => {
      const r = await db.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'galleria_media_v2' ORDER BY indexname`)
      const per = new Map(r.rows.map((x) => [x.indexname, x.indexdef]))
      expect(per.get('idx_galleria_v2_broadcast_vive')).toMatch(/\(scuola_id\) WHERE .*is_broadcast.*eliminato_il IS NULL/)
      expect(per.get('idx_galleria_v2_destinatari_vive')).toMatch(/USING gin \(target_section_ids\) WHERE .*eliminato_il IS NULL/)
    })
  })

  describe('chi può chiamarla', () => {
    const miei = async () =>
      (await db.query<Coppia>(`SELECT media_id, alunno_id FROM public.media_visibili_miei()`)).rows

    prova('authenticated non può chiamare media_visibili_genitore(uuid), può chiamare media_visibili_miei()', async () => {
      await inRollback(async () => {
        const mia = await foto({ tag: [FIGLIO_1] })
        await foto({ tag: [FIGLIO_PONTE] })
        await comeUtente('authenticated', GEN_DUE_FIGLI)
        expect(await codiceErrore(`SELECT * FROM public.media_visibili_genitore($1)`, [GEN_PONTE])).toBe('42501')
        expect(await miei()).toEqual([{ media_id: mia, alunno_id: FIGLIO_1 }])
      })
    })

    prova('anon non può chiamare nessuna delle due', async () => {
      await inRollback(async () => {
        await comeUtente('anon', null)
        expect(await codiceErrore(`SELECT * FROM public.media_visibili_genitore($1)`, [GEN_DUE_FIGLI])).toBe('42501')
        expect(await codiceErrore(`SELECT * FROM public.media_visibili_miei()`)).toBe('42501')
      })
    })

    prova('service_role chiama media_visibili_genitore(uuid) per conto di un genitore', async () => {
      await inRollback(async () => {
        const m = await foto({ tag: [FIGLIO_1] })
        await comeUtente('service_role', null)
        expect(await coppieDi(GEN_DUE_FIGLI)).toEqual([{ media_id: m, alunno_id: FIGLIO_1 }])
      })
    })

    prova('media_visibili_miei() dà le righe di chi chiama, e niente a chi non ha claim', async () => {
      await inRollback(async () => {
        const m = await foto({ tag: [FIGLIO_PONTE] })
        const attese = await coppieDi(GEN_PONTE)
        expect(attese).toEqual([{ media_id: m, alunno_id: FIGLIO_PONTE }])
        await db.exec('SAVEPOINT prima_del_ruolo')
        await comeUtente('authenticated', GEN_PONTE)
        expect(await miei()).toEqual(attese)
        await db.exec('ROLLBACK TO SAVEPOINT prima_del_ruolo')
        await comeUtente('authenticated', null)
        expect(await miei()).toEqual([])
      })
    })
  })
})

type DatiAvviso = {
  sede?: string | null
  scope?: string
  target?: string[] | null
  classi?: string[] | null
  /** Quanto manca alla scadenza, da adesso (`now()` è fermo dentro una transazione): `'0'` è l'ultimo istante valido. */
  fraQuanto?: string
  vecchiaScadenza?: string | null
  creatoIl?: string
}

/** Di partenza un avviso globale della prima sede, nato il 20/10/2026, che scade domani. */
async function avviso(d: DatiAvviso = {}): Promise<string> {
  return una<string>(
    `INSERT INTO public.avvisi (scuola_id, target_scope, target_section_ids, target_classes, scadenza, scadenza_avviso, created_at)
     VALUES ($1, $2, $3, $4, $5, now() + $6::interval, $7) RETURNING id`,
    [d.sede === undefined ? SEDE : d.sede, d.scope ?? 'globale', d.target ?? null, d.classi ?? null, d.vecchiaScadenza ?? null,
      d.fraQuanto ?? '1 day', d.creatoIl ?? '2026-10-20T12:00:00+02:00'])
}

type CoppiaAvviso = { avviso_id: string; alunno_id: string }

async function avvisiDi(genitore: string | null): Promise<CoppiaAvviso[]> {
  const r = await db.query<CoppiaAvviso>(
    `SELECT avviso_id, alunno_id FROM public.avvisi_visibili_genitore($1) ORDER BY avviso_id, alunno_id`, [genitore])
  return r.rows
}

describe('avvisi_visibili_genitore', () => {
  describe('a chi arriva', () => {
    prova('un avviso di una sezione arriva al figlio in quella sezione, non a quello nell’altra', async () => {
      await inRollback(async () => {
        const a = await avviso({ scope: 'classe', target: [SEZ_1] })
        expect(await avvisiDi(GEN_DUE_FIGLI)).toEqual([{ avviso_id: a, alunno_id: FIGLIO_1 }])
        expect(await avvisiDi(GEN_PONTE)).toEqual([])
      })
    })

    prova('un avviso con più sezioni arriva a chi sta in una qualunque', async () => {
      await inRollback(async () => {
        const a = await avviso({ scope: 'classe', target: [SEZ_1, SEZ_2] })
        expect(await avvisiDi(GEN_DUE_FIGLI)).toEqual([
          { avviso_id: a, alunno_id: FIGLIO_1 }, { avviso_id: a, alunno_id: FIGLIO_2 },
        ])
      })
    })

    prova('un avviso globale (target vuoto) arriva a tutta la sede, una riga per figlio', async () => {
      await inRollback(async () => {
        const nullo = await avviso()
        const vuoto = await avviso({ target: [], classi: [] })
        const atteso = (a: string) => [{ avviso_id: a, alunno_id: FIGLIO_1 }, { avviso_id: a, alunno_id: FIGLIO_2 }]
        expect(await avvisiDi(GEN_DUE_FIGLI)).toEqual(
          [...atteso(nullo), ...atteso(vuoto)].sort((x, y) => x.avviso_id.localeCompare(y.avviso_id) || x.alunno_id.localeCompare(y.alunno_id)))
        expect((await avvisiDi(GEN_PONTE)).map((x) => x.alunno_id)).toEqual([FIGLIO_PONTE, FIGLIO_PONTE])
      })
    })

    prova('un globale non esce dalla sua sede, e un avviso senza sede non arriva a nessuno', async () => {
      await inRollback(async () => {
        await frequenza({ alunno: FIGLIO_TRASFERITO, annoSede: ATTIVO_B, sezione: SEZ_B })
        await avviso()
        await avviso({ sede: null })
        expect(await avvisiDi(GEN_TRASFERITO)).toEqual([])
        const suo = await avviso({ sede: SEDE_B })
        expect(await avvisiDi(GEN_TRASFERITO)).toEqual([{ avviso_id: suo, alunno_id: FIGLIO_TRASFERITO }])
      })
    })

    prova('un destinatario di un’altra sede non apre l’avviso: decide anche la sede dell’avviso', async () => {
      await inRollback(async () => {
        await frequenza({ alunno: FIGLIO_TRASFERITO, annoSede: ATTIVO_B, sezione: SEZ_B })
        await avviso({ scope: 'classe', target: [SEZ_B] })
        expect(await avvisiDi(GEN_TRASFERITO)).toEqual([])
      })
    })

    prova('conta la sezione attuale: dopo un cambio di classe l’avviso della classe di prima non arriva più', async () => {
      await inRollback(async () => {
        const diPrima = await avviso({ scope: 'classe', target: [SEZ_1] })
        const nuova = await avviso({ scope: 'classe', target: [SEZ_2] })
        expect((await avvisiDi(GEN_DOPPIO)).map((x) => x.avviso_id)).toEqual([diPrima])
        await db.query(`UPDATE public.frequenze SET section_id = $2 WHERE alunno_id = $1`, [FIGLIO_DOPPIO, SEZ_2])
        expect((await avvisiDi(GEN_DOPPIO)).map((x) => x.avviso_id)).toEqual([nuova])
      })
    })

    prova('un figlio senza sezione non incrocia nessun destinatario, e il globale gli arriva', async () => {
      await inRollback(async () => {
        await avviso({ scope: 'classe', target: [SEZ_1, SEZ_2] })
        const perTutti = await avviso()
        expect(await avvisiDi(GEN_SENZA_SEZIONE)).toEqual([{ avviso_id: perTutti, alunno_id: FIGLIO_SENZA_SEZIONE }])
      })
    })

    prova('il legame via student_parents conta come quello diretto', async () => {
      await inRollback(async () => {
        const a = await avviso({ scope: 'classe', target: [SEZ_2] })
        expect(await avvisiDi(GEN_PONTE)).toEqual([{ avviso_id: a, alunno_id: FIGLIO_PONTE }])
      })
    })
  })

  // Il trigger traduce i nomi in uuid: un nome che nessuna sezione ha resta nei nomi e lascia gli uuid vuoti. Quell'avviso HA
  // dei destinatari, solo che non si sa quali. Un guasto non deve aprire dati.
  describe('un avviso con i destinatari non risolti non arriva a nessuno', () => {
    for (const scope of ['classe', 'globale']) {
      prova(`${scope}, con un nome di classe che nessuna sezione ha`, async () => {
        await inRollback(async () => {
          const a = await avviso({ scope, classi: ['Classe che non esiste'] })
          const r = await db.query<{ target_section_ids: string[] }>(`SELECT target_section_ids FROM public.avvisi WHERE id = $1`, [a])
          expect(r.rows[0].target_section_ids).toEqual([])
          expect(await avvisiDi(GEN_DUE_FIGLI)).toEqual([])
          expect(await avvisiDi(GEN_SENZA_SEZIONE)).toEqual([])
        })
      })
    }

    prova('classe, senza né uuid né nomi: vuoto non vuol dire «per tutti» se lo scope dice «classe»', async () => {
      await inRollback(async () => {
        await avviso({ scope: 'classe' })
        await avviso({ scope: 'classe', target: [], classi: [] })
        expect(await avvisiDi(GEN_DUE_FIGLI)).toEqual([])
        expect(await avvisiDi(GEN_SENZA_SEZIONE)).toEqual([])
      })
    })

    prova('con il nome di una sezione che c’è, il trigger lo traduce e l’avviso arriva a quella sezione', async () => {
      await inRollback(async () => {
        const a = await avviso({ scope: 'classe', classi: ['Girasoli'] })
        expect(await avvisiDi(GEN_DUE_FIGLI)).toEqual([{ avviso_id: a, alunno_id: FIGLIO_1 }])
      })
    })

    prova('globale con destinatari veri: comandano i destinatari, non diventa per tutta la sede', async () => {
      await inRollback(async () => {
        const a = await avviso({ scope: 'globale', classi: ['Girasoli'] })
        expect(await avvisiDi(GEN_DUE_FIGLI)).toEqual([{ avviso_id: a, alunno_id: FIGLIO_1 }])
      })
    })

    prova('globale con i soli uuid: lo stesso, e un figlio senza sezione non lo riceve', async () => {
      await inRollback(async () => {
        const a = await avviso({ scope: 'globale', target: [SEZ_1] })
        const r = await db.query<{ target_classes: string[] | null }>(`SELECT target_classes FROM public.avvisi WHERE id = $1`, [a])
        expect(r.rows[0].target_classes ?? []).toEqual([])
        expect(await avvisiDi(GEN_DUE_FIGLI)).toEqual([{ avviso_id: a, alunno_id: FIGLIO_1 }])
        expect(await avvisiDi(GEN_SENZA_SEZIONE)).toEqual([])
      })
    })
  })

  describe('la scadenza', () => {
    prova('un avviso valido non scaduto si vede anche se precedente all’ingresso', async () => {
      await inRollback(async () => {
        const { oggi } = await giorni()
        await nuovaIscrizione({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, sezione: SEZ_1, ingresso: oggi })
        const globale = await avviso()
        const diClasse = await avviso({ scope: 'classe', target: [SEZ_1] })
        expect((await avvisiDi(GEN_IN_ATTESA)).map((x) => x.avviso_id).sort()).toEqual(ordinate(globale, diClasse))
      })
    })

    prova('un avviso scaduto non si vede, nell’ultimo istante sì (come la route: `.gte`)', async () => {
      await inRollback(async () => {
        await avviso({ fraQuanto: '-1 millisecond' })
        expect(await avvisiDi(GEN_DOPPIO)).toEqual([])
        const ultimo = await avviso({ fraQuanto: '0' })
        expect(await avvisiDi(GEN_DOPPIO)).toEqual([{ avviso_id: ultimo, alunno_id: FIGLIO_DOPPIO }])
      })
    })

    prova('decide `scadenza_avviso`, non la vecchia `scadenza`', async () => {
      await inRollback(async () => {
        const vivo = await avviso({ vecchiaScadenza: '2020-01-01' })
        await avviso({ vecchiaScadenza: '2999-01-01', fraQuanto: '-1 day' })
        expect(await avvisiDi(GEN_DOPPIO)).toEqual([{ avviso_id: vivo, alunno_id: FIGLIO_DOPPIO }])
      })
    })
  })

  describe('la regola del figlio attivo', () => {
    prova('un ritirato non vede niente', async () => {
      await inRollback(async () => {
        await avviso()
        await avviso({ scope: 'classe', target: [SEZ_1] })
        expect(await avvisiDi(GEN_RITIRATO)).toEqual([])
      })
    })

    prova('con due figli, quando uno lascia si perde solo ciò che arrivava da lui', async () => {
      await inRollback(async () => {
        const globale = await avviso()
        await avviso({ scope: 'classe', target: [SEZ_2] })
        await db.query(`UPDATE public.frequenze SET stato = 'ritirato', data_uscita = '2026-10-01' WHERE id = $1`, [FREQ_2])
        expect(await avvisiDi(GEN_DUE_FIGLI)).toEqual([{ avviso_id: globale, alunno_id: FIGLIO_1 }])
      })
    })

    prova('un bambino vivo in due sedi dà una riga sola per avviso, dalla frequenza di quella sede', async () => {
      await inRollback(async () => {
        await db.query(`UPDATE public.anni_sede SET stato = 'in_preparazione' WHERE id = $1`, [ATTIVO_B])
        await frequenza({ alunno: FIGLIO_PONTE, annoSede: PRIMA_B, ingresso: '2025-09-01' })
        expect(await figliDi(GEN_PONTE)).toHaveLength(2)
        const a = await avviso()
        const b = await avviso({ sede: SEDE_B })
        expect(await avvisiDi(GEN_PONTE)).toEqual(
          [a, b].sort().map((avviso_id) => ({ avviso_id, alunno_id: FIGLIO_PONTE })))
      })
    })
  })

  describe('schema indietro', () => {
    prova('senza avvisi nessuna riga e nessun errore', async () => {
      await inRollback(async () => {
        await db.exec(`DROP TABLE public.avvisi CASCADE`)
        expect(await avvisiDi(GEN_DUE_FIGLI)).toEqual([])
      })
    })
  })

  describe('chi può chiamarla', () => {
    prova('authenticated e anon non possono, service_role sì', async () => {
      await inRollback(async () => {
        const a = await avviso({ scope: 'classe', target: [SEZ_1] })
        await db.exec('SAVEPOINT prima_del_ruolo')
        await comeUtente('authenticated', GEN_DUE_FIGLI)
        expect(await codiceErrore(`SELECT * FROM public.avvisi_visibili_genitore($1)`, [GEN_PONTE])).toBe('42501')
        await db.exec('ROLLBACK TO SAVEPOINT prima_del_ruolo')
        await comeUtente('anon', null)
        expect(await codiceErrore(`SELECT * FROM public.avvisi_visibili_genitore($1)`, [GEN_PONTE])).toBe('42501')
        await db.exec('ROLLBACK TO SAVEPOINT prima_del_ruolo')
        await comeUtente('service_role', null)
        expect(await avvisiDi(GEN_DUE_FIGLI)).toEqual([{ avviso_id: a, alunno_id: FIGLIO_1 }])
      })
    })
  })
})

async function thread(docente: string, genitore: string, figlio: string): Promise<string> {
  return una<string>(
    `INSERT INTO public.chat_threads (teacher_id, parent_id, student_id) VALUES ($1, $2, $3) RETURNING id`, [docente, genitore, figlio])
}

type RigaThread = { thread_id: string; scrivibile: boolean }

async function threadDi(utente: string | null): Promise<RigaThread[]> {
  const r = await db.query<RigaThread>(`SELECT thread_id, scrivibile FROM public.thread_visibili($1) ORDER BY thread_id`, [utente])
  return r.rows
}

const manopola = (accesa: boolean) =>
  db.query(`UPDATE public.anno_regole SET chat_sola_lettura_dal_passaggio = $1`, [accesa])

const ritira = (frequenzaId: string) =>
  db.query(`UPDATE public.frequenze SET stato = 'ritirato', data_uscita = '2026-10-01' WHERE id = $1`, [frequenzaId])

describe('thread_visibili', () => {
  const POSIZIONI = [{ accesa: false, nome: 'spenta' }, { accesa: true, nome: 'accesa' }]

  describe('il filtro sul figlio attivo vale in tutte e due le posizioni della manopola', () => {
    for (const { accesa, nome } of POSIZIONI) {
      prova(`manopola ${nome}: il genitore vede il thread del figlio attivo, con il docente assegnato si scrive`, async () => {
        await inRollback(async () => {
          await manopola(accesa)
          const t = await thread(DOC_SEZ_1, GEN_DUE_FIGLI, FIGLIO_1)
          expect(await threadDi(GEN_DUE_FIGLI)).toEqual([{ thread_id: t, scrivibile: true }])
          expect(await threadDi(DOC_SEZ_1)).toEqual([{ thread_id: t, scrivibile: true }])
        })
      })

      prova(`manopola ${nome}: il genitore non vede il thread di un figlio ritirato, il docente ne vede la storia e non scrive`, async () => {
        await inRollback(async () => {
          await manopola(accesa)
          const t = await thread(DOC_SEZ_1, GEN_RITIRATO, FIGLIO_RITIRATO)
          expect(await threadDi(GEN_RITIRATO)).toEqual([])
          expect(await threadDi(DOC_SEZ_1)).toEqual([{ thread_id: t, scrivibile: false }])
        })
      })

      prova(`manopola ${nome}: nemmeno la segreteria scrive sul thread di un figlio ritirato`, async () => {
        await inRollback(async () => {
          await manopola(accesa)
          const t = await thread(SEGRETERIA, GEN_RITIRATO, FIGLIO_RITIRATO)
          expect(await threadDi(GEN_RITIRATO)).toEqual([])
          expect(await threadDi(SEGRETERIA)).toEqual([{ thread_id: t, scrivibile: false }])
        })
      })

      prova(`manopola ${nome}: un figlio in attesa con ingresso futuro non è attivo`, async () => {
        await inRollback(async () => {
          await manopola(accesa)
          const { domani } = await giorni()
          await nuovaIscrizione({ alunno: FIGLIO_IN_ATTESA, annoSede: ANNO_2627, sezione: SEZ_1, ingresso: domani })
          const t = await thread(DOC_SEZ_1, GEN_IN_ATTESA, FIGLIO_IN_ATTESA)
          expect(await threadDi(GEN_IN_ATTESA)).toEqual([])
          expect(await threadDi(DOC_SEZ_1)).toEqual([{ thread_id: t, scrivibile: false }])
        })
      })
    }
  })

  describe('ogni thread guarda il suo bambino', () => {
    const dove = async (utente: string) =>
      Object.fromEntries((await threadDi(utente)).map((x) => [x.thread_id, x.scrivibile]))

    for (const { accesa, nome } of POSIZIONI) {
      prova(`manopola ${nome}: lo stesso docente scrive sul figlio attivo e non sul ritirato`, async () => {
        await inRollback(async () => {
          await manopola(accesa)
          const attivo = await thread(DOC_SEZ_1, GEN_DOPPIO, FIGLIO_DOPPIO)
          const ritirato = await thread(DOC_SEZ_1, GEN_RITIRATO, FIGLIO_RITIRATO)
          expect(await dove(DOC_SEZ_1)).toEqual({ [attivo]: true, [ritirato]: false })
        })
      })
    }

    prova('manopola accesa: lo stesso docente è assegnato a un bambino e non all’altro', async () => {
      await inRollback(async () => {
        await manopola(true)
        const suo = await thread(DOC_SEZ_1, GEN_DUE_FIGLI, FIGLIO_1)
        const altro = await thread(DOC_SEZ_1, GEN_DUE_FIGLI, FIGLIO_2)
        expect(await dove(DOC_SEZ_1)).toEqual({ [suo]: true, [altro]: false })
        expect(await dove(GEN_DUE_FIGLI)).toEqual({ [suo]: true, [altro]: false })
      })
    })
  })

  describe('la manopola spenta, come al deploy', () => {
    prova('un thread del figlio attivo è scrivibile anche con un docente non più assegnato: le conversazioni di oggi restano come sono', async () => {
      await inRollback(async () => {
        const t = await thread(DOC_SEZ_2, GEN_DUE_FIGLI, FIGLIO_1)
        expect(await threadDi(GEN_DUE_FIGLI)).toEqual([{ thread_id: t, scrivibile: true }])
        expect(await threadDi(DOC_SEZ_2)).toEqual([{ thread_id: t, scrivibile: true }])
      })
    })
  })

  describe('la manopola accesa', () => {
    prova('con il docente non più assegnato il thread si vede e non si scrive, da tutte e due le parti', async () => {
      await inRollback(async () => {
        await manopola(true)
        const t = await thread(DOC_SEZ_2, GEN_DUE_FIGLI, FIGLIO_1)
        expect(await threadDi(GEN_DUE_FIGLI)).toEqual([{ thread_id: t, scrivibile: false }])
        expect(await threadDi(DOC_SEZ_2)).toEqual([{ thread_id: t, scrivibile: false }])
      })
    })

    for (const [nome, chi] of [['admin', AMMINISTRATORE], ['coordinator', DIREZIONE], ['segreteria', SEGRETERIA]] as const) {
      prova(`con un operatore ${nome} si scrive sempre, senza nessuna riga in utenti_sezioni`, async () => {
        await inRollback(async () => {
          await manopola(true)
          const t = await thread(chi, GEN_DUE_FIGLI, FIGLIO_1)
          expect(await threadDi(GEN_DUE_FIGLI)).toEqual([{ thread_id: t, scrivibile: true }])
          expect(await threadDi(chi)).toEqual([{ thread_id: t, scrivibile: true }])
        })
      })
    }

    prova('un altro ruolo non conta come operatore', async () => {
      await inRollback(async () => {
        await manopola(true)
        const t = await thread(CUOCA, GEN_DUE_FIGLI, FIGLIO_1)
        expect(await threadDi(GEN_DUE_FIGLI)).toEqual([{ thread_id: t, scrivibile: false }])
      })
    })

    prova('la sola riga per materia non assegna il docente alla classe', async () => {
      await inRollback(async () => {
        await manopola(true)
        const t = await thread(DOC_MATERIA, GEN_DOPPIO, FIGLIO_DOPPIO)
        expect(await threadDi(GEN_DOPPIO)).toEqual([{ thread_id: t, scrivibile: false }])
        await db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2)`, [DOC_MATERIA, SEZ_1])
        expect(await threadDi(GEN_DOPPIO)).toEqual([{ thread_id: t, scrivibile: true }])
      })
    })

    prova('conta la sezione attuale del figlio: dopo un cambio di classe la scrittura segue il docente nuovo', async () => {
      await inRollback(async () => {
        await manopola(true)
        const vecchia = await thread(DOC_SEZ_1, GEN_DOPPIO, FIGLIO_DOPPIO)
        const nuova = await thread(DOC_SEZ_2, GEN_DOPPIO, FIGLIO_DOPPIO)
        const dove = async () => Object.fromEntries((await threadDi(GEN_DOPPIO)).map((x) => [x.thread_id, x.scrivibile]))
        expect(await dove()).toEqual({ [vecchia]: true, [nuova]: false })
        await db.query(`UPDATE public.frequenze SET section_id = $2 WHERE alunno_id = $1`, [FIGLIO_DOPPIO, SEZ_2])
        expect(await dove()).toEqual({ [vecchia]: false, [nuova]: true })
      })
    })

    prova('una sezione nulla non assegna nessuno; l’operatore resta scrivibile', async () => {
      await inRollback(async () => {
        await manopola(true)
        const col_docente = await thread(DOC_SEZ_1, GEN_SENZA_SEZIONE, FIGLIO_SENZA_SEZIONE)
        const con_segreteria = await thread(SEGRETERIA, GEN_SENZA_SEZIONE, FIGLIO_SENZA_SEZIONE)
        expect(Object.fromEntries((await threadDi(GEN_SENZA_SEZIONE)).map((x) => [x.thread_id, x.scrivibile])))
          .toEqual({ [col_docente]: false, [con_segreteria]: true })
      })
    })

    prova('un profilo revocato non conta più: né operatore né docente assegnato', async () => {
      await inRollback(async () => {
        await manopola(true)
        const colDocente = await thread(DOC_SEZ_1, GEN_DOPPIO, FIGLIO_DOPPIO)
        const conSegreteria = await thread(SEGRETERIA, GEN_DOPPIO, FIGLIO_DOPPIO)
        await db.query(`UPDATE public.utenti SET archiviato_il = now() WHERE id = ANY ($1::uuid[])`, [[DOC_SEZ_1, SEGRETERIA]])
        expect(Object.fromEntries((await threadDi(GEN_DOPPIO)).map((x) => [x.thread_id, x.scrivibile])))
          .toEqual({ [colDocente]: false, [conSegreteria]: false })
      })
    })
  })

  describe('di chi è un thread', () => {
    prova('un altro genitore non lo vede, anche se è genitore dello stesso bambino', async () => {
      await inRollback(async () => {
        await thread(DOC_SEZ_1, GEN_DUE_FIGLI, FIGLIO_1)
        expect(await threadDi(GEN_PONTE)).toEqual([])
        await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [GEN_PONTE, FIGLIO_1])
        expect(await threadDi(GEN_PONTE)).toEqual([])
      })
    })

    prova('un altro docente non lo vede', async () => {
      await inRollback(async () => {
        await thread(DOC_SEZ_1, GEN_DUE_FIGLI, FIGLIO_1)
        expect(await threadDi(DOC_SEZ_2)).toEqual([])
        expect(await threadDi(SEGRETERIA)).toEqual([])
      })
    })

    prova('il genitore non vede un thread a suo nome su un bambino che non è suo', async () => {
      await inRollback(async () => {
        await thread(DOC_SEZ_1, GEN_DUE_FIGLI, FIGLIO_DOPPIO)
        expect(await threadDi(GEN_DUE_FIGLI)).toEqual([])
      })
    })

    // `parent_id` porta due cose secondo l'età della riga (`20261012085225_chat_broadcast_privato.sql`): l'account o la sua
    // riga di `parents`. La regola di oggi le accetta tutte e due, e anche il segnale della chat.
    prova('un thread con la riga di parents al posto dell’account è di quell’account', async () => {
      await inRollback(async () => {
        const t = await thread(DOC_SEZ_2, PONTE_1, FIGLIO_PONTE)
        expect(await threadDi(GEN_PONTE)).toEqual([{ thread_id: t, scrivibile: true }])
        expect(await threadDi(DOC_SEZ_2)).toEqual([{ thread_id: t, scrivibile: true }])
        expect(await threadDi(GEN_DOPPIO)).toEqual([])
      })
    })

    prova('un thread con la riga di parents e un figlio ritirato non si vede', async () => {
      await inRollback(async () => {
        const f = await una<string>(`SELECT id FROM public.frequenze WHERE alunno_id = $1`, [FIGLIO_PONTE])
        await thread(DOC_SEZ_2, PONTE_1, FIGLIO_PONTE)
        await ritira(f)
        expect(await threadDi(GEN_PONTE)).toEqual([])
      })
    })

    prova('una persona docente e genitore vede i suoi thread nei due ruoli, ciascuno con la sua regola', async () => {
      await inRollback(async () => {
        await manopola(true)
        await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [DOC_SEZ_1, FIGLIO_2])
        const daDocente = await thread(DOC_SEZ_1, GEN_DOPPIO, FIGLIO_DOPPIO)
        const daGenitore = await thread(DOC_MATERIA, DOC_SEZ_1, FIGLIO_2)
        expect(Object.fromEntries((await threadDi(DOC_SEZ_1)).map((x) => [x.thread_id, x.scrivibile])))
          .toEqual({ [daDocente]: true, [daGenitore]: false })
      })
    })

    prova('un utente senza thread o nullo: nessuna riga', async () => {
      await inRollback(async () => {
        await thread(DOC_SEZ_1, GEN_DUE_FIGLI, FIGLIO_1)
        expect(await threadDi(GEN_RITIRATO)).toEqual([])
        expect(await threadDi(null)).toEqual([])
      })
    })

    prova('un bambino vivo in due sedi dà una riga sola per thread, e il docente di una delle due sezioni è assegnato', async () => {
      await inRollback(async () => {
        await manopola(true)
        await db.query(`UPDATE public.anni_sede SET stato = 'in_preparazione' WHERE id = $1`, [ATTIVO_B])
        const annoPrimaB = await una<string>(`SELECT anno_id FROM public.anni_sede WHERE id = $1`, [PRIMA_B])
        const sezPrimaB = await una<string>(
          `INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, 'Tulipani di prima', $2) RETURNING id`, [SEDE_B, annoPrimaB])
        await frequenza({ alunno: FIGLIO_PONTE, annoSede: PRIMA_B, sezione: sezPrimaB, ingresso: '2025-09-01' })
        expect(await figliDi(GEN_PONTE)).toHaveLength(2)
        await db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2)`, [DOC_MATERIA, sezPrimaB])
        const t = await thread(DOC_MATERIA, GEN_PONTE, FIGLIO_PONTE)
        expect(await threadDi(GEN_PONTE)).toEqual([{ thread_id: t, scrivibile: true }])
        const altro = await thread(SEGRETERIA, GEN_PONTE, FIGLIO_PONTE)
        expect((await threadDi(GEN_PONTE)).map((x) => x.thread_id).sort()).toEqual(ordinate(t, altro))
      })
    })
  })

  describe('thread_e_visibile', () => {
    prova('dice la stessa cosa di thread_visibili, per ogni utente e ogni thread, nelle due posizioni', async () => {
      await inRollback(async () => {
        const threads = [
          await thread(DOC_SEZ_1, GEN_DUE_FIGLI, FIGLIO_1),
          await thread(DOC_SEZ_2, GEN_DUE_FIGLI, FIGLIO_1),
          await thread(SEGRETERIA, GEN_DUE_FIGLI, FIGLIO_2),
          await thread(DOC_SEZ_1, GEN_RITIRATO, FIGLIO_RITIRATO),
          await thread(DOC_SEZ_2, PONTE_1, FIGLIO_PONTE),
        ]
        const utenti = [GEN_DUE_FIGLI, GEN_RITIRATO, GEN_PONTE, GEN_DOPPIO, DOC_SEZ_1, DOC_SEZ_2, DOC_MATERIA, SEGRETERIA]
        let visti = 0
        for (const accesa of [false, true]) {
          await manopola(accesa)
          for (const u of utenti) {
            const suoi = new Set((await threadDi(u)).map((x) => x.thread_id))
            for (const t of threads) {
              const si = await una<boolean>(`SELECT public.thread_e_visibile($1, $2)`, [u, t])
              expect(si, `utente ${u}, thread ${t}, manopola ${accesa}`).toBe(suoi.has(t))
              if (si) visti++
            }
          }
        }
        // Non è una tautologia sul vuoto. Per posizione 9 sì: 3 di GEN_DUE_FIGLI, 1 di GEN_PONTE, 2 di DOC_SEZ_1, 2 di DOC_SEZ_2,
        // 1 di SEGRETERIA. La manopola decide chi scrive, non chi vede.
        expect(visti).toBe(2 * 9)
      })
    })

    prova('un thread che non esiste o un utente nullo: false, non errore', async () => {
      await inRollback(async () => {
        const t = await thread(DOC_SEZ_1, GEN_DUE_FIGLI, FIGLIO_1)
        expect(await una<boolean>(`SELECT public.thread_e_visibile($1, $2)`, [GEN_DUE_FIGLI, GEN_DUE_FIGLI])).toBe(false)
        expect(await una<boolean>(`SELECT public.thread_e_visibile($1, $2)`, [null, t])).toBe(false)
        expect(await una<boolean>(`SELECT public.thread_e_visibile($1, $2)`, [GEN_DUE_FIGLI, null])).toBe(false)
      })
    })
  })

  describe('schema indietro', () => {
    prova('senza chat_threads nessuna riga e nessun errore', async () => {
      await inRollback(async () => {
        await db.exec(`DROP TABLE public.chat_threads CASCADE`)
        expect(await threadDi(GEN_DUE_FIGLI)).toEqual([])
        expect(await una<boolean>(`SELECT public.thread_e_visibile($1, $2)`, [GEN_DUE_FIGLI, GEN_DUE_FIGLI])).toBe(false)
      })
    })

    prova('senza la riga delle regole la manopola non si legge, e chiude: conta solo l’assegnazione', async () => {
      await inRollback(async () => {
        const assegnato = await thread(DOC_SEZ_1, GEN_DOPPIO, FIGLIO_DOPPIO)
        const altro = await thread(DOC_SEZ_2, GEN_DOPPIO, FIGLIO_DOPPIO)
        await db.exec(`SET LOCAL session_replication_role = replica`)
        await db.exec(`DELETE FROM public.anno_regole`)
        await db.exec(`SET LOCAL session_replication_role = DEFAULT`)
        expect(Object.fromEntries((await threadDi(GEN_DOPPIO)).map((x) => [x.thread_id, x.scrivibile])))
          .toEqual({ [assegnato]: true, [altro]: false })
      })
    })

    prova('senza parents restano i thread con l’account', async () => {
      await inRollback(async () => {
        const t = await thread(DOC_SEZ_1, GEN_DUE_FIGLI, FIGLIO_1)
        await db.exec(`DROP TABLE public.parents CASCADE`)
        expect(await threadDi(GEN_DUE_FIGLI)).toEqual([{ thread_id: t, scrivibile: true }])
      })
    })
  })

  describe('chi può chiamarla', () => {
    const miei = async () =>
      (await db.query<RigaThread>(`SELECT thread_id, scrivibile FROM public.thread_visibili_miei()`)).rows

    prova('authenticated non può chiamare thread_visibili(uuid) né thread_e_visibile, può chiamare thread_visibili_miei()', async () => {
      await inRollback(async () => {
        const mio = await thread(DOC_SEZ_1, GEN_DUE_FIGLI, FIGLIO_1)
        const altrui = await thread(DOC_SEZ_2, GEN_PONTE, FIGLIO_PONTE)
        await comeUtente('authenticated', GEN_DUE_FIGLI)
        expect(await codiceErrore(`SELECT * FROM public.thread_visibili($1)`, [GEN_PONTE])).toBe('42501')
        expect(await codiceErrore(`SELECT public.thread_e_visibile($1, $2)`, [GEN_PONTE, altrui])).toBe('42501')
        expect(await miei()).toEqual([{ thread_id: mio, scrivibile: true }])
      })
    })

    prova('anon non può chiamare nessuna delle tre', async () => {
      await inRollback(async () => {
        await comeUtente('anon', null)
        expect(await codiceErrore(`SELECT * FROM public.thread_visibili($1)`, [GEN_DUE_FIGLI])).toBe('42501')
        expect(await codiceErrore(`SELECT public.thread_e_visibile($1, $2)`, [GEN_DUE_FIGLI, GEN_DUE_FIGLI])).toBe('42501')
        expect(await codiceErrore(`SELECT * FROM public.thread_visibili_miei()`)).toBe('42501')
      })
    })

    prova('service_role chiama thread_visibili(uuid) e thread_e_visibile per conto di un genitore', async () => {
      await inRollback(async () => {
        const t = await thread(DOC_SEZ_1, GEN_DUE_FIGLI, FIGLIO_1)
        await comeUtente('service_role', null)
        expect(await threadDi(GEN_DUE_FIGLI)).toEqual([{ thread_id: t, scrivibile: true }])
        expect(await una<boolean>(`SELECT public.thread_e_visibile($1, $2)`, [GEN_DUE_FIGLI, t])).toBe(true)
      })
    })

    prova('thread_visibili_miei() dà le righe di chi chiama, e niente a chi non ha claim', async () => {
      await inRollback(async () => {
        await manopola(true)
        await thread(DOC_SEZ_1, GEN_DUE_FIGLI, FIGLIO_2)
        const attese = await threadDi(GEN_DUE_FIGLI)
        expect(attese).toHaveLength(1)
        expect(attese[0].scrivibile).toBe(false)
        await db.exec('SAVEPOINT prima_del_ruolo')
        await comeUtente('authenticated', GEN_DUE_FIGLI)
        expect(await miei()).toEqual(attese)
        await db.exec('ROLLBACK TO SAVEPOINT prima_del_ruolo')
        await comeUtente('authenticated', null)
        expect(await miei()).toEqual([])
      })
    })
  })
})

type DatiVoce = {
  alunno?: string | null
  sede?: string | null
  /** La competenza decide l'anno della voce: di partenza un mese del 2026/27. */
  competenza?: string
  stato?: string
  pagato?: number
  categoria?: string | null
  visibileDal?: string | null
  padre?: string | null
}

/** Di partenza una voce da pagare della prima sede, nell'anno attivo. */
async function voce(d: DatiVoce = {}): Promise<string> {
  return una<string>(
    `INSERT INTO public.pagamenti
       (alunno_id, scuola_id, descrizione, importo, scadenza, stato, categoria_id, importo_pagato, periodo_competenza, visibile_dal, parent_payment_id)
     VALUES ($1, $2, 'Voce di prova', 100, $3, $4, $5, $6, $3, $7, $8) RETURNING id`,
    [d.alunno === undefined ? FIGLIO_DOPPIO : d.alunno, d.sede === undefined ? SEDE : d.sede, d.competenza ?? '2026-10-01',
      d.stato ?? 'da_pagare', d.categoria ?? null, d.pagato ?? 0, d.visibileDal ?? null, d.padre ?? null])
}

async function vociDi(genitore: string | null): Promise<string[]> {
  const r = await db.query<{ voce_id: string }>(`SELECT voce_id FROM public.voci_visibili_genitore($1)`, [genitore])
  return r.rows.map((x) => x.voce_id).sort()
}

const categoria = (nome: string) =>
  una<string>(`INSERT INTO public.payment_categories (scuola_id, nome) VALUES (NULL, $1) RETURNING id`, [nome])

const nelListino = (annoSede: string, tipo: string, cat: string) =>
  db.query(`INSERT INTO public.listino_voci (anno_sede_id, voce, payment_category_id, importo) VALUES ($1, $2, $3, 100)`, [annoSede, tipo, cat])

const FUTURA = '2027-10-01'

describe('voci_visibili_genitore', () => {
  describe('di chi sono', () => {
    prova('le voci di tutti i figli collegati, per le due strade', async () => {
      await inRollback(async () => {
        const a = await voce({ alunno: FIGLIO_1 })
        const b = await voce({ alunno: FIGLIO_2 })
        const ponte = await voce({ alunno: FIGLIO_PONTE })
        expect(await vociDi(GEN_DUE_FIGLI)).toEqual(ordinate(a, b))
        expect(await vociDi(GEN_PONTE)).toEqual([ponte])
      })
    })

    prova('un figlio ritirato con un dovuto aperto resta: la voce si deve poter pagare', async () => {
      await inRollback(async () => {
        const aperta = await voce({ alunno: FIGLIO_RITIRATO })
        expect(await figliDi(GEN_RITIRATO)).toEqual([])
        expect(await vociDi(GEN_RITIRATO)).toEqual([aperta])
      })
    })

    prova('un figlio ritirato non porta con sé le voci di un anno futuro', async () => {
      await inRollback(async () => {
        await voce({ alunno: FIGLIO_RITIRATO, competenza: FUTURA })
        expect(await vociDi(GEN_RITIRATO)).toEqual([])
      })
    })

    prova('la voce di un altro bambino, o senza bambino, non si vede', async () => {
      await inRollback(async () => {
        await voce({ alunno: FIGLIO_PONTE })
        await voce({ alunno: null })
        expect(await vociDi(GEN_DUE_FIGLI)).toEqual([])
        expect(await vociDi(null)).toEqual([])
      })
    })

    prova('un figlio collegato per tutte e due le strade dà la voce una volta sola', async () => {
      await inRollback(async () => {
        const v = await voce()
        expect(await vociDi(GEN_DOPPIO)).toEqual([v])
      })
    })
  })

  describe('l’anno', () => {
    prova('una voce dell’anno attivo o di un anno passato si vede, una di un anno futuro no', async () => {
      await inRollback(async () => {
        const attivo = await voce()
        const passato = await voce({ competenza: '2026-03-01' })
        const futura = await voce({ competenza: FUTURA })
        const anni = await db.query<{ id: string; anno_inizio: number }>(
          `SELECT p.id, y.anno_inizio FROM public.pagamenti p JOIN public.anni_scolastici y ON y.id = p.anno_id`)
        const annoDi = new Map(anni.rows.map((x) => [x.id, x.anno_inizio]))
        expect([annoDi.get(attivo), annoDi.get(passato), annoDi.get(futura)]).toEqual([2026, 2025, 2027])
        expect(await vociDi(GEN_DOPPIO)).toEqual(ordinate(attivo, passato))
      })
    })

    prova('dopo il passaggio d’anno la voce non è più futura', async () => {
      await inRollback(async () => {
        const v = await voce({ competenza: FUTURA })
        expect(await vociDi(GEN_DOPPIO)).toEqual([])
        await passaAl2027()
        expect(await vociDi(GEN_DOPPIO)).toEqual([v])
      })
    })

    prova('l’anno attivo è quello della sede della voce', async () => {
      await inRollback(async () => {
        // La seconda sede non è ancora passata al 2026/27: per lei quella competenza è futura.
        await db.query(`UPDATE public.anni_sede SET stato = 'in_preparazione' WHERE id = $1`, [ATTIVO_B])
        const qui = await voce()
        await voce({ sede: SEDE_B })
        expect(await vociDi(GEN_DOPPIO)).toEqual([qui])
      })
    })

    // `POST /api/pagamenti` la lascia ricavare dal bambino, e il registro le dà l'anno da lì: senza riserva, una voce futura
    // senza `scuola_id` non troverebbe un anno attivo e passerebbe per «non si può dire».
    prova('una voce senza sede prende quella del bambino, come il registro', async () => {
      await inRollback(async () => {
        const qui = await voce({ sede: null })
        await voce({ sede: null, competenza: FUTURA })
        const anni = await db.query<{ anno_inizio: number }>(
          `SELECT y.anno_inizio FROM public.pagamenti p JOIN public.anni_scolastici y ON y.id = p.anno_id ORDER BY 1`)
        expect(anni.rows.map((x) => x.anno_inizio)).toEqual([2026, 2027])
        expect(await vociDi(GEN_DOPPIO)).toEqual([qui])
      })
    })

    prova('il listino di una voce senza sede è quello della sede del bambino', async () => {
      await inRollback(async () => {
        const c = await categoria('Quota di prova')
        await nelListino(ANNO[2027], 'quota_nuova', c)
        const v = await voce({ sede: null, competenza: FUTURA, categoria: c })
        expect(await vociDi(GEN_DOPPIO)).toEqual([v])
      })
    })

    prova('una voce di cui non si sa la sede non ha un anno: non si può dire futura, e resta', async () => {
      await inRollback(async () => {
        await db.query(`UPDATE public.alunni SET scuola_id = NULL WHERE id = $1`, [FIGLIO_DOPPIO])
        const v = await voce({ sede: null, competenza: FUTURA })
        expect(await una<string | null>(`SELECT anno_id FROM public.pagamenti WHERE id = $1`, [v])).toBeNull()
        expect(await vociDi(GEN_DOPPIO)).toEqual([v])
      })
    })

    // Il registro la lascia così solo quando la sua rete ha preso un guasto: a `replica` i trigger non scattano.
    prova('una voce con la sede del bambino ma senza anno non si può dire futura, e resta', async () => {
      await inRollback(async () => {
        await db.exec(`SET LOCAL session_replication_role = replica`)
        const v = await voce({ sede: null, competenza: FUTURA })
        await db.exec(`SET LOCAL session_replication_role = DEFAULT`)
        expect(await una<string | null>(`SELECT anno_id FROM public.pagamenti WHERE id = $1`, [v])).toBeNull()
        expect(await una<string | null>(`SELECT public.anno_attivo($1)`, [SEDE])).not.toBeNull()
        expect(await vociDi(GEN_DOPPIO)).toEqual([v])
      })
    })

    prova('una voce con un anno, in una sede senza anno attivo, non si può dire futura e resta', async () => {
      await inRollback(async () => {
        const v = await voce({ competenza: FUTURA })
        await db.query(`UPDATE public.anni_sede SET stato = 'in_preparazione' WHERE scuola_id = $1`, [SEDE])
        expect(await una<string | null>(`SELECT public.anno_attivo($1)`, [SEDE])).toBeNull()
        expect(await vociDi(GEN_DOPPIO)).toEqual([v])
      })
    })
  })

  describe('le eccezioni al futuro', () => {
    prova('una voce futura già pagata si vede: le due «Iscrizione» con competenza dal 2027 restano', async () => {
      await inRollback(async () => {
        const iscrizione = await categoria('Iscrizione')
        const pagata = await voce({ competenza: FUTURA, stato: 'pagato', pagato: 100, categoria: iscrizione })
        expect(await vociDi(GEN_DOPPIO)).toEqual([pagata])
      })
    })

    prova('una voce futura pagata a metà si vede: quei soldi la famiglia li ha dati', async () => {
      await inRollback(async () => {
        const acconto = await voce({ competenza: FUTURA, stato: 'parziale', pagato: 40 })
        expect(await vociDi(GEN_DOPPIO)).toEqual([acconto])
      })
    })

    prova('una voce futura esente, pagata con importo pagato zero, si vede', async () => {
      await inRollback(async () => {
        const esente = await voce({ competenza: FUTURA, stato: 'pagato', pagato: 0 })
        expect(await vociDi(GEN_DOPPIO)).toEqual([esente])
      })
    })

    prova('la quota di una frequenza (quota_pagamento_id) si vede anche da pagare', async () => {
      await inRollback(async () => {
        const quota = await voce({ competenza: FUTURA })
        await db.query(`UPDATE public.frequenze SET quota_pagamento_id = $2 WHERE alunno_id = $1`, [FIGLIO_DOPPIO, quota])
        expect(await vociDi(GEN_DOPPIO)).toEqual([quota])
      })
    })

    prova('le rate della quota di una frequenza si vedono con lei', async () => {
      await inRollback(async () => {
        const quota = await voce({ competenza: FUTURA })
        const rata = await voce({ competenza: FUTURA, padre: quota })
        await voce({ competenza: FUTURA, padre: await voce({ competenza: FUTURA }) })
        await db.query(`UPDATE public.frequenze SET quota_pagamento_id = $2 WHERE alunno_id = $1`, [FIGLIO_DOPPIO, quota])
        expect(await vociDi(GEN_DOPPIO)).toEqual(ordinate(quota, rata))
      })
    })

    for (const tipo of ['quota_nuova', 'quota_conferma']) {
      prova(`una voce futura con la categoria di ${tipo} del listino si vede anche da pagare`, async () => {
        await inRollback(async () => {
          const c = await categoria('Quota di prova')
          await nelListino(ANNO[2027], tipo, c)
          const v = await voce({ competenza: FUTURA, categoria: c })
          expect(await vociDi(GEN_DOPPIO)).toEqual([v])
        })
      })
    }

    prova('il listino vale per il suo anno e per la sua sede', async () => {
      await inRollback(async () => {
        const c = await categoria('Quota di prova')
        await nelListino(ANNO_2627, 'quota_nuova', c)
        const annoFuturoB = await una<string>(
          `SELECT s.id FROM public.anni_sede s WHERE s.scuola_id = $1 AND s.anno_id = (SELECT anno_id FROM public.anni_sede WHERE id = $2)`,
          [SEDE_B, ANNO[2027]])
        await nelListino(annoFuturoB, 'quota_nuova', c)
        await voce({ competenza: FUTURA, categoria: c })
        expect(await vociDi(GEN_DOPPIO)).toEqual([])
      })
    })

    prova('la categoria della retta nel listino non è una quota', async () => {
      await inRollback(async () => {
        const c = await categoria('Retta di prova')
        await nelListino(ANNO[2027], 'retta', c)
        await voce({ competenza: FUTURA, categoria: c })
        await voce({ competenza: FUTURA })
        expect(await vociDi(GEN_DOPPIO)).toEqual([])
      })
    })
  })

  describe('visibile_dal', () => {
    prova('una data futura nasconde qualunque voce: dell’anno attivo, pagata, quota', async () => {
      await inRollback(async () => {
        const { domani } = await giorni()
        const c = await categoria('Quota di prova')
        await nelListino(ANNO[2027], 'quota_nuova', c)
        await voce({ visibileDal: domani })
        await voce({ visibileDal: domani, stato: 'pagato', pagato: 100 })
        await voce({ visibileDal: domani, competenza: FUTURA, categoria: c })
        expect(await vociDi(GEN_DOPPIO)).toEqual([])
      })
    })

    prova('senza data, con una data passata o con quella di oggi la voce si vede', async () => {
      await inRollback(async () => {
        const { oggi, ieri } = await giorni()
        const attese = [await voce(), await voce({ visibileDal: ieri }), await voce({ visibileDal: oggi })]
        expect(await vociDi(GEN_DOPPIO)).toEqual(ordinate(...attese))
      })
    })

    // Oggi è il giorno di Roma, non quello della sessione: in produzione le sessioni sono in UTC. Con questi due fusi uno dei
    // due sta sempre su un giorno diverso da quello di Roma, a qualunque ora giri la prova.
    for (const fuso of ['Etc/GMT-14', 'Etc/GMT+12']) {
      prova(`oggi è il giorno di Roma anche con la sessione in ${fuso}`, async () => {
        await inRollback(async () => {
          const { oggi, domani } = await giorni()
          const si = await voce({ visibileDal: oggi })
          await voce({ visibileDal: domani })
          await db.exec(`SET LOCAL TimeZone = '${fuso}'`)
          expect(await vociDi(GEN_DOPPIO)).toEqual([si])
        })
      })
    }
  })

  describe('schema indietro', () => {
    prova('senza pagamenti nessuna riga e nessun errore', async () => {
      await inRollback(async () => {
        await db.exec(`DROP TABLE public.pagamenti CASCADE`)
        expect(await vociDi(GEN_DOPPIO)).toEqual([])
      })
    })

    prova('senza una delle strade del legame resta l’altra', async () => {
      await inRollback(async () => {
        const diretta = await voce({ alunno: FIGLIO_1 })
        const ponte = await voce({ alunno: FIGLIO_PONTE })
        await db.exec(`DROP TABLE public.student_parents CASCADE`)
        expect(await vociDi(GEN_DUE_FIGLI)).toEqual([diretta])
        expect(await vociDi(GEN_PONTE)).toEqual([])
        expect(ponte).not.toBe(diretta)
      })
    })
  })

  describe('chi può chiamarla', () => {
    const miei = async () =>
      (await db.query<{ voce_id: string }>(`SELECT voce_id FROM public.voci_visibili_miei()`)).rows.map((x) => x.voce_id).sort()

    prova('authenticated non può chiamare voci_visibili_genitore(uuid), può chiamare voci_visibili_miei()', async () => {
      await inRollback(async () => {
        const mia = await voce({ alunno: FIGLIO_1 })
        await voce({ alunno: FIGLIO_PONTE })
        await comeUtente('authenticated', GEN_DUE_FIGLI)
        expect(await codiceErrore(`SELECT * FROM public.voci_visibili_genitore($1)`, [GEN_PONTE])).toBe('42501')
        expect(await miei()).toEqual([mia])
      })
    })

    prova('anon non può chiamare nessuna delle due', async () => {
      await inRollback(async () => {
        await comeUtente('anon', null)
        expect(await codiceErrore(`SELECT * FROM public.voci_visibili_genitore($1)`, [GEN_DUE_FIGLI])).toBe('42501')
        expect(await codiceErrore(`SELECT * FROM public.voci_visibili_miei()`)).toBe('42501')
      })
    })

    prova('service_role chiama voci_visibili_genitore(uuid) per conto di un genitore', async () => {
      await inRollback(async () => {
        const v = await voce({ alunno: FIGLIO_1 })
        await comeUtente('service_role', null)
        expect(await vociDi(GEN_DUE_FIGLI)).toEqual([v])
      })
    })

    prova('voci_visibili_miei() dà le righe di chi chiama, e niente a chi non ha claim', async () => {
      await inRollback(async () => {
        const v = await voce({ alunno: FIGLIO_PONTE })
        await db.exec('SAVEPOINT prima_del_ruolo')
        await comeUtente('authenticated', GEN_PONTE)
        expect(await miei()).toEqual([v])
        await db.exec('ROLLBACK TO SAVEPOINT prima_del_ruolo')
        await comeUtente('authenticated', null)
        expect(await miei()).toEqual([])
      })
    })
  })
})

// Le due funzioni che tengono in un posto solo «chi è mio figlio» e «che cos'è una frequenza attiva». Con il parametro aperto,
// un genitore potrebbe chiedere di qualunque bambino o di qualunque account.
describe('figli_collegati e frequenze_attive', () => {
  prova('figli_collegati dà anche il figlio ritirato, per le due strade', async () => {
    const figli = async (g: string) => (await una<string[]>(`SELECT public.figli_collegati($1)`, [g]))
    expect(await figli(GEN_RITIRATO)).toEqual([FIGLIO_RITIRATO])
    expect(await figli(GEN_PONTE)).toEqual([FIGLIO_PONTE])
    expect(await figli(GEN_DUE_FIGLI)).toEqual(expect.arrayContaining([FIGLIO_1, FIGLIO_2]))
  })

  prova('frequenze_attive dice la stessa cosa di figli_attivi, e un alunno ritirato non ha righe', async () => {
    const r = await db.query<Riga>(`SELECT ${COLONNE} FROM public.frequenze_attive($1) ORDER BY alunno_id`, [[FIGLIO_1, FIGLIO_2, FIGLIO_RITIRATO]])
    expect(r.rows).toEqual(await figliDi(GEN_DUE_FIGLI))
  })

  for (const ruolo of ['authenticated', 'anon']) {
    prova(`${ruolo} non può chiamarle`, async () => {
      await inRollback(async () => {
        await comeUtente(ruolo, ruolo === 'anon' ? null : GEN_DUE_FIGLI)
        expect(await codiceErrore(`SELECT public.figli_collegati($1)`, [GEN_PONTE])).toBe('42501')
        expect(await codiceErrore(`SELECT * FROM public.frequenze_attive($1)`, [[FIGLIO_PONTE]])).toBe('42501')
      })
    })
  }
})

describe('la manopola della chat', () => {
  prova('anno_regole.chat_sola_lettura_dal_passaggio nasce spenta, boolean e NOT NULL', async () => {
    const r = await db.query<{ data_type: string; is_nullable: string; column_default: string }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'anno_regole' AND column_name = 'chat_sola_lettura_dal_passaggio'`)
    expect(r.rows).toEqual([{ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }])
    expect(await una<boolean>(`SELECT chat_sola_lettura_dal_passaggio FROM public.anno_regole`)).toBe(false)
  })
})

// Il lancio manuale di «DB migrate (CI)» gira con `--single-transaction` su un database senza l'anno: un errore su un
// file solo annulla tutto. M44a deve passare anche lì, e chi la applica deve poter aspettare il lock soltanto un poco.
describe('M44a su un database senza l’anno', () => {
  prova('si applica anche dove anno_regole non c’è, con il lock_timeout impostato', async () => {
    const nudo = new PGlite()
    try {
      await nudo.exec(SCHEMA_BASE)
      await nudo.exec('BEGIN')
      await applicaPr2(nudo, 'M44a')
      const r = await nudo.query<{ lock_timeout: string }>('SHOW lock_timeout')
      expect(r.rows[0].lock_timeout).toBe('10s')
      await nudo.exec('COMMIT')
      const f = await nudo.query<{ f: string | null }>(`SELECT to_regprocedure('public.figli_attivi(uuid)')::text AS f`)
      expect(f.rows[0].f).not.toBeNull()
    } finally {
      await nudo.close()
    }
  })
})
