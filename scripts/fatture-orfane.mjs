#!/usr/bin/env node
/**
 * Registrazione delle fatture ORFANE (D1 §9): documenti partiti verso Aruba e mai scritti
 * in `fatture_emesse`.
 *
 *   node scripts/fatture-orfane.mjs --out <cartella FUORI dal repo> [--solo <pagamento_uuid>] [--conserva] [--applica]
 *
 * ─── COSA FA ────────────────────────────────────────────────────────────────
 *   1. guardie: `--out` fuori dal repository (che è PUBBLICO), `openssl version`,
 *      `select 1`, vincolo per sede assente in `pg_constraint` (senza la migrazione di
 *      D1 non si scrive niente);
 *   2. scoperta dal DB col predicato «partita non registrata» del modulo TS (fonte UNICA:
 *      qui non ne esiste una copia), ricontrollato voce per voce col predicato TS;
 *      accoppiamento coi log `registro-*`; una voce con un invio della coda è «DA DECIDERE»;
 *   3. TUTTE le letture da Aruba (signin, `getByFilename` per voce, scorrimento dell'anno),
 *      ciascuna preceduta da `guardiaArubaPerScript`, PRIMA di qualunque scrittura;
 *   4. controlli a-h (D1 §9.1 punto 5), XSD compreso;
 *   5. con `--applica`: per ogni voce pronta stampa «SCRIVO i/N:» con l'istruzione intera e
 *      i dati personali MASCHERATI, poi la esegue da `<out>/<pagamento>.sql` (0600);
 *      `--solo` limita il lavoro a un pagamento;
 *   6. riconteggio col predicato.
 *
 * Uscite: 0 = niente da fare o tutto registrato · 1 = guardia d'uso · 2 = almeno una voce
 * «DA DECIDERE» · 3 = errore di scrittura. I file `.p7m`, `.xml` e `.sql` si cancellano in
 * uscita, salvo `--conserva`; il rapporto (`orfane-rapporto.json`, solo uuid, nomi file,
 * numeri e codici) resta sempre, anche quando una guardia ferma lo script a metà.
 *
 * ─── PERCHÉ `main(argv, deps)` ───────────────────────────────────────────────
 * Lo script scrive righe WORM, che non si correggono più. L'ordine delle operazioni
 * (letture Aruba → scritture, stampa → scrittura, `--solo`) si prova con dipendenze finte
 * in `__tests__/lib/fatture-orfane-cli.test.ts`; il ramo d'avvio in fondo monta quelle vere
 * (processi figli sempre con `execFileSync(cmd, args[])`, mai una shell).
 *
 * ─── LE STAMPE ──────────────────────────────────────────────────────────────
 * Mai codici fiscali, nomi, causali o XML in chiaro: CF come `ABC…(16)`, nomi come
 * lunghezza, testi lunghi come `<N byte, sha256 …>` (`maschera*` della libreria). Il
 * codice fiscale dell'anagrafica non viene nemmeno letto: il confronto si fa sull'IMPRONTA
 * sha256, calcolata dal database.
 */

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  FermoAruba,
  RADICE_REPO,
  RE_NOME_FILE_ARUBA,
  creaLettoreAruba,
  eseguiFiglio,
  estraiXmlDaP7m,
  guardiaArubaPerScript,
  leggiCredenzialiAruba,
  righeDaJsonCli,
  rifiutaOutNelRepository,
  sqlDaCliSupabase,
  sqlstateDi,
} from './lib/aruba-lettura.mjs'
import {
  DA_DECIDERE,
  ESITI_LOG_REGISTRO,
  PARTITA_IVA_CEDENTE,
  PREFISSO_SEDE_DI_PROVA,
  SERIE,
  SQL_VINCOLO_PER_SEDE,
  VoceNonValida,
  accoppiaOrfane,
  componiInsert,
  datiDaLog,
  estraiCampiXml,
  leggiNumeroFattura,
  maschera,
  mascheraCf,
  risolviIntestatario,
  verdettoVincolo,
} from './lib/fatture-orfane.mjs'

/* ────────────────────────────────────────────────────────────────────────────
 * Costanti
 * ──────────────────────────────────────────────────────────────────────────── */

export const USCITA = Object.freeze({ ok: 0, guardia: 1, daDecidere: 2, scrittura: 3 })

export const USO =
  'Uso: node scripts/fatture-orfane.mjs --out <cartella FUORI dal repo> ' +
  '[--solo <pagamento_uuid>] [--conserva] [--applica]'

/** Il rapporto che resta sempre in `--out`: niente dati personali, solo uuid, file, numeri e codici. */
export const NOME_RAPPORTO = 'orfane-rapporto.json'

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RE_IMPORTO = /^\d+\.\d{2}$/
const RE_PROGRESSIVO = /^[AF]\d{8}$/

/**
 * Gli errori di Aruba che riguardano UN documento: la voce diventa «DA DECIDERE» e il
 * lavoro prosegue. Tutti gli altri (429, guardia, rete, signin, credenziali) fermano lo
 * script con 1: al primo 429 non si fa un'altra chiamata (D1 §10.5).
 */
const ERRORI_ARUBA_PER_VOCE = new Set(['aruba-http', 'aruba-senza-contenuto', 'involucro-errore'])

/** Ogni lettura porta un'etichetta in testa: nei log della CLI e nei test si riconosce. */
const etichetta = (nome) => `/* orfane:${nome} */ `

/* ────────────────────────────────────────────────────────────────────────────
 * Argomenti
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * @param {string[]} argv
 * @returns {{ opzioni: { out: string | null, solo: string | null, conserva: boolean, applica: boolean } }
 *   | { errore: string }}
 */
export function leggiArgomenti(argv) {
  const opzioni = { out: null, solo: null, conserva: false, applica: false }
  const lista = Array.isArray(argv) ? argv : []
  for (let i = 0; i < lista.length; i++) {
    const a = lista[i]
    if (a === '--out' || a === '--solo') {
      const valore = lista[i + 1]
      if (typeof valore !== 'string' || valore.startsWith('--')) return { errore: `${a} vuole un valore` }
      opzioni[a.slice(2)] = valore
      i++
    } else if (a.startsWith('--out=')) opzioni.out = a.slice('--out='.length)
    else if (a.startsWith('--solo=')) opzioni.solo = a.slice('--solo='.length)
    else if (a === '--conserva') opzioni.conserva = true
    else if (a === '--applica') opzioni.applica = true
    else return { errore: `argomento sconosciuto: ${a}` }
  }
  if (opzioni.solo !== null && !RE_UUID.test(opzioni.solo)) return { errore: '--solo vuole l\'uuid di un pagamento' }
  if (opzioni.solo !== null) opzioni.solo = opzioni.solo.toLowerCase()
  return { opzioni }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Piccoli attrezzi
 * ──────────────────────────────────────────────────────────────────────────── */

/** Una fermata con la sua uscita: la lancia il flusso, la raccoglie `main`. */
class Fermata extends Error {
  constructor(uscita, messaggio) {
    super(messaggio)
    this.uscita = uscita
  }
}

/** Una stringa SQL fra apici, SOLO per valori già validati (uuid, nomi file, serie, impronte). */
function lit(valore) {
  if (typeof valore !== 'string' || valore.includes("'") || valore.includes('\\')) {
    throw new Fermata(USCITA.guardia, 'valore non validato in una lettura: lo script si ferma')
  }
  return `'${valore}'`
}

const elenco = (valori) => valori.map(lit).join(', ')

/** Impronta sha256 del codice fiscale normalizzato: lo stesso calcolo della lettura SQL. */
export function improntaCf(cf) {
  const normalizzato = typeof cf === 'string' ? cf.replace(/\s+/g, '').toUpperCase() : ''
  // Un CF assente resta assente: l'impronta della stringa vuota combacerebbe con ogni
  // anagrafica senza codice fiscale.
  if (normalizzato === '') return ''
  return createHash('sha256').update(normalizzato, 'utf8').digest('hex')
}

/** L'espressione SQL gemella di `improntaCf`, su una colonna. */
const improntaSql = (colonna) =>
  `encode(sha256(convert_to(upper(regexp_replace(coalesce(${colonna}, ''), '\\s', '', 'g')), 'UTF8')), 'hex')`

/**
 * Il `ProgressivoInvio` che l'app scrive per (serie, numero, anno): è la formula di
 * `progressivoInvioFattura` (`src/lib/aruba/emissione.ts:331-334`). Non si importa: quel
 * modulo non si carica sotto Node senza bundler (usa proprietà di parametro TypeScript).
 */
export function progressivoAtteso({ sezionale, numero, anno }) {
  const lettera = sezionale === 'FPR' ? 'F' : 'A'
  return `${lettera}${String(anno % 100).padStart(2, '0')}${String(numero).padStart(6, '0')}`
}

const senzaP7m = (f) => (typeof f === 'string' ? f.replace(/\.p7m$/, '') : '')

function stessoNumero(a, b) {
  return a !== null && b !== null && a.sezionale === b.sezionale && a.numero === b.numero && a.anno === b.anno
}

const centesimi = (v) => Math.round(Number(v) * 100)

/* ────────────────────────────────────────────────────────────────────────────
 * Le letture (sola lettura: l'unica scrittura è l'istruzione di `componiInsert`)
 * ──────────────────────────────────────────────────────────────────────────── */

function sqlCandidati(predicato, { conteggio = false } = {}) {
  const dove =
    `where (${predicato})\n` +
    `  and coalesce(p.scuola_id::text, '') not like '${PREFISSO_SEDE_DI_PROVA}%'`
  if (conteggio) return `select count(*)::int as n from public.pagamenti p\n${dove}`
  return (
    `select p.id, p.scuola_id, p.fattura_stato::text as fattura_stato, p.fattura_aruba_id,\n` +
    `  to_char(p.fattura_emessa_il at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as fattura_emessa_il,\n` +
    `  p.importo::text as importo\n` +
    `from public.pagamenti p\n${dove}\n` +
    `order by p.fattura_emessa_il nulls last, p.id`
  )
}

/** Dei log si leggono SOLO i campi che servono all'accoppiamento, non l'intero contesto. */
const SQL_LOG = (esiti) =>
  `select l.id, l.messaggio, l.utente_id, l.scuola_id,\n` +
  `  jsonb_build_object('campi', jsonb_build_object('esito', l.contesto->'campi'->'esito', 'msg', l.contesto->'campi'->'msg'),\n` +
  `    'causa', jsonb_build_object('messaggio', l.contesto->'causa'->'messaggio')) as contesto\n` +
  `from public.app_log l\n` +
  `where l.evento = 'fattura' and l.contesto->'campi'->>'esito' in (${elenco(esiti)})\n` +
  `order by l.visto_l_ultima`

/**
 * Gli adulti del bambino, dalle stesse fonti della cascata di `determinaQuoteFatturazione`
 * (scelta sulla scheda, ordine divise, quote, legami runtime e anagrafici), una riga per
 * persona (`parents.id`) con l'id della fonte più forte. Del codice fiscale esce solo
 * l'IMPRONTA.
 */
const SQL_ADULTI = (ids) =>
  `with pag as (select p.id, p.alunno_id from public.pagamenti p where p.id in (${elenco(ids)})),\n` +
  `fonti as (\n` +
  `  select pag.id as pagamento_id, a.intestatario_fatture->>'adult_id' as adult_id, 1 as priorita\n` +
  `    from pag join public.alunni a on a.id = pag.alunno_id\n` +
  `  union all select d.pagamento_id, d.parent_id::text, 2 from public.divise_ordini d join pag on pag.id = d.pagamento_id\n` +
  `  union all select q.pagamento_id, q.adult_id::text, 3 from public.pagamenti_quote q join pag on pag.id = q.pagamento_id\n` +
  `  union all select pag.id, l.genitore_id::text, 4 from pag join public.legame_genitori_alunni l on l.alunno_id = pag.alunno_id\n` +
  `  union all select pag.id, sp.parent_id::text, 5 from pag join public.student_parents sp on sp.student_id = pag.alunno_id\n` +
  `)\n` +
  `select distinct on (f.pagamento_id, g.id) f.pagamento_id, f.adult_id, g.id as parent_id,\n` +
  `  ${improntaSql('g.fiscal_code')} as cf_impronta, g.first_name as nome, g.last_name as cognome\n` +
  `from fonti f join public.parents g on (g.id::text = f.adult_id or g.auth_user_id::text = f.adult_id)\n` +
  `where f.adult_id is not null\n` +
  `order by f.pagamento_id, g.id, f.priorita`

const SQL_GENITORI_CF = (impronte) =>
  `select g.id, ${improntaSql('g.fiscal_code')} as cf_impronta, g.first_name as nome, g.last_name as cognome\n` +
  `from public.parents g where ${improntaSql('g.fiscal_code')} in (${elenco(impronte)})`

/* ────────────────────────────────────────────────────────────────────────────
 * Il lavoro in `--out`: rapporto sempre, file sensibili solo fino all'uscita
 * ──────────────────────────────────────────────────────────────────────────── */

function creaLavoro(out, { conserva }) {
  const sensibili = []
  const rapporto = { strumento: 'scripts/fatture-orfane.mjs', fase: 'avvio', voci: [], avvisi: [] }
  const scriviPrivato = (nome, contenuto) => {
    const percorso = join(out, nome)
    writeFileSync(percorso, contenuto, { mode: 0o600 })
    chmodSync(percorso, 0o600)
    return percorso
  }
  return {
    out,
    rapporto,
    fase(nome) {
      rapporto.fase = nome
      this.salva()
    },
    salva() {
      scriviPrivato(NOME_RAPPORTO, `${JSON.stringify(rapporto, null, 2)}\n`)
    },
    sensibile(nome, contenuto) {
      const percorso = scriviPrivato(nome, contenuto)
      sensibili.push(percorso)
      return percorso
    },
    chiudi() {
      if (!conserva) for (const p of sensibili) rmSync(p, { force: true })
      rapporto.file_sensibili = conserva ? sensibili.length : 0
      this.salva()
    },
  }
}

/** La voce come compare nel rapporto: nessun dato personale. */
function vocePerRapporto(v) {
  return {
    pagamento_id: v.pagamento_id,
    scuola_id: v.scuola_id,
    file: v.file,
    fattura_emessa_il: v.fattura_emessa_il,
    numero: v.numeroLetto?.testo ?? null,
    stato: v.stato,
    motivi: v.motivi,
    avvisi: v.avvisi,
    controlli: v.controlli ?? null,
    stato_sdi: v.statoSdi ?? null,
    intestatario_caso: v.intestatario?.caso ?? null,
    scrittura: v.scrittura ?? null,
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * main
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * @param {string[]} argv
 * @param {{
 *   sql: (testo: string) => Promise<object[]>,
 *   scrivi: (fileSql: string) => Promise<object[]>,
 *   guardia: () => Promise<{ ok: boolean, codice?: string, messaggio?: string, riprova_dopo?: Date }>,
 *   apriAruba: () => { signin: Function, getByFilename: Function, scorriDocumenti: Function },
 *   openssl: () => string,
 *   estraiXml: (contenuto: Buffer, opzioni: { cartella: string }) => string,
 *   validaXsd: (xml: string) => Promise<{ valido: boolean, errori: string[] }>,
 *   moduli: { PREDICATO_SQL_PARTITA_NON_REGISTRATA: string, fatturaPartitaNonRegistrata: Function,
 *     formattaNumeroFattura: Function, codiceStatoAruba: Function, mapStatoAruba: Function },
 *   stampa: (riga: string) => void,
 *   radice?: string,
 * }} deps
 * @returns {Promise<number>} il codice d'uscita
 */
export async function main(argv, deps) {
  const stampa = typeof deps?.stampa === 'function' ? deps.stampa : () => {}
  const argomenti = leggiArgomenti(argv)
  if (argomenti.errore) {
    stampa(`${argomenti.errore}\n${USO}`)
    return USCITA.guardia
  }
  const { opzioni } = argomenti

  // Guardia 1, prima di QUALUNQUE chiamata: i file di questo script contengono dati di minori.
  let out
  try {
    out = rifiutaOutNelRepository(opzioni.out, deps?.radice ?? RADICE_REPO)
  } catch (e) {
    stampa(e instanceof Error ? e.message : String(e))
    return USCITA.guardia
  }
  mkdirSync(out, { recursive: true, mode: 0o700 })

  const lavoro = creaLavoro(out, opzioni)
  lavoro.rapporto.opzioni = { applica: opzioni.applica, solo: opzioni.solo, conserva: opzioni.conserva }
  let uscita
  try {
    uscita = await flusso(opzioni, deps, lavoro, stampa)
  } catch (e) {
    if (e instanceof Fermata) {
      stampa(e.message)
      uscita = e.uscita
    } else if (e instanceof FermoAruba) {
      stampa(`FERMO (${e.codice}): ${e.message}`)
      lavoro.rapporto.fermo = { codice: e.codice, riprova_dopo: e.riprova_dopo ?? null }
      uscita = typeof e.uscita === 'number' ? e.uscita : USCITA.guardia
    } else {
      stampa(`Errore inatteso: ${e instanceof Error ? e.message : String(e)}`)
      uscita = USCITA.guardia
    }
    stampa(`Risultati parziali in ${join(out, NOME_RAPPORTO)}. Nessuna scrittura dopo questo punto.`)
  } finally {
    lavoro.rapporto.uscita = uscita ?? USCITA.guardia
    lavoro.chiudi()
  }
  return uscita
}

async function flusso(opzioni, deps, lavoro, stampa) {
  const { moduli } = deps
  if (!moduli || typeof moduli.PREDICATO_SQL_PARTITA_NON_REGISTRATA !== 'string' ||
      typeof moduli.fatturaPartitaNonRegistrata !== 'function') {
    throw new Fermata(USCITA.guardia, 'Manca il modulo del predicato «partita non registrata»: lo script non parte.')
  }
  const predicatoSql = moduli.PREDICATO_SQL_PARTITA_NON_REGISTRATA

  /** Una lettura: ogni errore o forma inattesa ferma lo script con 1 (fail-closed). */
  const leggi = async (nome, testo) => {
    let righe
    try {
      righe = await deps.sql(`${etichetta(nome)}${testo}`)
    } catch (e) {
      const sqlstate = sqlstateDi(e)
      throw new Fermata(USCITA.guardia,
        `Lettura «${nome}» fallita (${sqlstate ? `SQLSTATE ${sqlstate}` : 'senza SQLSTATE'}): lo script si ferma.`)
    }
    if (!Array.isArray(righe)) throw new Fermata(USCITA.guardia, `Lettura «${nome}»: risposta non tabellare.`)
    return righe
  }

  // ── 1. Guardie ────────────────────────────────────────────────────────────
  lavoro.fase('guardie')
  let versione
  try {
    versione = String(deps.openssl() ?? '')
  } catch {
    throw new Fermata(USCITA.guardia, 'openssl non disponibile: serve per aprire gli involucri firmati.')
  }
  if (!/ssl/i.test(versione)) throw new Fermata(USCITA.guardia, 'openssl version: risposta non riconosciuta.')

  const uno = await leggi('select-1', 'select 1 as uno')
  if (uno.length !== 1 || Number(uno[0]?.uno) !== 1) throw new Fermata(USCITA.guardia, 'select 1: risposta inattesa.')

  const vincolo = verdettoVincolo(await leggi('vincolo', SQL_VINCOLO_PER_SEDE))
  if (!vincolo.ok) throw new Fermata(USCITA.guardia, vincolo.messaggio)

  // ── 2. Scoperta ───────────────────────────────────────────────────────────
  lavoro.fase('scoperta')
  const giornale = await leggi('giornale', "select to_regclass('public.fatture_coda_invii') is not null as esiste")
  if (giornale.length !== 1 || typeof giornale[0]?.esiste !== 'boolean') {
    throw new Fermata(USCITA.guardia, 'Esistenza di fatture_coda_invii non leggibile: lo script non parte.')
  }
  const giornaleEsiste = giornale[0].esiste

  const candidati = await leggi('candidati', sqlCandidati(predicatoSql))
  const log = await leggi('log', SQL_LOG(ESITI_LOG_REGISTRO))

  const fileDeiLog = [...new Set(log.map((r) => datiDaLog(r).file).filter((f) => f && RE_NOME_FILE_ARUBA.test(f)))]
  const pagamentiDeiLog = fileDeiLog.length === 0 ? [] : await leggi('pagamenti-dei-log',
    `select p.id, p.scuola_id, p.fattura_stato::text as fattura_stato, p.fattura_aruba_id,\n` +
    `  to_char(p.fattura_emessa_il at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as fattura_emessa_il,\n` +
    `  p.importo::text as importo\n` +
    `from public.pagamenti p where p.fattura_aruba_id in (${elenco(fileDeiLog)})`)

  const tutti = [...candidati, ...pagamentiDeiLog]
  for (const p of tutti) {
    if (!RE_UUID.test(String(p?.id ?? ''))) throw new Fermata(USCITA.guardia, 'Un pagamento letto non ha un uuid valido.')
  }
  const ids = [...new Set(tutti.map((p) => p.id))]
  const righe = ids.length === 0 ? [] : await leggi('righe',
    `select f.pagamento_id, f.sdi_stato, f.aruba_filename from public.fatture_emesse f where f.pagamento_id in (${elenco(ids)})`)
  let pagamentiConInvio = null
  if (giornaleEsiste) {
    pagamentiConInvio = ids.length === 0 ? [] : (await leggi('invii',
      `select distinct i.pagamento_id from public.fatture_coda_invii i where i.pagamento_id in (${elenco(ids)})`))
      .map((r) => r.pagamento_id)
  }

  const scoperta = accoppiaOrfane({
    candidatiSql: candidati,
    pagamentiDeiLog,
    righe,
    log,
    pagamentiConInvio,
    predicato: moduli.fatturaPartitaNonRegistrata,
  })
  const importoPer = new Map(tutti.map((p) => [p.id, p.importo ?? null]))
  lavoro.rapporto.scoperta = {
    candidati: candidati.length,
    voci: scoperta.voci.length,
    da_decidere: scoperta.daDecidere,
    esclusi_sede_di_prova: scoperta.esclusi,
    log_senza_orfana: scoperta.logSenzaOrfana,
    giornale_esiste: giornaleEsiste,
  }
  lavoro.rapporto.avvisi.push(...scoperta.avvisi)
  lavoro.rapporto.voci = scoperta.voci.map(vocePerRapporto)
  lavoro.salva()
  stampa(`Scoperta: ${scoperta.voci.length} voci (${scoperta.daDecidere} DA DECIDERE), ` +
    `${scoperta.esclusi} della sede di prova escluse, ${scoperta.logSenzaOrfana.length} log senza orfana.`)
  for (const a of scoperta.avvisi) stampa(`  avviso: ${a}`)

  // I due predicati che non concordano non sono un caso da decidere voce per voce: vuol
  // dire che la scoperta stessa non è affidabile. Niente Aruba, niente scritture.
  const discordi = scoperta.voci.filter((v) => v.motivi.includes(DA_DECIDERE.predicatiDiscordi))
  if (discordi.length > 0) {
    for (const v of discordi) stampa(`  ${v.pagamento_id}: ${DA_DECIDERE.predicatiDiscordi}`)
    stampa('I predicati SQL e TS non concordano: nessuna lettura da Aruba, nessuna scrittura.')
    lavoro.fase('predicati-discordi')
    return USCITA.daDecidere
  }

  let voci = scoperta.voci
  if (opzioni.solo !== null) {
    voci = voci.filter((v) => v.pagamento_id === opzioni.solo)
    if (voci.length === 0) throw new Fermata(USCITA.guardia, `--solo ${opzioni.solo}: il pagamento non è fra le orfane trovate.`)
  }
  lavoro.rapporto.voci = voci.map(vocePerRapporto)
  const daDecidere = (v, motivo) => {
    v.stato = 'da_decidere'
    if (!v.motivi.includes(motivo)) v.motivi.push(motivo)
  }
  let pronte = voci.filter((v) => v.stato === 'pronta')

  if (pronte.length === 0) {
    lavoro.fase('fine')
    stampa(voci.length === 0 ? 'Nessuna orfana: niente da fare.' : 'Nessuna voce pronta: niente da leggere né da scrivere.')
    for (const v of voci) stampa(`  ${v.pagamento_id}: ${v.motivi.join('; ')}`)
    return voci.some((v) => v.stato === 'da_decidere') ? USCITA.daDecidere : USCITA.ok
  }

  // ── 3. Aruba: TUTTE le letture, prima di qualunque scrittura ──────────────
  lavoro.fase('aruba')
  const aruba = deps.apriAruba()
  const guardato = async (fn) => {
    const g = await deps.guardia()
    if (!g || g.ok !== true) {
      throw new FermoAruba(g?.codice ?? 'lettura-fallita', g?.messaggio ?? 'Guardia Aruba senza esito: lo script si ferma.',
        { riprova_dopo: g?.riprova_dopo })
    }
    return fn()
  }

  await guardato(() => aruba.signin())
  for (const v of pronte) {
    let doc
    try {
      doc = await guardato(() => aruba.getByFilename(v.file))
    } catch (e) {
      if (e instanceof FermoAruba && ERRORI_ARUBA_PER_VOCE.has(e.codice)) {
        daDecidere(v, `DA DECIDERE: Aruba non restituisce il documento (${e.codice})`)
        continue
      }
      throw e
    }
    lavoro.sensibile(`${v.pagamento_id}.p7m`, doc.contenuto)
    let xml
    try {
      xml = deps.estraiXml(doc.contenuto, { cartella: lavoro.out })
    } catch (e) {
      daDecidere(v, `DA DECIDERE: involucro firmato illeggibile (${e?.codice ?? 'openssl'})`)
      continue
    }
    lavoro.sensibile(`${v.pagamento_id}.xml`, xml)
    v.xml = xml
    const stato = Array.isArray(doc.fatture) && doc.fatture.length === 1 ? doc.fatture[0]?.stato : null
    const codice = moduli.codiceStatoAruba(stato)
    const mappato = moduli.mapStatoAruba(codice)
    v.statoSdi = { codice, etichetta: mappato.label, scarto: mappato.isScarto }
    if (mappato.isScarto) v.avvisi.push(`Aruba dà il documento come scarto (${mappato.label}): la sync porterà la riga a scartata`)
    const campi = estraiCampiXml(xml)
    if (!campi.ok) {
      daDecidere(v, `DA DECIDERE: XML non conforme al tracciato dell'app (${campi.motivo})`)
      continue
    }
    v.campi = campi.campi
    v.numeroLetto = leggiNumeroFattura(campi.campi.numero)
  }

  const anni = [...new Set(pronte.filter((v) => v.stato === 'pronta' && v.numeroLetto).map((v) => v.numeroLetto.anno))].sort()
  const documentiPerAnno = new Map()
  for (const anno of anni) {
    const { documenti } = await guardato(() => aruba.scorriDocumenti({ anno }))
    documentiPerAnno.set(anno, Array.isArray(documenti) ? documenti : [])
  }
  lavoro.rapporto.aruba = { documenti_letti: pronte.filter((v) => v.xml).length, anni_scorsi: anni }
  // Da qui in poi Aruba non si chiama più.

  // ── 4. Controlli a-h ──────────────────────────────────────────────────────
  lavoro.fase('controlli')
  pronte = pronte.filter((v) => v.stato === 'pronta')
  for (const v of pronte) {
    const esito = await deps.validaXsd(v.xml)
    v.xsdValido = esito?.valido === true
    v.xsdErrori = Array.isArray(esito?.errori) ? esito.errori.length : null
  }

  const conNumero = pronte.filter((v) => v.numeroLetto && SERIE.includes(v.numeroLetto.sezionale))
  const numeriARegistro = conNumero.length === 0 ? [] : await leggi('registro-numeri',
    `select f.sezionale, f.anno, f.numero from public.fatture_emesse f where (f.sezionale, f.anno, f.numero) in (` +
    conNumero.map((v) => `(${lit(v.numeroLetto.sezionale)}, ${v.numeroLetto.anno}, ${v.numeroLetto.numero})`).join(', ') + ')')
  const idsPronte = pronte.map((v) => v.pagamento_id)
  const origini = new Map((await leggi('origine',
    `select p.id as pagamento_id, a.intestatario_fatture->>'tipo' as origine\n` +
    `from public.pagamenti p left join public.alunni a on a.id = p.alunno_id where p.id in (${elenco(idsPronte)})`))
    .map((r) => [r.pagamento_id, r.origine ?? null]))
  const adulti = await leggi('adulti', SQL_ADULTI(idsPronte))
  const impronte = [...new Set(pronte.filter((v) => v.campi).map((v) => improntaCf(v.campi.cessionario.codiceFiscale)))]
    .filter((i) => i !== '')
  const genitori = impronte.length === 0 ? [] : await leggi('genitori-cf', SQL_GENITORI_CF(impronte))

  for (const v of pronte) {
    const c = v.campi
    const n = v.numeroLetto
    const controlli = {}
    // a. Il numero è nella forma di `formattaNumeroFattura`, e coincide con quello del log.
    let formaNumero = false
    try {
      formaNumero = n !== null && moduli.formattaNumeroFattura(n.sezionale, n.numero, n.anno) === c.numero
    } catch {
      formaNumero = false
    }
    controlli.a = formaNumero && (v.log?.numero == null || stessoNumero(v.log.numero, n))
    // b. Fattura ordinaria del nostro cedente.
    controlli.b = c.tipoDocumento === 'TD01' && c.cedenteIdCodice === PARTITA_IVA_CEDENTE
    // c. ProgressivoInvio nella forma dell'app e coerente col numero.
    controlli.c = RE_PROGRESSIVO.test(c.progressivoInvio) && n !== null && c.progressivoInvio === progressivoAtteso(n)
    // d. Totale del documento uguale all'importo del pagamento nell'XML (vince l'XML, F37).
    controlli.d = RE_IMPORTO.test(c.importoTotaleDocumento) && typeof c.importoPagamento === 'string' &&
      centesimi(c.importoTotaleDocumento) === centesimi(c.importoPagamento)
    const importoDb = importoPer.get(v.pagamento_id)
    if (controlli.d && importoDb != null && centesimi(importoDb) !== centesimi(c.importoTotaleDocumento)) {
      v.avvisi.push('il totale del documento differisce da pagamenti.importo: vince l\'XML (F37)')
    }
    // e. Schema ufficiale.
    controlli.e = v.xsdValido === true
    // f. Su Aruba un solo documento con (serie, numero), ed è il nostro file.
    const conLoStessoNumero = n === null ? [] : (documentiPerAnno.get(n.anno) ?? [])
      .filter((d) => (d?.fatture ?? []).some((f) => stessoNumero(leggiNumeroFattura(f?.numero), n)))
    const nostri = conLoStessoNumero.filter((d) => senzaP7m(d.filename) === senzaP7m(v.file))
    controlli.f = conLoStessoNumero.length === 1 && nostri.length === 1
    if (conLoStessoNumero.length > nostri.length) v.avvisi.push('DOPPIONE: su Aruba c\'è un altro documento con lo stesso numero')
    // g. Nel DB: nessuna riga per (serie, anno, numero). Le altre condizioni di g sono già
    //    vere per costruzione: zero righe del pagamento e `in_attesa` col suo file li ha
    //    provati la scoperta; il vincolo la guardia; la riga porta sempre `modalita_emissione`.
    controlli.g = n !== null && !numeriARegistro.some((r) =>
      r.sezionale === n.sezionale && Number(r.anno) === n.anno && Number(r.numero) === n.numero)
    // h. Intestatario dal codice fiscale dell'XML INVIATO (decisione 24), per impronta.
    const impronta = improntaCf(c.cessionario.codiceFiscale)
    const adultiVoce = adulti.filter((a) => a.pagamento_id === v.pagamento_id)
    v.intestatario = risolviIntestatario({
      codiceFiscale: impronta,
      adulti: adultiVoce.map((a) => ({ adult_id: a.adult_id, parent_id: a.parent_id, codice_fiscale: a.cf_impronta })),
      genitori: genitori.map((g) => ({ id: g.id, codice_fiscale: g.cf_impronta })),
      origine: origini.get(v.pagamento_id) ?? null,
    })
    controlli.h = v.intestatario.esito === 'risolto'
    v.controlli = controlli

    const falliti = Object.entries(controlli).filter(([, ok]) => ok !== true).map(([k]) => k)
    for (const k of falliti) daDecidere(v, `DA DECIDERE: controllo ${k} non superato`)
    if (!controlli.h && v.intestatario.motivo) daDecidere(v, v.intestatario.motivo)
    if (falliti.length > 0) continue

    // L'istruzione: le validazioni di `componiInsert` sono l'ultimo controllo.
    const persona = [...adultiVoce, ...genitori].find((a) =>
      (a.parent_id ?? a.id) === v.intestatario.parent_registry_id) ?? null
    try {
      v.istruzione = componiInsert({
        pagamento_id: v.pagamento_id,
        scuola_id: v.scuola_id,
        file: v.file,
        sezionale: n.sezionale,
        anno: n.anno,
        numero: n.numero,
        progressivo_invio: c.progressivoInvio,
        causale: c.descrizione,
        importo: c.importoTotaleDocumento,
        intestatario: { nome: c.cessionario.nome, cognome: c.cessionario.cognome, codice_fiscale: c.cessionario.codiceFiscale },
        xml: v.xml,
        istante: v.fattura_emessa_il,
        quota_adult_id: v.intestatario.quota_adult_id,
        parent_registry_id: v.intestatario.parent_registry_id,
        bollo_virtuale: c.bolloVirtuale,
        app_log_id: v.log?.app_log_id ?? null,
        emessa_da: v.log?.utente_id ?? null,
        vincolo: v.log?.vincolo ?? null,
      }, {
        predicatoSql,
        giornaleEsiste,
        anagrafica: persona ? { nome: persona.nome, cognome: persona.cognome } : null,
      })
      v.mascherati = maschera({
        intestatario: { nome: c.cessionario.nome, cognome: c.cessionario.cognome, codice_fiscale: c.cessionario.codiceFiscale },
        causale: c.descrizione,
        xml: v.xml,
      }, persona ? { nome: persona.nome, cognome: persona.cognome } : null)
    } catch (e) {
      if (e instanceof VoceNonValida) daDecidere(v, `DA DECIDERE: ${e.message}`)
      else throw e
    }
  }

  lavoro.rapporto.voci = voci.map(vocePerRapporto)
  lavoro.salva()
  const pronteFinali = voci.filter((v) => v.stato === 'pronta')
  const restanoDaDecidere = voci.some((v) => v.stato === 'da_decidere')
  stampa(`Controlli a-h: ${pronteFinali.length} pronte, ${voci.length - pronteFinali.length} DA DECIDERE.`)
  for (const v of voci) {
    const numero = v.numeroLetto?.testo ?? '(numero non letto)'
    stampa(`  ${v.pagamento_id} · ${v.file ?? '(file assente)'} · ${numero} → ` +
      (v.stato === 'pronta' ? `pronta (CF ${mascheraCf(v.campi?.cessionario?.codiceFiscale)}, caso ${v.intestatario?.caso})`
        : v.motivi.join('; ')))
    for (const a of v.avvisi) stampa(`      avviso: ${a}`)
  }

  if (!opzioni.applica) {
    lavoro.fase('fine-a-secco')
    stampa('A secco: nessuna scrittura. Per registrare: --applica (prima con --solo sulla voce più vecchia).')
    return restanoDaDecidere ? USCITA.daDecidere : USCITA.ok
  }

  // ── 5. Scrittura ──────────────────────────────────────────────────────────
  lavoro.fase('scrittura')
  const prima = await leggi('conteggio', sqlCandidati(predicatoSql, { conteggio: true }))
  stampa(`Orfane secondo il predicato, prima delle scritture: ${prima[0]?.n ?? '?'}.`)
  const N = pronteFinali.length
  let erroreScrittura = false
  for (let i = 0; i < N; i++) {
    const v = pronteFinali[i]
    const m = v.mascherati
    stampa(`SCRIVO ${i + 1}/${N}: pagamento ${v.pagamento_id} · ${v.file} · ${v.numeroLetto.testo}\n` +
      `  codice fiscale ${m.codice_fiscale} · nome: ${m.nome} · cognome: ${m.cognome}\n` +
      `  causale ${m.causale} · XML ${m.xml}\n` +
      v.istruzione.sqlMascherato)
    const file = lavoro.sensibile(`${v.pagamento_id}.sql`, v.istruzione.sql)
    let esito
    try {
      esito = await deps.scrivi(file)
    } catch (e) {
      const sqlstate = sqlstateDi(e)
      v.scrittura = { esito: 'errore', sqlstate: sqlstate ?? null }
      stampa(`  ERRORE di scrittura (${sqlstate ? `SQLSTATE ${sqlstate}` : 'senza SQLSTATE'}): mi fermo qui.`)
      erroreScrittura = true
      break
    }
    const r = Array.isArray(esito) && esito.length === 1 ? esito[0] : null
    if (!r || Number(r.registrate) !== 1 || Number(r.audit) !== 1) {
      v.scrittura = { esito: 'nessuna-riga', registrate: r ? Number(r.registrate) : null }
      stampa('  Nessuna riga registrata: una precondizione non è più vera. Mi fermo; rilancia a secco.')
      erroreScrittura = true
      break
    }
    v.scrittura = { esito: 'registrata', fattura_id: r.fattura_id ?? null, audit_id: r.audit_id ?? null }
    lavoro.rapporto.voci = voci.map(vocePerRapporto)
    lavoro.salva()
    stampa(`  registrata: fattura ${r.fattura_id ?? '?'}, audit ${r.audit_id ?? '?'}.`)
  }

  // ── 6. Riconteggio ────────────────────────────────────────────────────────
  lavoro.fase('riconteggio')
  const dopo = await leggi('riconteggio', sqlCandidati(predicatoSql, { conteggio: true }))
  lavoro.rapporto.riconteggio = dopo[0]?.n ?? null
  stampa(`Riconteggio col predicato: ${dopo[0]?.n ?? '?'} (atteso 0 quando tutte le voci sono registrate).`)
  lavoro.fase('fine')
  if (erroreScrittura) return USCITA.scrittura
  return restanoDaDecidere ? USCITA.daDecidere : USCITA.ok
}

/* ────────────────────────────────────────────────────────────────────────────
 * Avvio: solo quando il file è lanciato da Node, mai quando lo importa un test
 * ──────────────────────────────────────────────────────────────────────────── */

/** Le dipendenze vere. I moduli di `src/` si caricano DOPO l'hook di `risolvi-ts.mjs`. */
export async function dipendenzeVere() {
  await import('./lib/risolvi-ts.mjs')
  const predicato = await import('@/lib/pagamenti/fattura-partita-non-registrata')
  const sezionale = await import('@/lib/fatturazione/sezionale')
  const stato = await import('@/lib/aruba/stato')
  const xsd = await import('../__tests__/lib/aruba/valida-xsd.ts')
  const sql = sqlDaCliSupabase()
  return {
    sql,
    scrivi: async (fileSql) => {
      let uscita
      try {
        uscita = eseguiFiglio('supabase', ['db', 'query', '--linked', '--agent', 'no', '-o', 'json', '-f', fileSql], {
          cwd: RADICE_REPO,
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (e) {
        const err = new Error(`supabase db query -f: uscita ${e?.status ?? '?'}`)
        err.sqlstate = sqlstateDi(e)
        throw err
      }
      return righeDaJsonCli(uscita)
    },
    guardia: () => guardiaArubaPerScript({ sql }),
    apriAruba: () => {
      const credenziali = leggiCredenzialiAruba()
      if (!credenziali) throw new FermoAruba('credenziali-mancanti', 'Mancano ARUBA_USERNAME / ARUBA_PASSWORD.')
      return creaLettoreAruba({ sql, credenziali })
    },
    openssl: () => eseguiFiglio('openssl', ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    estraiXml: (contenuto, { cartella }) => estraiXmlDaP7m(contenuto, { cartella }),
    validaXsd: (xml) => xsd.validaFatturaPA(xml),
    moduli: {
      PREDICATO_SQL_PARTITA_NON_REGISTRATA: predicato.PREDICATO_SQL_PARTITA_NON_REGISTRATA,
      fatturaPartitaNonRegistrata: predicato.fatturaPartitaNonRegistrata,
      formattaNumeroFattura: sezionale.formattaNumeroFattura,
      codiceStatoAruba: stato.codiceStatoAruba,
      mapStatoAruba: stato.mapStatoAruba,
    },
    stampa: (riga) => console.log(riga),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), await dipendenzeVere())
}
