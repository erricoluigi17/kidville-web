import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * IL LOCK CHE SORVEGLIA IL CANCELLO — non l'artefatto, il cancello.
 *
 * ─── PERCHÉ QUESTO TEST NON GUARDA I FILE CHE CONTANO ──────────────────────
 * I due `capacitor.config.json` sincronizzati — quelli che finiscono DENTRO il
 * binario e che il runtime legge davvero — sono gitignorati (`ios/.gitignore:12`,
 * `android/.gitignore:103`). In un clone pulito NON ESISTONO, e la CI fa checkout +
 * `npm ci` + gate senza mai lanciare `cap sync`. Un test che pretendesse di aprirli
 * sarebbe rosso su ogni PR per un file che lì non può esistere, e verrebbe
 * disattivato entro una settimana: è già successo, sta scritto in
 * `offline-html-nativo.test.ts` (i suoi `it.skipIf`).
 *
 * Quindi il controllo sull'artefatto vive DOVE SI COSTRUISCE
 * (`scripts/verifica-shell-nativa.py`, chiamato dalla Run Script Phase di Xcode e
 * dal task Gradle). Questo file fa le due cose che in CI si possono fare davvero:
 *
 *   1. che il METRO non sia scaduto — `mobile/profilo-rilascio.json` deve dire
 *      ancora ciò che `capacitor.config.ts` genera. Senza, il cancello
 *      confronterebbe l'artefatto con regole vecchie e direbbe di sì a una build
 *      sbagliata;
 *   2. che il cancello sia ANCORA AGGANCIATO. È possibile perché i punti di
 *      aggancio stanno in file TRACCIATI — `project.pbxproj`, `build.gradle`,
 *      `package.json` — anche se i file che controllano non lo sono. Sganciarlo
 *      diventa così un diff visibile e un test rosso, non un gesto invisibile.
 *
 * ─── E UN TERZO PEZZO, CHE È LA CAUSA A MONTE ──────────────────────────────
 * Il comando che avvelena la shell è COMMITTATO in otto file (istruzioni per i
 * tester Maestro, agenti della pipeline, prompt di collaudo) e nessuno di essi
 * diceva come si torna indietro. Non è un difetto di chi esegue: è un difetto
 * delle istruzioni che legge.
 */

const RADICE = path.resolve(__dirname, '..', '..')
const PROFILO = 'mobile/profilo-rilascio.json'
const SCRIPT = 'scripts/verifica-shell-nativa.py'
const PBXPROJ = 'ios/App/App.xcodeproj/project.pbxproj'
const GRADLE = 'android/app/build.gradle'

const leggi = (rel: string): string => fs.readFileSync(path.join(RADICE, rel), 'utf8')

const regole = JSON.parse(leggi(PROFILO)).regole as Record<string, unknown>

/**
 * Le chiavi che hanno GIÀ fatto danno fra il 2026-07-31 e il 2026-08-14. Se questo
 * elenco si accorcia, il cancello sta controllando meno di quanto crede — è
 * l'autodifesa nello stile di `logging-coverage.test.ts`.
 */
const CHIAVI_CHE_HANNO_FATTO_DANNO = [
  'server.url',
  'server.cleartext',
  'server.errorPath',
  'server.allowNavigation',
  'loggingBehavior',
  'ios.limitsNavigationsToAppBoundDomains',
]

function valore(oggetto: unknown, chiave: string): unknown {
  return chiave
    .split('.')
    .reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), oggetto)
}

async function configCon(url: string) {
  vi.resetModules()
  vi.stubEnv('CAP_SERVER_URL', url)
  return (await import('../../capacitor.config')).default
}

describe('shell nativa — il metro di misura non può scollarsi dalla sorgente', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('ogni regola del profilo è ciò che capacitor.config.ts produce con l’URL di produzione', async () => {
    const config = await configCon('https://app.kidville.it')
    const divergenze = Object.entries(regole)
      .filter(([chiave, atteso]) => JSON.stringify(valore(config, chiave)) !== JSON.stringify(atteso))
      .map(
        ([chiave, atteso]) =>
          `${chiave}: la sorgente produce ${JSON.stringify(valore(config, chiave))}, il profilo pretende ${JSON.stringify(atteso)}`,
      )
    expect(
      divergenze,
      `${PROFILO} non descrive più ciò che capacitor.config.ts genera: allinea il profilo (o la sorgente), altrimenti il cancello della build misura con un metro scaduto`,
    ).toEqual([])
  })

  it('…e con un URL di SVILUPPO il profilo NON è soddisfatto: discrimina davvero', async () => {
    // La prova speculare. Senza, un profilo fatto di regole banalmente vere passerebbe
    // questo file e lascerebbe passare qualunque build. È il valore esatto trovato in
    // `ios/App/App/capacitor.config.json` il 2026-08-14.
    const config = await configCon('http://localhost:3100')
    const divergenze = Object.keys(regole).filter(
      (chiave) => JSON.stringify(valore(config, chiave)) !== JSON.stringify(regole[chiave]),
    )
    expect(divergenze, 'un profilo che va bene anche a una build di sviluppo non è un profilo').toContain('server.url')
    expect(divergenze).toContain('ios.limitsNavigationsToAppBoundDomains')
  })

  it('il profilo copre le chiavi che hanno già fatto danno', () => {
    const mancanti = CHIAVI_CHE_HANNO_FATTO_DANNO.filter((k) => !(k in regole))
    expect(
      mancanti,
      `chiavi tolte da ${PROFILO}: un profilo più corto è un cancello più largo, e queste sono esattamente quelle che erano sbagliate`,
    ).toEqual([])
  })
})

describe('shell nativa — il cancello è ancora agganciato dove si costruisce', () => {
  it('lo script del cancello esiste ed è eseguibile', () => {
    expect(
      fs.existsSync(path.join(RADICE, SCRIPT)),
      `${SCRIPT} è sparito: le due build native chiamano un file che non c’è`,
    ).toBe(true)
    expect(leggi(SCRIPT).startsWith('#!/usr/bin/env python3')).toBe(true)
  })

  it('iOS — la Run Script Phase è dichiarata, eseguita dal target, per prima, e solo in Release', () => {
    const pbx = leggi(PBXPROJ)

    const fase = pbx.match(/([0-9A-Z]{8,32}) \/\* Verifica shell nativa \*\/ = \{\s*isa = PBXShellScriptBuildPhase;/)
    expect(
      fase,
      'la Run Script Phase «Verifica shell nativa» non è più nel progetto Xcode: un Archive tornerebbe a imbarcare qualunque cosa ci sia sul disco',
    ).not.toBeNull()
    const idFase = fase?.[1] ?? ''

    expect(pbx, 'la phase non chiama più lo script del cancello').toContain(SCRIPT)

    // Dichiarata è una cosa, ESEGUITA è un'altra: deve stare nella lista `buildPhases`
    // del target. È esattamente la distinzione che è costata `ChunkErrorBoundary`, un
    // componente con 11 test verdi che l'app non montava.
    const buildPhases = pbx.match(/buildPhases = \(([\s\S]*?)\);/)?.[1] ?? ''
    expect(buildPhases, 'la phase esiste ma il target non la esegue').toContain(idFase)
    expect(
      buildPhases.indexOf(idFase),
      'la phase non è la prima: la build spenderebbe minuti prima di scoprire che l’artefatto è sbagliato',
    ).toBeLessThan(buildPhases.indexOf('Sources'))

    // E deve restare MUTA in Debug: chi collauda su simulatore punta a localhost per
    // mestiere, e un cancello che gli dà torto viene tolto entro una settimana.
    expect(
      pbx,
      'la guardia su $CONFIGURATION è sparita: il cancello darebbe rosso anche a chi builda per il simulatore',
    ).toContain('$CONFIGURATION')
  })

  it('Android — Gradle lo esegue prima di ogni build di release, e non tocca il debug', () => {
    const gradle = leggi(GRADLE)
    expect(gradle, 'il task verificaShellNativa non c’è più').toContain(SCRIPT)
    expect(gradle, 'il task non è più agganciato al ramo di release').toContain('preReleaseBuild')
    expect(
      gradle,
      'il cancello si è agganciato anche al ramo di DEBUG: l’APK dell’emulatore deve poter puntare a 10.0.2.2',
    ).not.toContain('preDebugBuild')
  })

  it('gli script npm di rilascio esistono e sincronizzano ENTRAMBE le piattaforme', () => {
    const scripts = JSON.parse(leggi('package.json')).scripts as Record<string, string>
    expect(scripts['rilascio:verifica'], 'manca `npm run rilascio:verifica`').toContain(SCRIPT)
    const sync = scripts['rilascio:sync'] ?? ''
    expect(sync, 'manca `npm run rilascio:sync`').toContain('npx cap sync')
    expect(sync, 'rilascio:sync non punta alla produzione').toContain('https://app.kidville.it')
    // `npx cap sync ios` (o `android`) riscrive UN SOLO file e lascia l'altro indietro:
    // è la firma esatta dello stato del 2026-08-14, Android corretto il 09/08 e iOS fermo
    // all'08/08 con `localhost:3100` dentro.
    expect(
      sync,
      '`rilascio:sync` sincronizza una piattaforma sola: è così che l’altra resta indietro senza che nessuno lo veda',
    ).not.toMatch(/npx cap sync\s+(ios|android)/)
    expect(sync, 'rilascio:sync non verifica il risultato').toContain('rilascio:verifica')
  })
})

describe('shell nativa — il pannello dei chunk mancanti è MONTATO, non solo scritto', () => {
  /**
   * Dal 2026-08-03 al 2026-08-14 `ChunkErrorBoundary` è esistito con 11 test verdi
   * senza essere renderizzato da nessuna parte: i test lo istanziavano da soli
   * (`render(<ChunkErrorBoundary />)`) e passavano, mentre in produzione un chunk
   * mancante lasciava l'utente su «Caricamento…» per sempre. Un test che monta il
   * proprio soggetto non dimostra che il soggetto sia montato.
   */
  it('RootProviders lo importa e lo renderizza', () => {
    const sorgente = leggi('src/components/providers/RootProviders.tsx')
    expect(sorgente, 'ChunkErrorBoundary non è più importato da RootProviders').toContain(
      "from '@/components/providers/ChunkErrorBoundary'",
    )
    expect(
      sorgente,
      'ChunkErrorBoundary è importato ma non renderizzato: è esattamente lo stato in cui è rimasto per undici giorni',
    ).toMatch(/<ChunkErrorBoundary\s*\/>/)
  })
})

describe('shell nativa — chi prescrive un sync di sviluppo dice anche come si torna indietro', () => {
  const RADICI = ['.claude/agents', '.claude/maestro-flows', '.codex/agents', 'docs/collaudo/prompt', 'docs/mobile.md']
  const PRESCRIZIONE_DI_SVILUPPO = /CAP_SERVER_URL="http:\/\/[^"]+"\s+npx cap sync/
  const CONTRORDINE = 'npm run rilascio:sync'

  function* fileDi(rel: string): Generator<string> {
    const pieno = path.join(RADICE, rel)
    if (!fs.existsSync(pieno)) return
    if (fs.statSync(pieno).isFile()) {
      yield rel
      return
    }
    for (const voce of fs.readdirSync(pieno, { withFileTypes: true })) {
      // `.claude/worktrees/` sono COPIE COMPLETE del repo su un ALTRO branch: scandagliarle
      // significherebbe giudicare il lavoro di un'altra sessione. Vedi vitest.config.ts.
      if (voce.name === 'worktrees' || voce.name.startsWith('.')) continue
      yield* fileDi(path.join(rel, voce.name))
    }
  }

  const prescrivono = RADICI.flatMap((r) => [...fileDi(r)]).filter((f) =>
    PRESCRIZIONE_DI_SVILUPPO.test(fs.readFileSync(path.join(RADICE, f), 'utf8')),
  )

  it('ci sono istruzioni da controllare (se questa cade, il test si sta autoingannando)', () => {
    // Misurato il 2026-08-14: sette file. Zero riscontri non vuol dire «risolto»,
    // vuol dire che il pattern non trova più niente.
    expect(prescrivono.length).toBeGreaterThanOrEqual(6)
  })

  it('ognuna porta con sé il contrordine', () => {
    const mute = prescrivono.filter((f) => !fs.readFileSync(path.join(RADICE, f), 'utf8').includes(CONTRORDINE))
    expect(
      mute,
      `questi file prescrivono un \`cap sync\` verso un indirizzo di SVILUPPO e non dicono mai di rimetterlo a posto con \`${CONTRORDINE}\`. Il config sincronizzato è gitignorato: se resta puntato lì non lo vede né git status, né una revisione, né la CI`,
    ).toEqual([])
  })
})
