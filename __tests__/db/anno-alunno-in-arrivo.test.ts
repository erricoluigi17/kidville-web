import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import {
  creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_GALLERIA_GENITORE, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.5.4 · IL BAMBINO CHE ARRIVA L'ANNO PROSSIMO (migrazione M45b).
 *
 * Un bambino la cui domanda è per l'anno dopo esiste in `alunni` con lo stato `in_arrivo`: nessuna sezione, nessuna
 * frequenza dell'anno attivo. Qui si prova, su PGlite vero e con la migrazione letta dal disco:
 *  · il CHECK `alunni_stato_ammesso` ammette `in_arrivo` e continua a respingere il resto;
 *  · lo specchio `alunni` → `frequenze` salta l'`in_arrivo` e continua a funzionare per tutti gli altri;
 *  · l'invariante 11-bis non conta un `in_arrivo`, la 11-ter lo conta se non ha l'arrivo;
 *  · il riallineamento dalla frequenza lo porta a `iscritto` (è ciò che farà il passaggio, 4.8) e un oblio non rivive;
 *  · A → B → A: la prova che DECIDE la correzione di `data_ingresso`;
 *  · un `in_arrivo` non conta fra i figli attivi, ma il genitore vede la voce della sua quota.
 *
 * Banco: la catena fino a M45e sul banco minimo, con `alunni.stato` e il CHECK di oggi (`SCHEMA_ISCRIZIONE_ANNO`). Il banco non
 * si tocca: `alunni.anonimizzato_il` si aggiunge qui. Ogni prova gira in una transazione che finisce in `ROLLBACK`. Le date sono
 * RELATIVE al giorno della transazione: `now()` è fisso dentro una transazione, e l'anno attivo si allarga attorno a oggi
 * (`giorni()`), così la prova dice la stessa cosa a qualunque data la si lanci. Solo uuid finti.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '33333333-3333-4333-8333-333333333333'
const AL = '11111111-1111-4111-8111-111111111111'
const AL2 = '11111111-1111-4111-8111-111111111112'
const GEN = '77777777-7777-4777-8777-777777777771'
const CARTELLA = join(process.cwd(), 'supabase', 'migrations')

let db: PGlite
const ANNO_SEDE: Record<string, string> = {} // `${sede}:${anno_inizio}`

const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 30_000)
async function inRollback(fn: () => Promise<void>) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}
async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function righe<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows
}

/** Oggi secondo il database; l'anno attivo di S1 e di S2 si allarga attorno a oggi. Va chiamata DENTRO `inRollback`. */
async function giorni(): Promise<{ oggi: string }> {
  await db.query(
    `UPDATE public.anni_sede
        SET inizio = least(inizio, public.giorno_roma(now()) - 40), fine = greatest(fine, public.giorno_roma(now()) + 40)
      WHERE id = ANY ($1::uuid[])`, [[ANNO_SEDE[`${S1}:2026`], ANNO_SEDE[`${S2}:2026`]]])
  return { oggi: await una<string>(`SELECT public.giorno_roma(now())::text`) }
}
async function giornoRelativo(oggi: string, delta: number): Promise<string> {
  return una<string>(`SELECT ($1::date + $2::int)::text`, [oggi, delta])
}
async function nuovoAlunno(id: string, stato: string, sede = S1) {
  await db.query(`INSERT INTO public.alunni (id, scuola_id, stato) VALUES ($1, $2, $3)`, [id, sede, stato])
}
async function frequenzeDi(id: string): Promise<Array<Record<string, unknown>>> {
  return righe(`SELECT to_jsonb(f) AS f FROM public.frequenze f WHERE f.alunno_id = $1 ORDER BY f.data_ingresso`, [id])
    .then((r) => r.map((x) => (x as unknown as { f: Record<string, unknown> }).f))
}
async function statoDi(id: string): Promise<string> {
  return una<string>(`SELECT stato FROM public.alunni WHERE id = $1`, [id])
}
async function invariante(nome: string, tabella: string): Promise<number> {
  return Number(await una<string>(
    `SELECT righe::text FROM public.anno_invarianti() WHERE invariante = $1 AND tabella = $2`, [nome, tabella]))
}
/** Una frequenza «come la scrive la 4.5»: di un anno non attivo, in attesa, senza moduli né quota (origine `recupero`, la prova non deve passare dai CHECK dei moduli). */
async function frequenzaDelFuturo(alunno: string, sede: string, annoInizio: number) {
  await db.query(
    `INSERT INTO public.frequenze (alunno_id, anno_sede_id, anno_id, scuola_id, origine, stato, data_ingresso)
     SELECT $1, s.id, s.anno_id, s.scuola_id, 'recupero', 'in_attesa', s.inizio FROM public.anni_sede s WHERE s.id = $2`,
    [alunno, ANNO_SEDE[`${sede}:${annoInizio}`]])
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [S1, S2], fino: 'M45e',
    codaPrima: SCHEMA_GALLERIA_GENITORE + SCHEMA_ISCRIZIONE_ANNO + 'ALTER TABLE public.alunni ADD COLUMN anonimizzato_il timestamptz;',
  })
  await db.exec(SCHEMA_LEGAMI_GENITORE)
  await db.exec(SCHEMA_AVVISI_CHAT_VOCI_GENITORE)
  const r = await db.query<{ scuola_id: string; anno_inizio: number; id: string }>(
    `SELECT s.scuola_id, y.anno_inizio, s.id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id`)
  for (const x of r.rows) ANNO_SEDE[`${x.scuola_id}:${x.anno_inizio}`] = x.id
}, 120_000)
afterAll(async () => { await db?.close() })

describe('il CHECK `alunni_stato_ammesso`', () => {
  prova('ammette `in_arrivo` e respinge ogni altro stato fuori elenco', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      expect(await statoDi(AL)).toBe('in_arrivo')
    })
    await inRollback(async () => {
      await expect(nuovoAlunno(AL, 'trasferito')).rejects.toThrow(/alunni_stato_ammesso/)
    })
  })

  prova('è riapplicabile: la seconda esecuzione della migrazione non rompe niente e il vincolo resta quello allargato', async () => {
    const sql = readFileSync(join(CARTELLA, readdirSync(CARTELLA).find((x) => x.endsWith('_anno_alunno_in_arrivo.sql'))!), 'utf8')
    await db.exec(sql)
    const def = await una<string>(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'alunni_stato_ammesso'`)
    expect(def).toContain('in_arrivo')
    expect(await una<boolean>(`SELECT convalidated FROM pg_constraint WHERE conname = 'alunni_stato_ammesso'`)).toBe(true)
  })
})

describe('lo specchio `alunni` → `frequenze`', () => {
  prova('un INSERT con stato `in_arrivo` non crea nessuna frequenza', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL, 'in_arrivo')
      expect(await frequenzeDi(AL)).toHaveLength(0)
    })
  })

  prova('con stato `iscritto` la crea, come oggi (nessuna regressione)', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL, 'iscritto')
      const f = await frequenzeDi(AL)
      expect(f).toHaveLength(1)
      expect(f[0].anno_sede_id).toBe(ANNO_SEDE[`${S1}:2026`])
      expect(f[0].origine).toBe('recupero')
    })
  })

  prova('un `in_arrivo` che cambia sede non riceve nemmeno allora la frequenza dell’anno attivo', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL, 'in_arrivo')
      await db.query(`UPDATE public.alunni SET scuola_id = $2 WHERE id = $1`, [AL, S2])
      expect(await frequenzeDi(AL)).toHaveLength(0)
    })
  })
})

describe('le invarianti 11-bis e 11-ter', () => {
  prova('11-bis non conta un `in_arrivo`; la sua 11-ter sì, finché non ha l’arrivo', async () => {
    await inRollback(async () => {
      await giorni()
      const prima = { bis: await invariante('11', 'alunni (senza frequenza)'), ter: await invariante('11', 'alunni (in arrivo senza arrivo)') }
      await nuovoAlunno(AL, 'in_arrivo')
      expect(await invariante('11', 'alunni (senza frequenza)')).toBe(prima.bis)
      expect(await invariante('11', 'alunni (in arrivo senza arrivo)')).toBe(prima.ter + 1)

      await frequenzaDelFuturo(AL, S1, 2027)
      expect(await invariante('11', 'alunni (in arrivo senza arrivo)')).toBe(prima.ter)
      expect(await invariante('11', 'alunni (senza frequenza)')).toBe(prima.bis)
    })
  })

  prova('PROVA DEL ROSSO: un alunno `iscritto` con una sede e senza frequenza fa salire la 11-bis, non la 11-ter', async () => {
    await inRollback(async () => {
      await giorni()
      const prima = { bis: await invariante('11', 'alunni (senza frequenza)'), ter: await invariante('11', 'alunni (in arrivo senza arrivo)') }
      await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
      await nuovoAlunno(AL, 'iscritto')
      await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = true`)
      expect(await frequenzeDi(AL)).toHaveLength(0)
      expect(await invariante('11', 'alunni (senza frequenza)')).toBe(prima.bis + 1)
      expect(await invariante('11', 'alunni (in arrivo senza arrivo)')).toBe(prima.ter)
    })
  })

  prova('un `in_arrivo` la cui frequenza è nell’anno già corrente (il passaggio non ha girato) resta contato dalla 11-ter', async () => {
    await inRollback(async () => {
      await giorni()
      const prima = await invariante('11', 'alunni (in arrivo senza arrivo)')
      await nuovoAlunno(AL, 'in_arrivo')
      // il banco di prova ha l'anno 2027 `in_preparazione`: lo si porta a `corrente` come se il passaggio avesse cambiato l'anno ma
      // non lo stato dell'alunno. Prima si chiude il 2026, perché l'indice unico non ammette due anni correnti.
      await frequenzaDelFuturo(AL, S1, 2027)
      expect(await invariante('11', 'alunni (in arrivo senza arrivo)')).toBe(prima)
      await db.query(`UPDATE public.anni_sede SET stato = 'chiuso' WHERE id = $1`, [ANNO_SEDE[`${S1}:2026`]])
      await db.query(`UPDATE public.anni_sede SET stato = 'corrente' WHERE id = $1`, [ANNO_SEDE[`${S1}:2027`]])
      expect(await invariante('11', 'alunni (in arrivo senza arrivo)')).toBe(prima + 1)
    })
  })

  prova('l’ultima definizione di `anno_invarianti` è conservata: cambiano solo la 11-bis e la 11-ter (e una variabile)', async () => {
    const corpo = (file: string) => {
      const sql = readFileSync(join(CARTELLA, file), 'utf8')
      const da = sql.indexOf('CREATE OR REPLACE FUNCTION public.anno_invarianti()')
      expect(da, `${file}: manca la definizione`).toBeGreaterThan(-1)
      return sql.slice(da, sql.indexOf('\n$$;', da)).split('\n')
    }
    const vecchia = corpo('20261108170148_anno_visibilita_genitore_funzioni.sql')
    const nuova = corpo(readdirSync(CARTELLA).find((x) => x.endsWith('_anno_alunno_in_arrivo.sql'))!)
    const insiemeNuova = new Set(nuova)
    const insiemeVecchia = new Set(vecchia)
    const tolte = vecchia.filter((r) => !insiemeNuova.has(r))
    const aggiunte = nuova.filter((r) => !insiemeVecchia.has(r))
    // Le righe tolte sono tutte della vecchia 11-bis: nessuna riga delle altre invarianti (7, 8, 13…) è sparita.
    for (const r of tolte) {
      expect(r, `riga tolta fuori dalla 11-bis: ${r}`).toMatch(/11-bis|v_n := 0|anno_attivo|frequenze f|EXECUTE 'SELECT count|INTO v_n|BEGIN$|v_gen\s+record/)
    }
    // Il cuore delle altre invarianti c'è ancora: la riga 7 (copiare una definizione più vecchia l'avrebbe persa).
    expect(nuova.join('\n')).toContain("invariante := '7'; tabella := 'galleria_media_v2'")
    expect(nuova.join('\n')).toContain("invariante := '8'; tabella := 'utenti_sezioni'")
    expect(nuova.join('\n')).toContain("invariante := '13'; tabella := d.t")
    expect(aggiunte.join('\n')).toContain("alunni (in arrivo senza arrivo)")
    expect(tolte.length, 'le righe tolte sono poche e tutte della vecchia 11-bis').toBeLessThan(15)
  })
})

describe('il riallineamento dalla frequenza', () => {
  prova('`alunni_riallinea_da_frequenze` porta un `in_arrivo` a `iscritto` quando nasce la frequenza dell’anno attivo', async () => {
    await inRollback(async () => {
      const { oggi } = await giorni()
      await nuovoAlunno(AL, 'in_arrivo')
      expect(await statoDi(AL)).toBe('in_arrivo')
      await db.query(
        `INSERT INTO public.frequenze (alunno_id, anno_sede_id, anno_id, scuola_id, origine, stato, data_ingresso)
         SELECT $1, s.id, s.anno_id, s.scuola_id, 'recupero', 'iscritto', $3::date FROM public.anni_sede s WHERE s.id = $2`,
        [AL, ANNO_SEDE[`${S1}:2026`], oggi])
      expect(await statoDi(AL)).toBe('iscritto')
    })
  })

  prova('un oblio (`anonimizzato_il`) non rivive: la scheda anonimizzata resta `in_arrivo`', async () => {
    await inRollback(async () => {
      const { oggi } = await giorni()
      await nuovoAlunno(AL, 'in_arrivo')
      await db.query(`UPDATE public.alunni SET anonimizzato_il = now() WHERE id = $1`, [AL])
      await db.query(
        `INSERT INTO public.frequenze (alunno_id, anno_sede_id, anno_id, scuola_id, origine, stato, data_ingresso)
         SELECT $1, s.id, s.anno_id, s.scuola_id, 'recupero', 'iscritto', $3::date FROM public.anni_sede s WHERE s.id = $2`,
        [AL, ANNO_SEDE[`${S1}:2026`], oggi])
      expect(await statoDi(AL)).toBe('in_arrivo')
    })
  })
})

describe('A → B → A: la prova che decide la correzione di `data_ingresso`', () => {
  prova('al ritorno la frequenza di A non include il periodo passato in B: ingresso di oggi, nessuna foto del periodo in B', async () => {
    await inRollback(async () => {
      const { oggi } = await giorni()
      const d = (n: number) => giornoRelativo(oggi, n)
      await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [GEN, AL])
      // il bambino entra in A venti giorni fa (lo specchio ha scritto l'ingresso di oggi: lo si porta indietro)
      await nuovoAlunno(AL, 'iscritto', S1)
      await db.query(`UPDATE public.frequenze SET data_ingresso = $2::date WHERE alunno_id = $1`, [AL, await d(-20)])
      // passa in B; poi la timeline vera (le date che lo specchio scrive oggi sono quelle di oggi)
      await db.query(`UPDATE public.alunni SET scuola_id = $2 WHERE id = $1`, [AL, S2])
      await db.query(`UPDATE public.frequenze SET data_uscita = $3::date WHERE alunno_id = $1 AND anno_sede_id = $2`,
        [AL, ANNO_SEDE[`${S1}:2026`], await d(-10)])
      await db.query(`UPDATE public.frequenze SET data_ingresso = $3::date WHERE alunno_id = $1 AND anno_sede_id = $2`,
        [AL, ANNO_SEDE[`${S2}:2026`], await d(-9)])
      // e torna in A
      await db.query(`UPDATE public.alunni SET scuola_id = $2 WHERE id = $1`, [AL, S1])

      const fa = (await frequenzeDi(AL)).find((f) => f.anno_sede_id === ANNO_SEDE[`${S1}:2026`])!
      expect(fa.stato).toBe('iscritto')
      expect(fa.data_uscita).toBeNull()

      // due foto «per tutta la sede A»: una del periodo in cui il bambino era in B, una di oggi
      const foto = async (giorno: string) => una<string>(
        `INSERT INTO public.galleria_media_v2 (scuola_id, is_broadcast, giorno_competenza) VALUES ($1, true, $2::date) RETURNING id`, [S1, giorno])
      const durante = await foto(await d(-5))
      const oggiFoto = await foto(oggi)
      const viste = (await righe<{ media_id: string }>(`SELECT media_id FROM public.media_visibili_genitore($1)`, [GEN])).map((x) => x.media_id)

      // La frequenza riaperta comincia OGGI: la foto fatta mentre il bambino era in B non si vede, quella di oggi sì.
      expect(viste).toContain(oggiFoto)
      expect(viste).not.toContain(durante)
      expect(String(fa.data_ingresso)).toBe(oggi)
    })
  })
})

describe('i figli attivi e la voce della quota', () => {
  prova('un `in_arrivo` non conta fra i figli attivi, ma resta fra i figli collegati', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL, 'in_arrivo')
      await nuovoAlunno(AL2, 'iscritto')
      await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2), ($1, $3)`, [GEN, AL, AL2])
      const attivi = (await righe<{ alunno_id: string }>(`SELECT alunno_id FROM public.figli_attivi($1)`, [GEN])).map((x) => x.alunno_id)
      expect(attivi).toEqual([AL2])
      const collegati = await una<string[]>(`SELECT public.figli_collegati($1)`, [GEN])
      expect([...collegati].sort()).toEqual([AL, AL2].sort())
    })
  })

  prova('un genitore il cui solo figlio è `in_arrivo` non ha figli attivi, e vede la voce della quota', async () => {
    await inRollback(async () => {
      const { oggi } = await giorni()
      await nuovoAlunno(AL, 'in_arrivo')
      await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [GEN, AL])
      const voce = await una<string>(
        `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, visibile_dal)
         VALUES ($1, $2, 'Iscrizione di prova', 100, $3::date, $3::date) RETURNING id`, [AL, S1, oggi])
      expect(await righe(`SELECT alunno_id FROM public.figli_attivi($1)`, [GEN])).toHaveLength(0)
      const viste = (await righe<{ voce_id: string }>(`SELECT voce_id FROM public.voci_visibili_genitore($1)`, [GEN])).map((x) => x.voce_id)
      expect(viste).toContain(voce)
    })
  })
})

describe('la fotografia `anno_fotografa`', () => {
  /** Quanti alunni di S1 la fotografia conta «senza frequenza nell'anno attivo». Va chiamata DENTRO `inRollback`. */
  async function senzaFrequenza(): Promise<number> {
    await db.query(`SELECT public.anno_fotografa('prima', ARRAY['alunni'])`)
    return Number(await una<string>(
      `SELECT coalesce(sum(valore), 0)::text FROM public.riconciliazione_anno
        WHERE tabella = 'alunni' AND voce = 'alunni_senza_frequenza' AND scuola_id = $1
          AND transazione = txid_current() AND id = (SELECT max(id) FROM public.riconciliazione_anno WHERE voce = 'alunni_senza_frequenza' AND scuola_id = $1)`,
      [S1]))
  }

  prova('un `in_arrivo` non è un alunno «senza frequenza»: il confronto prima/dopo del passaggio non lo conta', async () => {
    await inRollback(async () => {
      await giorni()
      const prima = await senzaFrequenza()
      await nuovoAlunno(AL, 'in_arrivo')
      expect(await senzaFrequenza()).toBe(prima)
    })
  })

  prova('PROVA DEL ROSSO: un `iscritto` con sede e senza frequenza lo fa salire di uno', async () => {
    await inRollback(async () => {
      await giorni()
      const prima = await senzaFrequenza()
      await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
      await nuovoAlunno(AL, 'iscritto')
      await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = true`)
      expect(await senzaFrequenza()).toBe(prima + 1)
    })
  })
})

describe('il CHECK `alunni_in_arrivo_senza_sezione`', () => {
  prova('un `in_arrivo` con una sezione non può esistere; senza sezione sì', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL, 'in_arrivo')
      const sez = await una<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Girasoli') RETURNING id`, [S1])
      await expect(db.query(`UPDATE public.alunni SET section_id = $2 WHERE id = $1`, [AL, sez])).rejects.toThrow(/alunni_in_arrivo_senza_sezione/)
    })
  })

  prova('è riapplicabile e convalidato', async () => {
    const sql = readFileSync(join(CARTELLA, readdirSync(CARTELLA).find((x) => x.endsWith('_anno_alunno_in_arrivo.sql'))!), 'utf8')
    await db.exec(sql)
    expect(await una<boolean>(`SELECT convalidated FROM pg_constraint WHERE conname = 'alunni_in_arrivo_senza_sezione'`)).toBe(true)
  })
})
