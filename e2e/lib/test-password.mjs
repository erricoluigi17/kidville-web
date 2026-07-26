/**
 * Password comune degli account TEST (`test.*@kidville.test`) — MAI nel repo.
 *
 * Quegli account sono ATTIVI in produzione (sede Kidville Giugliano) e uno di essi ha
 * ruolo `segreteria`, cioè vede l'anagrafica dell'intera sede: la loro password è un
 * segreto vero. Fino al 2026-07-26 era scritta in chiaro in 9 file committati, con il
 * repository pubblico. È stata ruotata e non deve tornare in nessun file: la si passa
 * dall'ambiente, e chi non ce l'ha non deve poter proseguire "a metà".
 *
 *   export KV_TEST_PASSWORD='…'   # dal gestore di credenziali del titolare
 *
 * Uso: `import { requireTestPassword } from '<…>/e2e/lib/test-password.mjs'`.
 */

export const KV_TEST_PASSWORD = 'KV_TEST_PASSWORD'

/**
 * Ritorna la password degli account TEST, oppure termina il processo con un messaggio
 * che dice esattamente cosa esportare. Nessun default, nessuna stringa vuota: proseguire
 * senza password produrrebbe più avanti un fallimento di login incomprensibile.
 *
 * @returns {string}
 */
export function requireTestPassword() {
  const valore = (process.env[KV_TEST_PASSWORD] || '').trim()
  if (!valore) {
    console.error(
      `\n✗ Manca la variabile d'ambiente ${KV_TEST_PASSWORD}.\n` +
        `  È la password comune degli account TEST (test.*@kidville.test) e NON è scritta nel repo.\n` +
        `  Prendila dal gestore di credenziali del titolare ed esportala prima di rilanciare:\n\n` +
        `      export ${KV_TEST_PASSWORD}='…'\n`,
    )
    process.exit(1)
  }
  return valore
}
