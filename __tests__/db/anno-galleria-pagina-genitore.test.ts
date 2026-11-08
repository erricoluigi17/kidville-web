import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2, SCHEMA_GALLERIA_GENITORE, SCHEMA_LEGAMI_GENITORE } from '../helpers/schema-anno-pglite'

/**
 * PR 4.4 · `galleria_pagina_genitore`: una pagina di un figlio, in ordine, col totale. Chi vede cosa lo decide
 * `media_visibili_genitore` (provata in `anno-visibilita-genitore.test.ts`); qui la prova che la pagina non la allarga e non
 * la perde per strada, su Postgres vero. Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const SEZ_A = '55555555-5555-4555-8555-555555555551'
const SEZ_B = '55555555-5555-4555-8555-555555555552'

const GEN_A = '99999999-9999-4999-8999-999999999991'
const GEN_B = '99999999-9999-4999-8999-999999999992'
const GEN_RITIRATO = '99999999-9999-4999-8999-999999999993'
const GEN_NUOVO = '99999999-9999-4999-8999-999999999994'

const FIGLIO_A = '11111111-1111-4111-8111-111111111111'
const FRATELLO_A = '11111111-1111-4111-8111-111111111112'
const FIGLIO_B = '11111111-1111-4111-8111-111111111113'
const FIGLIO_RITIRATO = '11111111-1111-4111-8111-111111111114'
const FIGLIO_NUOVO = '11111111-1111-4111-8111-111111111115'

const NATA_COL_RIEMPIMENTO = '2026-11-07T10:00:00+01:00'

let db: PGlite
let ANNO: string

const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 30_000)

async function inRollback(fn: () => Promise<void>) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}

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

type DatiFoto = { tag?: string[]; broadcast?: boolean; target?: string[] | null; il?: string; eliminata?: boolean }

async function foto(d: DatiFoto = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.galleria_media_v2 (scuola_id, tag_students, is_broadcast, target_section_ids, created_at, eliminato_il)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [SEDE, d.tag ?? [], d.broadcast ?? false, d.target ?? null, d.il ?? '2026-10-20T12:00:00+02:00',
      d.eliminata ? '2026-10-30T10:00:00Z' : null])
  return r.rows[0].id
}

type RigaPagina = { media_id: string | null; totale: string | number }

async function pagina(
  utente: string,
  alunno: string,
  o: { dal?: string; al?: string; limit?: number; offset?: number } = {},
): Promise<{ ids: (string | null)[]; totale: number }> {
  const r = await db.query<RigaPagina>(
    `SELECT media_id, totale FROM public.galleria_pagina_genitore($1, $2, $3, $4, $5, $6)`,
    [utente, alunno, o.dal ?? null, o.al ?? null, o.limit ?? 30, o.offset ?? 0])
  return { ids: r.rows.map((x) => x.media_id), totale: Number(r.rows[0]?.totale ?? -1) }
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M44g', codaPrima: SCHEMA_GALLERIA_GENITORE })
  await db.exec(SCHEMA_LEGAMI_GENITORE)

  const anni = await db.query<{ id: string; anno_id: string }>(
    `SELECT s.id, s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
      WHERE s.scuola_id = $1 AND y.anno_inizio = 2026`, [SEDE])
  ANNO = anni.rows[0].id
  for (const [id, nome] of [[SEZ_A, 'Girasoli'], [SEZ_B, 'Margherite']]) {
    await db.query(`INSERT INTO public.sections (id, scuola_id, name, anno_id) VALUES ($1, $2, $3, $4)`,
      [id, SEDE, nome, anni.rows[0].anno_id])
  }

  await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
  for (const id of [FIGLIO_A, FRATELLO_A, FIGLIO_B, FIGLIO_RITIRATO, FIGLIO_NUOVO]) {
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [id, SEDE])
  }
  await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = true`)

  const legami: Array<[string, string]> = [
    [GEN_A, FIGLIO_A], [GEN_A, FRATELLO_A], [GEN_B, FIGLIO_B], [GEN_RITIRATO, FIGLIO_RITIRATO], [GEN_NUOVO, FIGLIO_NUOVO],
  ]
  for (const [g, a] of legami) {
    await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [g, a])
  }

  const frequenza = (alunno: string, sezione: string, extra: { stato?: string; ingresso?: string; uscita?: string; origine?: string; tipo?: string; nata?: string } = {}) =>
    db.query(
      `INSERT INTO public.frequenze (alunno_id, anno_sede_id, section_id, stato, data_ingresso, data_uscita, origine, tipo, creata_il)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [alunno, ANNO, sezione, extra.stato ?? 'iscritto', extra.ingresso ?? '2026-09-01', extra.uscita ?? null,
        extra.origine ?? 'recupero', extra.tipo ?? null, extra.nata ?? NATA_COL_RIEMPIMENTO])
  await frequenza(FIGLIO_A, SEZ_A)
  await frequenza(FRATELLO_A, SEZ_A)
  await frequenza(FIGLIO_B, SEZ_B)
  await frequenza(FIGLIO_RITIRATO, SEZ_A, { stato: 'ritirato', uscita: '2026-10-01' })
  // Una famiglia nuova: la riga viene da una domanda, e la sua data d'ingresso è vera.
  await frequenza(FIGLIO_NUOVO, SEZ_A, { stato: 'in_attesa', ingresso: '2026-10-10', origine: 'domanda', tipo: 'nuova', nata: 'now' })

  for (const a of [FIGLIO_A, FRATELLO_A, FIGLIO_RITIRATO]) {
    await db.query(
      `INSERT INTO public.alunni_classi_storico (alunno_id, scuola_id, section_id, dal, fonte) VALUES ($1, $2, $3, '2026-09-01', 'attuale')`,
      [a, SEDE, SEZ_A])
  }
  await db.query(
    `INSERT INTO public.alunni_classi_storico (alunno_id, scuola_id, section_id, dal, fonte) VALUES ($1, $2, $3, '2026-09-01', 'attuale')`,
    [FIGLIO_B, SEDE, SEZ_B])
}, 120_000)
afterAll(async () => { await db.close() })

describe('galleria_pagina_genitore', () => {
  prova('dà la pagina dalla foto più recente, e il totale resta quello di tutte', async () => {
    await inRollback(async () => {
      const vecchia = await foto({ tag: [FIGLIO_A], il: '2026-10-18T12:00:00+02:00' })
      const media = await foto({ tag: [FIGLIO_A], il: '2026-10-19T12:00:00+02:00' })
      const nuova = await foto({ tag: [FIGLIO_A], il: '2026-10-20T12:00:00+02:00' })

      expect(await pagina(GEN_A, FIGLIO_A, { limit: 2 })).toEqual({ ids: [nuova, media], totale: 3 })
      expect(await pagina(GEN_A, FIGLIO_A, { limit: 2, offset: 2 })).toEqual({ ids: [vecchia], totale: 3 })
    })
  })

  prova('oltre la fine resta una riga col totale, e nessuna foto', async () => {
    await inRollback(async () => {
      await foto({ tag: [FIGLIO_A] })
      expect(await pagina(GEN_A, FIGLIO_A, { offset: 5 })).toEqual({ ids: [null], totale: 1 })
    })
  })

  prova('nessuna foto: una riga col totale a zero', async () => {
    expect(await pagina(GEN_A, FIGLIO_A)).toEqual({ ids: [null], totale: 0 })
  })

  prova('solo il figlio chiesto: la foto del fratello non entra nella pagina né nel totale', async () => {
    await inRollback(async () => {
      const sua = await foto({ tag: [FIGLIO_A] })
      await foto({ tag: [FRATELLO_A] })
      expect(await pagina(GEN_A, FIGLIO_A)).toEqual({ ids: [sua], totale: 1 })
    })
  })

  prova('una foto della sezione A non arriva alla famiglia della sezione B', async () => {
    await inRollback(async () => {
      const diA = await foto({ target: [SEZ_A] })
      expect(await pagina(GEN_A, FIGLIO_A)).toEqual({ ids: [diA], totale: 1 })
      expect(await pagina(GEN_B, FIGLIO_B)).toEqual({ ids: [null], totale: 0 })
    })
  })

  prova('il figlio di un altro non si legge passando il suo id', async () => {
    await inRollback(async () => {
      await foto({ tag: [FIGLIO_A] })
      expect(await pagina(GEN_B, FIGLIO_A)).toEqual({ ids: [null], totale: 0 })
    })
  })

  prova('un figlio ritirato non dà più niente', async () => {
    await inRollback(async () => {
      await foto({ tag: [FIGLIO_RITIRATO], il: '2026-09-20T12:00:00+02:00' })
      expect(await pagina(GEN_RITIRATO, FIGLIO_RITIRATO)).toEqual({ ids: [null], totale: 0 })
    })
  })

  prova('una famiglia nuova vede dal giorno d’ingresso, non prima', async () => {
    await inRollback(async () => {
      await foto({ tag: [FIGLIO_NUOVO], il: '2026-10-05T12:00:00+02:00' })
      const dopo = await foto({ tag: [FIGLIO_NUOVO], il: '2026-10-12T12:00:00+02:00' })
      expect(await pagina(GEN_NUOVO, FIGLIO_NUOVO)).toEqual({ ids: [dopo], totale: 1 })
    })
  })

  prova('una foto nel cestino non c’è', async () => {
    await inRollback(async () => {
      await foto({ tag: [FIGLIO_A], eliminata: true })
      expect(await pagina(GEN_A, FIGLIO_A)).toEqual({ ids: [null], totale: 0 })
    })
  })

  prova('il filtro della data: estremi compresi', async () => {
    await inRollback(async () => {
      await foto({ tag: [FIGLIO_A], il: '2026-10-19T23:59:59Z' })
      const primo = await foto({ tag: [FIGLIO_A], il: '2026-10-20T00:00:00Z' })
      const ultimo = await foto({ tag: [FIGLIO_A], il: '2026-10-20T23:59:59.999Z' })
      await foto({ tag: [FIGLIO_A], il: '2026-10-21T00:00:00Z' })
      expect(await pagina(GEN_A, FIGLIO_A, { dal: '2026-10-20T00:00:00.000Z', al: '2026-10-20T23:59:59.999Z' }))
        .toEqual({ ids: [ultimo, primo], totale: 2 })
    })
  })

  prova('mai più di cento id, anche se ne chiede di più', async () => {
    await inRollback(async () => {
      await db.query(
        `INSERT INTO public.galleria_media_v2 (scuola_id, tag_students, created_at)
         SELECT $1, ARRAY[$2]::uuid[], TIMESTAMPTZ '2026-10-20 12:00+02' + (n || ' minutes')::interval FROM generate_series(1, 120) n`,
        [SEDE, FIGLIO_A])
      const r = await pagina(GEN_A, FIGLIO_A, { limit: 5000 })
      expect(r.ids).toHaveLength(100)
      expect(r.totale).toBe(120)
    })
  })

  describe('chi può chiamarla', () => {
    const CHIAMATA = `SELECT * FROM public.galleria_pagina_genitore($1, $2)`
    const comeRuolo = (ruolo: string) => db.exec(`SET LOCAL ROLE ${ruolo}`)

    prova('authenticated e anon no', async () => {
      await inRollback(async () => {
        await comeRuolo('authenticated')
        expect(await codiceErrore(CHIAMATA, [GEN_A, FIGLIO_A])).toBe('42501')
      })
      await inRollback(async () => {
        await comeRuolo('anon')
        expect(await codiceErrore(CHIAMATA, [GEN_A, FIGLIO_A])).toBe('42501')
      })
    })

    prova('service_role sì', async () => {
      await inRollback(async () => {
        await comeRuolo('service_role')
        expect(await codiceErrore(CHIAMATA, [GEN_A, FIGLIO_A])).toBe('nessun-errore')
      })
    })
  })
})
