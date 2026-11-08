import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2, SCHEMA_LEGAMI_GENITORE } from '../helpers/schema-anno-pglite'

/**
 * PR 4.4 · CHE COSA VEDE UNA FAMIGLIA. Una regola sola, in SQL.
 *
 * Compito 4.4.1 · `figli_attivi`: un figlio è attivo se la sua frequenza sta nell'anno attivo della sede, è
 * `in_attesa` o `iscritto`, e oggi (giorno di Roma) cade fra `data_ingresso` e `data_uscita`. `sospeso` è un flag.
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

const GEN_DUE_FIGLI = '99999999-9999-4999-8999-999999999991'
const GEN_RITIRATO = '99999999-9999-4999-8999-999999999992'
const GEN_IN_ATTESA = '99999999-9999-4999-8999-999999999993'
const GEN_TRASFERITO = '99999999-9999-4999-8999-999999999994'
const GEN_PONTE = '99999999-9999-4999-8999-999999999995'
const GEN_DOPPIO = '99999999-9999-4999-8999-999999999996'
const GEN_ALTRI_ANNI = '99999999-9999-4999-8999-999999999997'

const FIGLIO_1 = '11111111-1111-4111-8111-111111111111'
const FIGLIO_2 = '11111111-1111-4111-8111-111111111112'
const FIGLIO_RITIRATO = '11111111-1111-4111-8111-111111111113'
const FIGLIO_IN_ATTESA = '11111111-1111-4111-8111-111111111114'
const FIGLIO_TRASFERITO = '11111111-1111-4111-8111-111111111115'
const FIGLIO_PONTE = '11111111-1111-4111-8111-111111111116'
const FIGLIO_DOPPIO = '11111111-1111-4111-8111-111111111117'
const FIGLIO_ALTRI_ANNI = '11111111-1111-4111-8111-111111111118'

const PONTE_1 = '88888888-8888-4888-8888-888888888881'
const PONTE_2 = '88888888-8888-4888-8888-888888888882'

type Riga = { alunno_id: string; frequenza_id: string; section_id: string | null; scuola_id: string }

let db: PGlite
/** `anni_sede.id` di ogni anno della sede principale, e l'anno attivo della seconda. */
const ANNO: Record<number, string> = {}
let ATTIVO_B: string
let ANNO_2627: string
let FREQ_1: string
let FREQ_2: string
let FREQ_RITIRATO: string

const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 30_000)

async function inRollback(fn: () => Promise<void>) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
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
}

/** Di partenza una frequenza `recupero` e `iscritto`, come tutte quelle di produzione. */
async function frequenza(d: DatiFrequenza): Promise<string> {
  return una<string>(
    `INSERT INTO public.frequenze (alunno_id, anno_sede_id, section_id, stato, data_ingresso, data_uscita, origine, tipo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [d.alunno, d.annoSede, d.sezione ?? null, d.stato ?? 'iscritto', d.ingresso ?? '2026-09-01', d.uscita ?? null,
      d.origine ?? 'recupero', d.tipo ?? null])
}

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

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE, SEDE_B], fino: 'M44a' })
  await db.exec(SCHEMA_LEGAMI_GENITORE)

  const anni = await db.query<{ anno_inizio: number; id: string; anno_id: string; scuola_id: string }>(
    `SELECT y.anno_inizio, s.id, s.anno_id, s.scuola_id
       FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id`)
  const riga = (sede: string, n: number) => anni.rows.find((x) => x.scuola_id === sede && x.anno_inizio === n)!
  for (const n of [2025, 2026, 2027]) ANNO[n] = riga(SEDE, n).id
  ANNO_2627 = ANNO[2026]
  ATTIVO_B = riga(SEDE_B, 2026).id

  const sezione = (id: string, sede: string, nome: string) =>
    db.query(`INSERT INTO public.sections (id, scuola_id, name, anno_id) VALUES ($1, $2, $3, $4)`,
      [id, sede, nome, riga(sede, 2026).anno_id])
  await sezione(SEZ_1, SEDE, 'Girasoli')
  await sezione(SEZ_2, SEDE, 'Margherite')
  await sezione(SEZ_B, SEDE_B, 'Tulipani')

  // Le frequenze le scrive la prova, una per una: lo specchio, che per ogni alunno nuovo ne fa nascere una dell'anno
  // attivo, resta spento solo mentre nascono gli alunni del seme.
  await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
  const alunno = (id: string, sede: string) =>
    db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [id, sede])
  for (const id of [FIGLIO_1, FIGLIO_2, FIGLIO_RITIRATO, FIGLIO_IN_ATTESA, FIGLIO_PONTE, FIGLIO_DOPPIO, FIGLIO_ALTRI_ANNI]) {
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

describe('la manopola della chat', () => {
  prova('anno_regole.chat_sola_lettura_dal_passaggio nasce spenta, boolean e NOT NULL', async () => {
    const r = await db.query<{ data_type: string; is_nullable: string; column_default: string }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'anno_regole' AND column_name = 'chat_sola_lettura_dal_passaggio'`)
    expect(r.rows).toEqual([{ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }])
    expect(await una<boolean>(`SELECT chat_sola_lettura_dal_passaggio FROM public.anno_regole`)).toBe(false)
  })
})
