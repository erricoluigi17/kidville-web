import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render, screen, fireEvent, act } from '@testing-library/react'

// =============================================================================
// `ui/Modal` — UNA MODALE CHE È DAVVERO UN DIALOGO (collaudo 2026-07-31).
//
// Cinque tester su otto hanno riportato lo stesso difetto da cinque angoli
// diversi. La causa è una sola, e sta tutta nella primitiva condivisa dai 15
// componenti che la usano (firma OTP, incassi, cassa, chat, avvisi…).
//
//  1. IL VELO ERA UN ANTENATO. `Modal.tsx` metteva `backdrop-filter: blur(8px)`
//     sul div che CONTIENE il `[role=dialog]`. Sulla WebView Chromium di Android
//     un antenato filtrato cancella l'INTERO sottoalbero dall'albero di
//     accessibilità: con la modale «Nuovo avviso» a schermo, `uiautomator dump`
//     restituiva 120 nodi e NESSUNO era della modale — per TalkBack non esisteva.
//     Misura del tester: togliendo `backdropFilter` dall'antenato via CDP, il
//     dump successivo esponeva subito TITOLO / CONTENUTO / PUBBLICA AVVISO.
//     Controprova nel repo: `AdminMenuSheet` mette il blur su un div FRATELLO
//     `aria-hidden` ed è regolarmente esposto.
//
//  2. LA PAGINA SOTTO RESTAVA VIVA. `aria-modal="true"` su un div normale non
//     esclude nulla: Chromium lo onora solo nel top layer (`<dialog>` +
//     `showModal()`). Misura: `{"inertSuMain":false,"ariaHiddenSuMain":null}`,
//     e nel dump convivevano la modale e i bottoni «Modifica»/«Elimina» della
//     tabella retrostante.
//
//  3. IL TASTO INDIETRO PORTAVA VIA LA BOZZA. `useOverlayIndietro` era stato
//     scritto ma non era invocato da NESSUNO (`grep -rn` → solo il file che lo
//     definisce): il registro restava vuoto, `chiudiOverlayInCima()` rispondeva
//     sempre `false` e Android navigava. Con «TESTa11y» nel titolo, un Indietro
//     riportava alla dashboard e cancellava il testo.
//
//  4. LA MODALE STAVA SOTTO LA TOPBAR. `z-[80]` contro `z-[105]` della topbar
//     admin: su iPhone il bottone di chiusura finiva SOTTO la barra verde e il
//     tap colpiva la campanella (`elementFromPoint` → `HEADER.kv-admin-topbar`).
//
// METODO. Si asserisce il COMPORTAMENTO, non la presenza degli attributi: dove
// finisce il focus (l'elemento esatto), che `onClose` sia stato invocato, che il
// dialogo sparisca dal DOM. Ogni asserzione negativa ha accanto il suo controllo
// positivo — soprattutto quello che conta: a modale CHIUSA la pagina sotto deve
// tornare raggiungibile. Senza, un test che verifica «lo sfondo non si raggiunge»
// passerebbe anche su una pagina che non ha caricato affatto.
// =============================================================================

// Il foglio «Menu» del cockpit NON usa la primitiva: ha una struttura sua (già
// corretta — è il modello da cui la primitiva ha copiato il velo fratello). Ma il
// tasto Indietro gli mancava allo stesso modo, con un esito anche peggiore: la
// pagina sotto cambiava MENTRE il foglio restava aperto sopra, e in una prova
// l'app è uscita del tutto. Qui i suoi provider sono stubbati: hanno test propri.
const sediStub = vi.hoisted(() => ({ sedi: [] as { id: string; nome: string }[] }))
vi.mock('next/navigation', () => ({ usePathname: () => '/admin' }))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: sediStub.sedi,
    selezionate: [],
    effettive: [],
    sedeCorrente: null,
    reFetchKey: '',
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))
vi.mock('@/components/ui/ContrastMenuButton', () => ({
  ContrastMenuButton: () => <button>Alto contrasto</button>,
}))
vi.mock('@/components/ui/LogoutMenuButton', () => ({
  LogoutMenuButton: () => <button>Esci</button>,
}))
// Stessa ragione delle due sorelle qui sopra: «Cambia profilo» ha i suoi test
// (`__tests__/components/cambia-profilo.test.tsx`) e ha bisogno di `useRouter` e
// di una `/api/me`. Qui è un marker inerte, così questo file continua a misurare
// il tasto Indietro e nient'altro.
vi.mock('@/components/ui/CambiaProfiloMenuButton', () => ({
  CambiaProfiloMenuButton: () => <button>Passa a Genitore</button>,
}))

import { Modal } from '@/components/ui/Modal'
import { AdminMenuSheet } from '@/components/features/admin/AdminMenuSheet'
import { chiudiOverlayInCima } from '@/lib/mobile/overlay-indietro'

const APRI = 'Apri la modale'
const SFONDO = 'Controllo di sfondo'
const DENTRO = 'Controllo dentro la modale'

/** Risalita completa: dal dialogo fino a `<html>`. */
function antenati(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  let p = el.parentElement
  while (p) {
    out.push(p)
    p = p.parentElement
  }
  return out
}

/** Una pagina finta con due controlli di sfondo e la modale dentro. */
function Pagina({
  closeOnBackdrop,
  onClose,
}: { closeOnBackdrop?: boolean; onClose?: () => void } = {}) {
  const [aperta, setAperta] = useState(false)
  return (
    <div>
      <button onClick={() => setAperta(true)}>{APRI}</button>
      <button>{SFONDO}</button>
      <Modal
        open={aperta}
        onClose={() => {
          onClose?.()
          setAperta(false)
        }}
        title="Titolo della modale"
        closeOnBackdrop={closeOnBackdrop}
      >
        <button>{DENTRO}</button>
      </Modal>
    </div>
  )
}

const apri = () => fireEvent.click(screen.getByRole('button', { name: APRI }))

/** Il velo: il fratello `aria-hidden` che porta lo sfondo velato e la sfocatura. */
function velo(dialog: HTMLElement): HTMLElement {
  const contenitore = dialog.parentElement as HTMLElement
  const trovato = Array.from(contenitore.children).find((c) => c !== dialog) as HTMLElement | undefined
  if (!trovato) throw new Error('il contenitore della modale non ha nessun fratello del dialogo')
  return trovato
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Il velo è un FRATELLO del dialogo, non un suo antenato.
// ─────────────────────────────────────────────────────────────────────────────

describe('Modal — la sfocatura non sta più su un antenato del dialogo', () => {
  it('il velo esiste, è `aria-hidden`, porta la sfocatura ed è fratello del dialogo', () => {
    render(<Pagina />)
    apri()
    const dialog = screen.getByRole('dialog')
    const v = velo(dialog)

    // Controllo positivo: il velo c'è davvero e sfoca davvero. Senza questo, la
    // prova successiva («nessun antenato sfoca») passerebbe anche su una modale
    // che ha perso del tutto il proprio sfondo.
    expect(v).toHaveAttribute('aria-hidden', 'true')
    expect(v.style.getPropertyValue('backdrop-filter')).not.toBe('')
    expect(v.parentElement).toBe(dialog.parentElement)
  })

  it('NESSUN antenato del `[role=dialog]` ha `backdrop-filter` o `filter` valorizzato', () => {
    render(<Pagina />)
    apri()
    const dialog = screen.getByRole('dialog')

    /** `getComputedStyle` risponde `'none'` (non stringa vuota) quando la proprietà non c'è. */
    const impostata = (v: string | null) => {
      const s = (v ?? '').trim()
      return s !== '' && s !== 'none'
    }
    const filtranti = antenati(dialog).filter((a) => {
      const s = getComputedStyle(a)
      // Sia lo stile inline (che jsdom calcola) sia le utility Tailwind (che non
      // calcola): la sfocatura può tornare dall'una o dall'altra porta.
      return (
        impostata(s.getPropertyValue('backdrop-filter')) ||
        impostata(s.getPropertyValue('filter')) ||
        /(^|\s)(backdrop-)?(blur|filter)-/.test(a.className)
      )
    })
    expect(filtranti.map((a) => a.getAttribute('style') ?? a.className)).toEqual([])
  })

  it('il velo prende il colore dal token, non da un hex cablato', () => {
    render(<Pagina />)
    apri()
    const v = velo(screen.getByRole('dialog'))
    expect(v.getAttribute('style')).toContain('--color-kidville-green')
    expect(v.getAttribute('style')).not.toContain('rgba(0,106,95')
  })

  it('il dialogo è posizionato: non finisce sotto al velo (che è `absolute`)', () => {
    // jsdom non impagina: la garanzia si dà sulla struttura. Un fratello
    // ASSOLUTO che viene prima in ordine di documento dipinge SOPRA un fratello
    // non posizionato — cioè il velo si mangerebbe il dialogo e ogni suo click.
    render(<Pagina />)
    apri()
    const dialog = screen.getByRole('dialog')
    expect(velo(dialog).className).toMatch(/(^|\s)absolute(\s|$)/)
    expect(dialog.className).toMatch(/(^|\s)relative(\s|$)/)
  })

  it('il click sul velo chiude (e con `closeOnBackdrop={false}` non chiude)', () => {
    const { unmount } = render(<Pagina />)
    apri()
    fireEvent.mouseDown(velo(screen.getByRole('dialog')))
    expect(screen.queryByRole('dialog')).toBeNull()
    unmount()

    render(<Pagina closeOnBackdrop={false} />)
    apri()
    fireEvent.mouseDown(velo(screen.getByRole('dialog')))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Lo sfondo diventa inerte, e torna vivo alla chiusura.
// ─────────────────────────────────────────────────────────────────────────────

describe('Modal — il contenuto retrostante non è raggiungibile mentre è aperta', () => {
  it('a modale CHIUSA nessuno è inerte e lo sfondo prende il focus (controllo positivo)', () => {
    render(<Pagina />)
    expect(document.querySelectorAll('[inert]').length).toBe(0)
    const sfondo = screen.getByRole('button', { name: SFONDO })
    sfondo.focus()
    expect(document.activeElement).toBe(sfondo)
  })

  it('aperta: lo sfondo è dentro un sottoalbero inerte, il dialogo NO', () => {
    render(<Pagina />)
    const sfondo = screen.getByRole('button', { name: SFONDO })
    apri()

    expect(sfondo.closest('[inert]')).not.toBeNull()
    const dialog = screen.getByRole('dialog')
    expect(dialog.closest('[inert]')).toBeNull()
    // Controllo positivo: dentro la modale il focus ci arriva davvero.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: DENTRO }))
  })

  it('chiusa: l’inerzia sparisce del tutto e lo sfondo torna a prendere il focus', () => {
    render(<Pagina />)
    apri()
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(document.querySelectorAll('[inert]').length).toBe(0)
    const sfondo = screen.getByRole('button', { name: SFONDO })
    sfondo.focus()
    expect(document.activeElement).toBe(sfondo)
  })

  it('alla chiusura riconsegna gli attributi come li aveva trovati', () => {
    // Dove `inert` non esiste (WebKit < 15.5, e jsdom) si affianca `aria-hidden`.
    // Il ripristino deve distinguere chi quell'attributo ce l'aveva già di suo —
    // un elemento decorativo — da chi l'ha ricevuto da noi: cancellarlo a tutti
    // renderebbe visibile agli screen reader roba nata per non esserlo.
    function ConDecorativo() {
      const [aperta, setAperta] = useState(false)
      return (
        <div>
          <button onClick={() => setAperta(true)}>{APRI}</button>
          <span data-testid="decorativo" aria-hidden="true">
            ★
          </span>
          <button>{SFONDO}</button>
          <Modal open={aperta} onClose={() => setAperta(false)} title="X">
            <button>{DENTRO}</button>
          </Modal>
        </div>
      )
    }
    render(<ConDecorativo />)
    const decorativo = screen.getByTestId('decorativo')
    const sfondo = screen.getByRole('button', { name: SFONDO })
    apri()
    expect(decorativo.closest('[inert]')).not.toBeNull() // controllo positivo
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(decorativo).toHaveAttribute('aria-hidden', 'true')
    expect(decorativo.hasAttribute('inert')).toBe(false)
    expect(sfondo.hasAttribute('aria-hidden')).toBe(false)
    expect(sfondo.hasAttribute('inert')).toBe(false)
  })

  it('con due modali sovrapposte lo sfondo resta inerte finché non si chiude anche l’ultima', () => {
    function Due() {
      const [a, setA] = useState(false)
      const [b, setB] = useState(false)
      return (
        <div>
          <button onClick={() => setA(true)}>{APRI}</button>
          <button>{SFONDO}</button>
          <Modal open={a} onClose={() => setA(false)} title="Sotto">
            <button onClick={() => setB(true)}>apri la seconda</button>
          </Modal>
          <Modal open={b} onClose={() => setB(false)} title="Sopra">
            <button>dentro la seconda</button>
          </Modal>
        </div>
      )
    }
    render(<Due />)
    const sfondo = screen.getByRole('button', { name: SFONDO })
    apri()
    fireEvent.click(screen.getByRole('button', { name: 'apri la seconda' }))
    expect(sfondo.closest('[inert]')).not.toBeNull()

    // Chiude solo quella in cima: lo sfondo NON deve tornare raggiungibile.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getAllByRole('dialog').length).toBe(1)
    expect(sfondo.closest('[inert]')).not.toBeNull()
    // …e la modale rimasta è di nuovo viva: il focus ci è tornato dentro.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'apri la seconda' }))
    expect((document.activeElement as HTMLElement).closest('[inert]')).toBeNull()

    // Chiusa anche quella, lo sfondo torna raggiungibile (controllo positivo).
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelectorAll('[inert]').length).toBe(0)
    sfondo.focus()
    expect(document.activeElement).toBe(sfondo)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Il tasto Indietro di Android chiude la modale invece di navigare.
// ─────────────────────────────────────────────────────────────────────────────

describe('Modal — il tasto Indietro fisico chiude la modale, non la pagina', () => {
  it('senza nessuna modale montata il registro è vuoto (controllo positivo)', () => {
    render(<Pagina />)
    expect(chiudiOverlayInCima()).toBe(false)
  })

  it('con la modale aperta l’evento è consumato, `onClose` è invocato e il dialogo sparisce', () => {
    const onClose = vi.fn()
    render(<Pagina onClose={onClose} />)
    apri()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // `true` = evento consumato: il gestore nativo NON navigherà. La chiusura passa
    // per uno `setState`, quindi va dentro `act` come farebbe il gestore vero.
    let consumato: boolean | undefined
    act(() => {
      consumato = chiudiOverlayInCima()
    })
    expect(consumato).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
    // L'asserzione che conta è sulla mutazione: il dialogo non c'è più.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('chiusa la modale, l’Indietro successivo torna a navigare (nessuna trappola)', () => {
    render(<Pagina />)
    apri()
    fireEvent.keyDown(document, { key: 'Escape' })
    // Se l'overlay non uscisse dal registro, ogni Indietro successivo verrebbe
    // ingoiato e l'utente resterebbe intrappolato nella pagina per sempre.
    expect(chiudiOverlayInCima()).toBe(false)
  })

  it('anche il foglio «Menu» del cockpit consuma l’Indietro e si chiude', () => {
    function Cockpit() {
      const [aperto, setAperto] = useState(false)
      return (
        <div>
          <button onClick={() => setAperto(true)}>{APRI}</button>
          <AdminMenuSheet
            open={aperto}
            onClose={() => setAperto(false)}
            withUser={(href) => href}
            ruolo="segreteria"
            returnFocusRef={{ current: null }}
          />
        </div>
      )
    }
    render(<Cockpit />)
    expect(chiudiOverlayInCima()).toBe(false) // controllo positivo: registro vuoto
    apri()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    let consumato: boolean | undefined
    act(() => {
      consumato = chiudiOverlayInCima()
    })
    expect(consumato).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Il focus-trap non lascia scappare nemmeno da `<body>`.
// ─────────────────────────────────────────────────────────────────────────────

describe('Modal — il focus-trap regge anche quando il focus è già scappato', () => {
  it('Tab con il focus su `<body>` lo riporta dentro il dialogo', () => {
    render(<Pagina />)
    apri()
    const dialog = screen.getByRole('dialog')
    const dentro = screen.getByRole('button', { name: DENTRO })
        // Il caso misurato: dopo il click su «Pubblica avviso» (bottone che si
    // disabilita durante la POST) `document.activeElement` è `<body>`, e da lì
    // il Tab usciva sulla pagina sotto.
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(dentro)
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('i controlli nascosti non entrano nel giro del focus', () => {
    render(
      <Modal open onClose={() => {}} title="X">
        <button style={{ display: 'none' }}>nascosto</button>
        <div hidden>
          <button>dentro un ramo nascosto</button>
        </div>
        <button>visibile</button>
      </Modal>,
    )
    // All'apertura il focus va sul primo controllo VISIBILE, non sul primo del DOM.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'visibile' }))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. La modale sta sopra il chrome del cockpit (topbar, sidebar, foglio Menu).
// ─────────────────────────────────────────────────────────────────────────────

describe('Modal — il piano sta sopra tutte le barre fisse dell’admin', () => {
  /** z-index massimo dichiarato nel sorgente di un componente. */
  function zMassimo(file: string): number {
    const src = readFileSync(path.resolve(process.cwd(), file), 'utf8')
    const valori = [...src.matchAll(/(?:^|\s)z-\[?(\d+)\]?/g)].map((m) => Number(m[1]))
    expect(valori.length).toBeGreaterThan(0)
    return Math.max(...valori)
  }

  it('z(modale) > z(topbar admin), > z(sidebar), > z(foglio Menu)', () => {
    render(<Pagina />)
    apri()
    const contenitore = screen.getByRole('dialog').parentElement as HTMLElement
    const zModale = Number(/(?:^|\s)z-\[?(\d+)\]?/.exec(contenitore.className)?.[1])
    expect(Number.isFinite(zModale)).toBe(true)

    const zChrome = Math.max(
      zMassimo('src/components/features/admin/AdminTopBarMobile.tsx'),
      zMassimo('src/components/features/admin/AdminSidebar.tsx'),
      zMassimo('src/components/features/admin/AdminMenuSheet.tsx'),
    )
    // Controllo positivo: il chrome un piano ce l'ha davvero (se il regex non
    // trovasse nulla, `zChrome` sarebbe -Infinity e il confronto passerebbe da solo).
    expect(zChrome).toBeGreaterThanOrEqual(105)
    expect(zModale).toBeGreaterThan(zChrome)
  })
})
