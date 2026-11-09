import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnno } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.5.10 · LA SPUNTA DEI MODULI, SUL DATABASE VERO (PGlite).
 *
 * La route `PUT /api/admin/frequenze/[frequenzaId]/moduli` non scrive mai `moduli_completi`, `quota_saldata` e `stato`: inserisce o toglie una
 * riga di `frequenze_moduli` e rilegge. Qui si prova che le DUE istruzioni che la route manda — `INSERT … ON CONFLICT DO NOTHING` (è ciò che
 * PostgREST fa con `ignoreDuplicates`) e `DELETE` della coppia — bastino davvero: i trigger ricalcolano, e i rifiuti arrivano con il codice
 * che `erroreAnno` traduce in 422. Il test di route (`__tests__/api/anno-moduli-spunta.test.ts`) usa un finto che ne riproduce il contratto:
 * questo è ciò che lo tiene onesto. Solo uuid finti, mai `now()` nelle date.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const SEDE_B = '22222222-2222-4222-8222-222222222223'
const UTENTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

let db: PGlite

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function errore(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) {
    const x = e as { code?: string; message?: string }
    return /^[A-Z_]+$/.test(x.message ?? '') ? x.message! : (x.code ?? 'senza-codice')
  }
  return 'nessun-errore'
}
async function annoSedeAttivo(sede = SEDE): Promise<{ id: string; inizio: string }> {
  const r = await db.query<{ id: string; inizio: string }>(`SELECT id, inizio::text FROM public.anni_sede WHERE id = public.anno_attivo($1)`, [sede])
  return r.rows[0]
}
async function freq(tipo: 'nuova' | 'conferma' = 'nuova', annoSede?: string): Promise<string> {
  const as = await annoSedeAttivo()
  const alunno = await una<string>(`INSERT INTO public.alunni (scuola_id) VALUES ($1) RETURNING id`, [SEDE])
  return una<string>(
    `INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, data_ingresso) VALUES ($1, $2, $3, 'segreteria', $4) RETURNING id`,
    [alunno, annoSede ?? as.id, tipo, as.inizio])
}
async function modulo(lista: 'conferma' | 'nuova', codice: string, annoSede?: string): Promise<string> {
  return una<string>(
    `INSERT INTO public.moduli_richiesti (anno_sede_id, lista, codice, titolo) VALUES ($1, $2, $3, 'Modulo di prova') RETURNING id`,
    [annoSede ?? (await annoSedeAttivo()).id, lista, codice])
}
async function leggi(id: string) {
  const r = await db.query<{ stato: string; moduli_completi: boolean; quota_saldata: boolean }>(
    `SELECT stato, moduli_completi, quota_saldata FROM public.frequenze WHERE id = $1`, [id])
  return r.rows[0]
}
/** L'istruzione di `PUT … { spuntato: true }`: PostgREST con `ignoreDuplicates` manda un INSERT … ON CONFLICT DO NOTHING. */
const spunta = (f: string, m: string) =>
  db.query(`INSERT INTO public.frequenze_moduli (frequenza_id, modulo_id, spuntato_da) VALUES ($1, $2, $3) ON CONFLICT (frequenza_id, modulo_id) DO NOTHING`, [f, m, UTENTE])
/** L'istruzione di `PUT … { spuntato: false }`. */
const togli = (f: string, m: string) => db.query(`DELETE FROM public.frequenze_moduli WHERE frequenza_id = $1 AND modulo_id = $2`, [f, m])
async function quotaPagata(f: string, stato = 'pagato'): Promise<void> {
  const p = await una<string>(
    `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza, stato) VALUES ($1, 'Quota di prova', 100, '2027-03-01', $2) RETURNING id`, [SEDE, stato])
  await db.query(`UPDATE public.frequenze SET quota_pagamento_id = $2 WHERE id = $1`, [f, p])
}

beforeAll(async () => {
  db = await creaDbAnno()
  await db.query(`INSERT INTO public.schools (id, nome) VALUES ($1, 'Sede A'), ($2, 'Sede B')`, [SEDE, SEDE_B])
}, 60_000)
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await db.exec(`TRUNCATE public.frequenze, public.moduli_richiesti, public.pagamenti, public.alunni, public.app_log CASCADE`)
})

describe('la spunta con le istruzioni della route', () => {
  it('spuntati tutti i moduli e quota pagata → `iscritto`, e i flag li ha calcolati il database', async () => {
    const f = await freq()
    const m1 = await modulo('nuova', 'privacy')
    const m2 = await modulo('nuova', 'regolamento')
    await quotaPagata(f)
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: false, quota_saldata: true })
    await spunta(f, m1)
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: false })
    await spunta(f, m2)
    expect(await leggi(f)).toMatchObject({ stato: 'iscritto', moduli_completi: true, quota_saldata: true })
  })

  it('spuntati tutti i moduli ma quota NON pagata → resta `in_attesa`', async () => {
    const f = await freq()
    const m = await modulo('nuova', 'privacy')
    await spunta(f, m)
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: true, quota_saldata: false })
  })

  it('togliere una spunta riporta `in_attesa` chi era `iscritto`', async () => {
    const f = await freq()
    const m1 = await modulo('nuova', 'privacy')
    const m2 = await modulo('nuova', 'regolamento')
    await quotaPagata(f)
    await spunta(f, m1)
    await spunta(f, m2)
    expect((await leggi(f)).stato).toBe('iscritto')
    await togli(f, m2)
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: false, quota_saldata: true })
  })

  it('un modulo AGGIUNTO dopo riporta `in_attesa` chi non l’ha', async () => {
    const f = await freq()
    const m1 = await modulo('nuova', 'privacy')
    await quotaPagata(f)
    await spunta(f, m1)
    expect((await leggi(f)).stato).toBe('iscritto')
    await modulo('nuova', 'nuovo-modulo')
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: false })
  })

  it('un modulo di un’ALTRA lista → MODULO_NON_RICHIESTO, anche con ON CONFLICT DO NOTHING', async () => {
    const f = await freq('nuova')
    const mConferma = await modulo('conferma', 'patto')
    expect(await errore(spunta(f, mConferma))).toBe('MODULO_NON_RICHIESTO')
    expect(await una<number>(`SELECT count(*)::int FROM public.frequenze_moduli`)).toBe(0)
  })

  it('un modulo di un altro anno_sede → ANNO_NON_COERENTE', async () => {
    const f = await freq()
    const asB = await annoSedeAttivo(SEDE_B)
    const mAltraSede = await modulo('nuova', 'privacy', asB.id)
    expect(await errore(spunta(f, mAltraSede))).toBe('ANNO_NON_COERENTE')
  })

  it('spuntare due volte non dà errore, lascia una riga sola e NON cambia la data della prima spunta', async () => {
    const f = await freq()
    const m = await modulo('nuova', 'privacy')
    await spunta(f, m)
    await db.query(`UPDATE public.frequenze_moduli SET spuntato_il = '2027-01-01T10:00:00Z'`)
    await spunta(f, m)
    expect(await una<number>(`SELECT count(*)::int FROM public.frequenze_moduli`)).toBe(1)
    expect(await una<string>(`SELECT spuntato_il::text FROM public.frequenze_moduli`)).toContain('2027-01-01')
    expect(await una<string>(`SELECT spuntato_da::text FROM public.frequenze_moduli`)).toBe(UTENTE)
  })

  it('togliere una spunta che non c’è non dà errore e non cambia niente', async () => {
    const f = await freq()
    const m = await modulo('nuova', 'privacy')
    await expect(togli(f, m)).resolves.toBeTruthy()
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: false })
  })

  it('togliere cancella SOLO la coppia nominata', async () => {
    const f1 = await freq()
    const f2 = await freq()
    const m = await modulo('nuova', 'privacy')
    await spunta(f1, m)
    await spunta(f2, m)
    await togli(f1, m)
    expect(await una<string>(`SELECT frequenza_id::text FROM public.frequenze_moduli`)).toBe(f2)
  })
})
