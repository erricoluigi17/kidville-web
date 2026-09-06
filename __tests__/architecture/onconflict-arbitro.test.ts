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
 *
 * ─── TRE COSE CHE IL SETACCIO FA DIVERSAMENTE DA COME SEMBREREBBE OVVIO ───────
 *
 * Tutte e tre nascono da un primo giro che era CIECO, e ognuna chiude un modo in cui questo lock
 * sarebbe stato verde senza controllare niente. Il dettaglio sta accanto al codice che le
 * applica; qui c'è l'elenco, perché fra sei mesi il perché vale quanto il come.
 *
 *  1. **Il confine di una chiamata sono le sue PARENTESI, non dieci righe.** Cercare `onConflict`
 *     in una finestra di dieci righe sotto `.upsert(` mancava `src/lib/fea/slots.ts` per una riga
 *     sola (il payload era di undici). Una chiamata mancata non fa rumore: il setaccio la
 *     classificava «senza `onConflict`, arbitra la chiave primaria» e passava oltre. Vedi
 *     `corpoChiamata()`.
 *  2. **Le costanti di tabella si risolvono NEL FILE, non con una mappa globale.** `TABELLA` vale
 *     tre tabelle diverse in tre route diverse: risolverla fuori dal suo file significa
 *     confrontare la chiave di una route con gli indici di un'altra tabella, cioè un verde per
 *     caso. Vedi `costantiDelFile()`.
 *  3. **Un indice non è un arbitro solo perché è UNIQUE.** Non lo è se è parziale, se è su
 *     ESPRESSIONE (`UNIQUE (lower(slug))` si presenterebbe come `['slug']`), se è rimasto
 *     `indisvalid = false`, e le sue colonne sono le sole CHIAVE — quelle in `INCLUDE` stanno in
 *     `indkey` ma non fanno parte dell'unicità. La query della fotografia li distingue tutti e
 *     quattro: vedi il commento sopra `SQL` in `indici-unici-fotografia.mjs`.
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
 * Chiavi che in produzione NON trovano un arbitro, e per cui va bene così — ognuna col suo
 * `perche`, che finisce nel messaggio d'errore il giorno in cui la voce smette di essere vera.
 *
 * ⚠️ LE DUE VOCI NON SONO LA STESSA COSA, e la lista sarebbe fuorviante se lo lasciasse credere:
 *
 *  · `registro_orario` è un ripiego **voluto e funzionante**. La sua voce è una sentinella: serve
 *    a far cadere il lock se un giorno quella chiave un arbitro lo trovasse.
 *  · `daily_routines` è un **difetto vivo**, dichiarato qui solo perché il rimedio non sta né in
 *    un'eccezione né in una migrazione, ma nel codice che chiama.
 *
 * Una voce si toglie quando sparisce la sua ragione — che è scritta dentro `perche`, e non è
 * sempre «l'indice adesso c'è».
 */
const SENZA_ARBITRO_ATTESO: { tabella: string; chiave: string; perche: string }[] = [
  {
    tabella: 'registro_orario',
    chiave: CHIAVE_REGISTRO_LEGACY,
    perche:
      'Ripiego VOLUTO per il database E2E della CI, che è un progetto separato e non migrato: là ' +
      'il vincolo del registro non ha ancora `scuola_id`, e senza questo secondo tentativo ' +
      'l’upsert non troverebbe nessun vincolo. In produzione il vincolo con la sede esiste e il ' +
      'ripiego non scatta mai, quindi qui NON deve trovare niente: se lo trovasse, vorrebbe dire ' +
      'che il vincolo senza sede è tornato — è la falla multi-sede del 2026-07-30, il «2 ANNI» di ' +
      'Aversa e quello di Cesa sulla stessa riga di registro. La voce si toglie il giorno in cui ' +
      'il DB E2E viene migrato e il ripiego sparisce da `src/`.',
  },
  {
    tabella: 'daily_routines',
    chiave: 'id',
    perche:
      'NON è «manca un indice»: è «manca la TABELLA», e nemmeno il codice che ci scrive è vivo. ' +
      '`daily_routines` non esiste nel database di produzione — misurato il 2026-09-06 su ' +
      '`pg_class`, zero righe — e nessuna migrazione la crea; il diario vero del prodotto è ' +
      '`eventi_diario`. `src/app/api/diary/route.ts` (righe 15-25) lo documenta dal 2026-08-04, ma ' +
      'solo per la ROUTE, che infatti degrada come si deve (503 dichiarato). ' +
      'A scrivere qui è `src/lib/offline/syncEngine.ts:142`, ed è CODICE MORTO DUE VOLTE, ' +
      'misurato il 2026-09-06: `saveLocalDiaryEntry` (:97) non ha nessun chiamante in `src/` né ' +
      'in `__tests__/`; `syncPendingDiaryEntries` (:112) ha come unico chiamante proprio quella ' +
      'funzione morta; e `db.diario` viene scritto SOLO dentro di essa, quindi anche se qualcuno ' +
      'la chiamasse la coda sarebbe vuota e si uscirebbe al `if (pending.length === 0) return` ' +
      'di :125, PRIMA dell’upsert. ' +
      '⚠️ QUINDI NON C’È NESSUNA PERDITA DI DATI IN CORSO, e va detto perché la lettura opposta ' +
      'sarebbe allarmante e falsa. Non è nemmeno il caso di «fallisce ma non si vede»: `logSync` ' +
      'funziona, ed è dimostrato dal suo gemello — in `app_log` c’è `sync-galleria-fallito` ' +
      '(1 occorrenza, 2026-09-01) prodotto dalla STESSA `logSync` nello STESSO file. Lo zero di ' +
      '`sync-diario-fallito` significa «non parte», non «non si vede». ' +
      '⚠️ IL RIMEDIO NON È CREARE LA TABELLA, ed è per questo che la voce sta qui invece che nei ' +
      'Task delle migrazioni: è CANCELLARE `saveLocalDiaryEntry` e `syncPendingDiaryEntries` ' +
      '(valutando anche `db.diario`), che è un commit di poche righe e chiude anche questa voce. ' +
      'Non c’è niente da collaudare: non c’è niente che gira. Resta fuori dallo scopo della ' +
      'correzione della mensa, quindi è scritto qui invece che fatto. ' +
      'QUESTA VOCE SI TOGLIE QUANDO QUEL CODICE MORTO SPARISCE, non quando la tabella viene creata.',
  },
]

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
 * Il testo fra la `(` di `.upsert(` e la parentesi che la CHIUDE, saltando stringhe e commenti.
 *
 * Il primo tentativo cercava `onConflict` in una finestra di dieci righe, e su
 * `src/lib/fea/slots.ts` l'ha mancato per una riga: il payload era lungo undici. Una chiamata
 * saltata non fa rumore — il setaccio la classifica come «senza `onConflict`, arbitra la chiave
 * primaria» e passa oltre. Un lock cieco è verde, ed è il modo più silenzioso di non controllare
 * niente: la finestra arbitraria è stata sostituita dal confine vero della chiamata.
 *
 * I COMMENTI si saltano, e in questo repo non è un dettaglio: sono in italiano, quindi pieni di
 * apostrofi. Un `// l'elenco` dentro le parentesi aprirebbe una stringa che non si chiude più, e
 * il parser correrebbe fino a fine file portandosi dietro l'`onConflict` della chiamata dopo.
 * Oggi nessun corpo è in fuga — ma il modo di fallire sarebbe silenzioso, e un errore silenzioso
 * in un lock è il lock che smette di esistere.
 *
 * ⚠️ SALTARE I COMMENTI HA APERTO UN LIMITE SUO, e va scritto perché è dello stesso tipo: questo
 * non è un parser JavaScript e non conosce le ESPRESSIONI REGOLARI. Una regex che termina con
 * due barre — `.replace(/\/\//g, '')` — viene letta come l'inizio di un commento, e il corpo
 * scappa fino a fine riga e oltre la chiusura della chiamata. Misurato su testo sintetico:
 * l'`onConflict` finisce attribuito alla chiamata SUCCESSIVA, in silenzio. In `src/` oggi nessun
 * corpo di `.upsert()` contiene una regex, quindi l'impatto è zero; il giorno in cui ne
 * contenesse una servirebbe un vero AST, non un'altra pezza a questo carattere-per-carattere.
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
    const due = testo.slice(i, i + 2)
    if (due === '//') { const fine = testo.indexOf('\n', i); i = fine < 0 ? testo.length : fine; continue }
    if (due === '/*') { const fine = testo.indexOf('*/', i + 2); i = fine < 0 ? testo.length : fine + 2; continue }
    if (c === "'" || c === '"' || c === '`') { dentro = c; i++; continue }
    if (c === '(') livello++
    else if (c === ')') { livello--; if (livello === 0) return testo.slice(aperta + 1, i) }
    i++
  }
  return testo.slice(aperta + 1)
}

type Setaccio = {
  /** Chiamate con tabella e chiave risolte: sono quelle che il lock confronta. */
  risolte: Chiave[]
  /** Chiamate la cui tabella o la cui chiave non si è riusciti a risolvere. */
  nonRisolte: Chiave[]
  /** Chiamate senza `onConflict`: l'arbitro è la chiave primaria, e c'è sempre. */
  senzaChiave: Chiave[]
}

let memoria: Setaccio | null = null

/**
 * Il setaccio, calcolato UNA volta.
 *
 * La prima versione teneva `nonRisolte` e `senzaChiave` come array di modulo che `chiaviDaSrc()`
 * svuotava e riempiva, e quattro prove la chiamavano solo per l'effetto collaterale: bastava
 * riordinare le prove — o aggiungerne una che non la chiama — perché una di loro leggesse le
 * liste di un'altra. Uno stato mutabile condiviso fra prove è un test che dipende dal proprio
 * ordine, cioè un test che un giorno dirà una cosa non vera. Qui la risposta è una sola, immutata,
 * e in più `src/` si legge una volta invece di quattro.
 */
function chiaviDaSrc(): Setaccio {
  if (memoria) return memoria
  const risolte: Chiave[] = []
  const nonRisolte: Chiave[] = []
  const senzaChiave: Chiave[] = []
  for (const f of filesTs(SRC)) {
    const testo = fs.readFileSync(f, 'utf8')
    const righe = testo.split('\n')
    // L'offset assoluto di ogni riga: serve a passare dalle righe (comode per risalire alla
    // `.from()`) alle posizioni nel testo (le uniche con cui si misura davvero che cosa sta in
    // mezzo fra due punti).
    const inizioDelleRighe: number[] = []
    let scorrere = 0
    for (const r of righe) { inizioDelleRighe.push(scorrere); scorrere += r.length + 1 }
    const locali = costantiDelFile(testo)
    for (const m of testo.matchAll(/\.upsert\(/g)) {
      const pos = m.index ?? 0
      const numRiga = testo.slice(0, pos).split('\n').length
      const i = numRiga - 1
      // Le righe di COMMENTO che nominano un upsert non sono chiamate.
      if (/^\s*(\*|\/\/)/.test(righe[i])) continue

      // La tabella si cerca RISALENDO, e qui la finestra di righe è rimasta — ma con un confine.
      // Un `;` o una `}` fra la `.from()` trovata e l'`.upsert()` vogliono dire che quella
      // `.from()` appartiene a un'ALTRA istruzione, e prenderla comunque significherebbe
      // confrontare la chiave di un upsert con gli indici della tabella sbagliata: verde per
      // caso, e nessuno se ne accorgerebbe mai. Misurato il 2026-09-06 su tutte e 63 le chiamate:
      // la `.from()` sta a distanza 0 o 1 riga e in nessun caso c'è un `;` o una `}` in mezzo,
      // quindi oggi il guard non rifiuta niente — esiste perché il giorno in cui rifiuterà, lo
      // dirà invece di tacere.
      // ⚠️ LIMITE RESIDUO, e non è coperto: `const s = supabase.from('X')` seguito da `s.upsert()`
      // su righe contigue non nomina nessuna `.from()` sulla riga dell'upsert e non ha né `;` né
      // `}` fra le due, quindi passerebbe prendendo la tabella giusta per fortuna. Oggi in `src/`
      // quella forma non esiste; il giorno in cui esistesse, servirebbe un vero AST.
      let tabella: string | null = null
      for (let j = i; j >= Math.max(0, i - 8); j--) {
        const lett = righe[j].match(/\.from\(\s*['"`]([A-Za-z0-9_]+)['"`]\s*\)/)
        const cost = lett ? null : righe[j].match(/\.from\(\s*([A-Za-z0-9_]+)\s*\)/)
        const trovato = lett ?? cost
        if (!trovato) continue
        // Ciò che sta FRA la fine della `.from(…)` e l'inizio di `.upsert(`, non le righe intere:
        // la riga dell'upsert contiene quasi sempre una `}` sua (`.upsert({ … }, { … })`), e
        // contarla farebbe rifiutare ogni chiamata del repo.
        const inizioRiga = inizioDelleRighe[j]
        const fineFrom = inizioRiga + (trovato.index ?? 0) + trovato[0].length
        if (/[;}]/.test(testo.slice(fineFrom, pos))) {
          tabella = 'NON_RISOLTA:from-oltre-un-confine'
          break
        }
        tabella = lett ? lett[1] : (locali[cost![1]] ?? `NON_RISOLTA:${cost![1]}`)
        break
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
      risolte.push(voce)
    }
  }
  memoria = { risolte, nonRisolte, senzaChiave }
  return memoria
}

type Indice = {
  tabella: string
  indice: string
  parziale: boolean
  con_espressioni: boolean
  nulls_not_distinct: boolean
  ha_colonna_nullable: boolean
  colonne: string[]
}
// `generato_il` NON è opzionale: `sogliaFotografia` lo pretende (vedi ./soglia-fotografia).
type Foto = { generato_il: string; generato_alle?: string | null; sha256: string; indici: Indice[] }

const foto: Foto = JSON.parse(fs.readFileSync(FOTO_PATH, 'utf8'))

/** Le colonne di una chiave, come insieme ordinato: `ON CONFLICT` non guarda l'ordine. */
const insieme = (cols: string) => [...cols.split(',').map((c) => c.trim())].sort().join(',')

/**
 * Questo indice può fare da arbitro per questa chiave?
 *
 * Quattro condizioni, e la quarta è quella che il lock aveva sbagliato.
 *
 * ⚠️ `ON CONFLICT (colonne)` INFERISCE L'INDICE A PRESCINDERE DA `NULLS NOT DISTINCT`. Quindi un
 * `UNIQUE (scuola_id, menu_config_id, settimana, giorno_settimana)` creato SENZA quella clausola
 * farebbe sparire il `42P10` — e il lock, guardando solo le colonne, direbbe VERDE. Ma
 * `menu_config_id` è nullable, e per Postgres due `NULL` sono DIVERSI: il salvataggio del menu
 * unico non troverebbe mai la riga da aggiornare e ne INSERIREBBE una nuova ogni volta.
 * Duplicati silenziosi al posto di un errore rumoroso: peggio del difetto che si stava
 * correggendo, e invisibile — il primo salvataggio funziona, il secondo raddoppia, e ci si
 * accorge del guasto mesi dopo, in tavola. Un lock che approva il rimedio sbagliato è peggio di
 * un lock che non c'è, perché fa smettere di guardare.
 *
 * `nulls_not_distinct` e `ha_colonna_nullable` non dicono niente presi da soli: la clausola serve
 * solo se una colonna chiave è davvero nullable, e la nullabilità è innocua se la clausola c'è.
 */
const arbitra = (i: Indice, tabella: string, chiave: string) =>
  i.tabella === tabella &&
  !i.parziale &&
  !i.con_espressioni &&
  (!i.ha_colonna_nullable || i.nulls_not_distinct) &&
  [...i.colonne].sort().join(',') === insieme(chiave)

/**
 * La fotografia sa qualcosa di questa tabella? Basta UN indice qualsiasi.
 *
 * ⚠️ È UN'EURISTICA, non un fatto, e va detto perché il messaggio che ne dipende è netto.
 * Misurato il 2026-09-06 sulla produzione: 135 tabelle in `public`, **134** con almeno un indice
 * UNIQUE valido. L'unica senza è `backup_pulizia_note_20260905` — una tabella di salvataggio, che
 * non ha né chiave primaria né altro. Quindi «zero indici nella fotografia» quasi sempre vuol
 * dire «tabella che non esiste», ma non sempre: su una tabella fatta come quel backup il lock
 * direbbe «probabilmente non esiste» a proposito di una tabella che c'è.
 *
 * Va bene così, perché sbaglia dalla parte del rumore: un upsert su una tabella senza NESSUN
 * vincolo unico è comunque un difetto da guardare — `ON CONFLICT` lì non ha proprio niente da
 * inferire. Il messaggio dice «con ogni probabilità», non «di sicuro», e offre l'altra lettura.
 */
const tabellaNota = (tabella: string) => foto.indici.some((i) => i.tabella === tabella)

/**
 * Esiste un indice che arbitrerebbe questa chiave se non fosse per i NULL?
 *
 * È la differenza fra i due sintomi, e quindi fra due messaggi d'errore che non possono essere
 * lo stesso: senza indice arriva `42P10` a ogni chiamata; con questo indice non arriva niente e
 * si accumulano duplicati. Chi legge un rosso deve sapere quale dei due sta guardando.
 */
const quasiArbitroPerINull = (k: Chiave) =>
  foto.indici.some(
    (i) =>
      i.tabella === k.tabella &&
      !i.parziale &&
      !i.con_espressioni &&
      i.ha_colonna_nullable &&
      !i.nulls_not_distinct &&
      [...i.colonne].sort().join(',') === insieme(k.chiave),
  )

/** Le chiavi di `src/` che non trovano un arbitro e non sono dichiarate in SENZA_ARBITRO_ATTESO. */
function senzaArbitro(): Chiave[] {
  const attese = new Set(SENZA_ARBITRO_ATTESO.map((v) => `${v.tabella}|${insieme(v.chiave)}`))
  return chiaviDaSrc()
    .risolte.filter((k) => !attese.has(`${k.tabella}|${insieme(k.chiave)}`))
    .filter((k) => !foto.indici.some((i) => arbitra(i, k.tabella, k.chiave)))
}

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
    expect(
      chiaviDaSrc().nonRisolte,
      `Di questi upsert non si è capito su quale tabella scrivono o con quale chiave. Saltarli ` +
      `renderebbe il lock cieco proprio dove il codice è meno leggibile: dai un nome risolvibile ` +
      `alla costante (una \`const NOME = 'tabella'\` nello stesso file), oppure aggiungila a ` +
      `COSTANTI in questo file. Se il motivo è \`from-oltre-un-confine\`, la \`.from()\` più ` +
      `vicina è separata dall'upsert da un \`;\` o da una \`}\`, cioè appartiene a un'altra ` +
      `istruzione: scrivi la chiamata in modo che tabella e upsert stiano nella stessa catena.`,
    ).toEqual([])
  })

  it('nessuna chiave di conflitto è senza arbitro (42P10 a ogni chiamata)', () => {
    // Solo le chiavi su tabelle che la fotografia CONOSCE, e solo quelle per cui non esiste
    // NESSUN indice sulle stesse colonne: gli altri due casi hanno un rimedio diverso e un
    // sintomo diverso, e stanno nelle due prove qui sotto. Un solo rosso, una sola cosa da fare.
    const orfane = senzaArbitro()
      .filter((k) => tabellaNota(k.tabella))
      .filter((k) => !quasiArbitroPerINull(k))
    expect(
      orfane,
      `Queste chiavi di conflitto non hanno, nel database, un indice UNIQUE NON PARZIALE e senza ` +
      `espressioni sulle stesse colonne: ogni chiamata torna 42P10 e nessun test coi mock se ne ` +
      `accorge. Il rimedio NON è aggiungere un'eccezione qui: è una migrazione che crei l'indice ` +
      `(se una colonna chiave può essere NULL, con NULLS NOT DISTINCT — vedi la prova qui sotto, ` +
      `perché crearlo senza è un rimedio peggiore del difetto). ${JSON.stringify(orfane, null, 2)}`,
    ).toEqual([])
  })

  it('nessuna chiave si appoggia a un indice che tratta i NULL come distinti', () => {
    // ⟵ IL RAMO CHE NON DÀ NESSUN ERRORE, ed è per questo che ha una prova sua. Qui l'indice
    // c'è, `ON CONFLICT` lo infersce, la chiamata risponde 200 e in `app_log` non compare niente:
    // ma se la riga porta un NULL in una colonna chiave, per Postgres non è uguale a nessuna
    // riga esistente, quindi l'upsert INSERISCE invece di aggiornare. Il primo salvataggio
    // sembra funzionare, il secondo raddoppia la riga, e ci si accorge del guasto mesi dopo.
    //
    // Dire «42P10» anche qui, come faceva il messaggio unico fino al 2026-09-06, manda chi legge
    // a cercare in `app_log` un codice che non c'è, e proprio sul caso più difficile da vedere.
    const ingannevoli = senzaArbitro().filter(quasiArbitroPerINull)
    expect(
      ingannevoli,
      `Su queste chiavi un indice inferibile C'È — non arriva nessun 42P10, la chiamata risponde ` +
      `200 — ma ha una colonna che può essere NULL e NON è \`NULLS NOT DISTINCT\`: quando quella ` +
      `colonna è NULL l'upsert non trova mai la riga e ne inserisce una nuova. Il sintomo non è ` +
      `un errore: sono DUPLICATI SILENZIOSI, visibili solo dal secondo salvataggio in poi. Lo si ` +
      `riconosce nella fotografia dalla voce con \`ha_colonna_nullable: true\` e ` +
      `\`nulls_not_distinct: false\` sulle stesse colonne. Il rimedio è ricreare l'indice con ` +
      `NULLS NOT DISTINCT (o rendere la colonna NOT NULL, se il dominio lo consente). ` +
      `${JSON.stringify(ingannevoli, null, 2)}`,
    ).toEqual([])
  })

  it('nessun upsert scrive su una tabella che la produzione non ha', () => {
    // ⟵ È L'ALTRO RAMO, e senza di lui il messaggio qui sopra manderebbe chi legge a scrivere una
    // migrazione che non serve. Se di una tabella la fotografia non ha NEMMENO la chiave
    // primaria, l'unica lettura sensata è che quella tabella non esista: le PK ci sono sempre, e
    // infatti sono 215 su 215 le tabelle che ne hanno una qui dentro. L'errore non è `42P10` («la
    // chiave non corrisponde a nessun vincolo») ma `PGRST205` («could not find the table … in the
    // schema cache»), e il rimedio non sta nel database — sta nel codice che lo chiama.
    const fantasma = senzaArbitro().filter((k) => !tabellaNota(k.tabella))
    expect(
      fantasma,
      `Questi upsert scrivono su tabelle di cui la fotografia non ha NESSUN indice, nemmeno la ` +
      `chiave primaria: quelle tabelle in produzione con ogni probabilità NON ESISTONO. Ogni ` +
      `chiamata torna \`PGRST205\`, non \`42P10\`, e se il chiamante la inghiotte in un catch la ` +
      `funzionalità è semplicemente spenta senza che nessuno lo veda. Il rimedio NON è una ` +
      `migrazione che crei la tabella: è che quel codice smetta di scrivere in un posto che non ` +
      `c'è — o punti alla tabella vera, o sparisca. (Se invece la tabella esiste ed è la ` +
      `fotografia a essere vecchia: ${COME_RIGENERARE}) ${JSON.stringify(fantasma, null, 2)}`,
    ).toEqual([])
  })

  it('le eccezioni dichiarate sono ancora eccezioni (se cade, la ragione della voce è scaduta)', () => {
    const usate = chiaviDaSrc().risolte
    for (const v of SENZA_ARBITRO_ATTESO) {
      // Ogni voce porta il suo `perche` nel messaggio: le due dichiarate qui non hanno la stessa
      // ragione, e un messaggio unico ne racconterebbe una sbagliata a chi trova il rosso.
      const trovato = foto.indici.some((i) => arbitra(i, v.tabella, v.chiave))
      expect(
        trovato,
        `\`${v.chiave}\` su ${v.tabella} ADESSO ha un arbitro in produzione, e la voce di ` +
        `SENZA_ARBITRO_ATTESO diceva che non doveva averlo. Rileggi la ragione con cui è stata ` +
        `scritta prima di toglierla:\n${v.perche}`,
      ).toBe(false)
      // Un'esenzione che sopravvive al suo motivo è un buco che nessuno ricorda di aver aperto.
      expect(
        usate.some((k) => k.tabella === v.tabella && insieme(k.chiave) === insieme(v.chiave)),
        `Nessun upsert di src/ usa più \`${v.chiave}\` su ${v.tabella}: togli la voce da ` +
        `SENZA_ARBITRO_ATTESO invece di lasciarla a coprire codice che non esiste. La ragione ` +
        `con cui era stata scritta:\n${v.perche}`,
      ).toBe(true)
      expect(
        v.perche.length,
        `La voce ${v.tabella}/${v.chiave} non ha una ragione scritta: un'eccezione senza motivo ` +
        `è un buco, non una decisione.`,
      ).toBeGreaterThan(80)
    }
  })

  it('la fotografia viene dal DATABASE, non dal codice che il lock controlla', () => {
    // Se la fotografia si ricavasse leggendo `src/`, questo file confronterebbe il codice con se
    // stesso: verde per costruzione, cioè nessun controllo.
    //
    // ⚠️ Il confronto è su SOTTOSTRINGHE, commenti compresi: è grossolano di proposito (leggere
    // un `.mjs` con un parser per una prova di igiene sarebbe sproporzionato), ma vuol dire che
    // anche NOMINARE una di queste parole in un commento del generatore fa cadere il lock — per
    // esempio scrivendoci «questo script non legge 'src'», cioè affermando la cosa giusta. Se
    // capita, non è il generatore a essere sbagliato: si riformula il commento, oppure si toglie
    // la parola da questa lista spiegando perché.
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
    //
    // ⚠️ SE UNA DI QUESTE CADE, LA CORREZIONE NON È ABBASSARE IL NUMERO. Un lock la cui soglia si
    // abbassa ogni volta che diventa rossa è una decorazione. Si abbassa solo dopo aver capito
    // perché è sceso, e scrivendolo qui accanto insieme alla nuova misura e alla data.
    const { risolte, senzaChiave } = chiaviDaSrc()
    expect(
      risolte.length,
      `Il setaccio trova ${risolte.length} upsert con onConflict risolto, contro i 63 misurati il ` +
      `2026-09-06. Delle due l'una, e vanno distinte prima di toccare il numero: o qualcuno ha ` +
      `TOLTO davvero degli upsert da src/ (verifica con \`grep -rc '\\.upsert(' src/\` e, se ` +
      `torna, aggiorna la soglia scrivendo qui accanto perché è scesa), oppure il SETACCIO ha ` +
      `smesso di leggerli — ed è il caso grave, perché un setaccio che non trova niente rende ` +
      `verde tutto il resto del file senza dire una parola.`,
    ).toBeGreaterThan(60)
    expect(
      senzaChiave.length,
      `Ci sono ${senzaChiave.length} \`.upsert()\` senza \`onConflict\`, contro gli 0 misurati il ` +
      `2026-09-06. Un upsert che si affida alla CHIAVE PRIMARIA è legittimo e questo lock non ha ` +
      `niente da dirgli: il rosso qui non accusa quel codice, chiede di guardare QUALI sono. Se ` +
      `sono davvero senza \`onConflict\`, alza la soglia dicendo quali e perché; se invece ` +
      `l'\`onConflict\` ce l'hanno, allora è \`corpoChiamata()\` a non leggerlo più — e ogni ` +
      `chiamata che finisce qui è una chiamata che il lock NON sta controllando.`,
    ).toBeLessThan(3)
    expect(
      foto.indici.length,
      `La fotografia contiene ${foto.indici.length} indici UNIQUE, contro i 215 del 2026-09-06: ` +
      `troppo pochi per essere la produzione. Un lock che gira su una fotografia quasi vuota ` +
      `approva qualunque chiave. Non abbassare la soglia: rigenera. ${COME_RIGENERARE}`,
    ).toBeGreaterThan(200)
  })

  it('la fotografia è della PRODUZIONE, non del database E2E della CI', () => {
    // ⟵ L'incidente che nessuna soglia numerica può prendere: rigenerare la fotografia contro il
    // progetto E2E della CI, che è separato e molto meno migrato. Il conteggio potrebbe anche
    // reggere, e il lock diventerebbe verde su chiavi che in PRODUZIONE non hanno arbitro — cioè
    // proprio il difetto che esiste per trovare, approvato dal database sbagliato.
    //
    // ⚠️ SI CERCA UN FATTO, NON UN NOME, e la prima versione sbagliava proprio qui: pretendeva
    // l'indice `unique_registro_orario`, credendolo esclusivo della produzione. Non lo è. Quel
    // NOME nasce nella baseline, su `(classe_sezione, data, ora_lezione)`, e il DB E2E ce l'ha; la
    // migrazione del 2026-07-30 che aggiunge `scuola_id` riusa lo stesso nome. Ciò che l'E2E non
    // ha sono le COLONNE, non il nome — quindi metà del controllo non distingueva i due database.
    // E il nome è anche fragile: il Task 4 di questo piano lo sostituisce, e la prova sarebbe
    // diventata rossa accusando il database sbagliato proprio nel giro in cui tutto torna verde —
    // cioè insegnando a cancellare la sentinella.
    const tabelle = new Set(foto.indici.map((i) => i.tabella))
    const registroPerSede = foto.indici.some(
      (i) => i.tabella === 'registro_orario' && i.colonne.includes('scuola_id'),
    )
    const mancanti = [
      ...(tabelle.has('enrollment_submissions') ? [] : ['la tabella enrollment_submissions']),
      ...(registroPerSede ? [] : ['un indice unico di registro_orario che comprenda scuola_id']),
    ]
    expect(
      mancanti,
      `Nella fotografia mancano segni che si trovano SOLO in produzione (${mancanti.join(', ')}): ` +
      `con ogni probabilità la query è stata eseguita sul database E2E della CI, che è un ` +
      `progetto separato e non migrato. Una fotografia presa dal database sbagliato fa dire al ` +
      `lock che va tutto bene su vincoli che in produzione non esistono. Rifai la query sul ` +
      `progetto di produzione. ${COME_RIGENERARE}`,
    ).toEqual([])

    // ⚠️ E LA FOTOGRAFIA DEVE ESSERE STATA PRESA CON LA QUERY DI OGGI. `ha_colonna_nullable` è
    // arrivato dopo, e una fotografia rigenerata con la query VECCHIA non fa rumore: il campo
    // manca (o, peggio, il generatore lo scrive `false` per tutti con il suo `!!undefined`), il
    // JSON resta valido, lo sha256 combacia perché è stato calcolato su quel contenuto, e
    // `arbitra()` smette semplicemente di guardare i NULL. Misurato: in entrambi i casi le voci
    // orfane passano da 5 a 2 — spariscono le due `registro_orario`, che sono esattamente quelle
    // che il controllo sui NULL esiste per trovare. Nessuna delle altre prove se ne accorge.
    expect(
      foto.indici.every((i) => typeof i.ha_colonna_nullable === 'boolean'),
      `Qualche voce della fotografia non porta \`ha_colonna_nullable\`: è stata generata con una ` +
      `query più vecchia del controllo sui NULL. ${COME_RIGENERARE}`,
    ).toBe(true)
    expect(
      foto.indici.some((i) => i.ha_colonna_nullable),
      // 26 su 215 il 2026-09-06. Zero è impossibile su questo schema: basta una FK opzionale.
      `Nessuno dei ${foto.indici.length} indici risulta avere una colonna nullable: impossibile ` +
      `su questo schema (erano 26 il 2026-09-06). La fotografia è stata rigenerata con la query ` +
      `VECCHIA, e il controllo sugli arbitri senza NULLS NOT DISTINCT è spento senza dirlo — ` +
      `cioè il lock approverebbe un indice che fa duplicati invece di aggiornare. ` +
      `${COME_RIGENERARE}`,
    ).toBe(true)
  })
})
