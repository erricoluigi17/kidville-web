import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_AVVISI_CHAT_VOCI_GENITORE } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.5.0 · test di fumo dello scheletro della PR 4.5: le cinque testate di migrazione si applicano nell'ordine
 * a, b, d, c, e e il banco parte. Nessuna logica da provare: i compiti successivi riempiono le testate e portano le loro prove.
 * Controlla anche che lo schema di prova contenga ciò che i compiti 4.5.5-4.5.9 daranno per scontato.
 *
 * Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const CARTELLA = join(process.cwd(), 'supabase', 'migrations')
const SUFFISSI_IN_ORDINE = [
  '_anno_tick.sql', // M45a
  '_anno_alunno_in_arrivo.sql', // M45b
  '_anno_listino_moduli_sezioni.sql', // M45d
  '_anno_iscrizione_conferma.sql', // M45c
  '_anno_crm_anno_id.sql', // M45e
]

let db: PGlite

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M45e', completo: true, codaPrima: SCHEMA_ISCRIZIONE_ANNO })
  // `pagamenti_quote` (con le colonne che la voce della quota userà) si crea dopo, come fanno i test della 4.4.
  await db.exec(SCHEMA_AVVISI_CHAT_VOCI_GENITORE)
}, 120_000)
afterAll(async () => {
  await db?.close()
})

async function esiste(tabella: string): Promise<boolean> {
  const r = await db.query<{ t: string | null }>(`SELECT to_regclass($1)::text t`, [tabella])
  return r.rows[0].t !== null
}
async function colonne(tabella: string): Promise<string[]> {
  const r = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [tabella])
  return r.rows.map((x) => x.column_name)
}

describe('le cinque testate della PR 4.5', () => {
  it('esistono e hanno le version in ordine a < b < d < c < e, tutte dopo l’ultima migrazione della 4.4', () => {
    const file = readdirSync(CARTELLA)
    const version = SUFFISSI_IN_ORDINE.map((s) => {
      const trovati = file.filter((f) => f.endsWith(s))
      expect(trovati, `${s}: file trovati ${trovati.length}`).toHaveLength(1)
      return trovati[0].slice(0, 14)
    })
    expect(version.length).toBe(5)
    for (let i = 0; i < version.length; i++) {
      expect(version[i] > '20261108221856', `${version[i]} deve seguire la 4.4`).toBe(true)
      if (i > 0) expect(version[i] > version[i - 1], `${version[i - 1]} < ${version[i]}`).toBe(true)
    }
  })

  it('si applicano nell’ordine a, b, d, c, e e il banco parte', async () => {
    const r = await db.query<{ n: string }>(`SELECT count(*)::text n FROM public.anni_sede`)
    expect(Number(r.rows[0].n)).toBeGreaterThan(0)
  })
})

describe('lo schema di prova ha ciò che i compiti 4.5.5-4.5.9 daranno per scontato', () => {
  it.each(['public.pagamenti', 'public.payment_categories', 'public.pagamenti_quote', 'public.sections',
    'public.alunni', 'public.student_documents', 'public.app_log', 'public.listino_voci', 'public.frequenze'])(
    'esiste %s', async (t) => {
      expect(await esiste(t), t).toBe(true)
    })

  it('sections ha fascia e continua_da; alunni ha stato', async () => {
    expect(await colonne('sections')).toEqual(expect.arrayContaining(['fascia', 'continua_da']))
    expect(await colonne('alunni')).toContain('stato')
  })

  it('payment_categories ha la categoria di sistema «iscrizione»', async () => {
    const r = await db.query<{ n: string }>(`SELECT count(*)::text n FROM public.payment_categories WHERE lower(nome) = 'iscrizione'`)
    expect(Number(r.rows[0].n)).toBeGreaterThanOrEqual(1)
  })

  it('app_log ha un indice unico su (fingerprint, giorno)', async () => {
    const r = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'app_log' AND indexdef ILIKE '%unique%'`)
    expect(r.rows.some((x) => /fingerprint/.test(x.indexdef) && /giorno/.test(x.indexdef)), 'indice unico su fingerprint, giorno').toBe(true)
  })

  it('c’è uno schema `cron` finto con `schedule`', async () => {
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'cron' AND p.proname = 'schedule'`)
    expect(Number(r.rows[0].n)).toBeGreaterThanOrEqual(1)
  })
})
