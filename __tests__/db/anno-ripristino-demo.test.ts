import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SEDE_E2E, SEDE_SIM, SEDE_VERA, UTENTE, creaBancoPassaggio, inRollback, una, type BancoPassaggio } from '../helpers/passaggio-banco'

/**
 * COMPITO 4.9.7 (rifatto nel giro 1: R4) · IL FILE DI RIPRISTINO DELLA SIMULAZIONE, ESEGUITO DAVVERO (su PGlite, mai su Demo).
 *
 * `ripristino-demo.sql` è UN blocco unico: `BEGIN; DO $$ … $$; COMMIT;` mandato in una richiesta sola. Il blocco `DO` si ferma da solo
 * (`RAISE EXCEPTION RIPRISTINO_…`) e, fermandosi, il COMMIT non viene raggiunto. Qui si prova con la STESSA esecuzione multi-istruzione
 * di PGlite (`db.exec`) che il lock `ripristino-demo-senza-sede` legge nel testo. Le prove D1-D8 della revisione:
 *
 *   D1  il file com'è (segnaposto)                          → si ferma (RIPRISTINO_SEGNAPOSTO)
 *   D2  data compilata ma stati ancora `AAAA/AA`            → si ferma, e NIENTE è cancellato (prima: cancellava e diceva 0 e 0)
 *   D3  fotografia in ordine cronologico, dopo una conferma VERA → riesce (prima: 23505 sull'indice del `corrente`)
 *   D4  simulazione senza conferma (solo il tick)           → riesce; l'anno nato dal tick resta, con la sua cronologia
 *   D5  una sede vera in `sedi_simulazione` con Demo        → si ferma (RIPRISTINO_SEDI_NON_UNA), la sede vera è intatta
 *   D6  `sedi_simulazione` vuoto                            → si ferma (prima: «non tocca niente» e basta)
 *   D7  il COMMIT è nella stessa richiesta                  → dopo un errore la transazione resta in errore (il COMMIT non è partito);
 *                                                              dopo il successo la scrittura è definitiva senza un secondo invio
 *   D8  l'annullo dopo la `fine` è il difetto R2 (corretto da un altro agente): qui non si prova.
 */

const FILE = path.resolve(__dirname, '../../docs/superpowers/simulazione/ripristino-demo.sql')
const ORIGINALE = fs.readFileSync(FILE, 'utf8')

let b: BancoPassaggio
beforeAll(async () => {
  b = await creaBancoPassaggio({ fino: 'M49b' })
}, 180_000)
afterAll(async () => {
  await b?.db.close()
})

const conta = (sql: string, p: unknown[] = []) => una<number>(b.db, `SELECT count(*)::int FROM (${sql}) x`, p)
const passaggi = (sede: string) => conta(`SELECT 1 FROM public.passaggi_anno WHERE scuola_id = $1`, [sede])
const righe = (sede: string) => conta(`SELECT 1 FROM public.passaggi_anno_righe r JOIN public.passaggi_anno p ON p.id = r.passaggio_id WHERE p.scuola_id = $1`, [sede])
const gettoni = (annoSede: string) => conta(`SELECT 1 FROM public.correzioni_anno_chiuso WHERE anno_sede_id = $1`, [annoSede])
const gettoniSede = (sede: string) => conta(`SELECT 1 FROM public.correzioni_anno_chiuso c JOIN public.anni_sede a ON a.id = c.anno_sede_id WHERE a.scuola_id = $1`, [sede])
const cronologia = (sede: string) => conta(`SELECT 1 FROM public.anni_sede_stati s JOIN public.anni_sede a ON a.id = s.anno_sede_id WHERE a.scuola_id = $1`, [sede])

interface Foto { etichetta: string; stato: string; domande: boolean }

/** Gli stati degli anni di una sede ORA, in ordine cronologico: è la «fotografia di partenza» che il titolare salva. */
async function fotografia(sede: string): Promise<Foto[]> {
  const r = await b.db.query<{ etichetta: string; stato: string; domande: boolean }>(
    `SELECT s.etichetta_breve AS etichetta, a.stato, a.domande_aperte AS domande
       FROM public.anni_sede a JOIN public.anni_scolastici s ON s.id = a.anno_id WHERE a.scuola_id = $1 ORDER BY a.inizio`, [sede])
  return r.rows
}
/** Gli stati ORA; con `soloDi`, solo degli anni della fotografia (gli anni nati dalla simulazione non ci sono, e restano). */
async function statiDi(sede: string, soloDi?: Foto[]): Promise<Foto[]> {
  const tutti = await fotografia(sede)
  return soloDi ? tutti.filter((f) => soloDi.some((s) => s.etichetta === f.etichetta)) : tutti
}

interface Compilazione { sede?: string; dal?: string; foto?: Foto[] }
/** Il file con i tre punti «DA COMPILARE» riempiti. Ciò che non si passa resta il segnaposto, com'è nel repository. */
function compila(o: Compilazione): string {
  let sql = ORIGINALE
  if (o.sede) sql = sql.replace("'<DEMO>'", `'${o.sede}'`)
  if (o.dal) sql = sql.replace("'AAAA-MM-GG'", `'${o.dal}'`)
  if (o.foto) {
    sql = sql.replace("('AAAA/AA', 'corrente', false)", o.foto.map((f) => `('${f.etichetta}', '${f.stato}', ${f.domande})`).join(',\n    '))
  }
  return sql
}
/** Il file raccolto in un SAVEPOINT al posto di BEGIN/COMMIT: la prova sta già in una transazione che finisce in ROLLBACK. */
function dentro(sql: string): string {
  const out = sql.replace(/^BEGIN;\s*$/m, 'SAVEPOINT ripr;').replace(/^COMMIT;\s*$/m, 'RELEASE SAVEPOINT ripr;')
  expect(out).not.toBe(sql)
  expect(out).toContain('SAVEPOINT ripr;')
  expect(out).toContain('RELEASE SAVEPOINT ripr;')
  return out
}

/** L'istante d'inizio della transazione di prova: tutto ciò che la prova scrive porta questo `now()`. È la «partenza» giusta. */
const adesso = () => una<string>(b.db, `SELECT now()::text`)

/** Una simulazione vera sulla sede di prova: conferma del passaggio con `p_oggi`, due giri di tick, un gettone con il suo uso. */
async function simula(conConferma: boolean): Promise<void> {
  await b.db.query(`UPDATE public.anno_regole SET guardia_attiva = true`)
  await b.db.exec(`CREATE OR REPLACE FUNCTION public.giorno_roma(p_istante timestamptz) RETURNS date LANGUAGE sql STABLE AS $f$ SELECT DATE '2027-08-01' $f$`)
  if (conConferma) {
    await b.db.query(`SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid, '2027-08-01'::date)`, [b.sim.da, b.sim.a, UTENTE])
    const pid = await una<string>(b.db, `SELECT id FROM public.passaggi_anno WHERE a_anno_sede_id = $1 AND stato = 'anteprima'`, [b.sim.a])
    await b.db.query(`SELECT public.passaggio_conferma($1::uuid, $2::uuid, '2027-08-01'::date)`, [pid, UTENTE])
  }
  await b.db.query(`SELECT public.anni_tick('2027-08-01'::date, $1::uuid)`, [SEDE_SIM])
  await b.db.query(`SELECT public.anni_tick('2027-09-02'::date, $1::uuid)`, [SEDE_SIM])
  const g = await una<string>(b.db,
    `INSERT INTO public.correzioni_anno_chiuso (utente_id, ruolo, anno_sede_id, codice, motivo) VALUES ($1, 'admin', $2, 'correzione', 'motivo finto di prova') RETURNING id`,
    [UTENTE, b.sim.da])
  await b.db.query(`INSERT INTO public.correzioni_anno_chiuso_usi (correzione_id, tabella, riga_id) VALUES ($1, 'presenze', 'x')`, [g])
}

/** Un'altra sede (vera) con un passaggio e un gettone suoi: non devono mai sparire. */
async function seminaVera(): Promise<void> {
  await b.db.query(`INSERT INTO public.passaggi_anno (scuola_id, da_anno_sede_id, a_anno_sede_id, stato) VALUES ($1, $2, $3, 'anteprima')`, [SEDE_VERA, b.vera.da, b.vera.a])
  await b.db.query(
    `INSERT INTO public.correzioni_anno_chiuso (utente_id, ruolo, anno_sede_id, codice, motivo) VALUES ($1, 'segreteria', $2, 'correzione', 'prova di una sede vera')`,
    [UTENTE, b.vera.da])
}

/**
 * Il file mandato COM'È (con BEGIN e COMMIT) e fermato dal blocco: l'errore porta il codice atteso, la transazione RESTA in errore
 * (= il COMMIT che segue il blocco non è stato eseguito) e, tornati al punto prima, non è cambiato niente.
 */
async function fermato(sql: string, codice: string, quadro: () => Promise<unknown>): Promise<void> {
  await b.db.exec('SAVEPOINT prima_del_file')
  const prima = await quadro()
  await expect(b.db.exec(sql)).rejects.toThrow(codice)
  await expect(b.db.query('SELECT 1'), 'dopo l’errore la richiesta si è interrotta: nemmeno il COMMIT è partito').rejects.toThrow(/aborted/i)
  await b.db.exec('ROLLBACK TO SAVEPOINT prima_del_file')
  expect(await quadro(), 'dopo l’errore non è cambiato niente').toEqual(prima)
  await b.db.exec('RELEASE SAVEPOINT prima_del_file')
}

const quadroSede = (sede: string) => async () => ({
  passaggi: await passaggi(sede), righe: await righe(sede), gettoni: await gettoniSede(sede), cronologia: await cronologia(sede), stati: await statiDi(sede),
})

describe('ripristino-demo.sql · il blocco si ferma da solo', () => {
  it('D1 · il file com’è, con i segnaposto: si ferma e non cambia niente', async () => {
    await inRollback(b.db, async () => {
      await simula(true)
      await fermato(ORIGINALE, 'RIPRISTINO_SEGNAPOSTO', quadroSede(SEDE_SIM))
    })
  })

  it('D2 · sede e data compilate ma la riga `AAAA/AA` lasciata: si ferma, prima che qualcosa sia cancellato', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      await simula(true)
      expect(await passaggi(SEDE_SIM)).toBeGreaterThan(0)
      await fermato(compila({ sede: SEDE_SIM, dal }), 'RIPRISTINO_SEGNAPOSTO', quadroSede(SEDE_SIM))
    })
  })

  it('segnaposto: la sede da sola, la data da sola, un’etichetta o uno stato sbagliati', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const foto = await fotografia(SEDE_SIM)
      await simula(true)
      const q = quadroSede(SEDE_SIM)
      await fermato(compila({ dal, foto }), 'RIPRISTINO_SEGNAPOSTO', q)
      await fermato(compila({ sede: SEDE_SIM, foto }), 'RIPRISTINO_SEGNAPOSTO', q)
      await fermato(compila({ sede: SEDE_SIM, dal, foto: [{ ...foto[0], etichetta: 'AAAA/AA' }, ...foto.slice(1)] }), 'RIPRISTINO_SEGNAPOSTO', q)
      await fermato(compila({ sede: SEDE_SIM, dal, foto: [{ ...foto[0], stato: 'aperto' }, ...foto.slice(1)] }), 'RIPRISTINO_SEGNAPOSTO', q)
    })
  })

  it('D5 · una sede VERA in `sedi_simulazione` insieme a Demo: si ferma, la sede vera resta com’è', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const foto = await fotografia(SEDE_SIM)
      await simula(true)
      await seminaVera()
      await b.db.query(`UPDATE public.anno_regole SET sedi_simulazione = ARRAY[$1, $2]::uuid[]`, [SEDE_SIM, SEDE_VERA])
      const q = async () => ({ vera: await quadroSede(SEDE_VERA)(), sim: await quadroSede(SEDE_SIM)() })
      expect((await q()).vera.gettoni).toBe(1)
      await fermato(compila({ sede: SEDE_SIM, dal, foto }), 'RIPRISTINO_SEDI_NON_UNA', q)
      // Anche scrivendo la sede VERA come attesa le sedi sono due: si ferma lo stesso.
      await fermato(compila({ sede: SEDE_VERA, dal, foto }), 'RIPRISTINO_SEDI_NON_UNA', q)
    })
  })

  it('D5-bis · l’unica sede in elenco non è quella scritta: RIPRISTINO_SEDE_DIVERSA', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const foto = await fotografia(SEDE_SIM)
      await simula(true)
      await seminaVera()
      await b.db.query(`UPDATE public.anno_regole SET sedi_simulazione = ARRAY[$1]::uuid[]`, [SEDE_VERA])
      await fermato(compila({ sede: SEDE_SIM, dal, foto }), 'RIPRISTINO_SEDE_DIVERSA', async () => ({ vera: await quadroSede(SEDE_VERA)(), sim: await quadroSede(SEDE_SIM)() }))
    })
  })

  it('D6 · una sede che NON comincia per e2e00000 con `sedi_simulazione` vuoto: si ferma (RIPRISTINO_SEDE_NON_DI_PROVA), non tocca niente', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const foto = await fotografia(SEDE_SIM)
      await simula(true)
      await b.db.query(`UPDATE public.anno_regole SET sedi_simulazione = '{}'::uuid[]`)
      await fermato(compila({ sede: SEDE_SIM, dal, foto }), 'RIPRISTINO_SEDE_NON_DI_PROVA', quadroSede(SEDE_SIM))
    })
  })

  it('(correzioni dopo la revisione finale, F2) una sede VERA fuori elenco: si ferma e la sua storia resta intatta', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const foto = await fotografia(SEDE_VERA)
      await seminaVera()
      await b.db.query(`UPDATE public.anno_regole SET sedi_simulazione = '{}'::uuid[]`)
      await fermato(compila({ sede: SEDE_VERA, dal, foto }), 'RIPRISTINO_SEDE_NON_DI_PROVA', quadroSede(SEDE_VERA))
    })
  })

  it('la data: troppo vecchia (precede la nascita di un anno) e nel futuro → RIPRISTINO_DATA, e non cambia niente', async () => {
    await inRollback(b.db, async () => {
      const foto = await fotografia(SEDE_SIM)
      await simula(true)
      const q = quadroSede(SEDE_SIM)
      // È la data larga delle prove D2, D3 e D5 della revisione: prima cancellava tutta la storia di Demo.
      await fermato(compila({ sede: SEDE_SIM, dal: '2020-01-01', foto }), 'RIPRISTINO_DATA', q)
      await fermato(compila({ sede: SEDE_SIM, dal: '2999-01-01', foto }), 'RIPRISTINO_DATA', q)
    })
  })

  it('la fotografia: un anno che Demo non ha, un anno doppio, due `corrente`, un anno che manca → RIPRISTINO_FOTOGRAFIA', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const foto = await fotografia(SEDE_SIM)
      await simula(true)
      const q = quadroSede(SEDE_SIM)
      const comp = (f: Foto[]) => compila({ sede: SEDE_SIM, dal, foto: f })
      await fermato(comp([...foto, { etichetta: '1999/00', stato: 'chiuso', domande: false }]), 'RIPRISTINO_FOTOGRAFIA', q)
      await fermato(comp([...foto, foto[0]]), 'RIPRISTINO_FOTOGRAFIA', q)
      await fermato(comp(foto.map((f) => ({ ...f, stato: 'corrente', domande: false }))), 'RIPRISTINO_FOTOGRAFIA', q)
      await fermato(comp(foto.slice(1)), 'RIPRISTINO_FOTOGRAFIA', q)
    })
  })

  it('i conteggi dopo non tornano (un trigger rimette un passaggio): RIPRISTINO_CONTEGGI e tutto annullato', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const foto = await fotografia(SEDE_SIM)
      await simula(true)
      await b.db.exec(`
        CREATE FUNCTION public.prova_rimetti_passaggio() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          INSERT INTO public.passaggi_anno (scuola_id, da_anno_sede_id, a_anno_sede_id, stato) VALUES (OLD.scuola_id, OLD.da_anno_sede_id, OLD.a_anno_sede_id, 'anteprima');
          RETURN OLD;
        END $f$;
        CREATE TRIGGER prova_rimetti_passaggio AFTER DELETE ON public.passaggi_anno FOR EACH ROW EXECUTE FUNCTION public.prova_rimetti_passaggio();
      `)
      await fermato(compila({ sede: SEDE_SIM, dal, foto }), 'RIPRISTINO_CONTEGGI', quadroSede(SEDE_SIM))
    })
  })
})

describe('ripristino-demo.sql · quando riesce', () => {
  it('D3 · dopo una conferma VERA, con la fotografia in ordine cronologico: toglie la simulazione, riporta gli stati, non tocca le altre sedi', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const foto = await fotografia(SEDE_SIM)
      expect(foto.map((f) => f.stato), 'la sede di prova parte con un anno corrente').toContain('corrente')
      await seminaVera()
      await simula(true)

      const nonCorrente = (await statiDi(SEDE_SIM)).filter((f) => f.stato === 'corrente').map((f) => f.etichetta)
      expect(nonCorrente, 'la conferma ha spostato il corrente').not.toEqual(foto.filter((f) => f.stato === 'corrente').map((f) => f.etichetta))
      expect(await passaggi(SEDE_SIM)).toBeGreaterThan(0)
      expect(await righe(SEDE_SIM), 'il passaggio ha le sue righe').toBeGreaterThan(0)
      expect(await gettoni(b.sim.da)).toBe(1)
      expect(await conta(`SELECT 1 FROM public.correzioni_anno_chiuso_usi`)).toBe(1)
      const veraPrima = await quadroSede(SEDE_VERA)()
      const e2ePrima = await quadroSede(SEDE_E2E)()
      const nati = await conta(`SELECT 1 FROM public.anni_sede WHERE scuola_id = $1 AND creato_il >= $2::timestamptz`, [SEDE_SIM, dal])

      const risultati = await b.db.exec(dentro(compila({ sede: SEDE_SIM, dal, foto })))

      expect(await passaggi(SEDE_SIM), 'i passaggi sono tolti').toBe(0)
      expect(await righe(SEDE_SIM), 'le righe dei passaggi vanno via con loro').toBe(0)
      expect(await gettoni(b.sim.da), 'i gettoni sono tolti').toBe(0)
      expect(await conta(`SELECT 1 FROM public.correzioni_anno_chiuso_usi`), 'gli usi vanno via con i gettoni').toBe(0)
      expect(await statiDi(SEDE_SIM, foto), 'gli stati sono quelli della fotografia').toEqual(foto)
      expect(await conta(`SELECT 1 FROM public.anni_sede_stati s JOIN public.anni_sede a ON a.id = s.anno_sede_id WHERE a.scuola_id = $1 AND a.creato_il < $2::timestamptz AND s.dal >= $2::timestamptz`, [SEDE_SIM, dal]),
        'nessuna riga di cronologia dopo la partenza, per gli anni che esistevano').toBe(0)
      expect(await conta(`SELECT 1 FROM public.anni_sede WHERE scuola_id = $1 AND creato_il >= $2::timestamptz`, [SEDE_SIM, dal]), 'gli anni nati dalla simulazione restano').toBe(nati)
      expect(nati, 'il tick ha preparato almeno un anno nuovo').toBeGreaterThan(0)
      expect(await quadroSede(SEDE_VERA)(), 'la sede vera è intatta').toEqual(veraPrima)
      expect(await quadroSede(SEDE_E2E)(), 'la sede e2e è intatta').toEqual(e2ePrima)

      const ultimo = risultati.at(-1)!.rows as { voce: string; valore: string }[]
      expect(ultimo.map((r) => r.voce), 'la tabella finale mostra gli stati di Demo').toContain(`stato · ${foto[0].etichetta}`)
      expect(ultimo.find((r) => r.voce === 'invarianti non a zero')).toBeDefined()
    })
  })

  it('D4 · simulazione SENZA conferma (solo il tick): riesce; l’anno nato dal tick resta, gli stati tornano', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const foto = await fotografia(SEDE_SIM)
      await simula(false)
      const dopoSimulazione = await statiDi(SEDE_SIM)
      expect(dopoSimulazione.length, 'il tick ha creato un anno').toBeGreaterThan(foto.length)
      expect(dopoSimulazione.slice(0, foto.length).map((f) => f.stato)).not.toEqual(foto.map((f) => f.stato))

      await b.db.exec(dentro(compila({ sede: SEDE_SIM, dal, foto })))

      expect((await statiDi(SEDE_SIM)).slice(0, foto.length), 'gli stati degli anni di partenza sono quelli della fotografia').toEqual(foto)
      expect((await statiDi(SEDE_SIM)).length, 'l’anno nato dal tick resta').toBe(dopoSimulazione.length)
      expect(await gettoni(b.sim.da)).toBe(0)
    })
  })

  it('la fotografia in ordine inverso riesce lo stesso (i due UPDATE rendono l’ordine irrilevante)', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const foto = await fotografia(SEDE_SIM)
      await simula(true)
      await b.db.exec(dentro(compila({ sede: SEDE_SIM, dal, foto: [...foto].reverse() })))
      expect(await statiDi(SEDE_SIM, foto)).toEqual(foto)
    })
  })

  it('senza conferma e senza simulazione (niente da togliere) riesce e lascia tutto com’era', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const foto = await fotografia(SEDE_SIM)
      const prima = await quadroSede(SEDE_SIM)()
      await b.db.exec(dentro(compila({ sede: SEDE_SIM, dal, foto })))
      expect(await quadroSede(SEDE_SIM)()).toEqual(prima)
    })
  })

  it('una data TARDA (dopo qualche riga della simulazione) riesce ma lascia quelle righe, e la tabella finale le mostra', async () => {
    await inRollback(b.db, async () => {
      const foto = await fotografia(SEDE_SIM)
      await simula(true)
      // Il tempo si sposta all'indietro per le righe (dentro una transazione `now()` non passa mai): gli anni nascono 10 giorni fa, la
      // simulazione ne ha 5, e la partenza «ricordata male» è di 3 giorni fa, più tarda di tutto ciò che la simulazione ha scritto.
      await b.db.exec(`
        UPDATE public.anni_sede SET creato_il = now() - interval '10 days' WHERE scuola_id = '${SEDE_SIM}' AND creato_il < now();
        UPDATE public.passaggi_anno SET creato_il = now() - interval '5 days' WHERE scuola_id = '${SEDE_SIM}';
        UPDATE public.correzioni_anno_chiuso SET creata_il = now() - interval '5 days' WHERE anno_sede_id = '${b.sim.da}';
      `)
      const dal = await una<string>(b.db, `SELECT (now() - interval '3 days')::text`)
      const risultati = await b.db.exec(dentro(compila({ sede: SEDE_SIM, dal, foto })))
      expect(await gettoni(b.sim.da), 'restano anche i gettoni').toBe(1)
      expect(await passaggi(SEDE_SIM), 'restano i passaggi: sono più vecchi della partenza dichiarata').toBeGreaterThan(0)
      const ultimo = risultati.at(-1)!.rows as { voce: string; valore: string }[]
      const rimasti = ultimo.find((r) => r.voce.startsWith('passaggi che restano'))
      expect(Number(rimasti?.valore), 'l’ultima tabella dice quanti passaggi restano').toBeGreaterThan(0)
    })
  })
})

describe('ripristino-demo.sql · una richiesta sola, COMMIT compreso (D7)', () => {
  // ULTIMA prova del file: scrive davvero (COMMIT), quindi niente ROLLBACK a proteggere il banco dopo di lei.
  it('riesce con il file COM’È (BEGIN, DO, COMMIT in un invio) e la scrittura è definitiva senza un secondo invio', async () => {
    const dal = await adesso()
    const foto = await fotografia(SEDE_SIM)
    await b.db.exec('BEGIN')
    await simula(true)
    await b.db.exec('COMMIT') // la simulazione, che nel mondo vero è già avvenuta in giorni precedenti
    expect(await passaggi(SEDE_SIM)).toBeGreaterThan(0)

    // `adesso()` era l’istante di una transazione che è già finita: la simulazione (tutta in una transazione dopo di lei) porta un `now()` più tardo.
    await b.db.exec(compila({ sede: SEDE_SIM, dal, foto }))

    // Nessun COMMIT mandato a parte: la transazione del file è già chiusa e i suoi effetti sono definitivi.
    await expect(b.db.exec('COMMIT'), 'non c’è nessuna transazione aperta: un COMMIT in più è solo un avviso').resolves.toBeDefined()
    expect(await passaggi(SEDE_SIM)).toBe(0)
    expect(await gettoni(b.sim.da)).toBe(0)
    expect(await statiDi(SEDE_SIM, foto)).toEqual(foto)
    expect(await una<string | null>(b.db, `SELECT to_regclass('pg_temp._sedi_simulazione')::text`), 'le tabelle temporanee sono sparite col COMMIT').toBeNull()
  })
})

describe('ripristino-demo.sql · la sede è di prova per il nome o per l\'elenco (correzioni dopo la revisione finale, F2)', () => {
  it('la Demo `e2e00000…` con `sedi_simulazione` VUOTO: riesce (il database la ammette già a simulare, non serve scrivere niente)', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const foto = await fotografia(SEDE_E2E)
      await b.db.query(`UPDATE public.anno_regole SET sedi_simulazione = '{}'::uuid[]`)
      await b.db.query(`INSERT INTO public.passaggi_anno (scuola_id, da_anno_sede_id, a_anno_sede_id, stato) VALUES ($1, $2, $3, 'anteprima')`, [SEDE_E2E, b.da, b.a])
      await b.db.query(
        `INSERT INTO public.correzioni_anno_chiuso (utente_id, ruolo, anno_sede_id, codice, motivo) VALUES ($1, 'admin', $2, 'correzione', 'motivo finto di prova')`,
        [UTENTE, b.da])
      await seminaVera()
      const veraPrima = await quadroSede(SEDE_VERA)()
      expect(await passaggi(SEDE_E2E)).toBe(1)
      expect(await gettoniSede(SEDE_E2E)).toBe(1)

      await b.db.exec(dentro(compila({ sede: SEDE_E2E, dal, foto })))

      expect(await passaggi(SEDE_E2E), 'il passaggio di prova è tolto').toBe(0)
      expect(await gettoniSede(SEDE_E2E), 'il gettone di prova è tolto').toBe(0)
      expect(await quadroSede(SEDE_VERA)(), 'la sede vera è intatta').toEqual(veraPrima)
    })
  })

  it('una sede vera UNICA in elenco: riesce, come prima', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const foto = await fotografia(SEDE_VERA)
      await seminaVera()
      await b.db.query(`UPDATE public.anno_regole SET sedi_simulazione = ARRAY[$1]::uuid[]`, [SEDE_VERA])
      expect(await passaggi(SEDE_VERA)).toBe(1)
      await b.db.exec(dentro(compila({ sede: SEDE_VERA, dal, foto })))
      expect(await passaggi(SEDE_VERA)).toBe(0)
      expect(await gettoniSede(SEDE_VERA)).toBe(0)
    })
  })
})
