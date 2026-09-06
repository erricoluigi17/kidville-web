import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * UN PLUGIN CAPACITOR DICHIARATO IN `package.json` NON È UN PLUGIN INSTALLATO.
 *
 * ─── IL DIFETTO CHE QUESTO LOCK VIENE A CHIUDERE ─────────────────────────────
 * Il 2026-09-06 `@capacitor/filesystem` era in `package.json` e in
 * `node_modules`, ma `npx cap sync` non era mai stato eseguito: nei tre file dei
 * progetti nativi `grep -i filesystem` dava ZERO occorrenze, mentre share,
 * camera, push, splash, status-bar, badge e biometric-auth c'erano tutti.
 *
 * Sul telefono la conseguenza non era un errore, era un RIPIEGO:
 * `Capacitor.isPluginAvailable('Filesystem')` rispondeva `false`, `scaricaSuNativo`
 * usciva alla prima riga e ogni «Scarica» finiva su `plugin-filesystem-assente`,
 * cioè apriva il foglio di condivisione col link — esattamente quello che faceva
 * già il pulsante «Condividi» accanto. Un guasto che si vede solo sul dispositivo,
 * e che sullo schermo somiglia a una funzione che c'è.
 *
 * ─── PERCHÉ IL LOCK È NUOVO, cioè: cosa NON se ne accorgeva ──────────────────
 * Misurato togliendo di nuovo le registrazioni del filesystem dai due progetti:
 * `npx tsc --noEmit` → 0, la suite di `scarica` → 26/26 verdi, e persino
 * `npm run rilascio:verifica` → «✅ shell nativa verificata — 6 regole, tutte
 * rispettate». Nessuno dei tre guarda i plugin: `scripts/verifica-shell-nativa.py`
 * confronta solo le regole di `capacitor.config`, e in tutto `__tests__/` non
 * esisteva un solo riferimento a `capacitor.settings.gradle` o a `Package.swift`.
 * Il guasto sarebbe rientrato domani, identico, con la suite verde.
 *
 * ─── QUALI FILE GUARDA, E PERCHÉ SOLO QUESTI TRE ─────────────────────────────
 * `android/app/src/main/assets/capacitor.plugins.json` è il file che il runtime
 * Android legge davvero, ma è GITIGNORATO (`android/.gitignore`): in un clone
 * pulito non esiste, e un test che lo aprisse sarebbe rosso su ogni PR — è la
 * stessa trappola già documentata in `gate-shell-nativa.test.ts`. I tre file qui
 * sotto invece sono TRACCIATI: `cap sync` li riscrive, git li vede, e la CI li ha.
 *
 * ─── COME SI RIPARA quando questo test diventa rosso ─────────────────────────
 *     npm run rilascio:sync
 * cioè `CAP_SERVER_URL=… npx cap sync` SENZA piattaforma. `npx cap sync android`
 * riscrive un solo progetto e lascia l'altro indietro: lezione già pagata qui il
 * 2026-08-14, iOS rimasto per sei giorni con `localhost:3100` dentro.
 */

const RADICE = path.resolve(__dirname, '..', '..')

/** `include ':capacitor-filesystem'` + il suo `projectDir`. */
const SETTINGS_GRADLE = 'android/capacitor.settings.gradle'
/** `implementation project(':capacitor-filesystem')` — senza questa riga il modulo non si linka. */
const BUILD_GRADLE = 'android/app/capacitor.build.gradle'
/** `.package(name:…, path:…)` in `dependencies` E `.product(…)` nel target. */
const PACKAGE_SWIFT = 'ios/App/CapApp-SPM/Package.swift'

const leggi = (rel: string): string => fs.readFileSync(path.join(RADICE, rel), 'utf8')

const settingsGradle = leggi(SETTINGS_GRADLE)
const buildGradle = leggi(BUILD_GRADLE)
const packageSwift = leggi(PACKAGE_SWIFT)

/**
 * Chi è un plugin e chi no NON è una lista scritta a mano qui dentro: è il campo
 * `capacitor` del `package.json` INSTALLATO, cioè lo stesso criterio che usa la
 * CLI di Capacitor per decidere cosa registrare. Una lista di esclusioni a mano
 * avrebbe il difetto di tutte le liste a mano: il plugin aggiunto domani non ci
 * sarebbe, e il lock tacerebbe proprio sul caso nuovo.
 *
 * `@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor/ios` e
 * `@capacitor/assets` non hanno quel campo, e infatti non vanno registrati.
 */
function dichiaratiInPackageJson(): string[] {
  const pkg = JSON.parse(leggi('package.json')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].sort()
}

function manifestInstallato(nome: string): { capacitor?: unknown } | null {
  const file = path.join(RADICE, 'node_modules', nome, 'package.json')
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8')) as { capacitor?: unknown }
}

const DICHIARATI = dichiaratiInPackageJson()
const NON_INSTALLATI = DICHIARATI.filter((n) => manifestInstallato(n) === null)
const PLUGIN = DICHIARATI.filter((n) => manifestInstallato(n)?.capacitor != null)

/**
 * Il nome del modulo Gradle che `cap sync` genera: scopo senza `@`, trattino,
 * nome. `@capacitor/filesystem` → `capacitor-filesystem`,
 * `@aparajita/capacitor-biometric-auth` → `aparajita-capacitor-biometric-auth`.
 */
function moduloGradle(nome: string): string {
  const [scopo, breve] = nome.startsWith('@') ? nome.slice(1).split('/') : ['', nome]
  return scopo ? `${scopo}-${breve}` : breve
}

function perRegex(valore: string): string {
  return valore.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Dove NON è registrato. Lista vuota = registrato ovunque serva.
 *
 * Su iOS si guardano DUE cose e non una: un `.package(…)` dichiarato ma non
 * ripreso da un `.product(…)` nelle dipendenze del target è un pacchetto che
 * Xcode scarica e non linka — cioè un plugin che sul telefono continua a non
 * esserci. Il nome SwiftPM (`CapacitorFilesystem`) non si indovina da qui: si
 * legge dalla riga stessa, ancorandosi al `path` verso `node_modules`, che è
 * l'unico pezzo che contiene il nome npm esatto.
 */
interface Fonti {
  settings: string
  build: string
  swift: string
}

/** Il contenuto vero dei tre file; le prove speculari qui sotto ne passano di mutilati. */
const SUL_DISCO: Fonti = { settings: settingsGradle, build: buildGradle, swift: packageSwift }

function mancanze(nome: string, fonti: Fonti = SUL_DISCO): string[] {
  const modulo = moduloGradle(nome)
  const buchi: string[] = []

  if (!new RegExp(`include\\s+':${perRegex(modulo)}'`).test(fonti.settings)) {
    buchi.push(`${SETTINGS_GRADLE} (manca \`include ':${modulo}'\`)`)
  }
  if (!new RegExp(`implementation project\\(':${perRegex(modulo)}'\\)`).test(fonti.build)) {
    buchi.push(`${BUILD_GRADLE} (manca \`implementation project(':${modulo}')\`)`)
  }

  const dichiarazione = fonti.swift.match(
    new RegExp(`\\.package\\(name:\\s*"([^"]+)",\\s*path:\\s*"[^"]*node_modules/${perRegex(nome)}"\\)`),
  )
  if (!dichiarazione) {
    buchi.push(`${PACKAGE_SWIFT} (manca \`.package(name: …, path: "…/node_modules/${nome}")\`)`)
  } else {
    const swift = dichiarazione[1]
    if (
      !new RegExp(`\\.product\\(name:\\s*"${perRegex(swift)}",\\s*package:\\s*"${perRegex(swift)}"\\)`).test(
        fonti.swift,
      )
    ) {
      buchi.push(
        `${PACKAGE_SWIFT} (il pacchetto ${swift} è dichiarato ma il target non lo linka: manca \`.product(name: "${swift}", package: "${swift}")\`)`,
      )
    }
  }

  return buchi
}

describe('plugin Capacitor — dichiarati in package.json E registrati nei progetti nativi', () => {
  it('ci sono plugin da controllare (se questa cade, il lock si sta autoingannando)', () => {
    // Misurato il 2026-09-06: nove plugin. Un elenco che si svuota non vuol dire
    // «niente da controllare», vuol dire che il criterio non trova più niente e
    // che il test qui sotto passerebbe su una lista vuota.
    expect(
      NON_INSTALLATI,
      'pacchetti dichiarati in package.json e assenti da node_modules: non si può dire se siano plugin. Esegui `npm ci`',
    ).toEqual([])
    expect(PLUGIN.length, 'nessun plugin Capacitor riconosciuto: il criterio del campo `capacitor` non funziona più').toBeGreaterThanOrEqual(8)
    // Quello che il 2026-09-06 mancava davvero, nominato: se un giorno sparisse
    // dall'elenco, sparirebbe in silenzio anche il caso che ha motivato il lock.
    expect(PLUGIN, '@capacitor/filesystem non è più riconosciuto come plugin').toContain('@capacitor/filesystem')
  })

  it('ognuno è registrato in TUTTI E TRE i file nativi tracciati', () => {
    const buchi = PLUGIN.flatMap((nome) => mancanze(nome).map((dove) => `${nome} → ${dove}`))
    expect(
      buchi,
      'plugin dichiarato in package.json ma non registrato nel progetto nativo: sul telefono `Capacitor.isPluginAvailable(...)` risponde `false` e la funzione degrada in silenzio. Si ripara con `npm run rilascio:sync` (MAI `npx cap sync android`, che riscrive una piattaforma sola), e i tre file vanno COMMITTATI',
    ).toEqual([])
  })

  it('…e la stessa regola dice di NO a un plugin che non c’è (prova speculare)', () => {
    // Senza questa, un errore nelle espressioni regolari renderebbe il test qui
    // sopra vero per costruzione — verde su qualunque cosa, cioè decorazione.
    // Il nome è di fantasia e non esiste in nessuno dei tre file.
    const finto = mancanze('@capacitor/plugin-che-non-esiste')
    expect(finto).toHaveLength(3)
    expect(finto.join(' | ')).toContain(SETTINGS_GRADLE)
    expect(finto.join(' | ')).toContain(BUILD_GRADLE)
    expect(finto.join(' | ')).toContain(PACKAGE_SWIFT)
  })

  it('su iOS un pacchetto dichiarato ma non linkato dal target conta come MANCANTE', () => {
    // La metà del controllo iOS che non si vede finché non si rompe: un
    // `Package.swift` in cui il `.package(…)` del filesystem c'è e il `.product(…)`
    // no è un plugin che Xcode SCARICA e non LINKA — sul telefono continua a non
    // esserci. Senza questa prova, `mancanze()` potrebbe guardare metà file e
    // nessuno se ne accorgerebbe.
    const swiftMutilato = packageSwift.replace(
      /\n\s*\.product\(name: "CapacitorFilesystem", package: "CapacitorFilesystem"\),?/,
      '',
    )
    expect(swiftMutilato, 'la riga `.product` del filesystem non è più dove il test la cerca').not.toBe(packageSwift)

    // Solo la parte iOS: così questa prova resta leggibile anche se a essere
    // rotti fossero i due file di Android.
    const buchi = mancanze('@capacitor/filesystem', { ...SUL_DISCO, swift: swiftMutilato }).filter((b) =>
      b.startsWith(PACKAGE_SWIFT),
    )
    expect(buchi).toHaveLength(1)
    expect(buchi[0]).toContain('il target non lo linka')
  })
})
