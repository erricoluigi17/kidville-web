import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK — nessun uuid di sede è cablato da nessuna parte
//
// Nato per le sole migrazioni (`20260718400000_pagamenti_solleciti_cron.sql`
// accendeva i solleciti con `WHERE scuola_id = '<uuid di Giugliano>'`: il cron è
// globale, quindi Aversa e Cesa non ereditavano nulla e «nessun sollecito»
// somigliava moltissimo a «nessun moroso»), esteso il 2026-07-31 a TUTTO il
// codice — `src/`, `scripts/`, `__tests__/`, `e2e/` — dopo l'audit globale
// multi-sede.
//
// PERCHÉ SERVE anche fuori dalle migrazioni. `d53b0fbc-…` era incollato in 30
// file: due route di seed (cancellate), due script che scrivono sul database di
// PRODUZIONE leggendo `.env.local`, quattro campagne di collaudo e 24 file di
// test. Nei test è innocuo ma normalizza l'errore — chi copia un test copia
// l'uuid — e da lì esce in uno script che agisce: `repair_parent_identities.mjs`
// aveva `SCUOLA_PROD_DEFAULT = 'd53b0fbc-…'` con un commento che lo giustificava
// come «unica sede di produzione». Dal 2026-07-29 le sedi sono tre.
//
// LE DUE PROVE.
//  1. Lista nera: gli uuid che NON devono comparire, ciascuno col suo perimetro
//     e la sua allowlist scritta (ogni voce è una decisione difendibile).
//  2. Euristica: un uuid LETTERALE assegnato a un identificatore di sede
//     (`SCUOLA_ID = '…'`, `scuola_id: '…'`, `school = '…'`) nel codice che gira
//     davvero. Serve per la sede numero quattro, il cui uuid oggi non conosciamo
//     e che nessuna lista nera potrebbe intercettare.
//
// COSA NON È VIETATO, e perché.
//  · Gli uuid palesemente finti dei test (`aaaaaaaa-…`, `11111111-…`): un test
//    non deve conoscere la produzione, ma deve pur nominare una sede. Le
//    costanti condivise stanno in `__tests__/fixtures/sedi.ts`.
//  · Il prefisso `e2e00000` come PREDICATO (`src/lib/scuole/reali.ts`): è il
//    segnale con cui la scuola finta della CI viene esclusa dagli elenchi
//    pubblici. Qui si vieta l'uuid COMPLETO della sede E2E, non il prefisso.
//  · Gli uuid nei commenti troncati (es. `d53b0fbc-…`) e nei file in allowlist.
// ─────────────────────────────────────────────────────────────────────────────

const RADICE = process.cwd()

/** I perimetri scanditi. Chiave → cartelle, relative alla radice del repo. */
const PERIMETRI = {
  src: ['src'],
  scripts: ['scripts'],
  test: ['__tests__'],
  e2e: ['e2e'],
  migrazioni: [join('supabase', 'migrations')],
  // I PROMPT della pipeline agentica. Non eseguono nulla, e proprio per questo
  // sono il posto peggiore dove lasciare un uuid: `.claude/agents/esecutore-opus.md`
  // ha detto per due giorni «Sede di produzione unica: Kidville Giugliano
  // (<uuid>)» a OGNI esecutore, prima che scrivesse una riga di codice — con
  // l'uuid già pronto da incollare. Era falso dal 2026-07-29 e ha inclinato
  // l'intera generazione di codice nella direzione dei 140 rilievi di quel
  // giorno. Una grep fatta una volta lo toglie; solo un lock impedisce che
  // rientri alla prossima riscrittura dei prompt.
  prompt: ['.claude', '.codex'],
} as const
type Perimetro = keyof typeof PERIMETRI

const TUTTI: Perimetro[] = ['src', 'scripts', 'test', 'e2e', 'migrazioni', 'prompt']
/** Il codice che gira davvero: prodotto, script di manutenzione, campagne di collaudo. */
const CHE_AGISCE: Perimetro[] = ['src', 'scripts', 'e2e', 'migrazioni']

const ESTENSIONI_CODICE = ['.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx', '.sql']
/** I prompt sono prosa e configurazione, non codice: altre estensioni. */
const ESTENSIONI_PROMPT = ['.md', '.toml', '.json', '.yaml', '.yml', '.sh']
const ESTENSIONI_DI: Record<Perimetro, string[]> = {
  src: ESTENSIONI_CODICE,
  scripts: ESTENSIONI_CODICE,
  test: ESTENSIONI_CODICE,
  e2e: ESTENSIONI_CODICE,
  migrazioni: ESTENSIONI_CODICE,
  prompt: ESTENSIONI_PROMPT,
}
const CARTELLE_SALTATE = new Set([
  'node_modules', '.next', '.auth', 'dist', 'coverage',
  'test-results', 'playwright-report', '__snapshots__',
  // Stato runtime del ciclo `/ship-cycle`: non è tracciato da git (.gitignore),
  // e la ricognizione che ci vive dentro CITA gli uuid perché il suo mestiere è
  // segnalarli. Vietarli lì significherebbe vietare di descrivere il difetto.
  '.ship-cycle',
])

/** Questo file NOMINA gli uuid vietati: è il suo mestiere, non si controlla da solo. */
const QUESTO_FILE = join('__tests__', 'architecture', 'migrazioni-senza-sede-cablata.test.ts')

type Regola = {
  /** L'uuid vietato, in minuscolo. */
  uuid: string
  /** Che cos'è, per il messaggio d'errore. */
  cosa: string
  /** Dove è vietato. */
  perimetri: Perimetro[]
  /** Percorso relativo → ragione per cui quel file può contenerlo. */
  allowlist: Record<string, string>
  /** Cosa fare al posto suo. */
  invece: string
}

const INVECE_SEDE_REALE =
  'la sede si riceve come parametro (`--scuola`, `KV_SCUOLA_ID`, body della richiesta) o si ' +
  "deriva dal dato (la sezione, l'alunno, `resolveScuolaScrittura`). Nei test si usa " +
  '`__tests__/fixtures/sedi.ts`. Nelle migrazioni si aggiorna per INSIEME o via `provisiona_sede`.'

const REGOLE: Regola[] = [
  {
    uuid: 'd53b0fbc-a9eb-4073-b302-73d1d5abd529',
    cosa: "l'uuid REALE di Kidville Giugliano",
    perimetri: TUTTI,
    allowlist: {
      // Migrazioni PRE-ESISTENTI: sono già applicate in produzione e non si
      // riscrivono (una migrazione è immutabile). NON aggiungere qui una
      // migrazione NUOVA per aggirare il lock: si scrive un UPDATE per INSIEME
      // (tutte le sedi, o quelle che soddisfano una condizione), oppure il
      // default entra nel provisioning (`public.provisiona_sede`).
      [join('supabase', 'migrations', '20260714103000_galleria_scuola_id.sql')]:
        'backfill una-tantum di galleria.scuola_id sulle foto già caricate',
      [join('supabase', 'migrations', '20260718400000_pagamenti_solleciti_cron.sql')]:
        'accensione dei solleciti sulla sola Giugliano: È IL DIFETTO, corretto da 20260729121000_solleciti_config_tutte_le_sedi.sql',
    },
    invece: INVECE_SEDE_REALE,
  },
  {
    uuid: '429da920-2c1f-47a8-82ed-a26f63ee0591',
    cosa: "l'uuid REALE di Kidville Aversa",
    perimetri: TUTTI,
    allowlist: {},
    invece: INVECE_SEDE_REALE,
  },
  {
    uuid: '04accbfd-5890-4416-99f7-acd8b864dc2f',
    cosa: "l'uuid REALE di Kidville Cesa",
    perimetri: TUTTI,
    allowlist: {},
    invece: INVECE_SEDE_REALE,
  },
  {
    uuid: '11111111-1111-1111-1111-111111111111',
    cosa: "l'uuid della finta «Kidville Roma» dei seed cancellati il 2026-07-31",
    // Non in `__tests__`: lì è un uuid palesemente finto, usato come id generico
    // (avviso, alunno, fattura) in una dozzina di file. Vietarlo nei test non
    // proteggerebbe nessun dato e romperebbe fixture legittime.
    perimetri: CHE_AGISCE,
    allowlist: {
      // Versione STORICA del trigger `fn_form_submission_etl`, che dichiarava
      // `c_scuola_id uuid := '1111…'`. Le migrazioni sono immutabili e queste due
      // sono già applicate; la funzione oggi in produzione non contiene più quel
      // valore (verificato su `pg_proc` il 2026-07-31: 0 righe).
      [join('supabase', 'migrations', '20260704120000_baseline.sql')]:
        'baseline storica: vecchia fn_form_submission_etl, riscritta da migrazioni successive',
      [join('supabase', 'migrations', '20260706105201_anagrafiche_residenza_provincia_civico.sql')]:
        'stessa funzione, stessa versione storica: già superata in produzione',
    },
    invece:
      'nessun codice che scrive su un database deve creare una sede con un uuid inventato: ' +
      '`POST /api/seed-db` faceva nascere «Kidville Roma» nel registry di PRODUZIONE, perché ' +
      '`.env.local` punta a produzione e `sealDangerous` guarda `NODE_ENV`, non il database.',
  },
  {
    uuid: 'e2e00000-0000-4000-8000-000000000001',
    cosa: "l'uuid della sede FINTA della CI",
    // Non in `__tests__` (la fixture `SEDE_E2E` serve a verificare il filtro che
    // la esclude dagli elenchi pubblici) e non in `e2e/` (è la sede su cui la
    // campagna E2E gira per definizione).
    perimetri: ['src', 'scripts', 'migrazioni'],
    allowlist: {
      [join('scripts', 'seed-e2e.mjs')]:
        'è il seed che CREA la sede finta della CI: quell\'uuid è il suo oggetto, non un assunto',
    },
    invece:
      'il prodotto riconosce la sede E2E dal PREDICATO `isScuolaE2E` (prefisso `e2e00000` o «e2e» ' +
      'nel nome, src/lib/scuole/reali.ts), mai dall\'uuid intero: così un secondo ambiente di prova ' +
      'viene escluso dagli elenchi pubblici senza toccare il codice.',
  },
  {
    uuid: 'e2e00000-0000-4000-8000-000000000002',
    cosa: "l'uuid della SECONDA sede finta della CI",
    // Gemella della precedente. Esiste dal 2026-07-31 (rilievo R132): con una
    // sola scuola nel seed, nessuno spec Playwright poteva accorgersi di una
    // perdita fra sedi — la suite era verde perché non c'era un confine da
    // attraversare, non perché il confine tenesse. Stesse regole della sede 1:
    // vietata in `src/` (il prodotto la riconosce dal predicato, mai dall'uuid),
    // lecita nel seed che la CREA e nella campagna E2E che ci gira sopra.
    perimetri: ['src', 'scripts', 'migrazioni'],
    allowlist: {
      [join('scripts', 'seed-e2e.mjs')]:
        "è il seed che CREA la seconda sede finta della CI: quell'uuid è il suo oggetto, non un assunto",
    },
    invece:
      'vale parola per parola quanto scritto per la prima sede E2E: il predicato `isScuolaE2E` ' +
      'copre entrambe (stesso prefisso `e2e00000`), quindi nessuna riga di prodotto deve nominarle.',
  },
]

/**
 * Un uuid LETTERALE assegnato a un identificatore di sede.
 * Intercetta `const SCUOLA_ID = '…'`, `scuola_id: '…'`, `school = "…"`,
 * `plessoId: '…'` — cioè la forma con cui una sede nuova verrebbe cablata
 * domani, quando il suo uuid non sarà in nessuna lista nera.
 */
const UUID_DI_SEDE_LETTERALE =
  /(?:scuola|scuole|sede|sedi|school|plesso|plessi)[a-z0-9_]*\s*[:=]\s*['"][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"]/i

/** Dove l'euristica è attiva. */
const EURISTICA_PERIMETRI: Perimetro[] = ['src', 'scripts', 'e2e']

/**
 * L'euristica ignora le righe che nominano un uuid GIÀ in lista nera: quei casi
 * hanno una regola dedicata, che sa dove sono leciti e dove no (la sede finta
 * della CI è cablata a ragione in `scripts/seed-e2e.mjs` e in `e2e/`, che è il
 * suo mestiere). Così l'euristica resta ciò per cui esiste: la sede numero
 * quattro, quella il cui uuid non conosce ancora nessuno.
 */
const UUID_GIA_GOVERNATI = REGOLE.map((r) => r.uuid)

/**
 * Esenzioni dell'euristica. **Vuota di proposito**: oggi nessun file di `src/`,
 * `scripts/` o `e2e/` ha ragione di cablare una sede. Chi ne aggiunge una scrive
 * qui accanto perché — e il controllo delle «voci morte» qui sotto la toglie di
 * mezzo appena smette di servire.
 */
const EURISTICA_AMMESSI: Record<string, string> = {}

// ── raccolta dei file ────────────────────────────────────────────────────────

function fileSotto(dir: string, estensioni: string[]): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (CARTELLE_SALTATE.has(e.name)) continue
      out.push(...fileSotto(join(dir, e.name), estensioni))
    } else if (estensioni.some((x) => e.name.endsWith(x))) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

/** Percorso relativo alla radice, con i separatori della piattaforma. */
const rel = (f: string) => relative(RADICE, f)

const FILES: Record<Perimetro, string[]> = {
  src: [], scripts: [], test: [], e2e: [], migrazioni: [], prompt: [],
}
for (const p of TUTTI) {
  FILES[p] = PERIMETRI[p]
    .flatMap((d) => fileSotto(join(RADICE, d), ESTENSIONI_DI[p]))
    .filter((f) => rel(f) !== QUESTO_FILE)
}

/** Cache: un file si legge una volta sola, non una per regola. */
const contenuto = new Map<string, string>()
function testo(f: string): string {
  let t = contenuto.get(f)
  if (t === undefined) {
    t = readFileSync(f, 'utf8')
    contenuto.set(f, t)
  }
  return t
}

// ── le prove ─────────────────────────────────────────────────────────────────

describe('lock architettura · nessun uuid di sede cablato', () => {
  it('tutti i perimetri sono leggibili (se cade, il lock si sta autoingannando)', () => {
    for (const p of TUTTI) {
      expect(
        FILES[p].length,
        `nessun file scandito sotto ${PERIMETRI[p].join(', ')}`,
      ).toBeGreaterThan(0)
    }
    // `src/` è il perimetro grande: un walk che ne trova quattro sta guardando altrove.
    expect(FILES.src.length).toBeGreaterThan(300)
  })

  for (const regola of REGOLE) {
    it(`${regola.cosa} non compare in ${regola.perimetri.flatMap((p) => PERIMETRI[p]).join(', ')}`, () => {
      const colpevoli: string[] = []
      for (const p of regola.perimetri) {
        for (const f of FILES[p]) {
          const r = rel(f)
          if (regola.allowlist[r]) continue
          if (testo(f).toLowerCase().includes(regola.uuid)) colpevoli.push(r)
        }
      }
      expect(
        colpevoli,
        `Questi file contengono ${regola.cosa} (${regola.uuid}).\n` +
          `Invece: ${regola.invece}\n` +
          `Se un file DEVE contenerlo, aggiungilo all'allowlist della regola con la ragione scritta.`,
      ).toEqual([])
    })
  }

  it('nessun uuid letterale è assegnato a un identificatore di sede (la sede numero quattro)', () => {
    const colpevoli: Array<string> = []
    for (const p of EURISTICA_PERIMETRI) {
      for (const f of FILES[p]) {
        const r = rel(f)
        if (EURISTICA_AMMESSI[r]) continue
        const righe = testo(f).split('\n')
        righe.forEach((riga, i) => {
          const minuscola = riga.toLowerCase()
          if (UUID_GIA_GOVERNATI.some((u) => minuscola.includes(u))) return
          if (UUID_DI_SEDE_LETTERALE.test(riga)) colpevoli.push(`${r}:${i + 1}`)
        })
      }
    }
    expect(
      colpevoli,
      'Qui una sede è scritta a mano. Un uuid di sede in un letterale vale per la sede di oggi e ' +
        'per nessuna di domani: la sede si riceve come parametro o si deriva dal dato (la sezione, ' +
        "l'alunno, `resolveScuolaScrittura`). Vale anche per una sede non ancora esistente, che " +
        'nessuna lista nera potrebbe intercettare.',
    ).toEqual([])
  })

  it("l'allowlist non contiene voci morte (un file cancellato la lascerebbe indietro)", () => {
    const morte: string[] = []
    for (const regola of REGOLE) {
      for (const percorso of Object.keys(regola.allowlist)) {
        const assoluto = join(RADICE, percorso)
        if (!existsSync(assoluto)) morte.push(`${percorso} (non esiste più)`)
        else if (!testo(assoluto).toLowerCase().includes(regola.uuid)) {
          morte.push(`${percorso} (non contiene più ${regola.uuid})`)
        }
      }
    }
    for (const percorso of Object.keys(EURISTICA_AMMESSI)) {
      const assoluto = join(RADICE, percorso)
      if (!existsSync(assoluto)) morte.push(`${percorso} (non esiste più)`)
      else if (!UUID_DI_SEDE_LETTERALE.test(testo(assoluto))) {
        morte.push(`${percorso} (non cabla più nessuna sede: togli l'esenzione)`)
      }
    }
    expect(
      morte,
      "Un'esenzione che non serve più è un permesso lasciato aperto: toglila dal lock.",
    ).toEqual([])
  })
})

// Il separatore di percorso è usato nelle chiavi delle allowlist: se un giorno
// il test girasse su Windows, `join` produce già `\` e il confronto regge.
void sep
