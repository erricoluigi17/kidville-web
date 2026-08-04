import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import config from '../../playwright.config'

/**
 * LOCK — ogni motore di browser DICHIARATO in `playwright.config.ts` deve anche
 * essere INSTALLATO dal workflow che esegue la suite.
 *
 * ─── IL DIFETTO ────────────────────────────────────────────────────────────
 * Collaudo del 2026-08-03, rilievo T13-F2: la configurazione Playwright aveva
 * un solo progetto, `chromium`. L'app iOS di Kidville è una WebView **WebKit**
 * (Capacitor): la piattaforma su cui gira l'app dei genitori non era mai stata
 * toccata da un test automatico. Le differenze che contano non sono teoriche —
 * `Intl`/date, `input[type=date]`, il layout dei radio del wizard, `fetch` con
 * credenziali, `100vh` sotto la barra di Safari: sono tutte cose che su WebKit
 * si comportano diversamente e che questa app usa nel percorso d'iscrizione e
 * nella schermata dei pagamenti.
 *
 * ─── PERCHÉ IL LOCK CONTROLLA **DUE** COSE INSIEME ─────────────────────────
 * Perché la configurazione a metà è verde e non esegue niente. Ci sono due
 * modi indipendenti di rompere questa copertura, e ciascuno da solo è
 * silenzioso:
 *
 *  1. dichiarare il progetto `webkit` e NON aggiungere `webkit` al passo
 *     `npx playwright install` del job E2E → in CI il progetto fallisce (o,
 *     peggio, viene saltato) per un browser mancante, e il rimedio ovvio sotto
 *     pressione è togliere il progetto;
 *  2. togliere il progetto e lasciare l'installazione → si scarica un browser
 *     che nessuno usa, e la copertura sparisce senza che nessun test lo dica.
 *
 * Il lock deriva l'elenco dei motori DAI PROGETTI (non da una lista scritta a
 * mano qui): il giorno in cui qualcuno aggiungerà un progetto `firefox`, questo
 * test diventa rosso finché il workflow non lo installa. È la proprietà che
 * serve — non «esiste la parola webkit da qualche parte».
 *
 * ─── COSA NON PUÒ FARE ─────────────────────────────────────────────────────
 * Non dice se gli spec su WebKit PASSANO: quello lo dice solo la CI. Dice che
 * esistono, che sono un sottoinsieme davvero ristretto (un progetto che
 * matcha zero file è verde in un secondo e non prova nulla) e che il browser
 * che dovrebbe eseguirli viene scaricato.
 */

const RADICE = process.cwd()
const CI_YML = join(RADICE, '.github', 'workflows', 'ci.yml')

/** I nomi dei progetti dichiarati nella config. */
const progetti = config.projects ?? []

/**
 * Il motore che un progetto Playwright userà davvero.
 * `devices['Desktop Safari']` porta con sé `defaultBrowserType: 'webkit'`;
 * un progetto senza `use` eredita il default di Playwright, cioè chromium.
 */
function motoreDi(p: (typeof progetti)[number]): string {
  const use = (p.use ?? {}) as { defaultBrowserType?: string; browserName?: string }
  return use.browserName ?? use.defaultBrowserType ?? 'chromium'
}

/** Tutti gli spec raccoglibili dalla suite principale (senza l'harness isolato). */
function specDellaSuite(): string[] {
  const out: string[] = []
  const visita = (d: string): void => {
    for (const voce of readdirSync(d)) {
      if (voce === '.auth' || voce === 'primaria-360' || voce === 'node_modules') continue
      const p = join(d, voce)
      if (statSync(p).isDirectory()) visita(p)
      else if (p.endsWith('.spec.ts')) out.push(relative(RADICE, p))
    }
  }
  visita(join(RADICE, 'e2e'))
  return out
}

/**
 * Il comando `npx playwright install` del workflow. Deve essercene ESATTAMENTE
 * uno: due passi di installazione che si contraddicono sono il modo in cui
 * questo lock verrebbe aggirato senza volerlo.
 */
function comandoInstall(): string {
  const yml = readFileSync(CI_YML, 'utf8')
  const righe = yml.split('\n').filter((r) => r.includes('playwright install'))
  expect(
    righe,
    'Nel workflow CI deve esserci esattamente un passo `npx playwright install`.',
  ).toHaveLength(1)
  return righe[0]
}

/** I browser passati a `playwright install` (i token che non sono flag). */
function browserInstallati(): string[] {
  const cmd = comandoInstall()
  const dopoInstall = cmd.slice(cmd.indexOf('playwright install') + 'playwright install'.length)
  return dopoInstall
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith('-'))
}

describe('lock: i motori dichiarati da Playwright sono quelli installati in CI', () => {
  it('il lock non è vuoto per costruzione', () => {
    // Un lock che non trova progetti né spec è verde per il motivo sbagliato.
    expect(progetti.length).toBeGreaterThan(1)
    expect(specDellaSuite().length).toBeGreaterThan(10)
  })

  it('esiste un progetto che gira su WebKit (la WebView dell’app iOS)', () => {
    const motori = progetti.map(motoreDi)
    expect(
      motori,
      'Nessun progetto Playwright gira su WebKit: la piattaforma su cui gira ' +
        "l'app iOS (WebView Capacitor) resterebbe senza un solo test automatico.",
    ).toContain('webkit')
  })

  it('ogni motore dichiarato dai progetti è installato dal job E2E', () => {
    const richiesti = [...new Set(progetti.map(motoreDi))].sort()
    const installati = browserInstallati()
    const mancanti = richiesti.filter((m) => !installati.includes(m))

    expect(
      mancanti,
      `Progetti Playwright che dichiarano un motore che la CI non scarica: ${mancanti.join(', ')}. ` +
        'Un progetto senza il suo browser non collauda niente — aggiorna il passo ' +
        '`npx playwright install --with-deps …` in .github/workflows/ci.yml.',
    ).toEqual([])
  })

  it('non si scaricano browser che nessun progetto usa', () => {
    const richiesti = new Set(progetti.map(motoreDi))
    const inutili = browserInstallati().filter((b) => !richiesti.has(b))

    expect(
      inutili,
      `La CI scarica browser che nessun progetto Playwright usa: ${inutili.join(', ')}. ` +
        'O è rimasto un progetto tolto (e la copertura è sparita in silenzio), o è ' +
        "un download che allunga ogni run senza collaudare nulla.",
    ).toEqual([])
  })

  it('il progetto WebKit è ristretto a un sottoinsieme di spec che ESISTONO', () => {
    const webkit = progetti.find((p) => motoreDi(p) === 'webkit')
    expect(webkit, 'progetto webkit assente').toBeDefined()

    // `testMatch` come RegExp e non come glob: è la forma che questo lock può
    // APPLICARE agli spec reali, invece di limitarsi a leggerne il testo.
    const match = webkit!.testMatch
    expect(
      match instanceof RegExp,
      'Il progetto webkit deve restringere gli spec con una RegExp `testMatch`: ' +
        'senza restrizione ripeterebbe TUTTA la suite su un secondo browser (il ' +
        'costo della CI raddoppia), e con un glob questo lock non potrebbe ' +
        'verificare che i file esistano davvero.',
    ).toBe(true)

    const rx = match as RegExp
    const tutti = specDellaSuite()
    const scelti = tutti.filter((f) => rx.test(f))

    // Il guasto silenzioso numero uno: un `testMatch` che non matcha NIENTE.
    // Playwright non se ne lamenta, il progetto finisce in zero secondi, e il
    // riquadro verde dice «webkit ✓» per zero test eseguiti.
    expect(
      scelti.length,
      `Il testMatch del progetto webkit (${rx}) non seleziona nessuno spec esistente: ` +
        'il progetto sarebbe verde senza eseguire nulla.',
    ).toBeGreaterThan(0)

    // …e il guasto opposto: la restrizione che non restringe.
    expect(
      scelti.length,
      'Il progetto webkit seleziona tutta la suite: doveva essere il sottoinsieme critico.',
    ).toBeLessThan(tutti.length)
  })

  it('il sottoinsieme WebKit copre i percorsi critici (login, home, denaro, iscrizione)', () => {
    const webkit = progetti.find((p) => motoreDi(p) === 'webkit')
    const rx = webkit!.testMatch as RegExp
    const scelti = specDellaSuite().filter((f) => rx.test(f))

    // I quattro percorsi che un genitore su iPhone fa davvero: entrare,
    // la home, i pagamenti (denaro) e il modulo pubblico d'iscrizione (che si
    // compila da Safari, non dall'app).
    for (const atteso of [
      'auth.spec.ts',
      'parent-home.spec.ts',
      'parent-pagamenti.spec.ts',
      'public-iscrizione.spec.ts',
    ]) {
      expect(
        scelti.some((f) => f.endsWith(atteso)),
        `Il progetto webkit non include ${atteso}: è uno dei percorsi critici che ` +
          "la WebView dell'app iOS deve reggere.",
      ).toBe(true)
    }
  })

  it('il progetto WebKit dipende dal progetto di setup (altrimenti non ha sessione)', () => {
    const webkit = progetti.find((p) => motoreDi(p) === 'webkit')
    // Senza `dependencies: ['setup']` gli storageState potrebbero non esistere
    // ancora: gli spec autenticati fallirebbero su un redirect al login, e la
    // diagnosi («webkit è rotto») sarebbe sbagliata.
    expect(webkit!.dependencies ?? []).toContain('setup')
  })
})
