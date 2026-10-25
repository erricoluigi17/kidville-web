/**
 * Il timeout delle chiamate all'involucro dei cron — sessione 8 della seconda serie di robustezza.
 *
 * Dalla sessione 6 ogni funzione dei cron chiama il server con
 * `public.cron_http_post('<job>', url := …, headers := …, body := …[, timeout_milliseconds := N])`:
 * gli argomenti di `net.http_post`, quasi sempre per nome, col nome del job davanti
 * (`scripts/cron-esiti/involucro.mjs`). Qui:
 *  · il job è il primo argomento, un letterale fra apici;
 *  · il timeout è l'argomento nominato `timeout_milliseconds` DENTRO quella chiamata (`:=` o `=>`),
 *    e se manca vale il default dell'involucro, 5000 ms;
 *  · il percorso della route NON si legge: l'URL arriva dal Vault. Quale route chiama ogni funzione
 *    lo dice `CHIAMANTI_CRON` nel lock `__tests__/architecture/cron-max-duration.test.ts`.
 *
 * `conTimeout` cambia UNA cosa: il numero di `timeout_milliseconds`, o l'argomento aggiunto in fondo
 * alla chiamata se non c'era. Lo usano il lock e lo script che genera la migrazione, così ciò che il
 * lock controlla e ciò che lo script scrive non possono divergere. Su ogni forma che non conosce si
 * ferma con un messaggio: non indovina.
 */
import { contaChiamate, corpoDi, mascheraSql } from './involucro.mjs'

/** Il default di `timeout_milliseconds` in `public.cron_http_post`, lo stesso di `net.http_post`. */
export const TIMEOUT_PREDEFINITO_MS = 5000

const APRE = /\bpublic\s*\.\s*cron_http_post\s*\(/i
const JOB = /^\s*'([a-z0-9][a-z0-9-]*)'\s*,/
const NOMINATO = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(:=|=>)/
const NUMERO = /^(\s*)(\d+)\s*$/
/** `timeout_milliseconds` è il sesto argomento dell'involucro: il job, poi i cinque di `net.http_post`. */
const POSIZIONE_TIMEOUT = 6

/**
 * L'unica chiamata all'involucro nel corpo di una funzione: il job, il timeout che vale e dove si
 * trova. `corpo` è il testo fra `AS $tag$` e la sua chiusura; commenti e stringhe non contano.
 */
export function chiamataAllInvolucro(corpo) {
  const { dirette, avvolte } = contaChiamate(corpo)
  if (dirette > 0) throw new Error('chiama ancora `net.http_post` direttamente: passa da `cron_http_post`')
  if (avvolte !== 1) throw new Error(`attesa UNA chiamata a \`public.cron_http_post\`, trovate ${avvolte}`)
  // Due maschere della stessa lunghezza del corpo: senza stringhe né commenti per parentesi e virgole,
  // senza i soli commenti per leggere i valori e la fine dell'ultimo argomento.
  const codice = mascheraSql(corpo)
  const soloCodice = mascheraSql(corpo, { stringhe: false })
  const m = APRE.exec(codice)
  const da = m.index + m[0].length
  const virgole = []
  let profondita = 0
  let a = -1
  for (let i = da; i < codice.length && a < 0; i++) {
    if (codice[i] === '(') profondita++
    else if (codice[i] === ')') {
      if (profondita === 0) a = i
      else profondita--
    } else if (codice[i] === ',' && profondita === 0) virgole.push(i)
  }
  if (a < 0) throw new Error('la chiamata a `cron_http_post` non si chiude')
  const job = JOB.exec(corpo.slice(da, a))
  if (!job) throw new Error('il primo argomento di `cron_http_post` non è il nome del job fra apici')
  const inizi = [da, ...virgole.map((v) => v + 1)]
  const fini = [...virgole, a]
  let posizionali = 0
  let freccia = ':='
  let timeout = null
  for (let k = 0; k < inizi.length; k++) {
    const n = NOMINATO.exec(codice.slice(inizi[k], fini[k]))
    if (!n) {
      posizionali++
      continue
    }
    if (n[2] === '=>') freccia = '=>'
    if (n[1].toLowerCase() !== 'timeout_milliseconds') continue
    const inizioValore = inizi[k] + n[0].length
    const valore = soloCodice.slice(inizioValore, fini[k])
    const v = NUMERO.exec(valore)
    if (!v) throw new Error(`timeout_milliseconds non è un numero letterale: «${valore.trim()}»`)
    const daNumero = inizioValore + v[1].length
    timeout = { da: daNumero, a: daNumero + v[2].length, ms: Number(v[2]) }
  }
  if (posizionali >= POSIZIONE_TIMEOUT) {
    throw new Error('timeout passato per posizione: si passa per nome, `timeout_milliseconds := <ms>`')
  }
  let fineCodice = a
  while (fineCodice > da && /\s/.test(soloCodice[fineCodice - 1])) fineCodice--
  return {
    job: job[1],
    timeoutMs: timeout ? timeout.ms : TIMEOUT_PREDEFINITO_MS,
    nominato: timeout !== null,
    timeout,
    freccia,
    fineCodice,
  }
}

/**
 * La definizione con `timeout_milliseconds` a `ms` nella chiamata all'involucro: si cambia il numero
 * se c'è, si aggiunge l'argomento in fondo alla chiamata (prima di un eventuale commento) se manca.
 * Nient'altro cambia.
 */
export function conTimeout(definizione, ms) {
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`timeout non valido: ${ms}`)
  const { testata, tag, corpo, coda } = corpoDi(definizione)
  const c = chiamataAllInvolucro(corpo)
  const nuovo = c.timeout
    ? corpo.slice(0, c.timeout.da) + String(ms) + corpo.slice(c.timeout.a)
    : corpo.slice(0, c.fineCodice) + `, timeout_milliseconds ${c.freccia} ${ms}` + corpo.slice(c.fineCodice)
  return testata + nuovo + tag + coda
}
