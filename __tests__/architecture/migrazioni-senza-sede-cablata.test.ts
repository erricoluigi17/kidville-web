import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK — nessuna NUOVA migrazione configura il prodotto per uuid di sede cablato
//
// A4. `20260718400000_pagamenti_solleciti_cron.sql` accende i solleciti con
// `WHERE scuola_id = '<uuid di Kidville Giugliano>'`. Il cron però è globale: la
// route seleziona le sedi con `solleciti_config.enabled`. Risultato: una sede
// nuova (Aversa, Cesa) non eredita nulla e nessuno se ne accorge — la funzione
// semplicemente non parte, e «nessun sollecito» somiglia moltissimo a «nessun
// moroso».
//
// La regola: la configurazione si applica per INSIEME (tutte le sedi, o quelle che
// soddisfano una condizione) oppure entra nel provisioning
// (`provisiona_sede`, 20260729120000). Mai per uuid scritto a mano: quello vale
// per la sede di oggi e per nessuna di domani.
//
// Restano ammessi gli uuid nei COMMENTI troncati (es. 'd53b0fbc-…') e nei file in
// ALLOWLIST, che sono storia già applicata e non si riscrive.
// ─────────────────────────────────────────────────────────────────────────────

/** L'unica sede di produzione: PRD §Sedi — Kidville Giugliano. */
const SEDE_PROD = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'

// Migrazioni PRE-ESISTENTI che cablano l'uuid. Sono già applicate in produzione e
// non si modificano (le migrazioni sono immutabili): l'una-tantum di dati che
// contengono è storia. NON aggiungere qui una migrazione NUOVA per aggirare il
// lock — si scrive un UPDATE per insieme, o si mette il default nel provisioning.
const ALLOWLIST = new Set<string>([
  // Backfill una-tantum di galleria.scuola_id sulle foto già caricate.
  '20260714103000_galleria_scuola_id.sql',
  // Accensione dei solleciti sulla sola Giugliano: È IL DIFETTO corretto da
  // 20260729121000_solleciti_config_tutte_le_sedi.sql.
  '20260718400000_pagamenti_solleciti_cron.sql',
])

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

describe('lock architettura · migrazioni senza uuid di sede cablato', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()

  it('la cartella delle migrazioni è leggibile (sanity)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const f of files) {
    if (ALLOWLIST.has(f)) continue
    it(`${f} non cabla l'uuid della sede di produzione`, () => {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
      expect(
        sql.includes(SEDE_PROD),
        `${f} contiene l'uuid di Kidville Giugliano. La configurazione va applicata per INSIEME ` +
          `(UPDATE su tutte le sedi / con una condizione) o inserita nel provisioning ` +
          `(public.provisiona_sede): con l'uuid cablato le sedi nuove — Aversa, Cesa — non ereditano nulla.`,
      ).toBe(false)
    })
  }
})
