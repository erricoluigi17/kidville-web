import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import {
  creaDbAnnoPr2, applicaPr2, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_LEGAMI_GENITORE, SCHEMA_RETTE, applicaServiziMensili,
} from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.6.0 · test di fumo dello scheletro della PR 4.6: le due testate (M46a, M46b) si applicano dopo la catena della 4.5 e
 * il banco delle rette parte. Nessuna logica da provare: i compiti 4.6.1 e 4.6.2 riempiono le testate e portano le loro prove.
 *
 * Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const CARTELLA = join(process.cwd(), 'supabase', 'migrations')
const SUFFISSI_IN_ORDINE = ['_anno_rette_dal_listino.sql', '_anno_listino_rette_scrittura.sql']

let db: PGlite

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M45e', completo: true, codaPrima: SCHEMA_ISCRIZIONE_ANNO })
  // Come fanno i test della 4.4: le tabelle dei legami e delle voci si creano dopo la catena, poi le rette e le due testate.
  await db.exec(SCHEMA_AVVISI_CHAT_VOCI_GENITORE)
  await db.exec(SCHEMA_LEGAMI_GENITORE)
  await db.exec(SCHEMA_RETTE)
  await applicaServiziMensili(db)
  await applicaPr2(db, 'M46a')
  await applicaPr2(db, 'M46b')
}, 120_000)
afterAll(async () => {
  await db?.close()
})

async function colonne(tabella: string): Promise<string[]> {
  const r = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [tabella])
  return r.rows.map((x) => x.column_name)
}

describe('le due testate della PR 4.6', () => {
  it('esistono, hanno la version in ordine e sono dopo la 4.5', () => {
    const file = readdirSync(CARTELLA)
    const versioni = SUFFISSI_IN_ORDINE.map((s) => {
      const f = file.find((x) => x.endsWith(s))
      expect(f, `manca *${s}`).toBeTruthy()
      return f!.slice(0, 14)
    })
    expect(versioni).toEqual([...versioni].sort())
    expect(new Set(versioni).size).toBe(versioni.length)
    expect(versioni[0] > '20261109035223', 'la prima testata deve stare dopo l’ultima della 4.5').toBe(true)
  })

  it('il banco delle rette ha le colonne che le funzioni leggeranno', async () => {
    expect(await colonne('alunni')).toEqual(expect.arrayContaining(['data_nascita', 'data_iscrizione', 'genitori_separati', 'stato']))
    expect(await colonne('admin_settings')).toEqual(expect.arrayContaining(['retta_giorno_scadenza', 'retta_giorno_visibilita', 'rette_config', 'retta_auto_enabled']))
    expect(await colonne('pagamenti')).toEqual(expect.arrayContaining(['sconto', 'sconto_motivo', 'gruppo', 'tipo', 'visibile_dal']))
    expect(await colonne('iscrizioni_servizi')).toEqual(expect.arrayContaining(['importo_mensile', 'dal', 'al']))
    expect(await colonne('sections')).toContain('fascia')
  })

  it('le funzioni dei servizi (che la 4.6.1 ridefinisce) ci sono già', async () => {
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_proc WHERE proname IN ('servizi_da_generare', 'genera_servizi_mensili', 'genera_servizi_anno')`)
    expect(Number(r.rows[0].n)).toBe(3)
  })
})
