// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase } from '../fixtures/finto-supabase'
import { controlloAnno } from '@/lib/health/controlli'
import {
  BAMBINI, SEDE_E2E, SEDE_VERA, UTENTE, creaBancoPassaggio, errore, inRollback, una,
  type BancoPassaggio,
} from '../helpers/passaggio-banco'

/**
 * COMPITO 4.9.2 · `PASSAGGIO_DA_FARE` (M49b). Una scrittura di una tabella del registro in modo `data` che cade in un anno
 * `in_preparazione`/`iscrizioni_aperte` GIÀ COMINCIATO, senza che il passaggio sia stato confermato, viene rifiutata dalla guardia
 * (e SOLO dalla guardia: a guardia spenta il database fa quello di oggi; in osservazione conta e lascia passare).
 *
 * ── Il calendario del banco ── 2026/27 `corrente` dal 01/09/2026 al 31/08/2027; 2027/28 dal 01/09/2027: della sede del passaggio
 * (`SEDE_E2E`) `iscrizioni_aperte`, della sede «vera» `in_preparazione`. L'orologio è finto (`vi.setSystemTime`, che PGlite segue
 * SOLO se è impostato PRIMA del `BEGIN`: dentro una transazione `now()` è quello dell'inizio): il 25/08/2027 l'anno nuovo non è
 * cominciato, il 01/09/2027 sì.
 *
 * ── Perché il confine è «l'anno è cominciato» e non «la data è dentro l'anno» ── l'agenda, la mensa e i servizi dal 01/09 si
 * programmano in primavera: sono tabelle `data` con una data nel 2027/28 scritte mentre l'anno non è cominciato. Il piano diceva
 * `data >= inizio`; avrebbe fermato anche quelle (Ruling nell'esito della 4.9).
 *
 * Ogni prova sta in una transazione che finisce in ROLLBACK. Solo uuid inventati.
 */

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

let b: BancoPassaggio

const PRIMA = '2027-08-25T10:00:00.000Z' // Roma 12:00 del 25/08/2027: il 2027/28 non è cominciato
const DOPO = '2027-09-01T10:00:00.000Z' //  Roma 12:00 del 01/09/2027: il 2027/28 è cominciato

/** Le nove tabelle `data` che il banco ha (le altre del registro non ci sono: il registro riga per riga è quello del banco). */
const TABELLE_DEL_BANCO = [
  'avvisi', 'chat_messages', 'eventi_diario', 'galleria_media_v2', 'mensa_prenotazioni', 'note_disciplinari', 'presenze',
  'valutazioni', 'video_intents',
]

beforeAll(async () => {
  b = await creaBancoPassaggio({ fino: 'M49b' })
}, 180_000)
afterAll(async () => {
  await b?.db.close()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Sposta l'orologio e poi apre la transazione che finisce in ROLLBACK (l'ordine conta: `now()` è quello del BEGIN). */
async function con(iso: string, fn: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(iso))
  await inRollback(b.db, fn)
}
const guardia = (accesa: boolean) => b.db.query(`UPDATE public.anno_regole SET guardia_attiva = $1`, [accesa])
const osservazione = (accesa: boolean) => b.db.query(`UPDATE public.anno_regole SET guardia_osserva = $1`, [accesa])

/** La guardia chiamata a mano su una riga sintetica: il banco non ha tutte le colonne di tutte le tabelle, la regola sì. */
async function guardiaSu(tabella: string, sede: string, anno: string, data: string): Promise<string> {
  return errore(
    b.db,
    `SELECT public.anno_guardia_verifica(
        t, 'INSERT', NULL,
        jsonb_build_object('id', gen_random_uuid(), 'scuola_id', $2::uuid, 'anno_id', $3::uuid, t.colonna_data, $4::text),
        NULL, false)
       FROM public.anno_tabelle t WHERE t.tabella = $1`,
    [tabella, sede, anno, data])
}

async function tabelleData() {
  const r = await b.db.query<{ tabella: string; guardia: string }>(
    `SELECT tabella, guardia FROM public.anno_tabelle WHERE modo = 'data' ORDER BY tabella`)
  return r.rows
}

/** Una scrittura vera (trigger compreso) che poi si disfa: il messaggio dell'errore, o `nessun-errore`. */
async function prova(sql: string, params: unknown[]): Promise<string> {
  await b.db.exec('SAVEPOINT prova_scrittura')
  let esito = 'nessun-errore'
  try {
    await b.db.query(sql, params)
  } catch (e) {
    esito = (e as { message?: string }).message ?? 'senza-messaggio'
  }
  await b.db.exec('ROLLBACK TO SAVEPOINT prova_scrittura')
  await b.db.exec('RELEASE SAVEPOINT prova_scrittura')
  return esito
}
const presenza = (data: string) =>
  prova(`INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, $3::date)`, [BAMBINI.continua, SEDE_E2E, data])

// ════════════════════════════════════════════════════════════════════════════════════════════
describe('la regola, tabella per tabella (la guardia chiamata a mano)', () => {
  it('il registro del banco ha le nove tabelle `data` che ci si aspetta (un lock cieco qui sarebbe verde su zero tabelle)', async () => {
    const nomi = (await tabelleData()).map((t) => t.tabella)
    expect(nomi).toEqual(TABELLE_DEL_BANCO)
  })

  it('a anno cominciato ogni tabella `data` con guardia rifiuta con PASSAGGIO_DA_FARE (anno in preparazione)', async () => {
    const tabelle = (await tabelleData()).filter((t) => t.guardia !== 'nessuna')
    expect(tabelle.length).toBe(TABELLE_DEL_BANCO.length)
    await con(DOPO, async () => {
      await guardia(true)
      for (const t of tabelle) {
        expect(await guardiaSu(t.tabella, SEDE_VERA, b.annoA, '2027-09-05'), t.tabella).toBe('PASSAGGIO_DA_FARE')
      }
    })
  })

  it('lo stesso con l’anno nuovo a iscrizioni aperte (la sede del passaggio)', async () => {
    const tabelle = await tabelleData()
    await con(DOPO, async () => {
      await guardia(true)
      for (const t of tabelle) {
        expect(await guardiaSu(t.tabella, SEDE_E2E, b.annoA, '2027-09-05'), t.tabella).toBe('PASSAGGIO_DA_FARE')
      }
    })
  })

  it('prima che l’anno cominci NESSUNA tabella rifiuta (agenda, mensa e servizi dal 01/09 si programmano in anticipo)', async () => {
    const tabelle = await tabelleData()
    await con(PRIMA, async () => {
      await guardia(true)
      for (const t of tabelle) {
        expect(await guardiaSu(t.tabella, SEDE_VERA, b.annoA, '2027-09-05'), t.tabella).toBe('nessun-errore')
      }
    })
  })

  it('una data dell’anno che sta finendo non cambia, a qualunque ora dopo l’inizio del nuovo', async () => {
    const tabelle = await tabelleData()
    await con(DOPO, async () => {
      await guardia(true)
      for (const t of tabelle) {
        expect(await guardiaSu(t.tabella, SEDE_VERA, b.annoDa, '2027-08-31'), t.tabella).toBe('nessun-errore')
      }
    })
  })

  it('il messaggio è il codice e il DETAIL porta la tabella e l’anno-sede, mai una riga', async () => {
    await con(DOPO, async () => {
      await guardia(true)
      await b.db.exec('SAVEPOINT s_dettaglio')
      let detail = ''
      try {
        await b.db.query(
          `SELECT public.anno_guardia_verifica(t, 'INSERT', NULL,
             jsonb_build_object('id', gen_random_uuid(), 'scuola_id', $1::uuid, 'anno_id', $2::uuid, t.colonna_data, '2027-09-05'), NULL, false)
             FROM public.anno_tabelle t WHERE t.tabella = 'presenze'`, [SEDE_VERA, b.annoA])
      } catch (e) {
        detail = (e as { detail?: string }).detail ?? ''
      }
      await b.db.exec('ROLLBACK TO SAVEPOINT s_dettaglio')
      expect(JSON.parse(detail)).toEqual({ tabella: 'presenze', anno_sede_id: b.vera.a })
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
describe('la scrittura vera, con il trigger, e le tre manopole', () => {
  it('guardia accesa, anno cominciato: una presenza del 05/09 è rifiutata, una del 31/08 passa', async () => {
    await con(DOPO, async () => {
      await guardia(true)
      expect(await presenza('2027-09-05')).toBe('PASSAGGIO_DA_FARE')
      expect(await presenza('2027-08-31')).toBe('nessun-errore')
    })
  })

  it('guardia accesa, anno NON cominciato: la presenza del 05/09 passa', async () => {
    await con(PRIMA, async () => {
      await guardia(true)
      expect(await presenza('2027-09-05')).toBe('nessun-errore')
    })
  })

  it('il giorno è quello di ROMA: alle 00:30 del 01/09 (22:30Z del 31/08) l’anno è cominciato, alle 23:30 del 31/08 (21:30Z) no', async () => {
    await con('2027-08-31T22:30:00.000Z', async () => {
      await guardia(true)
      expect(await presenza('2027-09-05')).toBe('PASSAGGIO_DA_FARE')
    })
    await con('2027-08-31T21:30:00.000Z', async () => {
      await guardia(true)
      expect(await presenza('2027-09-05')).toBe('nessun-errore')
    })
  })

  it('guardia SPENTA (lo stato di produzione oggi): la stessa scrittura passa, come prima del 4.9', async () => {
    await con(DOPO, async () => {
      await guardia(false)
      await osservazione(false)
      expect(await presenza('2027-09-05')).toBe('nessun-errore')
    })
  })

  it('osservazione: la scrittura passa e si conta una riga per chiave, con la chiave `passaggio_da_fare`', async () => {
    await con(DOPO, async () => {
      await guardia(false)
      await osservazione(true)
      await b.db.query(`DELETE FROM public.anno_guardia_osservazioni`)
      expect(await presenza('2027-09-05')).toBe('nessun-errore')
      // la prova ha disfatto la scrittura ma il contatore sta in una tabella a parte: anche lui è stato disfatto dal savepoint,
      // quindi si ripete dentro la transazione e si guarda prima di tornare indietro
      await b.db.query(`INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, DATE '2027-09-05')`, [BAMBINI.continua, SEDE_E2E])
      const r = await b.db.query<{ tabella: string; op: string; stato: string; n: string }>(
        `SELECT tabella, op, stato, n::text FROM public.anno_guardia_osservazioni WHERE stato = 'passaggio_da_fare'`)
      expect(r.rows).toEqual([{ tabella: 'presenze', op: 'INSERT', stato: 'passaggio_da_fare', n: '1' }])
    })
  })

  it('un UPDATE che porta una presenza DENTRO l’anno nuovo è rifiutato; uno che non muove né l’anno né la data passa', async () => {
    await con(DOPO, async () => {
      await guardia(false)
      const vecchia = await una<string>(
        b.db, `INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, DATE '2027-08-31') RETURNING id`,
        [BAMBINI.continua, SEDE_E2E])
      // una riga che sta GIÀ nel 2027/28 (scritta a guardia spenta): un UPDATE che non la sposta non è «entrare»
      const nuova = await una<string>(
        b.db, `INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, DATE '2027-09-05') RETURNING id`,
        [BAMBINI.continua, SEDE_E2E])
      await guardia(true)
      expect(await prova(`UPDATE public.presenze SET data = DATE '2027-09-05' WHERE id = $1`, [vecchia])).toBe('PASSAGGIO_DA_FARE')
      expect(await prova(`UPDATE public.presenze SET data = data WHERE id = $1`, [nuova])).toBe('nessun-errore')
      expect(await prova(`UPDATE public.presenze SET data = DATE '2027-09-06' WHERE id = $1`, [nuova])).toBe('PASSAGGIO_DA_FARE')
    })
  })

  it('il riempimento storico non è una scrittura di persone: con l’interruttore acceso non scatta', async () => {
    await con(DOPO, async () => {
      await guardia(true)
      await b.db.query(`SELECT set_config('anno_scolastico.riempimento', 'on', true)`)
      expect(await presenza('2027-09-05')).toBe('nessun-errore')
    })
  })

  it('una tabella `dichiarato` (le voci con competenza nell’anno nuovo) non passa di qui: `pagamenti` è libero', async () => {
    const modo = await una<string>(b.db, `SELECT modo FROM public.anno_tabelle WHERE tabella = 'pagamenti'`)
    expect(modo).toBe('dichiarato')
    await con(DOPO, async () => {
      await guardia(true)
      expect(await errore(
        b.db,
        `SELECT public.anno_guardia_verifica(t, 'INSERT', NULL,
           jsonb_build_object('id', gen_random_uuid(), 'scuola_id', $1::uuid, 'anno_id', $2::uuid, 'competenza', '2027-09-01'), NULL, false)
           FROM public.anno_tabelle t WHERE t.tabella = 'pagamenti'`, [SEDE_E2E, b.annoA])).toBe('nessun-errore')
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
describe('dopo la conferma del passaggio la stessa scrittura passa; dopo l’annullamento torna a fermarsi', () => {
  it('conferma → passa; annulla → si ferma', async () => {
    await con(DOPO, async () => {
      await guardia(true)
      const p = (await una<{ passaggio_id: string }>(
        b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid)`, [b.da, b.a, UTENTE])).passaggio_id
      await b.db.query(`SELECT public.passaggio_riga_correggi($1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid)`,
        [p, BAMBINI.ritiratoTendina, 'continua', null, UTENTE])
      await b.db.query(`SELECT public.passaggio_riga_correggi($1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid)`,
        [p, BAMBINI.cambiaGradoSenzaSezione, 'esce', null, UTENTE])

      // prima: il passaggio non c'è, l'anno è cominciato
      expect(await presenza('2027-09-05')).toBe('PASSAGGIO_DA_FARE')

      await b.db.query(`SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, b.oggi])
      expect(await una<string>(b.db, `SELECT stato FROM public.anni_sede WHERE id = $1`, [b.a])).toBe('corrente')
      expect(await presenza('2027-09-05')).toBe('nessun-errore')

      await b.db.query(`SELECT public.passaggio_annulla($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, b.oggi])
      expect(await una<string>(b.db, `SELECT stato FROM public.anni_sede WHERE id = $1`, [b.a])).toBe('iscrizioni_aperte')
      expect(await presenza('2027-09-05')).toBe('PASSAGGIO_DA_FARE')
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
describe('`salute_anno()`: le due chiavi nuove', () => {
  async function salute(): Promise<Record<string, number>> {
    return una<Record<string, number>>(b.db, `SELECT public.salute_anno()`)
  }

  it('le tre chiavi di prima ci sono ancora, con le tre nuove (S9: passaggio_iniziato)', async () => {
    await con(PRIMA, async () => {
      const s = await salute()
      expect(Object.keys(s).sort()).toEqual(
        ['guardia_spenta_vicina', 'in_ritardo_giorni', 'invarianti_non_zero', 'passaggio_da_fare', 'passaggio_iniziato', 'sedi_senza_successivo'])
    })
  })

  it('`passaggio_da_fare`: a 8 giorni dall’inizio è 0, a 7 e a 6 è 1 (una sola sede «vera»; la prova e la simulazione sono fuori)', async () => {
    await con('2027-08-24T10:00:00.000Z', async () => {
      expect((await salute()).passaggio_da_fare).toBe(0)
    })
    await con('2027-08-25T10:00:00.000Z', async () => {
      expect((await salute()).passaggio_da_fare).toBe(1)
    })
    await con('2027-08-26T10:00:00.000Z', async () => {
      expect((await salute()).passaggio_da_fare).toBe(1)
    })
  })

  it('(chiusura A) il giro orario di anni_tick scrive UNA riga `error` per sede e per giorno (la seconda volta non scrive: occorrenze 1) da 7 giorni prima dell\'inizio; a 8 giorni, a passaggio fatto e per la sede di prova niente', async () => {
    const righe = () => b.db.query<{ occorrenze: number; scuola_id: string; livello: string }>(
      `SELECT occorrenze, scuola_id, livello FROM public.app_log WHERE fingerprint LIKE 'anni-tick-passaggio-da-fare:%'`).then((r) => r.rows)
    await con('2027-08-24T10:00:00.000Z', async () => {
      await b.db.query('SELECT public.anni_tick()')
      expect(await righe(), 'a 8 giorni dall\'inizio').toHaveLength(0)
    })
    await con('2027-08-25T10:00:00.000Z', async () => {
      await b.db.query('SELECT public.anni_tick()')
      await b.db.query('SELECT public.anni_tick()')
      const r = await righe()
      expect(r, 'una sola riga, la sede vera; mai la sede di prova').toHaveLength(1)
      expect(r[0]).toMatchObject({ scuola_id: SEDE_VERA, livello: 'error', occorrenze: 1 })
    })
  })

  it('`passaggio_da_fare` torna a 0 quando l’anno nuovo di una sede è `corrente`', async () => {
    await con(DOPO, async () => {
      expect((await salute()).passaggio_da_fare).toBe(1)
      await b.db.query(`SELECT set_config('anno_scolastico.riempimento', 'off', true)`)
      await b.db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura', domande_aperte = false WHERE id = $1`, [b.vera.da])
      await b.db.query(`UPDATE public.anni_sede SET stato = 'corrente' WHERE id = $1`, [b.vera.a])
      expect((await salute()).passaggio_da_fare).toBe(0)
    })
  })

  it('`guardia_spenta_vicina`: a guardia spenta, 31 giorni prima dell’ultimo giorno aperto è 0, 30 e 29 è 1; a guardia accesa è sempre 0', async () => {
    const ultimo = await una<string>(b.db, `SELECT ultimo_giorno_aperto::text FROM public.anni_sede WHERE id = $1`, [b.vera.da])
    const giorno = (meno: number) => {
      const d = new Date(`${ultimo}T10:00:00.000Z`)
      d.setUTCDate(d.getUTCDate() - meno)
      return d.toISOString()
    }
    await con(giorno(31), async () => {
      await guardia(false)
      expect((await salute()).guardia_spenta_vicina).toBe(0)
    })
    await con(giorno(30), async () => {
      await guardia(false)
      expect((await salute()).guardia_spenta_vicina).toBe(1)
    })
    await con(giorno(29), async () => {
      await guardia(false)
      expect((await salute()).guardia_spenta_vicina).toBe(1)
    })
    await con(giorno(29), async () => {
      await guardia(true)
      expect((await salute()).guardia_spenta_vicina).toBe(0)
    })
  })

  // ── (correzioni, giro 3, M1) Il passaggio fatto a guardia spenta: dal giorno dopo la `fine` l'anno vecchio resta `in_chiusura` ──
  // Il tick non lo chiude (guardia spenta) e scrive `anni-tick-guardia-spenta:<sede>`, che `tasso-errore` non conta più: deve vederlo `anno`.
  async function passaggioFatto(sede: { da: string; a: string }, statoVecchio: string): Promise<void> {
    await b.db.query(`SELECT set_config('anno_scolastico.riempimento', 'off', true)`)
    await b.db.query(`UPDATE public.anni_sede SET stato = $2, domande_aperte = false WHERE id = $1`, [sede.da, statoVecchio])
    await b.db.query(`UPDATE public.anni_sede SET stato = 'corrente' WHERE id = $1`, [sede.a])
  }
  const giornoDopoLaFine = async (annoSede: string) => {
    const fine = await una<string>(b.db, `SELECT fine::text FROM public.anni_sede WHERE id = $1`, [annoSede])
    const d = new Date(`${fine}T10:00:00.000Z`)
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString()
  }
  /** Il controllo `anno` di /api/health, alimentato dalla `salute_anno()` vera del banco. */
  async function controlloAnnoDalBanco() {
    const s = await salute()
    const client = creaFintoSupabase({}, [], { errori: {}, rpc: { salute_anno: () => ({ data: s, error: null }) } as never }) as unknown as SupabaseClient
    return controlloAnno(client, Date.now())
  }

  it('(M1) passaggio fatto a guardia spenta, il giorno dopo la `fine`: `guardia_spenta_vicina` conta l’anno rimasto `in_chiusura` e `anno` è `degradato`', async () => {
    const giorno = await giornoDopoLaFine(b.vera.da)
    await con(giorno, async () => {
      await guardia(false)
      await passaggioFatto(b.vera, 'in_chiusura')
      const s = await salute()
      expect(s.passaggio_da_fare, 'il passaggio è fatto').toBe(0)
      expect(s.guardia_spenta_vicina, 'ma l’anno vecchio è rimasto in_chiusura oltre la fine').toBe(1)
      expect(await controlloAnnoDalBanco()).toMatchObject({ nome: 'anno', esito: 'degradato' })
    })
  })

  it('(M1) non conta: con la guardia accesa, per una sede `e2e00000…`, e per un anno già `chiuso`', async () => {
    const giorno = await giornoDopoLaFine(b.vera.da)
    await con(giorno, async () => {
      await guardia(true)
      await passaggioFatto(b.vera, 'in_chiusura')
      expect((await salute()).guardia_spenta_vicina, 'guardia accesa').toBe(0)
    })
    await con(giorno, async () => {
      await guardia(false)
      await passaggioFatto(b.vera, 'chiuso')
      await passaggioFatto(b, 'in_chiusura')
      const s = await salute()
      expect(s.guardia_spenta_vicina, 'la sede vera ha l’anno chiuso, la sede e2e00000 è esclusa').toBe(0)
      expect(await controlloAnnoDalBanco()).toMatchObject({ nome: 'anno', esito: 'ok' })
    })
  })
})
