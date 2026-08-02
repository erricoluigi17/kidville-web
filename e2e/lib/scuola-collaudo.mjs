/**
 * Sede su cui gira una campagna di collaudo — dall'AMBIENTE, mai dal repo.
 *
 * Le campagne `e2e/collaudo-giornata/**` ed `e2e/primaria-360/**` non girano sul
 * database della CI: girano su PRODUZIONE, sugli account `*.test` e sulle sezioni
 * TEST. Fino al 2026-07-31 la sede era l'uuid di Kidville Giugliano scritto in
 * quattro file, con il commento «unica sede di produzione». Dal 2026-07-29 le sedi
 * sono TRE: quella costante non dice più quale plesso si sta toccando, e uno script
 * di seed che sbaglia sede scrive account e dati di scena nel plesso di famiglie
 * vere — in silenzio, perché niente si rompe.
 *
 *   export KV_SCUOLA_ID='…'   # `select id, nome from scuole` sul progetto giusto
 *
 * Uso: `import { requireScuolaCollaudo } from '<…>/e2e/lib/scuola-collaudo.mjs'`.
 */

export const KV_SCUOLA_ID = 'KV_SCUOLA_ID'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Ritorna l'uuid della sede di collaudo, oppure termina il processo dicendo cosa
 * esportare. Nessun default: una campagna che «indovina» la sede è esattamente il
 * difetto che questo helper esiste per impedire.
 *
 * @returns {string}
 */
export function requireScuolaCollaudo() {
  const valore = (process.env[KV_SCUOLA_ID] || '').trim()
  if (!UUID_RE.test(valore)) {
    console.error(
      `\n✗ Manca (o non è un uuid) la variabile d'ambiente ${KV_SCUOLA_ID}.\n` +
        `  È la sede su cui gira la campagna di collaudo. Le sedi di produzione sono TRE\n` +
        `  (Giugliano, Aversa, Cesa): la sede si dichiara, non si eredita da una costante.\n` +
        `  Prendi l'uuid dal database — select id, nome from scuole — ed esportalo:\n\n` +
        `      export ${KV_SCUOLA_ID}='…'\n`,
    )
    process.exit(1)
  }
  return valore
}
