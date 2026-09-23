#!/usr/bin/env node
/**
 * Indagine sulla numerazione delle serie fiscali (D1 §3) e, solo se serve, allineamento del
 * contatore di una serie (D1 §4). Per default SOLA LETTURA.
 *
 *   node scripts/numerazione-serie.mjs --out <cartella FUORI dal repo> [--anno 2026] [--xml-fuori-app]
 *   node scripts/numerazione-serie.mjs --out <…> --allinea --serie <Asilo|FPR> --a <N>
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Il 18/09 la serie FPR è saltata da 2154 a 2516. L'app prende il numero con
 * `GREATEST(contatore, pavimento) + 1`, e il pavimento lo legge da Aruba: un documento
 * numerato a mano sul pannello basta a spostare tutta la serie (H1). Questa CLI mette a
 * confronto registro, orfane, giornale della coda e documenti di Aruba, attribuisce ogni
 * salto al documento fuori app che lo spiega, e prova (P7) che il codice attivo a ogni
 * salto è quello del deploy di produzione `rif`.
 *
 * ─── FORMA TESTABILE ────────────────────────────────────────────────────────
 * Tutto il lavoro sta in `main(argv, deps)`: DB, scrittura, Aruba, git, gh, guardia, stampa e
 * orologio arrivano da fuori, e il test li sostituisce con finti che registrano l'ORDINE delle
 * chiamate. Il ramo d'avvio in fondo gira solo quando il file è lanciato con `node`, e passa le
 * dipendenze vere: processi figli con `execFileSync(cmd, args[])`, mai una shell.
 *
 * ─── LE REGOLE CHE NON SI DEROGANO ──────────────────────────────────────────
 *   · `--out` fuori dal repository (che è PUBBLICO): controllato prima di qualunque chiamata;
 *   · la guardia di D1 §10 (`guardiaArubaPerScript`) prima di OGNI chiamata ad Aruba; se nega,
 *     uscita 1 e nessun'altra chiamata; al primo 429 ci si ferma, e i parziali restano in `--out`;
 *   · la P7 confronta con `rif`, mai con `HEAD` (D1 §0.2 a): sul branch i percorsi della
 *     numerazione li modifica la correzione stessa;
 *   · le orfane si trovano col predicato importato dal modulo TS (fonte unica, CR1): qui non ne
 *     esiste una copia, e il test lo verifica leggendo questo file;
 *   · `--allinea` fa UNA scrittura, a confronto-e-scambio (D1 §4.3): prima la stampa intera
 *     («SCRIVO:»), poi l'esecuzione, poi la rilettura. 0 righe aggiornate = qualcuno ha
 *     allocato nel frattempo: uscita 1, si rilancia;
 *   · nei file e a terminale solo numeri, serie, uuid, nomi file e istanti: mai codici fiscali,
 *     nomi, `sender` o `receiver`. I file in `--out` hanno permessi 0600.
 *
 * Codici d'uscita (D1 §3.3): 0 = tutto spiegato e P7 vera; 1 = guardia d'uso (`--out`,
 * credenziali, CLI, git o gh, `rif` non antenato, 429, guardie del §10, rifiuto di `--allinea`);
 * 2 = salto non spiegato, doppione, etichette illeggibili, oppure P7 falsa.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  FermoAruba,
  RADICE_REPO,
  creaLettoreAruba,
  estraiXmlDaP7m,
  guardiaArubaPerScript,
  leggiCredenzialiAruba,
  rifiutaOutNelRepository,
  sqlDaCliSupabase,
} from './lib/aruba-lettura.mjs'
import {
  SERIE,
  allocazioniConContatore,
  argomentiGit,
  attribuisciSalti,
  buchi,
  classifica,
  componiAllineamento,
  deployAttivoAl,
  doppioni,
  leggiEtichetta,
  obiettivoContatore,
  prospetto,
  provaP7,
  verificaConfrontoEScambio,
} from './lib/numerazione-serie.mjs'

/* ────────────────────────────────────────────────────────────────────────────
 * Costanti
 * ──────────────────────────────────────────────────────────────────────────── */

/** Il repository dei deploy (pubblico): la P7 legge da qui i deploy di produzione. */
export const REPO_GITHUB = 'erricoluigi17/kidville-web'

/** Al più 20 `getByFilename` con `--xml-fuori-app` (D1 §3.2), a 5 s l'una dall'altra. */
export const MAX_XML_FUORI_APP = 20

/**
 * Le finestre di D1 §2.4 (UTC), fra due scorrimenti registrati in `app_log`: servono a contare
 * i documenti fuori app per finestra (P4) e a scegliere quelli da leggere con `--xml-fuori-app`
 * (F1-F4). Intervalli chiusi a sinistra, aperti a destra.
 */
export const FINESTRE_FUORI_APP = Object.freeze([
  { nome: 'F1', da: '2026-09-17T10:31:00Z', a: '2026-09-18T07:45:00Z' },
  { nome: 'F2', da: '2026-09-18T09:18:00Z', a: '2026-09-18T13:18:00Z' },
  { nome: 'F3', da: '2026-09-18T13:18:00Z', a: '2026-09-21T08:36:00Z' },
  { nome: 'F4', da: '2026-09-21T09:19:00Z', a: '2026-09-21T13:06:00Z' },
  { nome: 'F5', da: '2026-09-21T13:06:00Z', a: '2026-09-22T08:25:00Z' },
  { nome: 'F6', da: '2026-09-22T08:25:00Z', a: '2026-09-22T10:52:00Z' },
])

/** Le finestre i cui documenti fuori app si leggono con `--xml-fuori-app` (D1 §3.2). */
const FINESTRE_XML = Object.freeze(['F1', 'F2', 'F3', 'F4'])

/**
 * Margine sulla lettura dei deploy: dopo il primo deploy riuscito entro l'istante cercato si
 * leggono ancora quelli CREATI fino a un'ora prima del suo successo, perché un deploy creato
 * prima può finire dopo (build più lunga).
 */
const MARGINE_DEPLOY_MS = 60 * 60 * 1000

const USO = [
  'Uso:',
  '  node scripts/numerazione-serie.mjs --out <cartella FUORI dal repo> [--anno 2026] [--xml-fuori-app]',
  '  node scripts/numerazione-serie.mjs --out <…> --allinea --serie <Asilo|FPR> --a <N>',
].join('\n')

/* ────────────────────────────────────────────────────────────────────────────
 * Il predicato delle orfane: dal modulo TS, mai copiato (CR1)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Carica `PREDICATO_SQL_PARTITA_NON_REGISTRATA` dal modulo di `src/`. Prima l'hook di
 * `risolvi-ts.mjs` (alias `@/` ed estensioni), POI il modulo, con `await import`: un import
 * statico verrebbe risolto prima che l'hook esista.
 *
 * @returns {Promise<string>}
 */
export async function caricaPredicato() {
  await import('./lib/risolvi-ts.mjs')
  const modulo = await import('../src/lib/pagamenti/fattura-partita-non-registrata.ts')
  const predicato = modulo.PREDICATO_SQL_PARTITA_NON_REGISTRATA
  if (typeof predicato !== 'string' || predicato.trim() === '') {
    throw new Error('il modulo del predicato non esporta PREDICATO_SQL_PARTITA_NON_REGISTRATA')
  }
  return predicato
}

/* ────────────────────────────────────────────────────────────────────────────
 * Le letture dal DB (solo numeri, uuid, nomi file e istanti)
 * ──────────────────────────────────────────────────────────────────────────── */

export const SQL_GIORNALE_ESISTE = "select to_regclass('public.fatture_coda_invii') is not null as giornale"

/** Q1: i contatori delle serie dell'anno. È anche la RILETTURA dopo `--allinea`. */
export function sqlContatori(anno) {
  return `select sezionale, anno, ultimo_numero, aggiornato_il from public.fatture_numerazione_sezionale where anno = ${anno} order by sezionale`
}

/**
 * Le letture Q1-Q6 di D1 §3.3. Q3 prende le orfane col predicato passato (quello del modulo
 * TS); Q6 esiste solo quando il giornale della coda esiste.
 *
 * @param {number} anno
 * @param {string} predicato
 */
export function sqlLetture(anno, predicato) {
  return {
    q1: sqlContatori(anno),
    q2:
      'select sezionale, numero, sdi_stato, aruba_filename, creato_il from public.fatture_emesse ' +
      `where anno = ${anno} and sezionale is not null and numero is not null order by creato_il, numero`,
    q3:
      'select p.id, p.fattura_aruba_id, p.fattura_emessa_il from public.pagamenti p ' +
      `where ${predicato} order by p.fattura_emessa_il nulls last, p.id`,
    q4:
      "select creato_il, visto_l_ultima, occorrenze, contesto->'campi'->>'ricevuti' as ricevuti, " +
      "contesto->'campi'->>'totale_dichiarato' as totale_dichiarato from public.app_log " +
      "where evento = 'fattura' and contesto->'campi'->>'esito' = 'scorrimento-concluso' order by creato_il",
    q5:
      "select creato_il, visto_l_ultima, occorrenze, livello, contesto->'campi'->>'esito' as esito, " +
      "contesto->'campi'->>'pagamento_id' as pagamento_id, contesto->'campi'->>'numero' as numero, " +
      "contesto->'campi'->>'pavimento' as pavimento, contesto->'campi'->>'contatore_prima' as contatore_prima, " +
      "contesto->'campi'->>'salto' as salto from public.app_log where evento = 'fattura' " +
      "and (contesto->'campi'->>'esito' = 'inviata' or contesto->'campi'->>'esito' like 'registro-%') order by creato_il",
    q6: `select sezionale, anno, numero, aruba_filename, creato_il from public.fatture_coda_invii where anno = ${anno}`,
  }
}

/** Il conteggio prima della scrittura (D1 §4.2 passo 5): il contatore è ancora quello letto? */
function sqlConteggioContatore(serie, anno, letto) {
  return `select count(*)::int as n from public.fatture_numerazione_sezionale where sezionale = '${serie}' and anno = ${anno} and ultimo_numero = ${letto}`
}

/* ────────────────────────────────────────────────────────────────────────────
 * Piccoli attrezzi
 * ──────────────────────────────────────────────────────────────────────────── */

/** @param {unknown} v @returns {number | null} */
function intero(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) ? n : null
}

/** @param {unknown} v @returns {string | null} */
function istanteIso(v) {
  if (v === null || v === undefined || v === '') return null
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** @param {number[]} numeri */
function massimo(numeri) {
  return numeri.length === 0 ? 0 : Math.max(...numeri)
}

/** @param {{ da: number, a: number }} i */
function testoIntervallo(i) {
  return i.da === i.a ? String(i.da) : `${i.da}-${i.a}`
}

/** @param {string} sha */
function corto(sha) {
  return typeof sha === 'string' ? sha.slice(0, 8) : String(sha)
}

/** L'anno dell'orologio di Roma: a Capodanno fa fede l'ora italiana, non quella UTC. */
function annoDiRoma(d) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric' }).format(d))
}

/**
 * Un file in `--out`, SEMPRE 0600: `mode` di `writeFileSync` vale solo alla creazione, quindi
 * dopo si forza anche con `chmod`.
 */
function salva(cartella, nome, contenuto) {
  const percorso = join(cartella, nome)
  writeFileSync(percorso, contenuto, { mode: 0o600 })
  chmodSync(percorso, 0o600)
  return percorso
}

/** Il documento di Aruba nei file: SOLO questi campi. `sender` e `receiver` non passano mai. */
function documentoPerIlFile(d) {
  return {
    filename: typeof d?.filename === 'string' ? d.filename : null,
    creationDate: d?.creationDate ?? null,
    lastUpdate: d?.lastUpdate ?? null,
    signed: Boolean(d?.signed),
    unsignedFile: Boolean(d?.unsignedFile),
    fatture: (Array.isArray(d?.fatture) ? d.fatture : []).map((f) => ({
      numero: typeof f?.numero === 'string' || typeof f?.numero === 'number' ? f.numero : null,
      stato: typeof f?.stato === 'string' || typeof f?.stato === 'number' ? f.stato : null,
      data: typeof f?.data === 'string' ? f.data : null,
    })),
  }
}

/**
 * Dall'XML di un documento fuori app, i soli codici e numeri (D1 §3.3 uscita 6): tipo, numero,
 * data, soggetto emittente, progressivo d'invio. Niente anagrafiche, niente codici fiscali:
 * l'XML intero non si salva.
 */
export function campiXmlFuoriApp(xml) {
  const testo = String(xml ?? '')
  const tag = (dentro, nome) => {
    const m = new RegExp(`<(?:[A-Za-z0-9_]+:)?${nome}>([^<]{0,80})</(?:[A-Za-z0-9_]+:)?${nome}>`).exec(dentro)
    return m ? m[1].trim() : null
  }
  const blocco = /<(?:[A-Za-z0-9_]+:)?DatiGeneraliDocumento>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?DatiGeneraliDocumento>/.exec(testo)
  const generali = blocco ? blocco[1] : ''
  return {
    tipoDocumento: tag(generali, 'TipoDocumento'),
    numero: tag(generali, 'Numero'),
    data: tag(generali, 'Data'),
    soggettoEmittente: tag(testo, 'SoggettoEmittente'),
    progressivoInvio: tag(testo, 'ProgressivoInvio'),
  }
}

/** La finestra di D1 §2.4 in cui cade un istante, oppure `null`. */
function finestraDi(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const f = FINESTRE_FUORI_APP.find((w) => Date.parse(w.da) <= t && t < Date.parse(w.a))
  return f ? f.nome : null
}

/* ────────────────────────────────────────────────────────────────────────────
 * I deploy di produzione, da gh (P7)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * L'elenco dei deploy di produzione, con l'istante del loro PRIMO status `success`. Gli status
 * si leggono uno per deploy, dal più recente al più vecchio, solo quanto basta a coprire
 * l'istante chiesto (`fino`), e restano in memoria fra una richiesta e l'altra.
 *
 * @param {(args: string[]) => string} gh
 */
function creaElencoDeploy(gh) {
  const grezzo = JSON.parse(String(gh(['api', `repos/${REPO_GITHUB}/deployments?environment=Production&per_page=100`])))
  if (!Array.isArray(grezzo)) throw new Error('gh api deployments: risposta non tabellare')
  const produzione = grezzo
    .filter((d) => d && typeof d === 'object' && /^production$/i.test(String(d.environment)) && /^[0-9a-f]{7,40}$/i.test(String(d.sha)))
    .filter((d) => Number.isFinite(Date.parse(d.created_at)))
    .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))
  /** @type {Map<unknown, string | null>} */
  const successi = new Map()

  function successo(d) {
    if (!successi.has(d.id)) {
      const stati = JSON.parse(String(gh(['api', `repos/${REPO_GITHUB}/deployments/${d.id}/statuses?per_page=100`])))
      if (!Array.isArray(stati)) throw new Error('gh api statuses: risposta non tabellare')
      const tempi = stati
        .filter((s) => s && s.state === 'success')
        .map((s) => Date.parse(s.created_at))
        .filter((t) => Number.isFinite(t))
      successi.set(d.id, tempi.length > 0 ? new Date(Math.min(...tempi)).toISOString() : null)
    }
    return successi.get(d.id) ?? null
  }

  return {
    /** @param {string} istante @returns {{ sha: string, istante: string | null, ambiente: string }[]} */
    fino(istante) {
      const limite = Date.parse(istante)
      const out = []
      let soglia = null
      for (const d of produzione) {
        if (soglia !== null && Date.parse(d.created_at) < soglia) break
        const quando = successo(d)
        out.push({ sha: String(d.sha), istante: quando, ambiente: String(d.environment) })
        if (soglia === null && quando !== null && Date.parse(quando) <= limite) soglia = Date.parse(quando) - MARGINE_DEPLOY_MS
      }
      return out
    },
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * main
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * @typedef {{
 *   sql: (testo: string) => Promise<any[]>,
 *   scrivi: (testo: string) => Promise<any[]>,
 *   aruba: any,
 *   git: (args: string[]) => { codice: number, stdout?: string },
 *   gh: (args: string[]) => string,
 *   guardia: (p: { sql: (testo: string) => Promise<any[]> }) => Promise<any>,
 *   stampa: (testo: string) => void,
 *   adesso: () => Date,
 * }} Dipendenze
 */

/**
 * Legge e controlla gli argomenti. Restituisce `{ errore }` al primo problema: nessuna
 * dipendenza è ancora stata toccata.
 *
 * @param {string[]} argv
 * @param {Date} adesso
 */
function leggiArgomenti(argv, adesso) {
  let valori
  try {
    ;({ values: valori } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        out: { type: 'string' },
        anno: { type: 'string' },
        'xml-fuori-app': { type: 'boolean', default: false },
        allinea: { type: 'boolean', default: false },
        serie: { type: 'string' },
        a: { type: 'string' },
      },
    }))
  } catch (e) {
    return { errore: `argomenti non validi: ${e instanceof Error ? e.message : String(e)}` }
  }
  const anno = valori.anno === undefined ? annoDiRoma(adesso) : intero(valori.anno)
  if (anno === null || anno < 2000 || anno > 2100) return { errore: '--anno deve essere un anno fra 2000 e 2100' }
  const allinea = valori.allinea === true
  if (!allinea && (valori.serie !== undefined || valori.a !== undefined)) {
    return { errore: '--serie e --a valgono solo con --allinea' }
  }
  let serie = null
  let a = null
  if (allinea) {
    if (!SERIE.includes(String(valori.serie))) return { errore: `--allinea vuole --serie ${SERIE.join('|')}` }
    serie = String(valori.serie)
    if (typeof valori.a !== 'string' || !/^\d{1,9}$/.test(valori.a)) return { errore: '--allinea vuole --a <numero intero>' }
    a = Number(valori.a)
  }
  return { out: valori.out, anno, xml: valori['xml-fuori-app'] === true, allinea, serie, a }
}

/**
 * L'indagine (e, con `--allinea`, l'unica scrittura). Restituisce il codice d'uscita.
 *
 * @param {string[]} argv
 * @param {Dipendenze} deps
 * @returns {Promise<number>}
 */
export async function main(argv, deps) {
  const { stampa } = deps
  const adesso = deps.adesso()
  const adessoIso = adesso.toISOString()
  const marca = adessoIso.replace(/[:.]/g, '-')

  // 0. Argomenti e --out: PRIMA di qualunque chiamata.
  const opz = leggiArgomenti(argv, adesso)
  if ('errore' in opz) {
    stampa(`${opz.errore}\n${USO}`)
    return 1
  }
  let out
  try {
    out = rifiutaOutNelRepository(opz.out)
  } catch (e) {
    stampa(e instanceof Error ? e.message : String(e))
    return 1
  }
  mkdirSync(out, { recursive: true, mode: 0o700 })

  const { anno } = opz
  let fase = 'avvio'
  /** Annota l'interruzione accanto ai parziali già salvati. */
  const interrompi = (codice, messaggio, uscita) => {
    salva(out, `interrotto-${marca}.json`, `${JSON.stringify({ fase, codice, messaggio, uscita, istante: adessoIso }, null, 2)}\n`)
    stampa(messaggio)
    stampa(`Interrotto nella fase «${fase}»: i risultati parziali sono in --out. Uscita ${uscita}.`)
    return uscita
  }

  try {
    // 1. Il predicato delle orfane, dal modulo TS.
    fase = 'predicato'
    const predicato = await caricaPredicato()

    // 2. Letture dal DB (Q1-Q6).
    fase = 'letture-db'
    const q = sqlLetture(anno, predicato)
    const esisteRiga = (await deps.sql(SQL_GIORNALE_ESISTE))[0]
    if (!esisteRiga || typeof esisteRiga.giornale !== 'boolean') {
      return interrompi('lettura-fallita', "Non so se il giornale della coda esiste: l'indagine non parte.", 1)
    }
    const giornaleEsiste = esisteRiga.giornale
    const contatori = await deps.sql(q.q1)
    const registro = await deps.sql(q.q2)
    const orfane = await deps.sql(q.q3)
    const scorrimenti = await deps.sql(q.q4)
    const esitiApp = await deps.sql(q.q5)
    const giornale = giornaleEsiste ? await deps.sql(q.q6) : null
    salva(
      out,
      `estrazione-db-${anno}-${marca}.json`,
      `${JSON.stringify({ anno, giornaleEsiste, contatori, registro, orfane, giornale, scorrimenti, esitiApp }, null, 2)}\n`,
    )

    // 3. Prima di Aruba, senza --allinea: rif esiste ed è antenato di HEAD (guardia d'uso).
    /** @type {ReturnType<typeof creaElencoDeploy> | null} */
    let elencoDeploy = null
    let rif = null
    if (!opz.allinea) {
      fase = 'rif'
      elencoDeploy = creaElencoDeploy(deps.gh)
      rif = deployAttivoAl(elencoDeploy.fino(adessoIso), adessoIso)
      const rifOk =
        rif !== null &&
        deps.git(argomentiGit('esiste', { rif })).codice === 0 &&
        deps.git(argomentiGit('antenato', { rif })).codice === 0
      if (!rifOk) {
        return interrompi(
          'rif',
          `Il deploy di produzione attivo adesso (${rif ? corto(rif) : 'nessuno'}) non è un antenato di HEAD in questo ` +
            'clone: aggiorna il branch o fai fetch, poi rilancia.',
          1,
        )
      }
    }

    // 4. Aruba: la guardia prima di OGNI chiamata.
    const chiamaAruba = async (operazione) => {
      const g = await deps.guardia({ sql: deps.sql })
      if (!g || g.ok !== true) {
        throw new FermoAruba(g?.codice ?? 'lettura-fallita', g?.messaggio ?? 'Guardia Aruba senza esito: lo script non parte.', {
          riprova_dopo: g?.riprova_dopo,
        })
      }
      return operazione()
    }
    fase = 'aruba-signin'
    await chiamaAruba(() => deps.aruba.signin())
    fase = 'aruba-scorrimento'
    const letti = await chiamaAruba(() => deps.aruba.scorriDocumenti({ anno }))
    const documentiAruba = (Array.isArray(letti?.documenti) ? letti.documenti : []).map(documentoPerIlFile)
    salva(
      out,
      `documenti-aruba-${anno}-${marca}.json`,
      `${JSON.stringify({ anno, totale: letti?.totale ?? null, pagine: letti?.pagine ?? null, documenti: documentiAruba }, null, 2)}\n`,
    )

    // 5. Analisi, tutta in funzioni pure.
    fase = 'analisi'
    const fattureInPiu = documentiAruba.filter((d) => d.fatture.length > 1).length
    const classificazione = classifica({
      documenti: documentiAruba.map((d) => ({
        filename: d.filename,
        creato: d.creationDate,
        etichetta: d.fatture[0]?.numero ?? null,
      })),
      registro,
      giornale,
      orfane,
      anno,
    })
    const { classificati } = classificazione
    const fuoriApp = classificati.filter((d) => d.origine === 'fuori-app')

    // Le allocazioni dell'app: registro, giornale e orfane (col numero letto su Aruba).
    /** @type {Map<string, { serie: string, numero: number, istante: string }>} */
    const allocate = new Map()
    const aggiungi = (serie, numero, istante) => {
      const n = intero(numero)
      const t = istanteIso(istante)
      if (!SERIE.includes(serie) || n === null || n <= 0 || t === null) return
      const chiave = `${serie}\u0000${n}`
      const gia = allocate.get(chiave)
      if (!gia || Date.parse(t) < Date.parse(gia.istante)) allocate.set(chiave, { serie, numero: n, istante: t })
    }
    for (const r of registro) aggiungi(r.sezionale, r.numero, r.creato_il)
    for (const r of giornale ?? []) aggiungi(r.sezionale, r.numero, r.creato_il)
    let orfaneSenzaDocumento = 0
    for (const o of orfane) {
      const doc = classificati.find((d) => d.origine === 'orfana' && d.filename === o.fattura_aruba_id)
      if (doc) aggiungi(doc.serie, doc.numero, o.fattura_emessa_il ?? doc.creato)
      else orfaneSenzaDocumento++
    }
    const allocazioni = allocazioniConContatore([...allocate.values()])
    const salti = attribuisciSalti({ allocazioni, fuoriApp, anno })
    const saltiNonSpiegati = salti.filter((s) => !s.spiegato).length
    const trovatiDoppioni = doppioni(classificati)

    const perSerie = SERIE.map((serie) => {
      const della = classificati.filter((d) => d.serie === serie)
      const contatoreRiga = contatori.find((c) => c.sezionale === serie && intero(c.anno) === anno)
      const contatore = contatoreRiga ? intero(contatoreRiga.ultimo_numero) : null
      const massimoAruba = massimo(della.map((d) => d.numero))
      const massimoRegistro = massimo(registro.filter((r) => r.sezionale === serie).map((r) => intero(r.numero) ?? 0))
      const massimoGiornale = giornaleEsiste
        ? massimo((giornale ?? []).filter((r) => r.sezionale === serie).map((r) => intero(r.numero) ?? 0))
        : null
      const obiettivo = obiettivoContatore({
        massimoAruba,
        massimoRegistro,
        massimoGiornale,
        contatore: contatore ?? -1,
        richiesto: opz.allinea && opz.serie === serie ? opz.a : null,
        saltiNonSpiegati,
        doppioni: trovatiDoppioni.length,
      })
      return {
        serie,
        app: della.filter((d) => d.origine === 'app').length,
        daRegistro: della.filter((d) => d.fonte === 'registro').length,
        daGiornale: della.filter((d) => d.fonte === 'giornale').length,
        orfane: della.filter((d) => d.origine === 'orfana').length,
        fuoriApp: della.filter((d) => d.origine === 'fuori-app').length,
        massimoAruba,
        massimoRegistro,
        massimoGiornale,
        contatore,
        ultimoNumeroVero: obiettivo.obiettivo,
        pavimentoMenoContatore: contatore === null ? null : massimoAruba - contatore,
        buchi: buchi(della.map((d) => d.numero)),
        obiettivo,
      }
    })

    const fuoriPerFinestra = FINESTRE_FUORI_APP.map((w) => ({
      finestra: w.nome,
      documenti: fuoriApp.filter((d) => finestraDi(d.creato) === w.nome).length,
    }))

    // A terminale: solo numeri.
    stampa(
      `Numerazione ${anno}: ${registro.length} righe a registro, ${orfane.length} orfane ` +
        `(${orfaneSenzaDocumento} senza documento su Aruba), giornale ${giornaleEsiste ? `${(giornale ?? []).length} invii` : 'assente'}, ` +
        `${documentiAruba.length} documenti su Aruba.`,
    )
    for (const s of perSerie) {
      stampa(
        `Serie ${s.serie}: app ${s.app} (registro ${s.daRegistro}, giornale ${s.daGiornale}), orfane ${s.orfane}, ` +
          `fuori app ${s.fuoriApp}; massimi Aruba ${s.massimoAruba}, registro ${s.massimoRegistro}, ` +
          `giornale ${s.massimoGiornale ?? '—'}; contatore ${s.contatore ?? '?'}; ultimo numero vero ` +
          `${s.ultimoNumeroVero ?? '?'}; pavimento − contatore ${s.pavimentoMenoContatore ?? '?'}`,
      )
      stampa(`  buchi ${s.serie}: ${s.buchi.map(testoIntervallo).join(', ') || 'nessuno'}`)
    }
    stampa(`Fuori app per finestra: ${fuoriPerFinestra.map((f) => `${f.finestra} ${f.documenti}`).join(', ')}`)
    for (const s of salti) {
      stampa(`Salto ${s.serie} ${s.contatore_prima} → ${s.numero} (${s.istante}): ${s.esito}`)
    }
    stampa(
      `Salti ${salti.length}, non spiegati ${saltiNonSpiegati}; doppioni ${trovatiDoppioni.length}; ` +
        `etichette illeggibili ${classificazione.illeggibili}` +
        (classificazione.formeIllegibili.length > 0
          ? ` (forme: ${classificazione.formeIllegibili.map((f) => `${f.forma} ×${f.casi}`).join(', ')})`
          : '') +
        `; documenti con più fatture ${fattureInPiu}; altra serie ${classificazione.altraSerie}; altro anno ${classificazione.altroAnno}`,
    )

    const dettaglio = {
      anno,
      istante: adessoIso,
      giornaleEsiste,
      serie: perSerie,
      salti,
      doppioni: trovatiDoppioni,
      fuoriApp: fuoriApp.map((d) => ({ filename: d.filename, creato: d.creato, serie: d.serie, numero: d.numero, finestra: finestraDi(d.creato) })),
      fuoriPerFinestra,
      illeggibili: classificazione.illeggibili,
      formeIllegibili: classificazione.formeIllegibili,
      altraSerie: classificazione.altraSerie,
      altroAnno: classificazione.altroAnno,
      fattureInPiu,
      orfaneSenzaDocumento,
      firme: {
        firmati: documentiAruba.filter((d) => d.signed).length,
        nonFirmati: documentiAruba.filter((d) => !d.signed).length,
        conFileNonFirmato: documentiAruba.filter((d) => d.unsignedFile).length,
      },
      p7: null,
      xmlFuoriApp: null,
    }
    const salvaDettaglio = () => salva(out, `numerazione-${anno}-${marca}.json`, `${JSON.stringify(dettaglio, null, 2)}\n`)
    salvaDettaglio()

    // ─── --allinea: una scrittura sola, a confronto-e-scambio (D1 §4.2-§4.3) ───
    if (opz.allinea) {
      fase = 'allinea'
      const s = perSerie.find((x) => x.serie === opz.serie)
      if (!s) return interrompi('serie', `Serie ${opz.serie} sconosciuta.`, 1)
      const { obiettivo } = s
      if (saltiNonSpiegati > 0 || trovatiDoppioni.length > 0) {
        return interrompi(
          'indagine-aperta',
          `RIFIUTO: ${saltiNonSpiegati} salti non spiegati e ${trovatiDoppioni.length} doppioni. Prima si chiude l'indagine.`,
          2,
        )
      }
      if (obiettivo.rifiuti.length > 0 || obiettivo.obiettivo === null || s.contatore === null) {
        return interrompi(
          'rifiuto',
          `RIFIUTO di --allinea ${opz.serie} ${anno} a ${opz.a}: ${obiettivo.rifiuti.join(', ') || 'contatore non letto'} ` +
            `(obiettivo ${obiettivo.obiettivo ?? '?'}, contatore ${s.contatore ?? '?'}).`,
          1,
        )
      }
      if (!obiettivo.scrivere) {
        stampa(`Contatore ${opz.serie} ${anno} già a ${s.contatore}, uguale all'obiettivo: nessuna scrittura.`)
        return 0
      }
      const letto = s.contatore
      const conteggio = await deps.sql(sqlConteggioContatore(opz.serie, anno, letto))
      if (intero(conteggio?.[0]?.n) !== 1) {
        return interrompi(
          'contatore-mosso',
          `Il contatore ${opz.serie} ${anno} non vale più ${letto}: qualcuno ha allocato nel frattempo. Nessuna scrittura: rilancia.`,
          1,
        )
      }
      const istruzione = componiAllineamento({
        serie: opz.serie,
        anno,
        letto,
        obiettivo: obiettivo.obiettivo,
        massimoAruba: s.massimoAruba,
        massimoRegistro: s.massimoRegistro,
        massimoGiornale: s.massimoGiornale,
        giornaleEsiste,
      })
      const mancanti = verificaConfrontoEScambio(istruzione, {
        serie: opz.serie,
        anno,
        letto,
        obiettivo: obiettivo.obiettivo,
        giornaleEsiste,
      })
      if (mancanti.length > 0) {
        return interrompi('istruzione', `L'istruzione non è a confronto-e-scambio (mancano: ${mancanti.join(', ')}): nessuna scrittura.`, 1)
      }
      stampa(`SCRIVO:\n${istruzione}`)
      const esito = await deps.scrivi(istruzione)
      const aggiornate = intero(esito?.[0]?.aggiornate)
      if (aggiornate !== 1) {
        return interrompi(
          'zero-righe',
          `${aggiornate ?? 0} righe aggiornate: il contatore è cambiato fra la lettura e la scrittura, oppure una riga sta sopra ` +
            `l'obiettivo. Nessun allineamento: rilancia.`,
          1,
        )
      }
      const riletti = await deps.sql(sqlContatori(anno))
      const riletto = intero(riletti.find((c) => c.sezionale === opz.serie)?.ultimo_numero)
      stampa(`Riletto: contatore ${opz.serie} ${anno} = ${riletto ?? '?'} (atteso ${obiettivo.obiettivo}).`)
      if (riletto !== obiettivo.obiettivo) {
        return interrompi('rilettura', `La rilettura non trova il contatore ${opz.serie} a ${obiettivo.obiettivo}.`, 1)
      }
      return 0
    }

    // 6. --xml-fuori-app: al più 20 documenti fuori app di F1-F4, uno alla volta.
    if (opz.xml) {
      fase = 'xml-fuori-app'
      const scelti = fuoriApp
        .filter((d) => FINESTRE_XML.includes(finestraDi(d.creato) ?? ''))
        .sort((x, y) => Date.parse(x.creato) - Date.parse(y.creato))
        .slice(0, MAX_XML_FUORI_APP)
      const letture = []
      dettaglio.xmlFuoriApp = letture
      try {
        for (const d of scelti) {
          const preso = await chiamaAruba(() => deps.aruba.getByFilename(d.filename))
          const xml = deps.aruba.estraiXml(preso.contenuto, { cartella: out })
          letture.push({ filename: d.filename, serie: d.serie, numeroSuAruba: d.numero, finestra: finestraDi(d.creato), ...campiXmlFuoriApp(xml) })
        }
      } finally {
        salva(out, `xml-fuori-app-${marca}.json`, `${JSON.stringify(letture, null, 2)}\n`)
        salvaDettaglio()
      }
      const discordi = letture.filter((l) => {
        const e = leggiEtichetta(l.numero)
        return !(e.tipo === 'serie' && e.serie === l.serie && e.numero === l.numeroSuAruba)
      }).length
      stampa(`XML fuori app letti ${letture.length} su ${scelti.length}; numero dell'XML diverso da quello di Aruba: ${discordi}`)
    }

    // 7. P7 contro rif (D1 §3.3): solo i salti dopo l'ultimo commit sui percorsi della numerazione.
    fase = 'p7'
    if (elencoDeploy === null || rif === null) throw new Error('P7 senza rif: stato impossibile')
    const ultimo = String(deps.git(argomentiGit('ultimoCommit', { rif })).stdout ?? '').trim()
    const dataUltimo = Date.parse(ultimo.split(' ')[1] ?? '')
    // Un salto di PRIMA dell'ultimo commit sui percorsi ha girato per forza con un codice diverso da
    // rif: confrontarlo renderebbe la P7 falsa per costruzione. Resta nell'attribuzione dei salti
    // (dove un «NON SPIEGATO» dà comunque uscita 2), e qui si elenca fra gli esclusi.
    const saltiP7 = Number.isFinite(dataUltimo) ? salti.filter((s) => Date.parse(s.istante) >= dataUltimo) : salti
    const esclusi = salti.filter((s) => !saltiP7.includes(s))
    const limite = saltiP7.reduce((m, s) => Math.min(m, Date.parse(s.istante)), Date.parse(adessoIso))
    const deploys = elencoDeploy.fino(new Date(limite).toISOString())
    const p7 = provaP7({ git: deps.git, deploys, salti: saltiP7, adesso: adessoIso })
    dettaglio.p7 = { ...p7, esclusi: esclusi.map((s) => ({ serie: s.serie, numero: s.numero, istante: s.istante })) }
    const righeP7 = [
      `rif ${p7.rif ?? '—'}`,
      `ultimo commit sui percorsi ${p7.ultimoCommit || '—'}`,
      `vero ${p7.vero} · uscita ${p7.uscita} · motivi ${p7.motivi.join(', ') || 'nessuno'}`,
      ...p7.perSalto.map((x) => `salto ${x.istante} · deploy ${x.deploy ?? '—'} · diff ${x.diff ?? '—'}`),
      ...esclusi.map((s) => `escluso (prima dell'ultimo commit) ${s.istante}`),
    ]
    salva(out, 'prova-codice-deploy.txt', `${righeP7.join('\n')}\n`)
    salvaDettaglio()
    stampa(
      `P7: ${p7.vero ? 'vera' : 'FALSA'} contro rif ${corto(p7.rif ?? '')} (salti confrontati ${saltiP7.length}, ` +
        `esclusi ${esclusi.length}${p7.motivi.length > 0 ? `; motivi ${p7.motivi.join(', ')}` : ''})`,
    )

    // 8. Prospetto per il commercialista e codice d'uscita.
    salva(out, `prospetto-numerazione-${anno}.txt`, prospetto({ anno, classificati, salti }))
    const motiviDue = []
    if (saltiNonSpiegati > 0) motiviDue.push('salti non spiegati')
    if (trovatiDoppioni.length > 0) motiviDue.push('doppioni')
    if (classificazione.illeggibili > 0 || fattureInPiu > 0) motiviDue.push('etichette illeggibili')
    if (p7.uscita === 2) motiviDue.push('P7 falsa')
    const uscita = motiviDue.length > 0 ? 2 : p7.uscita === 1 ? 1 : 0
    stampa(`Uscita ${uscita}${motiviDue.length > 0 ? ` (${motiviDue.join(', ')})` : ''}. Dettaglio e prospetto in --out.`)
    return uscita
  } catch (e) {
    if (e instanceof FermoAruba) return interrompi(e.codice, e.message, e.uscita ?? 1)
    const testo = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim().slice(0, 300)
    return interrompi('errore', `Errore: ${testo}`, 1)
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Avvio: solo quando il file è lanciato con `node`, con le dipendenze vere
 * ──────────────────────────────────────────────────────────────────────────── */

/** Le dipendenze vere. Ogni processo figlio parte con `execFileSync(cmd, args[])`, senza shell. */
function dipendenzeVere() {
  const sql = sqlDaCliSupabase()
  let lettore = null
  const lettoreAruba = () => {
    if (!lettore) lettore = creaLettoreAruba({ sql, credenziali: leggiCredenzialiAruba() })
    return lettore
  }
  return {
    sql,
    scrivi: sqlDaCliSupabase(),
    aruba: {
      signin: () => lettoreAruba().signin(),
      scorriDocumenti: (p) => lettoreAruba().scorriDocumenti(p),
      getByFilename: (f) => lettoreAruba().getByFilename(f),
      estraiXml: (contenuto, { cartella }) => estraiXmlDaP7m(contenuto, { cartella }),
    },
    git: (args) => {
      try {
        const stdout = execFileSync('git', args, { cwd: RADICE_REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false })
        return { codice: 0, stdout }
      } catch (e) {
        if (typeof e?.status === 'number') return { codice: e.status, stdout: String(e.stdout ?? '') }
        throw e
      }
    },
    gh: (args) =>
      execFileSync('gh', args, {
        cwd: RADICE_REPO,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      }),
    guardia: guardiaArubaPerScript,
    stampa: (testo) => process.stdout.write(`${testo}\n`),
    adesso: () => new Date(),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), dipendenzeVere())
}
