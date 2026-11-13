import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { BAMBINI, SEDE_E2E, UTENTE, creaBancoPassaggio, errore, inRollback, una, type BancoPassaggio } from '../helpers/passaggio-banco'

/**
 * PR 4.9, GIRO DI CORREZIONE 1 · le prove dei bloccanti R1, R2 (conferma e annullo dopo il tick), R3 (passaggio mancante),
 * R5 (il job notturno), R6 (agosto) e R7 (i periodi dei voti), a GUARDIA ACCESA e con il giorno esplicito.
 *
 * Il calendario del banco: vecchio 2026/27 (`b.da`) dal 01/09/2026 al 31/08/2027, ultimo giorno aperto 31/07/2027; nuovo 2027/28
 * (`b.a`) `iscrizioni_aperte` dal 01/09/2027. `b.oggi` = 01/08/2027, il giorno dopo l'ultimo giorno aperto.
 *
 * L'orologio è finto SOLO quando la prova passa dalla guardia vera (che legge `now()`), e va impostato PRIMA del `BEGIN`.
 * Ogni prova finisce in ROLLBACK. Solo uuid inventati.
 */

let b: BancoPassaggio

const ARMADIETTO = `
  CREATE TABLE public.armadietto_richieste (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid NOT NULL,
    stato text NOT NULL DEFAULT 'aperta',
    creato_il timestamptz NOT NULL DEFAULT now(),
    promemoria_inviato_il timestamptz
  );
`

beforeAll(async () => {
  b = await creaBancoPassaggio({ fino: 'M49b', codaPrima: ARMADIETTO })
}, 180_000)
afterAll(async () => {
  await b?.db.close()
})
afterEach(() => {
  vi.useRealTimers()
})

async function con(iso: string, fn: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(iso))
  await inRollback(b.db, fn)
}
const guardia = (accesa: boolean) => b.db.query(`UPDATE public.anno_regole SET guardia_attiva = $1`, [accesa])
const stato = async (id: string) =>
  (await b.db.query<{ stato: string; domande_aperte: boolean; fine: string }>(
    `SELECT stato, domande_aperte, fine::text FROM public.anni_sede WHERE id = $1`, [id])).rows[0]
const tick = (oggi: string) => b.db.query(`SELECT public.anni_tick($1::date, $2::uuid)`, [oggi, SEDE_E2E])
const anteprima = async () =>
  (await una<{ passaggio_id: string }>(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid)`, [b.da, b.a, UTENTE])).passaggio_id
const correggi = (p: string, alunno: string, esito: string) =>
  b.db.query(`SELECT public.passaggio_riga_correggi($1::uuid, $2::uuid, $3::text, NULL, $4::uuid)`, [p, alunno, esito, UTENTE])
const conferma = (p: string, oggi: string) =>
  una<{ gia_confermato: boolean }>(b.db, `SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, oggi])
const annulla = (p: string, oggi: string) =>
  una<{ gia_annullato?: boolean; conteggi?: Record<string, number> }>(b.db, `SELECT public.passaggio_annulla($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, oggi])
async function decidi(p: string) {
  await correggi(p, BAMBINI.ritiratoTendina, 'continua')
  await correggi(p, BAMBINI.cambiaGradoSenzaSezione, 'esce')
}
const usiPassaggio = async () =>
  una<number>(b.db, `SELECT count(*)::int FROM public.correzioni_anno_chiuso_usi u JOIN public.correzioni_anno_chiuso c ON c.id = u.correzione_id WHERE c.codice = 'passaggio'`)

describe('R1 · la conferma dopo il tick, a guardia accesa', () => {
  it('in agosto (20/08): il tick ha portato il vecchio a `in_chiusura`, la conferma passa e lascia gli usi del gettone `passaggio` (codice `passaggio`)', async () => {
    await con('2027-08-20T10:00:00.000Z', async () => {
      await guardia(true)
      const p = await anteprima()
      await decidi(p)
      await tick('2027-08-20')
      expect((await stato(b.da)).stato).toBe('in_chiusura')
      expect((await conferma(p, '2027-08-20')).gia_confermato).toBe(false)
      expect((await stato(b.da)).stato).toBe('in_chiusura')
      expect((await stato(b.a)).stato).toBe('corrente')
      expect(await usiPassaggio(), 'ogni riga scritta in un anno protetto lascia il suo uso').toBeGreaterThan(0)
    })
  })

  it('il 3 settembre: il tick ha CHIUSO il vecchio prima che la segreteria confermasse, e la conferma passa lo stesso', async () => {
    await con('2027-09-03T10:00:00.000Z', async () => {
      await guardia(true)
      const p = await anteprima()
      await decidi(p)
      await tick('2027-09-03')
      expect((await stato(b.da)).stato).toBe('chiuso')
      expect((await conferma(p, '2027-09-03')).gia_confermato).toBe(false)
      const vecchio = await stato(b.da)
      expect(vecchio.stato).toBe('chiuso')
      expect(vecchio.domande_aperte).toBe(false)
      expect((await stato(b.a)).stato).toBe('corrente')
      expect(await usiPassaggio()).toBeGreaterThan(0)
    })
  })

  it('l’interruttore non resta acceso dopo la funzione: nella stessa transazione un anno chiuso torna a chiedere il gettone', async () => {
    await con('2027-09-03T10:00:00.000Z', async () => {
      await guardia(true)
      const p = await anteprima()
      await decidi(p)
      await tick('2027-09-03')
      await conferma(p, '2027-09-03')
      expect(await una<string>(b.db, `SELECT current_setting('anno_passaggio.in_corso', true)`)).toBe('off')
      const e = await errore(
        b.db, `INSERT INTO public.presenze (alunno_id, scuola_id, data, section_id) VALUES ($1, $2, '2027-05-10', $3)`,
        [BAMBINI.continua, SEDE_E2E, b.sezioni.girasoli])
      expect(e).toBe('ANNO_CHIUSO')
    })
  })
})

describe('R2 · l’annullo dopo il tick', () => {
  it('annullo il 3 settembre: il vecchio è stato chiuso dal tick, resta chiuso, `domande_aperte` NON si rimette, il nuovo torna a iscrizioni aperte', async () => {
    await con('2027-09-03T10:00:00.000Z', async () => {
      await guardia(true)
      const p = await anteprima()
      await decidi(p)
      await conferma(p, '2027-08-01')
      await tick('2027-09-03')
      expect((await stato(b.da)).stato).toBe('chiuso')
      expect((await annulla(p, '2027-09-03')).gia_annullato ?? false).toBe(false)
      const vecchio = await stato(b.da)
      expect(vecchio.stato).toBe('chiuso')
      expect(vecchio.domande_aperte, 'un anno chiuso non accetta domande: il vincolo ANNO_CHIUSO_CON_DOMANDE lo vieta').toBe(false)
      expect((await stato(b.a)).stato).toBe('iscrizioni_aperte')
      await b.db.exec('SET CONSTRAINTS ALL IMMEDIATE')
    })
  })

  it('annullo in agosto, dopo il tick: il vecchio torna `corrente` con le domande com’erano', async () => {
    await con('2027-08-20T10:00:00.000Z', async () => {
      await guardia(true)
      const prima = await stato(b.da)
      const p = await anteprima()
      await decidi(p)
      await conferma(p, '2027-08-01')
      await tick('2027-08-20')
      await annulla(p, '2027-08-20')
      const vecchio = await stato(b.da)
      expect(vecchio.stato).toBe('corrente')
      expect(vecchio.domande_aperte).toBe(prima.domande_aperte)
      await b.db.exec('SET CONSTRAINTS ALL IMMEDIATE')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('R3 · il passaggio non fatto risponde PASSAGGIO_DA_FARE, anche quando la causa visibile è la classe', () => {
  const DOPO = '2027-09-02T10:00:00.000Z'
  const scrivi = () =>
    errore(b.db, `INSERT INTO public.presenze (alunno_id, scuola_id, data, section_id) VALUES ($1, $2, '2027-09-02', $3)`,
      [BAMBINI.continua, SEDE_E2E, b.sezioni.girasoli])

  for (const [nome, attiva, osserva] of [['spenta', false, false], ['in osservazione', false, true], ['accesa', true, false]] as const) {
    it(`guardia ${nome}: una presenza del nuovo anno con la classe dell’anno prima, senza passaggio → PASSAGGIO_DA_FARE`, async () => {
      await con(DOPO, async () => {
        await b.db.query(`UPDATE public.anno_regole SET guardia_attiva = $1, guardia_osserva = $2`, [attiva, osserva])
        expect(await scrivi()).toBe('PASSAGGIO_DA_FARE')
      })
    })
  }

  it('col passaggio già fatto la stessa scrittura è SEZIONE_DI_ALTRO_ANNO (la classe è davvero sbagliata)', async () => {
    await con(DOPO, async () => {
      await guardia(true)
      const p = await anteprima()
      await decidi(p)
      await conferma(p, '2027-09-02')
      expect(await scrivi()).toBe('SEZIONE_DI_ALTRO_ANNO')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('R-a / R6 · agosto: su `in_chiusura` la guardia non ferma nessuno e conta; su `chiuso` serve il gettone', () => {
  const scrivi = (data: string) =>
    errore(b.db, `INSERT INTO public.presenze (alunno_id, scuola_id, data, section_id) VALUES ($1, $2, $3::date, $4)`,
      [BAMBINI.continua, SEDE_E2E, data, b.sezioni.girasoli])

  it('in_chiusura, nessun gettone: la scrittura PASSA e si conta nelle osservazioni (stato `in_chiusura`)', async () => {
    await con('2027-08-20T10:00:00.000Z', async () => {
      await guardia(true)
      await tick('2027-08-20')
      expect(await scrivi('2027-08-10')).toBe('nessun-errore')
      const r = await b.db.query<{ tabella: string }>(`SELECT tabella FROM public.anno_guardia_osservazioni WHERE stato = 'in_chiusura'`)
      expect(r.rows.map((x) => x.tabella)).toContain('presenze')
    })
  })

  it('chiuso, nessun gettone: resta ANNO_CHIUSO', async () => {
    await con('2027-09-03T10:00:00.000Z', async () => {
      await guardia(true)
      await tick('2027-09-03')
      expect(await scrivi('2027-05-10')).toBe('ANNO_CHIUSO')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('R5 · il job notturno dei promemoria non è fermato da un anno chiuso', () => {
  const nuova = () =>
    una<string>(b.db, `INSERT INTO public.armadietto_richieste (scuola_id, creato_il) VALUES ($1, '2027-05-10T10:00:00Z') RETURNING id`, [SEDE_E2E])

  it('`promemoria_inviato_il` passa su un anno chiuso a guardia accesa: tre notti, UN solo promemoria', async () => {
    await con('2027-09-03T10:00:00.000Z', async () => {
      await guardia(true)
      const r = await nuova()
      await tick('2027-09-03')
      let promemoria = 0
      for (let notte = 0; notte < 3; notte++) {
        const daRicordare = await una<number>(
          b.db, `SELECT count(*)::int FROM public.armadietto_richieste WHERE stato = 'aperta' AND promemoria_inviato_il IS NULL`)
        promemoria += daRicordare
        if (daRicordare > 0) {
          expect(await errore(b.db, `UPDATE public.armadietto_richieste SET promemoria_inviato_il = now() WHERE id = $1`, [r])).toBe('nessun-errore')
        }
      }
      expect(promemoria, 'senza l’esenzione la marcatura fallirebbe e la richiesta verrebbe ricordata ogni notte').toBe(1)
    })
  })

  it('ma la richiesta non si può riscrivere: `stato` su un anno chiuso → ANNO_CHIUSO', async () => {
    await con('2027-09-03T10:00:00.000Z', async () => {
      await guardia(true)
      const r = await nuova()
      await tick('2027-09-03')
      expect(await errore(b.db, `UPDATE public.armadietto_richieste SET stato = 'chiusa' WHERE id = $1`, [r])).toBe('ANNO_CHIUSO')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('R7 · `periodo_id` è un dato derivato: il ricalcolo dei periodi non è fermato da un anno chiuso', () => {
  it('l’elenco delle colonne esenti porta `periodo_id` per i voti e per le giustifiche didattiche', async () => {
    for (const t of ['valutazioni', 'giustifiche_didattiche']) {
      const e = await una<string[]>(b.db, `SELECT public.anno_colonne_esenti($1)`, [t])
      expect(e, t).toContain('periodo_id')
    }
  })

  it('su un voto di un anno chiuso, a guardia accesa, cambiare SOLO `periodo_id` passa; cambiare il voto → ANNO_CHIUSO', async () => {
    await con('2027-09-03T10:00:00.000Z', async () => {
      await guardia(true)
      await tick('2027-09-03')
      const vecchio = { id: '77777777-7777-4777-8777-777777777771', alunno_id: BAMBINI.continua, anno_id: b.annoDa, data_evento: '2027-05-10', voto: '8', periodo_id: '77777777-7777-4777-8777-777777777772' }
      const guardiaVoto = (nuovo: Record<string, unknown>) =>
        errore(b.db,
          `SELECT public.anno_guardia_verifica(t, 'UPDATE', $1::jsonb, $2::jsonb, NULL, false) FROM public.anno_tabelle t WHERE t.tabella = 'valutazioni'`,
          [JSON.stringify(vecchio), JSON.stringify(nuovo)])
      expect(await guardiaVoto({ ...vecchio, periodo_id: '77777777-7777-4777-8777-777777777773' })).toBe('nessun-errore')
      expect(await guardiaVoto({ ...vecchio, voto: '9' })).toBe('ANNO_CHIUSO')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('S9 · la salute distingue «il passaggio è da fare» da «si sta già scrivendo nell’anno sbagliato»', () => {
  const salute = () => una<{ passaggio_da_fare: number; passaggio_iniziato: number }>(b.db, `SELECT public.salute_anno()`)

  it('28/08: la sede vera ha il passaggio da fare ma l’anno nuovo non è cominciato (iniziato = 0)', async () => {
    await con('2027-08-28T10:00:00.000Z', async () => {
      const s = await salute()
      expect(s.passaggio_da_fare).toBeGreaterThan(0)
      expect(s.passaggio_iniziato).toBe(0)
    })
  })

  it('02/09: l’anno nuovo è cominciato e il passaggio non c’è: iniziato > 0', async () => {
    await con('2027-09-02T10:00:00.000Z', async () => {
      expect((await salute()).passaggio_iniziato).toBeGreaterThan(0)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('S2 · l’invariante 7 vede l’anno visibile: dal 20/08 al 31/08, con un genitore legato, resta a zero', () => {
  for (const giorno of ['2027-08-20', '2027-08-31']) {
    it(`conferma e tick il ${giorno}, un genitore legato al bambino che continua: nessuna riga dell’invariante 7`, async () => {
      await con(`${giorno}T10:00:00.000Z`, async () => {
        await guardia(true)
        await b.db.query(`INSERT INTO public.parents (id, auth_user_id) VALUES ('88888888-8888-4888-8888-888888888881', '88888888-8888-4888-8888-888888888882')`)
        await b.db.query(`INSERT INTO public.student_parents (student_id, parent_id) VALUES ($1, '88888888-8888-4888-8888-888888888881')`, [BAMBINI.continua])
        const p = await anteprima()
        await decidi(p)
        await conferma(p, giorno)
        await tick(giorno)
        const r = await b.db.query<{ invariante: string; tabella: string | null; righe: number }>(
          `SELECT invariante::text, tabella, righe::int FROM public.anno_invarianti() WHERE invariante::text = '7' AND righe > 0`)
        expect(r.rows).toEqual([])
      })
    })
  }
})
