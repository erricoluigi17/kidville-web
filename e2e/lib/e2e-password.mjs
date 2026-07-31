/**
 * Password dei 4 account del seed E2E (`*.e2e@kidville.test`) — MAI nel repo.
 *
 * PERCHÉ. Fino al 2026-07-31 era un letterale scritto in `scripts/seed-e2e.mjs`,
 * `e2e/fixtures.ts` e `docs/e2e.md`, con l'esenzione motivata «tanto è il database
 * della CI, non contiene dati reali». La frase era vera del DATABASE e falsa
 * dell'ACCOUNT: il 2026-07-29 il provisioning di Kidville Aversa e Kidville Cesa
 * ha collegato `admin.e2e@kidville.test` (ruolo `admin`) alle due sedi VERE, e per
 * due giorni quella riga di codice — in un repository PUBBLICO — è stata una
 * credenziale di Direzione valida in produzione. Gli account sono stati bannati e
 * il ponte rimosso; la password non torna in nessun file.
 *
 *   export KV_E2E_PASSWORD='…'   # dal gestore di credenziali del titolare
 *
 * In CI la variabile arriva dal secret GitHub `CI_E2E_PASSWORD` (workflow
 * `.github/workflows/ci.yml`, job `e2e`). Il seed la RIMPOSTA a ogni esecuzione
 * (`auth.admin.updateUserById`): cambiare il secret basta a ruotarla sul progetto
 * Supabase della CI, non serve toccare gli account a mano.
 *
 * Uso: `import { requireE2EPassword } from '<…>/e2e/lib/e2e-password.mjs'`.
 */

export const KV_E2E_PASSWORD = 'KV_E2E_PASSWORD'

/** Il messaggio è uno solo, così la variante `.ts` di `e2e/fixtures.ts` dice
 *  esattamente le stesse parole di questo script. */
export const MESSAGGIO_E2E_PASSWORD =
  `Manca la variabile d'ambiente ${KV_E2E_PASSWORD}: è la password dei 4 account del seed E2E ` +
  '(*.e2e@kidville.test) e NON è scritta nel repo. In locale prendila dal gestore di credenziali ' +
  `del titolare ed esportala prima di rilanciare:  export ${KV_E2E_PASSWORD}='…'  — in CI arriva ` +
  'dal secret GitHub CI_E2E_PASSWORD.'

/**
 * Ritorna la password del seed E2E, oppure termina il processo dicendo cosa
 * esportare. Nessun default e nessuna stringa vuota: con un default, un seed
 * lanciato senza variabile riscriverebbe le credenziali dei 4 account con un
 * valore noto a chiunque — che è precisamente il difetto da cui veniamo.
 *
 * @returns {string}
 */
export function requireE2EPassword() {
  const valore = (process.env[KV_E2E_PASSWORD] || '').trim()
  if (!valore) {
    console.error(`\n✗ ${MESSAGGIO_E2E_PASSWORD}\n`)
    process.exit(1)
  }
  return valore
}
