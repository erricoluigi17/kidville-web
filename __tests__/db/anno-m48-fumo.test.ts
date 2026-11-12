import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  BAMBINI, BAMBINI_SIM, SEDE_E2E, SEDE_SIM, creaBancoPassaggio, una, type BancoPassaggio,
} from '../helpers/passaggio-banco'

/**
 * COMPITO 4.8.0 · test di fumo dello scheletro della PR 4.8: le tre testate di migrazione si applicano nell'ordine a, c, b, il banco
 * del passaggio parte e la sua popolazione copre i casi che i compiti successivi daranno per scontati. Nessuna logica da provare:
 * la riempiono i compiti 4.8.1, 4.8.2 e 4.8.7, che portano le loro prove.
 *
 * Solo uuid finti. Nessuna data del 2027 scritta qui: il giorno del passaggio è letto dal database.
 */

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')
const SUFFISSI_IN_ORDINE = [
  '_anno_passaggio_anteprima.sql', // M48a
  '_anno_passaggio_didattica.sql', // M48c
  '_anno_passaggio_conferma.sql', // M48b
]

let b: BancoPassaggio
beforeAll(async () => {
  b = await creaBancoPassaggio()
}, 180_000)
afterAll(async () => {
  await b?.db.close()
})

describe('le tre testate della PR 4.8', () => {
  it('hanno le version in ordine a < c < b, tutte dopo l’ultima migrazione della 4.5', () => {
    const file = readdirSync(CARTELLA)
    const version = SUFFISSI_IN_ORDINE.map((s) => {
      const trovati = file.filter((f) => f.endsWith(s))
      expect(trovati, `${s}: file trovati ${trovati.length}`).toHaveLength(1)
      return trovati[0].slice(0, 14)
    })
    expect(version.length).toBe(3)
    for (let i = 0; i < version.length; i++) {
      expect(version[i] > '20261109035223', `${version[i]} deve seguire la 4.5`).toBe(true)
      if (i > 0) expect(version[i] > version[i - 1], `${version[i - 1]} < ${version[i]}`).toBe(true)
    }
  })

  it('si applicano nell’ordine a, c, b e il banco parte', async () => {
    expect(await una<number>(b.db, `SELECT count(*)::int FROM public.anni_sede`)).toBeGreaterThan(0)
  })
})

describe('il banco del passaggio', () => {
  it('le due sedi di prova sono ammesse a un giorno diverso da oggi, la terza no', async () => {
    const ammesse = await una<string[]>(b.db, `SELECT sedi_simulazione::text[] FROM public.anno_regole`)
    expect(ammesse).toEqual([SEDE_SIM])
    expect(SEDE_E2E.startsWith('e2e00000')).toBe(true)
  })

  it('l’anno vecchio è corrente, il nuovo ha le iscrizioni aperte, e il giorno del passaggio viene dal database', async () => {
    const r = await b.db.query<{ id: string; stato: string }>(`SELECT id, stato FROM public.anni_sede WHERE id = ANY ($1::uuid[])`, [[b.da, b.a]])
    const stato = Object.fromEntries(r.rows.map((x) => [x.id, x.stato]))
    expect(stato[b.da]).toBe('corrente')
    expect(stato[b.a]).toBe('iscrizioni_aperte')
    const ultimo = await una<string>(b.db, `SELECT ultimo_giorno_aperto::text FROM public.anni_sede WHERE id = $1`, [b.da])
    expect(b.oggi > ultimo).toBe(true)
    expect(await una<number>(b.db, `SELECT ($1::date - $2::date)::int`, [b.oggi, ultimo])).toBe(1)
  })

  it('ha dodici bambini nella sede del passaggio e due nella sede di simulazione', async () => {
    expect(Object.keys(BAMBINI)).toHaveLength(12)
    expect(await una<number>(b.db, `SELECT count(*)::int FROM public.alunni WHERE scuola_id = $1`, [SEDE_E2E])).toBe(12)
    expect(await una<number>(b.db, `SELECT count(*)::int FROM public.alunni WHERE scuola_id = $1`, [SEDE_SIM])).toBe(Object.keys(BAMBINI_SIM).length)
  })

  it('i casi ci sono: continuazione, conferma con altra classe, nuova, «no», senza risposta, ritirato dalla tendina, ex alunno, cambio di grado', async () => {
    const f = async (id: string) =>
      (await b.db.query<{ anno_sede_id: string; stato: string; tipo: string | null; section_id: string | null; non_rinnova_il: string | null }>(
        `SELECT anno_sede_id, stato, tipo, section_id, non_rinnova_il::text FROM public.frequenze WHERE alunno_id = $1 ORDER BY data_ingresso`, [id])).rows
    const nuova = async (id: string) => (await f(id)).find((x) => x.anno_sede_id === b.a)
    const vecchia = async (id: string) => (await f(id)).find((x) => x.anno_sede_id === b.da)

    expect((await nuova(BAMBINI.continua))?.section_id).toBe(b.sezioni.girasoliNuova)
    expect((await nuova(BAMBINI.continuaB))?.section_id).toBe(b.sezioni.farfalleNuova)
    expect((await nuova(BAMBINI.continuaAltraSezione))?.section_id).toBe(b.sezioni.girasoliNuova)
    expect((await nuova(BAMBINI.nuova))?.tipo).toBe('nuova')
    expect(await vecchia(BAMBINI.nuova)).toBeUndefined()
    expect((await vecchia(BAMBINI.no))?.non_rinnova_il).not.toBeNull()
    expect(await nuova(BAMBINI.no)).toBeUndefined()
    expect(await nuova(BAMBINI.nonRisposto)).toBeUndefined()
    expect((await vecchia(BAMBINI.nonRisposto))?.stato).toMatch(/^(iscritto|in_attesa)$/)
    expect(await una<string>(b.db, `SELECT stato FROM public.alunni WHERE id = $1`, [BAMBINI.ritiratoTendina])).toBe('ritirato')
    expect((await nuova(BAMBINI.ritiratoTendina))?.stato).toBe('in_attesa')
    expect((await vecchia(BAMBINI.ritiratoArchiviato))?.stato).toBe('ritirato')
    expect(await nuova(BAMBINI.ritiratoArchiviato)).toBeUndefined()
    expect((await vecchia(BAMBINI.ritornato))?.stato).toBe('ritirato')
    expect((await nuova(BAMBINI.ritornato))?.tipo).toBe('nuova')
    expect(await una<string>(b.db, `SELECT stato FROM public.alunni WHERE id = $1`, [BAMBINI.ritornato])).toBe('in_arrivo')
    expect((await vecchia(BAMBINI.inArrivoConConferma))?.stato).toBe('ritirato')
    expect((await nuova(BAMBINI.inArrivoConConferma))?.tipo).toBe('conferma')
    expect(await una<string>(b.db, `SELECT stato FROM public.alunni WHERE id = $1`, [BAMBINI.inArrivoConConferma])).toBe('in_arrivo')
    expect((await nuova(BAMBINI.cambiaGradoConSezione))?.section_id).toBe(b.sezioni.primaria)
    expect((await nuova(BAMBINI.cambiaGradoSenzaSezione))?.section_id).toBeNull()
  })

  it('le classi nuove sono le continuazioni di quelle vecchie, e la terza dell’infanzia non ne ha', async () => {
    const r = await b.db.query<{ id: string; continua_da: string | null }>(
      `SELECT id, continua_da FROM public.sections WHERE scuola_id = $1 AND anno_id = $2`, [SEDE_E2E, b.annoA])
    const daId = Object.fromEntries(r.rows.map((x) => [x.id, x.continua_da]))
    expect(daId[b.sezioni.girasoliNuova]).toBe(b.sezioni.girasoli)
    expect(daId[b.sezioni.farfalleNuova]).toBe(b.sezioni.farfalle)
    expect(r.rows.some((x) => x.continua_da === b.sezioni.stelline)).toBe(false)
  })

  it('c’è una riga per sede nella tabella dei passaggi? No: il banco parte senza nessun passaggio', async () => {
    expect(await una<number>(b.db, `SELECT count(*)::int FROM public.passaggi_anno`)).toBe(0)
  })

  it('le cinque tabelle della didattica ci sono, vuote', async () => {
    for (const t of ['materie', 'campanelle', 'orario_settimanale', 'tempo_scuola', 'sezione_materia_obiettivo']) {
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.${t}`), t).toBe(0)
    }
  })
})
