import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * R25 — «Leggi l'informativa» non deve buttare il genitore fuori dall'app.
 *
 * ─── COSA ERA SUCCESSO ───────────────────────────────────────────────────────
 * Nel modulo «Comunica un'assenza» la riga che dichiara chi legge il motivo — un
 * dato sanitario di un minore — porta il link all'informativa. Il link era
 * `<a href="/privacy" target="_blank">`: sul web è innocuo (una scheda in più),
 * dentro la WKWebView di Capacitor le schede NON esistono, quindi il sistema
 * consegna l'indirizzo a Safari. Misurato sul simulatore: l'app passa in secondo
 * piano e per rientrare resta solo il breadcrumb «◀ Kidville», che è un
 * affordance di sistema, non un comando dell'app.
 *
 * È un pattern nato per il web e trasportato nel guscio nativo, dove «apri in
 * una scheda nuova» significa «esci dall'applicazione».
 *
 * ─── PERCHÉ IL COMPORTAMENTO RESTA DIVERSO SULLE DUE PIATTAFORME ─────────────
 * Perché il difetto è solo del guscio. Sul web la scheda nuova PRESERVA il
 * modulo compilato, ed è la cosa giusta; nel guscio si naviga e si torna, e il
 * ritorno viaggia in `?da=` perché la history di una WebView non è affidabile
 * (deep link, riavvii — `AppBar.tsx` lo annota da tempo).
 */

const stub = { nativo: false, pathname: '/parent/attendance' }
/** Gli indirizzi aperti nella STESSA vista (`_self`), cioè senza uscire dall'app. */
let aperture: [string, string][] = []

vi.mock('@/lib/push/native-register', () => ({
  isNativeApp: () => stub.nativo,
}))

// Solo `usePathname`: il componente NON usa `useRouter`, che lancerebbe fuori
// dall'albero dell'App Router — cioè in ogni test che monta una schermata.
vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
}))

import { LinkInterno, destinazioneInApp } from '@/components/ui/LinkInterno'

beforeEach(() => {
  stub.nativo = false
  stub.pathname = '/parent/attendance'
  aperture = []
  vi.spyOn(window, 'open').mockImplementation((url, target) => {
    aperture.push([String(url), String(target)])
    return null
  })
})

describe('LinkInterno', () => {
  it('sul WEB resta una scheda nuova: il modulo compilato non si perde', () => {
    render(<LinkInterno href="/privacy">Leggi l’informativa</LinkInterno>)
    const a = screen.getByRole('link', { name: /informativa/i })
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
    // `fireEvent.click` torna `false` se qualcuno ha chiamato `preventDefault`.
    expect(fireEvent.click(a), 'sul web il click NON va intercettato: apre la scheda').toBe(true)
    expect(aperture, 'sul web la scheda nuova la apre il browser, non il codice').toEqual([])
  })

  it('nel guscio NATIVO il tocco NON esce dall’app: naviga dentro, con il ritorno', () => {
    stub.nativo = true
    render(<LinkInterno href="/privacy">Leggi l’informativa</LinkInterno>)
    const a = screen.getByRole('link', { name: /informativa/i })
    // Le DUE metà, e servono entrambe: senza `preventDefault` il browser esegue
    // comunque il `target="_blank"` — cioè esce dall'app — anche se il codice ha
    // aperto la pagina in-app. Una prova sulla sola `window.open` sarebbe verde
    // su un componente che espelle lo stesso.
    expect(fireEvent.click(a), 'il click del guscio va INTERCETTATO, altrimenti `_blank` esce comunque').toBe(false)
    expect(aperture).toEqual([['/privacy?da=%2Fparent%2Fattendance', '_self']])
  })

  it('il ritorno è il percorso da cui si è arrivati, non una costante', () => {
    stub.nativo = true
    stub.pathname = '/parent/primaria/assenze'
    render(<LinkInterno href="/termini">Termini</LinkInterno>)
    fireEvent.click(screen.getByRole('link', { name: 'Termini' }))
    expect(aperture).toEqual([['/termini?da=%2Fparent%2Fprimaria%2Fassenze', '_self']])
  })

  it('fuori dall’App Router (`usePathname` → null) il ritorno è la home, non «null»', () => {
    stub.nativo = true
    stub.pathname = null as unknown as string
    render(<LinkInterno href="/privacy">Leggi l’informativa</LinkInterno>)
    fireEvent.click(screen.getByRole('link', { name: /informativa/i }))
    expect(aperture).toEqual([['/privacy?da=%2F', '_self']])
  })

  it('un href che ha già una query non perde il proprio punto interrogativo', () => {
    expect(destinazioneInApp('/privacy?sezione=motivo', '/parent/attendance'))
      .toBe('/privacy?sezione=motivo&da=%2Fparent%2Fattendance')
  })

  it('conserva le classi e gli attributi di chi lo monta', () => {
    render(
      <LinkInterno href="/privacy" className="font-semibold underline" aria-label="Informativa">
        x
      </LinkInterno>,
    )
    const a = screen.getByRole('link', { name: 'Informativa' })
    expect(a.className).toContain('underline')
  })
})

/**
 * IL LOCK — perché il rimedio non resti nel file in cui il difetto è stato visto.
 *
 * Il rilievo nominava tre punti; cercando la stessa forma se n'è trovato un
 * QUARTO (`/parent/attendance`, la schermata gemella del modulo). È la ragione
 * per cui qui non si controlla «quei tre file sono a posto» ma «nessun file
 * dell'area riservata apre un percorso interno in una scheda nuova».
 *
 * Perimetro: solo gli `href` LETTERALI che cominciano con `/` e non con `/api/`.
 * Un allegato (`/api/…/file?id=…`) o un URL che arriva dal database sono link a
 * un FILE o a un sito esterno: là `target="_blank"` è la cosa giusta, e
 * distinguerli guardando la stringa è l'unico modo che non produce falsi
 * positivi.
 */
describe('lock · nessun percorso interno si apre in una scheda nuova', () => {
  const RADICE = process.cwd()
  const AREA = ['src/app/(dashboard)', 'src/components/features']

  /** Ogni `<a>`/`<Link>` con `target="_blank"` e un href letterale interno. */
  function apertureEsterne(sorgente: string): string[] {
    const trovati: string[] = []
    // `[^>]` include già i ritorni a capo: niente flag `s`, che il target di tsc non ammette.
    const re = /<(?:a|Link)\s+([^>]*?)>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(sorgente)) !== null) {
      const attributi = m[1]
      if (!/target\s*=\s*["']_blank["']/.test(attributi)) continue
      const href = /href\s*=\s*["'](\/[^"']*)["']/.exec(attributi)
      if (!href) continue // href dinamico o esterno: non è questo il caso
      if (href[1].startsWith('/api/')) continue // file da scaricare, non una schermata
      trovati.push(href[1])
    }
    return trovati
  }

  it('l’estrattore vede davvero un caso (altrimenti il divieto è vuoto)', () => {
    const finto = [
      '<a href="/privacy" target="_blank" rel="noopener noreferrer" className="x">t</a>',
      '<a href={c.downloadUrl} target="_blank" rel="noreferrer">t</a>',
      '<a href="/api/parent/file?id=1" target="_blank">t</a>',
      '<Link href="/parent/profilo">t</Link>',
    ].join('\n')
    expect(apertureEsterne(finto)).toEqual(['/privacy'])
  })

  it('nessun file dell’area riservata espelle l’utente su un percorso interno', () => {
    const guasti: string[] = []
    for (const cartella of AREA) {
      // `git ls-files` elenca i file TRACCIATI, che non è la stessa cosa dei file
      // PRESENTI: un file cancellato e non ancora committato resta in elenco e non
      // esiste su disco. Senza `existsSync` questo lock non falliva su un link
      // sbagliato — moriva con `ENOENT`, cioè smetteva di misurare l'intera cartella
      // per un motivo che non c'entra niente con i link. Misurato il 2026-08-11,
      // cancellando `AdultRegistryForm.tsx` insieme alla rotta che serviva.
      const elenco = execFileSync('git', ['ls-files', cartella], { cwd: RADICE, encoding: 'utf8' })
        .split('\n')
        .filter((f) => f.endsWith('.tsx'))
        .filter((f) => existsSync(join(RADICE, f)))
      for (const file of elenco) {
        for (const href of apertureEsterne(readFileSync(join(RADICE, file), 'utf8'))) {
          guasti.push(`${file} → ${href}`)
        }
      }
    }
    expect(
      guasti,
      `Questi link aprono una schermata DELL'APP in una scheda nuova:\n  ${guasti.join('\n  ')}\n` +
      'Nella WebView di Capacitor le schede non esistono: il sistema consegna l’indirizzo a ' +
      'Safari/Chrome e l’utente esce dall’applicazione, senza un comando per rientrare. Va usato ' +
      '`<LinkInterno>`, che sul web resta una scheda nuova e nel guscio nativo naviga in-app.',
    ).toEqual([])
  })
})
