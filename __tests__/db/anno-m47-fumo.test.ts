import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_AVVISI_CHAT_VOCI_GENITORE } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.7.0 · test di fumo dello scheletro della PR 4.7: la testata M47 si applica dopo le cinque della 4.5 e il banco parte.
 * Controlla anche che lo schema di prova contenga ciò che le due funzioni di lettura del cruscotto (4.7.1) leggeranno.
 *
 * Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const CARTELLA = join(process.cwd(), 'supabase', 'migrations')

let db: PGlite

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M47', completo: true, codaPrima: SCHEMA_ISCRIZIONE_ANNO })
  await db.exec(SCHEMA_AVVISI_CHAT_VOCI_GENITORE)
}, 120_000)
afterAll(async () => {
  await db?.close()
})

async function esiste(tabella: string): Promise<boolean> {
  const r = await db.query<{ t: string | null }>(`SELECT to_regclass($1)::text t`, [tabella])
  return r.rows[0].t !== null
}

describe('la testata M47', () => {
  it('esiste una volta sola e la sua version segue quella di M45e', () => {
    const file = readdirSync(CARTELLA)
    const m47 = file.filter((f) => f.endsWith('_anno_cruscotto.sql'))
    const m45e = file.filter((f) => f.endsWith('_anno_crm_anno_id.sql'))
    expect(m47, 'file M47').toHaveLength(1)
    expect(m45e, 'file M45e').toHaveLength(1)
    expect(m47[0].slice(0, 14) > m45e[0].slice(0, 14)).toBe(true)
  })

  it('si applica dopo le cinque della 4.5 e il banco parte', async () => {
    const r = await db.query<{ n: string }>(`SELECT count(*)::text n FROM public.anni_sede`)
    expect(Number(r.rows[0].n)).toBeGreaterThan(0)
  })
})

describe('lo schema di prova ha ciò che il cruscotto leggerà', () => {
  it.each([
    'public.pagamenti', 'public.payment_categories', 'public.listino_voci', 'public.posti_autorizzati', 'public.moduli_richiesti',
    'public.frequenze_moduli', 'public.sections', 'public.enrollment_submissions', 'public.frequenze', 'public.alunni', 'public.app_log',
  ])('esiste %s', async (t) => {
    expect(await esiste(t), t).toBe(true)
  })

  it('le funzioni della 4.5 su cui il cruscotto si appoggia ci sono', async () => {
    const r = await db.query<{ proname: string }>(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND proname IN ('anno_conta_posti', 'anno_quota_voce', 'anno_attivo', 'giorno_roma')`)
    expect(r.rows.map((x) => x.proname).sort()).toEqual(['anno_attivo', 'anno_conta_posti', 'anno_quota_voce', 'giorno_roma'])
  })
})
