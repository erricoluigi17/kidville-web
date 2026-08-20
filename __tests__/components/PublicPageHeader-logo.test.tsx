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
    // `/iscrizione` passa il selettore di lingua come `children`. Se il marchio
    // fosse renso prima dello slot, su quella pagina non sarebbe più al bordo — e
    // sarebbe l'unica delle cinque a mostrarlo altrove.
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
