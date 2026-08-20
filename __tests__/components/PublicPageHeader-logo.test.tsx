import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PublicPageHeader } from '@/components/ui/PublicPageHeader'

/**
 * IL MARCHIO NELLA RIGA DI TESTA PUBBLICA.
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ───────────────────────────────────────────────
 * Perché `PublicPageHeader` è il punto unico da cui prendono la testata le
 * pagine pubbliche che ne usano UNA CON IL RITORNO, e ogni cosa che ci entra la
 * ereditano tutte insieme.
 *
 * ⚠️ QUESTO COMMENTO ELENCAVA LE PAGINE, E FRA QUELLE C'ERA `/iscrizione`. Era
 * FALSO: `/iscrizione` non ha mai usato questo componente — `EnrollmentWizard`
 * monta il comando di contrasto a mano, perché a sinistra ha il contatore dei
 * passi invece del ritorno. Misurato il 2026-08-20: zero `<img>` nel DOM di
 * `/iscrizione`, cioè la pagina più vista di tutte (~9 invii l'ora) era rimasta
 * senza marchio mentre questo file dichiarava il contrario, e restava verde
 * perché prova il COMPONENTE ISOLATO senza rendere nessuna pagina.
 *
 * Un elenco di pagine scritto in un commento non è una misura: si controlla con
 * `grep -rn "PublicPageHeader\|MarchioKidville" src`. Il lock che sorveglia
 * DAVVERO quali pagine hanno il marchio sta più sotto e legge i sorgenti.
 *
 * ─── LE QUATTRO COSE CHE SORVEGLIA, E PERCHÉ OGNUNA ─────────────────────────
 *
 *  · IL MARCHIO C'È E HA UN NOME. `alt=""` lo renderebbe decorativo, e chi
 *    ascolta la pagina non saprebbe di chi è il modulo che sta compilando.
 *
 *  · NON È UN LINK. La riga di testa ha UNA sola via d'uscita — il ritorno a
 *    sinistra — ed è ciò che la rende leggibile. Un secondo bersaglio cliccabile
 *    accanto, che porterebbe altrove, gliela toglie. Il test conta i link: uno.
 *
 *  · STA IN FONDO A DESTRA. «In alto a destra» vuol dire al bordo, non accanto
 *    al bordo: se domani qualcuno inserisce un comando dopo il logo, il marchio
 *    smette di essere l'ultimo elemento e il test lo dice.
 *
 *  · NON USA `logo_green.png`. È il rischio concreto di questo lavoro, non
 *    un'ipotesi: in `public/` ci sono DUE file con lo stesso wordmark verde.
 *    `logo_green.png` è 6000×3375 con il marchio confinato nel terzo centrale e
 *    il resto bianco — reso a 24 px di altezza, il wordmark ne misurerebbe otto.
 *    `logo-kidville.png` è 2227×571, ritagliato, ed è già quello del login.
 *    Nessun errore, nessun avviso: solo un logo che sembra sparito.
 *
 * ─── PERCHÉ SI ATTENDE IL COMPONENTE ────────────────────────────────────────
 * `PublicPageHeader` è un componente SERVER `async`: `render(<PublicPageHeader />)`
 * renderebbe una Promise. Si attende la chiamata e si rende il JSX che ritorna.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (chiave: string) => chiave,
  getLocale: async () => 'it',
}))

// Il comando di Alto Contrasto è un componente client con i suoi effetti: qui
// interessa solo che occupi il suo posto nella riga, non cosa fa.
vi.mock('@/components/ui/PublicContrastButton', () => ({
  PublicContrastButton: () => <button type="button">Alto contrasto</button>,
}))

afterEach(cleanup)

describe('PublicPageHeader · il marchio', () => {
  it('rende il wordmark, con il nome leggibile da chi ascolta la pagina', async () => {
    render(await PublicPageHeader({}))
    const logo = screen.getByAltText('Kidville')
    // `next/image` riscrive il `src` in un URL ottimizzato (`/_next/image?url=…`):
    // si cerca il NOME del file DENTRO l'attributo, non l'uguaglianza — altrimenti
    // il test misura l'ottimizzatore invece del componente.
    expect(logo.getAttribute('src')).toContain('logo-kidville')
  })

  it('NON è un link: la riga di testa ha una sola via d’uscita, ed è il ritorno', async () => {
    render(await PublicPageHeader({}))
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByAltText('Kidville').closest('a')).toBeNull()
  })

  it('è l’ULTIMO elemento della riga: «in alto a destra» vuol dire al bordo', async () => {
    const { container } = render(await PublicPageHeader({}))
    const riga = container.firstElementChild as HTMLElement
    const gruppoDestro = riga.lastElementChild as HTMLElement
    expect(gruppoDestro.lastElementChild?.tagName).toBe('IMG')
    expect(gruppoDestro.lastElementChild).toBe(screen.getByAltText('Kidville'))
  })

  it('NON usa logo_green.png, che è lo stesso marchio con il 90% di bianco intorno', async () => {
    render(await PublicPageHeader({}))
    // `decodeURIComponent`: dentro l'URL di `next/image` il percorso è codificato,
    // e cercare la stringa grezza in `%2Flogo_green.png` non la troverebbe mai —
    // il test passerebbe sempre, cioè non sarebbe un test.
    const src = decodeURIComponent(screen.getByAltText('Kidville').getAttribute('src') ?? '')
    expect(src).not.toContain('logo_green')
  })

  it('resta l’ultimo anche quando la pagina aggiunge comandi propri (`children`)', async () => {
    // ⚠️ QUESTO COMMENTO DICEVA IL FALSO SU TRE PUNTI, e stava ottanta righe
    // sotto il riquadro che denuncia esattamente questa classe di errore.
    // Diceva: «`/iscrizione` passa il selettore di lingua come `children` […]
    // sarebbe l'unica delle cinque a mostrarlo altrove». Ma `/iscrizione` non
    // usa questo componente (lo dice il file stesso, più su), non ha nessun
    // `LanguageSwitcher`, e «delle cinque» è il conteggio che il commit che ha
    // scritto quel riquadro dichiarava di aver ritirato.
    //
    // L'unica pagina che passa `children` è `/cancellazione-account`
    // (`page.tsx:45-47`). Il caso resta da provare — se il marchio fosse reso
    // prima dello slot, lì non sarebbe più al bordo — ma va provato per quello
    // che è.
    render(await PublicPageHeader({ children: <button type="button">Lingua</button> }))
    const gruppoDestro = (screen.getByAltText('Kidville').parentElement) as HTMLElement
    expect(gruppoDestro.lastElementChild).toBe(screen.getByAltText('Kidville'))
  })
})

describe('il marchio sulle superfici pubbliche — chi ce l’ha DAVVERO', () => {
  /**
   * ⚠️ QUESTO È IL LOCK CHE MANCAVA.
   *
   * Quelli qui sopra provano il componente isolato: dicono che `PublicPageHeader`
   * monta il marchio, e non sanno niente di quali pagine lo usino. Il 2026-08-20
   * erano tutti verdi mentre `/iscrizione` non aveva nessun logo.
   *
   * Questo legge i SORGENTI delle pagine pubbliche e pretende che ognuna arrivi
   * al marchio per una delle due strade: `PublicPageHeader` (testata col
   * ritorno) o `MarchioKidville` montato direttamente (testata del wizard
   * d'iscrizione, che il ritorno non ce l'ha).
   */
  const SUPERFICI_PUBBLICHE: { nome: string; file: string }[] = [
    { nome: '/lavora-con-noi', file: 'src/app/lavora-con-noi/page.tsx' },
    { nome: '/privacy', file: 'src/app/privacy/page.tsx' },
    { nome: '/termini', file: 'src/app/termini/page.tsx' },
    { nome: '/assistenza', file: 'src/app/assistenza/page.tsx' },
    { nome: '/cancellazione-account', file: 'src/app/cancellazione-account/page.tsx' },
    { nome: '/anagrafica-personale', file: 'src/app/anagrafica-personale/page.tsx' },
    // Il wizard, non la pagina: `/iscrizione/page.tsx` lo monta e basta.
    { nome: '/iscrizione', file: 'src/components/features/public/EnrollmentWizard.tsx' },
  ]

  for (const { nome, file } of SUPERFICI_PUBBLICHE) {
    it(`${nome} arriva al marchio, per una delle due strade`, () => {
      const src = readFileSync(join(process.cwd(), file), 'utf8')
        // Via i commenti: un file che NOMINA il componente in una nota non lo
        // monta. È esattamente l'errore che ha tenuto verde questo file.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\{\s*\}/g, '')
        .replace(/(?<!:)\/\/.*$/gm, '')
      const viaTestata = src.includes('<PublicPageHeader')
      const viaMarchio = src.includes('<MarchioKidville')
      expect(
        viaTestata || viaMarchio,
        `${nome} non monta né <PublicPageHeader> né <MarchioKidville>: quella pagina è senza marchio`,
      ).toBe(true)
    })
  }

  /**
   * ⚠️ E LA CATENA HA UN ANELLO IN PIÙ, che il lock qui sopra non vedeva.
   *
   * `/lavora-con-noi` e `/anagrafica-personale` NON rendono la testata: la
   * passano al wizard come `intestazione={<PublicPageHeader …/>}`. A renderla è
   * il wizard. Il lock dei sorgenti trova `<PublicPageHeader` nella pagina e si
   * dichiara soddisfatto — ma togliere `{intestazione}` dal corpo del wizard
   * toglierebbe marchio, ritorno e Alto Contrasto a DUE superfici pubbliche con
   * tutto il gate verde.
   *
   * Non è teorico: `anagrafica-personale-page.test.tsx:85` verifica solo che la
   * PROP sia l'elemento giusto, e per farlo mocka `PublicPageHeader` a
   * `() => null`. Nessun test, prima di questo, leggeva lo slot.
   */
  const SLOT: { nome: string; pagina: string; wizard: string }[] = [
    {
      nome: '/lavora-con-noi',
      pagina: 'src/app/lavora-con-noi/page.tsx',
      wizard: 'src/components/features/public/CandidaturaInsegnanteWizard.tsx',
    },
    {
      nome: '/anagrafica-personale',
      pagina: 'src/app/anagrafica-personale/page.tsx',
      wizard: 'src/components/features/public/AnagraficaPersonaleWizard.tsx',
    },
  ]

  for (const { nome, pagina, wizard } of SLOT) {
    it(`${nome} passa la testata come prop, e il wizard la RENDE`, () => {
      const dellaPagina = readFileSync(join(process.cwd(), pagina), 'utf8')
      expect(
        dellaPagina.includes('intestazione={<PublicPageHeader'),
        `${nome} non passa più la testata al wizard`,
      ).toBe(true)
      const delWizard = readFileSync(join(process.cwd(), wizard), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(?<!:)\/\/.*$/gm, '')
      expect(
        delWizard.includes('{intestazione}'),
        `${wizard} riceve la testata e non la rende: ${nome} resta senza marchio, senza ritorno e senza Alto Contrasto, con il gate verde`,
      ).toBe(true)
    })
  }

  it('e `PublicPageHeader` il marchio lo monta davvero (la catena si verifica, non si suppone)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/ui/PublicPageHeader.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\s*\}/g, '')
      .replace(/(?<!:)\/\/.*$/gm, '')
    expect(
      src.includes('<MarchioKidville'),
      'PublicPageHeader non monta più il marchio: le pagine che si affidano a lui sono senza, e nessuna lo saprebbe',
    ).toBe(true)
  })
})

describe('la riga di testa di `/iscrizione` va a capo: il marchio non fa traboccare la pagina', () => {
  /**
   * ⚠️ QUESTO È UN LOCK SU CLASSI, E LO DICE. jsdom non fa layout: nessun test
   * di questa suite può misurare uno `scrollWidth`. La misura vera è stata fatta
   * con Chromium sulla pagina viva il 2026-08-20, e sta scritta in
   * `src/components/ui/MarchioKidville.tsx` — con marchio e senza, a cinque
   * larghezze. Riassunto: prima il documento scrollava in orizzontale a OGNI
   * larghezza (320→394, 360→423, 390→437, 414→448); nascondendo il solo `<img>`
   * l'eccedenza spariva del tutto.
   *
   * Quello che questo test può fare è impedire che le tre classi che l'hanno
   * chiusa spariscano in silenzio. Sono tre e servono tutte e tre:
   *
   *  · `flex-wrap` sulla riga — senza, il gruppo destro non ha dove andare;
   *  · `min-w-0` sul blocco di sinistra — senza, il suo min-content spinge fuori
   *    il resto anche quando ci sarebbe spazio (è la parte che il rilievo non
   *    aveva previsto, ed è perché traboccava anche a 414 px);
   *  · `shrink-0` sul gruppo del marchio — l'`<img>` con `w-auto` non si comprime
   *    per costruzione, e senza `shrink-0` sarebbe il bottone di contrasto a
   *    farlo, andando a capo dentro di sé (difetto già misurato e scritto in
   *    `PublicContrastButton.tsx`).
   *
   * Se un giorno la riga cambia forma, questo test va RIMISURATO in un browser,
   * non adattato: tre classi giuste in un layout diverso non garantiscono niente.
   */
  const SORGENTE = readFileSync(
    join(process.cwd(), 'src/components/features/public/EnrollmentWizard.tsx'),
    'utf8',
  )

  it('la riga di testa ha `flex-wrap`', () => {
    expect(
      /className="mb-6 flex flex-wrap items-start justify-between gap-3"/.test(SORGENTE),
      'senza `flex-wrap` il gruppo destro non ha dove andare e la pagina scrolla in orizzontale',
    ).toBe(true)
  })

  it('il blocco di sinistra ha `min-w-0`', () => {
    // È subito dentro la riga di testa: si cerca lì, non nel file intero.
    const riga = SORGENTE.slice(SORGENTE.indexOf('mb-6 flex flex-wrap items-start justify-between'))
    expect(riga.slice(0, 400)).toContain('className="min-w-0"')
  })

  it('il gruppo del marchio ha `shrink-0`', () => {
    expect(SORGENTE).toContain('className="flex shrink-0 items-center gap-2"')
  })
})
