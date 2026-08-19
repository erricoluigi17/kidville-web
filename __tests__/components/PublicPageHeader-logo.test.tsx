import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import { PublicPageHeader } from '@/components/ui/PublicPageHeader'

/**
 * IL MARCHIO NELLA RIGA DI TESTA PUBBLICA.
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ───────────────────────────────────────────────
 * Perché `PublicPageHeader` è il punto unico da cui cinque pagine pubbliche
 * prendono la loro testata — `/lavora-con-noi`, `/iscrizione`, `/privacy`,
 * `/termini`, `/assistenza` — e ogni cosa che ci entra la ereditano tutte e
 * cinque insieme. Un difetto qui non è un difetto in una pagina: è un difetto in
 * ogni superficie che una famiglia o una candidata vede prima di avere un account.
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
