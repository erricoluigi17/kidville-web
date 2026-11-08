import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2, applicaPr2, SCHEMA_STUDENT_DOCUMENTS } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.2.M (1) · le schede sanitarie già firmate non scadono più («valgono fino a revoca»).
 *
 * La sezione della migrazione toglie `expiry_date` SOLO alle schede sanitarie con la scadenza standard
 * del 31/07/2027; altre scadenze e altri tipi di documento non si toccano. L'`UPDATE` deve passare con la guardia
 * dell'anno ACCESA (come in produzione dalla PR 3) su una riga creata nel 2026/27 (`corrente`).
 * `student_documents` entra nel banco (`codaPrima`) nella forma minima del baseline, PRIMA della migrazione, così il registro la vede.
 * Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const A1 = '44444444-4444-4444-8444-444444444441'
const A2 = '44444444-4444-4444-8444-444444444442'

let db: PGlite

async function scadenza(id: string): Promise<string | null> {
  const r = await db.query<{ e: string | null }>(`SELECT expiry_date::text e FROM public.student_documents WHERE id = $1`, [id])
  return r.rows[0].e
}
async function doc(tipo: string, scad: string | null, alunno = A1): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.student_documents (student_id, document_type, file_url, expiry_date, created_at)
     VALUES ($1, $2::public.document_type_enum, 'x', $3, TIMESTAMPTZ '2026-10-01 10:00:00+02') RETURNING id`, [alunno, tipo, scad])
  return r.rows[0].id
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M3', codaPrima: SCHEMA_STUDENT_DOCUMENTS })
  await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $3), ($2, $3)`, [A1, A2, SEDE])
}, 120_000)
afterAll(async () => { await db.close() })

describe('4.2.M · schede sanitarie senza scadenza', () => {
  it('con la guardia accesa: due schede con 31/07/2027 → NULL; altra scadenza e altro tipo restano', async () => {
    const s1 = await doc('scheda_sanitaria', '2027-07-31', A1)
    const s2 = await doc('scheda_sanitaria', '2027-07-31', A2)
    const altraScadenza = await doc('scheda_sanitaria', '2027-01-15')
    const altroTipo = await doc('pdp', '2027-07-31')
    const senza = await doc('scheda_sanitaria', null)
    await db.exec(`UPDATE public.anno_regole SET guardia_attiva = true, guardia_osserva = false`)
    const prima = await db.query<{ guardia_attiva: boolean }>(`SELECT guardia_attiva FROM public.anno_regole`)
    expect(prima.rows[0].guardia_attiva).toBe(true)

    await applicaPr2(db, 'M42')

    expect(await scadenza(s1)).toBeNull()
    expect(await scadenza(s2)).toBeNull()
    expect(await scadenza(altraScadenza)).toBe('2027-01-15')
    expect(await scadenza(altroTipo)).toBe('2027-07-31')
    expect(await scadenza(senza)).toBeNull()
  })
})
