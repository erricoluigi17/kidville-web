import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Aiuti per i test che ESEGUONO il SQL delle migrazioni su un Postgres vero (PGlite): leggono la migrazione dal
 * suo file invece di riscriverla, e ne ritagliano una funzione. Non è un test (non finisce in `*.test.ts`).
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')

/** Il testo della migrazione il cui nome finisce per `suffisso` (`_report_cassa_aggregato.sql`). */
export function migrazione(suffisso: string): string {
  const file = readdirSync(CARTELLA).find((nome) => nome.endsWith(suffisso))
  if (!file) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, file), 'utf8')
}

/** I commenti `-- …` tolti: un lock che cerca una stringa non deve trovarla nel commento che la spiega. */
export function senzaCommentiSql(testo: string): string {
  return testo.replace(/--.*$/gm, '')
}

/**
 * `CREATE OR REPLACE FUNCTION public.<nome>(` fino al `$$;` che chiude il corpo. Le funzioni di queste
 * migrazioni usano un solo livello di `$$`.
 */
export function funzione(testo: string, nome: string): string {
  const inizio = testo.indexOf(`CREATE OR REPLACE FUNCTION public.${nome}(`)
  if (inizio < 0) throw new Error(`funzione ${nome} non trovata`)
  const apertura = /\bAS \$\$/.exec(testo.slice(inizio))
  if (!apertura) throw new Error(`corpo di ${nome} non trovato`)
  const dopoApertura = inizio + apertura.index + apertura[0].length
  const chiusura = testo.indexOf('$$', dopoApertura)
  if (chiusura < 0) throw new Error(`chiusura di ${nome} non trovata`)
  return testo.slice(inizio, testo.indexOf(';', chiusura) + 1)
}

/** I `REVOKE`/`GRANT` di quella funzione, nell'ordine in cui compaiono. */
export function permessi(testo: string, nome: string): string {
  const cerca = new RegExp(`^(?:REVOKE|GRANT)[^;]*FUNCTION public\\.${nome}\\([^;]*;`, 'gm')
  return (testo.match(cerca) ?? []).join('\n')
}

/** La funzione con i suoi permessi: ciò che serve per installarla (o riscriverla) in un database di prova. */
export function funzioneConPermessi(testo: string, nome: string): string {
  return `${funzione(testo, nome)}\n${permessi(testo, nome)}`
}
