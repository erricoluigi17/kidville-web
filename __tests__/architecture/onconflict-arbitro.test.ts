import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { posterioriCheContengono, senzaCommenti, sogliaFotografia } from './soglia-fotografia'
import { CHIAVE_OVERRIDE, CHIAVE_ROTAZIONE } from '@/lib/mensa/chiave-menu'
import { CHIAVE_REGISTRO, CHIAVE_REGISTRO_LEGACY } from '@/lib/registro/chiave-orario'

/**
 * LOCK · ogni chiave di conflitto usata da un `.upsert()` di `src/` deve avere, nel database, un
 * indice UNIQUE **non parziale e senza espressioni** sulle stesse colonne.
 *
 * PERCHÉ ESISTE. `ON CONFLICT (colonne)` NON infersce un indice PARZIALE: Postgres pretende un
 * `WHERE` che implichi il predicato dell'indice, e PostgREST non ha modo di mandarlo — il
 * parametro è `on_conflict=<colonne>` e basta. Un upsert contro un indice parziale non è «un po'
 * fragile»: è `42P10` a OGNI chiamata, sempre, e nessun test coi mock lo vede perché il vincolo
 * vive nel database — un mock dice sempre di sì. Il 2026-09-05 la segreteria di Cesa ci ha
 * sbattuto contro nove volte cercando di caricare il menu della mensa; il 2026-09-01 era toccato
 * all'Armadietto. Terza volta che la categoria si ripresenta: da qui in poi la trova questo file,
 * non una persona che sta lavorando.
 *
 * Vale lo stesso, e per la stessa ragione, per un indice su ESPRESSIONE: `on_conflict=slug` non
 * infersce `UNIQUE (lower(slug))`. Senza il campo `con_espressioni` nella fotografia un indice
 * del genere si presenterebbe come `['slug']` — cioè come un arbitro che non è.
 *
 * IL LOCK GIRA OFFLINE. La sua unica sorgente di verità è la fotografia versionata, che porta un
 * `sha256` del contenuto (chi la addomestica a mano fa cadere il test) e un `generato_alle` (una
 * fotografia vecchia non sa più niente, e un lock che non sa niente è verde per costruzione).
 * VA RIGENERATA DOPO OGNI `apply_migration` che tocchi un indice UNIQUE:
 * `node __tests__/fixtures/indici-unici-fotografia.mjs --sql` → esegui → `… < risposta.json`.
 */

const RADICE = process.cwd()
const SRC = path.join(RADICE, 'src')
const MIGRAZIONI = path.join(RADICE, 'supabase', 'migrations')
const FOTO_PATH = path.join(RADICE, '__tests__/fixtures/indici-unici-snapshot.json')
const GENERATORE = path.join(RADICE, '__tests__/fixtures/indici-unici-fotografia.mjs')

/**
 * Le chiavi che vivono in una COSTANTE ESPORTATA invece che in una stringa letterale. Vanno
 * risolte importandole, non con una regex: sono le più importanti, perché una costante è
 * esattamente ciò che si scrive quando la chiave è delicata.
 */
const COSTANTI: Record<string, string> = {
  CHIAVE_ROTAZIONE,
  CHIAVE_OVERRIDE,
  CHIAVE_REGISTRO,
  CHIAVE_REGISTRO_LEGACY,
}

/**
 * Chiavi che NON devono avere un arbitro in produzione, con la ragione scritta.
 * Una sola voce, e non è un'eccezione di comodo: `CHIAVE_REGISTRO_LEGACY` esiste apposta per il
 * database E2E della CI, che è un progetto separato e non migrato — là il vincolo del registro
 * non ha ancora `scuola_id`. In produzione quella chiave NON deve trovare niente: se un giorno lo
 * trovasse, vorrebbe dire che il vincolo senza sede è tornato, cioè la falla multi-sede del
 * 2026-07-30 (il «2 ANNI» di Aversa e quello di Cesa sulla stessa riga di registro).
 */
const SENZA_ARBITRO_ATTESO = [{ tabella: 'registro_orario', chiave: CHIAVE_REGISTRO_LEGACY }]

type Chiave = { file: string; riga: number; tabella: string; chiave: string }

function filesTs(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...filesTs(full))
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/**
 * Le `const NOME = 'valore'` dichiarate NEL FILE.
 *
 * Un dizionario globale nome→valore non basterebbe, e non per pedanteria: `TABELLA` vale
 * `anagrafica_personale` in `admin/anagrafica-personale`, `pratiche_personale` in
 * `admin/pratiche-personale`, `candidature_insegnanti` in `admin/candidature-insegnanti`. Lo
 * stesso nome, tre tabelle diverse: risolverlo fuori dal suo file significa confrontare la chiave
 * di una route con gli indici di un'altra tabella — cioè un verde per caso.
 */
function costantiDelFile(testo: string): Record<string, string> {
  const m: Record<string, string> = {}
  const forma = /^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*(?::\s*[^=]+)?=\s*['"`]([^'"`]*)['"`]/gm
  for (const r of testo.matchAll(forma)) m[r[1]] = r[2]
  return m
}

/**
 * Il testo fra la `(` di `.upsert(` e la parentesi che la CHIUDE, saltando le stringhe.
 *
 * Il primo tentativo cercava `onConflict` in una finestra di dieci righe, e su
 * `src/lib/fea/slots.ts` l'ha mancato per una riga: il payload era lungo undici. Una chiamata
 * saltata non fa rumore — il setaccio la classifica come «senza `onConflict`, arbitra la chiave
 * primaria» e passa oltre. Un lock cieco è verde, ed è il modo più silenzioso di non controllare
 * niente: la finestra arbitraria è stata sostituita dal confine vero della chiamata.
 */
function corpoChiamata(testo: string, aperta: number): string {
  let livello = 0
  let i = aperta
  let dentro: string | null = null
  while (i < testo.length) {
    const c = testo[i]
    if (dentro) {
      if (c === '\\') { i += 2; continue }
      if (c === dentro) dentro = null
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') { dentro = c; i++; continue }
    if (c === '(') livello++
    else if (c === ')') { livello--; if (livello === 0) return testo.slice(aperta + 1, i) }
    i++
  }
  return testo.slice(aperta + 1)
}

/** Chiamate `.upsert(` la cui tabella o la cui chiave non si è riusciti a risolvere. */
const nonRisolte: Chiave[] = []
/** Chiamate `.upsert(` senza `onConflict`: l'arbitro è la chiave primaria, e c'è sempre. */
const senzaChiave: Chiave[] = []

function chiaviDaSrc(): Chiave[] {
  nonRisolte.length = 0
  senzaChiave.length = 0
  const out: Chiave[] = []
  for (const f of filesTs(SRC)) {
    const testo = fs.readFileSync(f, 'utf8')
    const righe = testo.split('\n')
    const locali = costantiDelFile(testo)
    for (const m of testo.matchAll(/\.upsert\(/g)) {
      const pos = m.index ?? 0
      const numRiga = testo.slice(0, pos).split('\n').length
      const i = numRiga - 1
      // Le righe di COMMENTO che nominano un upsert non sono chiamate.
      if (/^\s*(\*|\/\/)/.test(righe[i])) continue

      let tabella: string | null = null
      for (let j = i; j >= Math.max(0, i - 8); j--) {
        const lett = righe[j].match(/\.from\(\s*['"`]([A-Za-z0-9_]+)['"`]\s*\)/)
        if (lett) { tabella = lett[1]; break }
        const cost = righe[j].match(/\.from\(\s*([A-Za-z0-9_]+)\s*\)/)
        if (cost) { tabella = locali[cost[1]] ?? `NON_RISOLTA:${cost[1]}`; break }
      }

      const corpo = corpoChiamata(testo, pos + m[0].length - 1)
      let chiave: string | null = null
      const lett = corpo.match(/onConflict:\s*['"`]([^'"`]+)['"`]/)
      if (lett) chiave = lett[1]
      else {
        const cost = corpo.match(/onConflict:\s*([A-Za-z0-9_]+)/)
        if (cost) chiave = COSTANTI[cost[1]] ?? locali[cost[1]] ?? `NON_RISOLTA:${cost[1]}`
      }

      const voce: Chiave = { file: path.relative(RADICE, f), riga: numRiga, tabella: tabella ?? '?', chiave: chiave ?? '' }
      // Nessun `onConflict` ⇒ l'arbitro è la chiave primaria: sempre presente, niente da provare.
      if (chiave === null) { senzaChiave.push(voce); continue }
      if (!tabella || tabella.startsWith('NON_RISOLTA:') || chiave.startsWith('NON_RISOLTA:')) {
        nonRisolte.push(voce)
        continue
      }
      out.push(voce)
    }
  }
  return out
}

type Indice = {
  tabella: string
  indice: string
  parziale: boolean
  con_espressioni: boolean
  nulls_not_distinct: boolean
  colonne: string[]
}
// `generato_il` NON è opzionale: `sogliaFotografia` lo pretende (vedi ./soglia-fotografia).
type Foto = { generato_il: string; generato_alle?: string | null; sha256: string; indici: Indice[] }

const foto: Foto = JSON.parse(fs.readFileSync(FOTO_PATH, 'utf8'))

/** Le colonne di una chiave, come insieme ordinato: `ON CONFLICT` non guarda l'ordine. */
const insieme = (cols: string) => [...cols.split(',').map((c) => c.trim())].sort().join(',')

/** Questo indice può fare da arbitro per questa chiave? */
const arbitra = (i: Indice, tabella: string, chiave: string) =>
  i.tabella === tabella &&
  !i.parziale &&
  !i.con_espressioni &&
  [...i.colonne].sort().join(',') === insieme(chiave)

const COME_RIGENERARE =
  'Rigenera la fotografia: `node __tests__/fixtures/indici-unici-fotografia.mjs --sql` → esegui ' +
  'la query sul DB → `node __tests__/fixtures/indici-unici-fotografia.mjs < risposta.json`.'

describe('ogni onConflict ha un arbitro non parziale', () => {
  it('la fotografia non è stata addomesticata a mano (sha256)', () => {
    // Stesse chiavi e stesso ordine di `normalizza()` in indici-unici-fotografia.mjs:
    // l'impronta copre il contenuto, non i metadati (`generato_il`, `generato_alle`, `sha256`).
    const contenuto = { indici: foto.indici }
    const atteso = createHash('sha256').update(JSON.stringify(contenuto)).digest('hex')
    expect(
      foto.sha256,
      `Il contenuto della fotografia non corrisponde al suo sha256: qualcuno l'ha modificata a ` +
      `mano invece di rigenerarla — cioè ha fatto tacere il lock invece di guardare il database. ` +
      COME_RIGENERARE,
    ).toBe(atteso)
  })

  it('la fotografia non è più vecchia dell’ultima migrazione applicata', () => {
    const soglia = sogliaFotografia(foto)
    // Si guarda lo SQL, non la prosa: una migrazione che nel commento dichiara di NON toccare un
    // vincolo lo nomina comunque, e un guard che misura la spiegazione paga chi commenta di meno.
    // Il riconoscimento è LARGO di proposito — anche una PRIMARY KEY entra nella fotografia — e
    // un falso allarme costa una rigenerazione, che è l'unico momento in cui qualcuno guarda
    // davvero se repo e database dicono la stessa cosa.
    const posteriori = posterioriCheContengono(MIGRAZIONI, soglia, (sql) => {
      const istruzioni = senzaCommenti(sql)
      return /\bunique\b/i.test(istruzioni) || /\bprimary\s+key\b/i.test(istruzioni)
    })
    expect(
      posteriori,
      `Queste migrazioni toccano un indice UNIQUE e sono POSTERIORI alla fotografia ` +
      `(${foto.generato_alle ?? foto.generato_il}): il lock starebbe confrontando le chiavi di ` +
      `oggi con gli indici di ieri, cioè non starebbe controllando niente. ${COME_RIGENERARE}`,
    ).toEqual([])
  })

  it('ogni upsert di src/ è stato risolto (tabella e chiave)', () => {
    chiaviDaSrc()
    expect(
      nonRisolte,
      `Di questi upsert non si è capito su quale tabella scrivono o con quale chiave. Saltarli ` +
      `renderebbe il lock cieco proprio dove il codice è meno leggibile: dai un nome risolvibile ` +
      `alla costante (una \`const NOME = 'tabella'\` nello stesso file), oppure aggiungila a ` +
      `COSTANTI in questo file.`,
    ).toEqual([])
  })

  it('nessuna chiave di conflitto punta a un indice parziale o inesistente', () => {
    const attese = new Set(SENZA_ARBITRO_ATTESO.map((v) => `${v.tabella}|${insieme(v.chiave)}`))
    const orfane = chiaviDaSrc()
      .filter((k) => !attese.has(`${k.tabella}|${insieme(k.chiave)}`))
      .filter((k) => !foto.indici.some((i) => arbitra(i, k.tabella, k.chiave)))
    expect(
      orfane,
      `Queste chiavi di conflitto non hanno, nel database, un indice UNIQUE NON PARZIALE e senza ` +
      `espressioni sulle stesse colonne: ogni chiamata torna 42P10 e nessun test coi mock se ne ` +
      `accorge. Il rimedio NON è aggiungere un'eccezione qui: è una migrazione che crei l'indice ` +
      `(se la colonna può essere NULL, con NULLS NOT DISTINCT). ${JSON.stringify(orfane, null, 2)}`,
    ).toEqual([])
  })

  it('le eccezioni dichiarate sono ancora eccezioni (se cade, un vincolo è cambiato)', () => {
    const usate = chiaviDaSrc()
    for (const v of SENZA_ARBITRO_ATTESO) {
      const trovato = foto.indici.some((i) => arbitra(i, v.tabella, v.chiave))
      expect(
        trovato,
        `\`${v.chiave}\` su ${v.tabella} ADESSO ha un arbitro in produzione. Era il ripiego per il ` +
        `DB E2E non migrato, e in produzione non doveva trovare niente: se lo trova, il vincolo ` +
        `senza sede è tornato — è la falla multi-sede del 2026-07-30.`,
      ).toBe(false)
      // Un'esenzione che sopravvive al suo motivo è un buco che nessuno ricorda di aver aperto.
      expect(
        usate.some((k) => k.tabella === v.tabella && insieme(k.chiave) === insieme(v.chiave)),
        `Nessun upsert di src/ usa più \`${v.chiave}\` su ${v.tabella}: togli la voce da ` +
        `SENZA_ARBITRO_ATTESO invece di lasciarla a coprire codice che non esiste.`,
      ).toBe(true)
    }
  })

  it('la fotografia viene dal DATABASE, non dal codice che il lock controlla', () => {
    // Se la fotografia si ricavasse leggendo `src/`, questo file confronterebbe il codice con se
    // stesso: verde per costruzione, cioè nessun controllo.
    const codice = fs.readFileSync(GENERATORE, 'utf8')
    for (const vietato of ['readdirSync', "'src'", 'onConflict']) {
      expect(
        codice.includes(vietato),
        `Il generatore della fotografia contiene «${vietato}»: se ricavasse gli indici dal codice ` +
        `invece che dal catalogo del database, questo lock non verificherebbe più niente.`,
      ).toBe(false)
    }
    expect(
      codice.includes('pg_index'),
      'Il generatore non nomina `pg_index`: da dove verrebbe la fotografia?',
    ).toBe(true)
  })

  it('ci sono chiavi da controllare (se cade, il lock si sta autoingannando)', () => {
    // Misurati il 2026-09-06: 63 chiamate `.upsert()` in `src/`, tutte con un `onConflict`
    // risolto, e 215 indici UNIQUE in produzione. Le soglie stanno APPENA sotto la misura: un
    // setaccio che smette di trovare gli upsert, o una fotografia che si svuota, passerebbero
    // entrambi in silenzio — sono i due modi in cui questo lock potrebbe non controllare niente.
    const chiavi = chiaviDaSrc()
    expect(chiavi.length, `upsert con onConflict risolti: ${chiavi.length}`).toBeGreaterThan(60)
    expect(senzaChiave.length, `upsert senza onConflict: ${senzaChiave.length}`).toBeLessThan(3)
    expect(foto.indici.length, `indici nella fotografia: ${foto.indici.length}`).toBeGreaterThan(200)
  })
})
