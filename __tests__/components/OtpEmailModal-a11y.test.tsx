import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import itForms from '../../messages/it/parentForms.json'
import enForms from '../../messages/en/parentForms.json'
import { OtpEmailModal } from '@/components/features/parent/forms/OtpEmailModal'

// =============================================================================
// `OtpEmailModal` — LA FINESTRA IN CUI UN GENITORE FIRMA (collaudo 2026-08-02).
//
// Non è una modale qualunque: è quella in cui un genitore appone una FIRMA
// ELETTRONICA SEMPLICE su un modulo scolastico. Ha valore legale, e per chi usa
// uno screen reader era muta su tutti e quattro i fronti misurati (a11y #4):
//
//   · nessun `role="dialog"`, nessun `aria-modal`, nessun nome: la finestra non
//     veniva annunciata, il Tab usciva sulla pagina sotto e Esc non chiudeva
//     (0 occorrenze di «Escape» nel file);
//   · il campo del codice a 6 cifre non aveva nome: il nome accessibile
//     calcolato era il PLACEHOLDER, cioè «••••••» — sei puntini letti a voce;
//   · il messaggio «codice errato» non era in nessuna live region (0 misurate):
//     chi non vede lo schermo riprovava a vuoto senza sapere perché;
//   · il ✕ non aveva nome (axe `button-name`, impact critical).
//
// LA CAUSA È UNA SOLA, ed è la stessa lezione già scritta in memoria per questo
// ciclo: una regola valida per due strade deve vivere in un posto solo. Il
// gemello `OtpSignatureModal` — stessa funzione, altro punto del prodotto — usa
// la primitiva `ui/Modal` e ha gli `aria-label`; questo era stato scritto a mano.
// Qui la finestra torna a essere UNA sola implementazione, non due.
//
// METODO. Nessuna asserzione «l'attributo c'è»: si verifica il COMPORTAMENTO —
// dove finisce il focus, che `onClose` sia stato davvero invocato, che il nome
// annunciato NON sia più il placeholder (che resta al suo posto come
// suggerimento). Ogni asserzione ha accanto il suo controllo positivo.
// =============================================================================

expect.extend(toHaveNoViolations)

const axeOpts = {
  rules: {
    // Regole di documento: non si applicano a un componente isolato in jsdom.
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
    'page-has-heading-one': { enabled: false },
  },
}

const EMAIL = 'genitore@esempio.test'

type Esito = { ok: boolean; error?: string }

function monta(opts: { onClose?: () => void; onVerify?: (c: string) => Promise<Esito> } = {}) {
  return render(
    <OtpEmailModal
      open
      email={EMAIL}
      onClose={opts.onClose ?? vi.fn()}
      onVerify={opts.onVerify ?? (async () => ({ ok: true }))}
    />,
  )
}

/** Il campo del codice, preso per RUOLO e NOME: è il punto del difetto. */
const campoCodice = () => screen.getByRole('textbox', { name: itForms.ariaCodiceFirma })

const digita = (valore: string) => fireEvent.change(campoCodice(), { target: { value: valore } })

afterEach(() => cleanup())

// ─────────────────────────────────────────────────────────────────────────────
// 1. È un dialogo, e si annuncia col suo nome
// ─────────────────────────────────────────────────────────────────────────────

describe('OtpEmailModal — la finestra della firma è un dialogo', () => {
  it('espone `role="dialog"` + `aria-modal`, col nome preso dal titolo visibile', () => {
    monta()
    const dialogo = screen.getByRole('dialog', { name: itForms.firmaElettronica })
    expect(dialogo).toHaveAttribute('aria-modal', 'true')
    // Il nome NON è un `aria-label` scritto a parte che potrebbe divergere dal
    // titolo a schermo: è il titolo stesso, referenziato.
    const titolo = screen.getByRole('heading', { name: itForms.firmaElettronica })
    expect(dialogo.getAttribute('aria-labelledby')).toBe(titolo.id)
    expect(titolo.id).not.toBe('')
  })

  it('a modale CHIUSA non esiste nessun dialogo (controllo positivo)', () => {
    render(<OtpEmailModal open={false} email={EMAIL} onClose={vi.fn()} onVerify={async () => ({ ok: true })} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('due istanze montate insieme non si rubano gli id del titolo', () => {
    render(
      <>
        <OtpEmailModal open email={EMAIL} onClose={vi.fn()} onVerify={async () => ({ ok: true })} />
        <OtpEmailModal open email={EMAIL} onClose={vi.fn()} onVerify={async () => ({ ok: true })} />
      </>,
    )
    // `hidden: true` perché è proprio ciò che ci si aspetta dalla primitiva: la
    // finestra in cima rende `inert` (e `aria-hidden`) tutto il resto, quella
    // sotto compresa. Qui interessa solo che gli id NON coincidano — con id
    // scritti a mano il secondo titolo etichetterebbe anche il primo dialogo.
    const [a, b] = screen.getAllByRole('dialog', { hidden: true })
    expect(a.getAttribute('aria-labelledby')).not.toBe(b.getAttribute('aria-labelledby'))
    expect(a.getAttribute('aria-labelledby')).not.toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Tastiera: Esc chiude, il focus resta dentro, e alla chiusura torna indietro
// ─────────────────────────────────────────────────────────────────────────────

describe('OtpEmailModal — la tastiera non resta fuori né intrappolata', () => {
  it('Esc chiude la finestra', () => {
    const onClose = vi.fn()
    monta({ onClose })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('all’apertura il focus entra nel campo del codice', async () => {
    monta()
    await waitFor(() => expect(document.activeElement).toBe(campoCodice()))
  })

  it('il Tab non esce dalla finestra, nemmeno se il focus è già scappato su `<body>`', () => {
    monta()
    const dialogo = screen.getByRole('dialog')
    ;(document.activeElement as HTMLElement)?.blur()
    expect(document.activeElement).toBe(document.body)

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(dialogo.contains(document.activeElement)).toBe(true)
  })

  it('mentre è aperta la pagina sotto è inerte, e alla chiusura torna raggiungibile', () => {
    function Pagina() {
      const [aperta, setAperta] = useState(false)
      return (
        <div>
          <button onClick={() => setAperta(true)}>Firma il modulo</button>
          <button>Controllo di sfondo</button>
          <OtpEmailModal
            open={aperta}
            email={EMAIL}
            onClose={() => setAperta(false)}
            onVerify={async () => ({ ok: true })}
          />
        </div>
      )
    }
    render(<Pagina />)
    const sfondo = screen.getByRole('button', { name: 'Controllo di sfondo' })
    const apri = screen.getByRole('button', { name: 'Firma il modulo' })

    // Controllo positivo: prima di aprire, lo sfondo prende il focus.
    sfondo.focus()
    expect(document.activeElement).toBe(sfondo)

    // `fireEvent.click` NON sposta il focus in jsdom, il browser sì: senza
    // questa riga il test misurerebbe il ripristino verso lo sfondo e non
    // verso il comando che ha aperto la finestra.
    apri.focus()
    fireEvent.click(apri)
    expect(sfondo.closest('[inert]')).not.toBeNull()
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelectorAll('[inert]').length).toBe(0)
    // WCAG 2.4.3: il focus torna a chi ha aperto la finestra.
    expect(document.activeElement).toBe(apri)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. I comandi hanno un nome
// ─────────────────────────────────────────────────────────────────────────────

describe('OtpEmailModal — ogni comando dice come si chiama', () => {
  it('il ✕ ha un nome accessibile e chiude davvero', () => {
    const onClose = vi.fn()
    monta({ onClose })
    const chiudi = screen.getByRole('button', { name: itForms.chiudi })
    // L'icona è decorativa: il nome lo porta l'etichetta, non la ✕.
    expect(chiudi.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(chiudi)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('il ✕ ha un bersaglio di almeno 44×44 (WCAG 2.5.8)', () => {
    monta()
    // jsdom non impagina: il minimo touch si verifica sulle classi dichiarate,
    // come già fa il lock di `AvvisoForm`.
    const chiudi = screen.getByRole('button', { name: itForms.chiudi })
    expect(chiudi.className).toMatch(/(^|\s)min-w-\[44px\](\s|$)/)
    expect(chiudi.className).toMatch(/(^|\s)min-h-\[44px\](\s|$)/)
  })

  it('il campo del codice ha un NOME, e il placeholder torna a essere un suggerimento', () => {
    monta()
    const campo = campoCodice() as HTMLInputElement
    // Il difetto misurato: il nome accessibile era «••••••».
    expect(campo).toHaveAttribute('aria-label', itForms.ariaCodiceFirma)
    expect(campo.placeholder).toBe('••••••')
    expect(campo.getAttribute('aria-label')).not.toBe(campo.placeholder)
    expect(campo.inputMode).toBe('numeric')
  })

  it('il ✕ sparisce a firma avvenuta, ma Esc continua a chiudere (nessuna trappola)', async () => {
    const onClose = vi.fn()
    monta({ onClose, onVerify: async () => ({ ok: true }) })
    digita('123456')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itForms.firmaCompleta, 'i') }))

    await screen.findByRole('heading', { name: itForms.moduloFirmato })
    expect(screen.queryByRole('button', { name: itForms.chiudi })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. L'esito si ANNUNCIA — errore e conferma
// ─────────────────────────────────────────────────────────────────────────────

describe('OtpEmailModal — l’esito della firma viene annunciato', () => {
  it('controllo positivo: prima di firmare non c’è nessun errore e la regione di stato è VUOTA', () => {
    monta()
    expect(screen.queryByRole('alert')).toBeNull()
    // La regione viva esiste già al montaggio, vuota: uno screen reader annuncia
    // i cambiamenti di una regione che c'era prima. Se nascesse insieme al testo,
    // l'annuncio potrebbe perdersi.
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('«codice errato» arriva in un `role="alert"`, e il campo si dichiara invalido', async () => {
    const errore = 'Codice non valido o scaduto'
    monta({ onVerify: async () => ({ ok: false, error: errore }) })
    digita('123456')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itForms.firmaCompleta, 'i') }))

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(errore)
    const campo = campoCodice()
    expect(campo).toHaveAttribute('aria-invalid', 'true')
    // L'errore è LEGATO al campo: chi ci torna sopra lo risente.
    expect(campo.getAttribute('aria-describedby')).toBe(avviso.id)
    expect(avviso.id).not.toBe('')
  })

  it('anche il codice incompleto (Invio con meno di 6 cifre) viene annunciato', async () => {
    monta()
    digita('12')
    fireEvent.keyDown(campoCodice(), { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent(itForms.inserisciCodice6)
  })

  it('la conferma «Modulo firmato» arriva nella regione di stato', async () => {
    monta({ onVerify: async () => ({ ok: true }) })
    digita('123456')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itForms.firmaCompleta, 'i') }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(itForms.moduloFirmato))
    expect(screen.getByRole('status')).toHaveTextContent(itForms.firmaRegistrata)
    // …e a firma avvenuta non resta nessun errore appeso.
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. axe, e le chiavi che tengono in piedi i nomi
// ─────────────────────────────────────────────────────────────────────────────

describe('OtpEmailModal — axe e cataloghi', () => {
  it('nessuna violazione axe sulla finestra aperta', async () => {
    const { container } = monta()
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('nessuna violazione axe con l’errore a schermo', async () => {
    const { container } = monta({ onVerify: async () => ({ ok: false, error: 'Codice non valido' }) })
    digita('123456')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itForms.firmaCompleta, 'i') }))
    await screen.findByRole('alert')
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('nessun testo della finestra è dipinto con utility grigie fuori dal tema', () => {
    const { container } = monta()
    // Misure (sRGB): `gray-400` #99A1AF = 2,60:1 su bianco — sotto i 3:1 che
    // WCAG 1.4.11 chiede a un COMANDO come il ✕; `gray-500` #6A7282 = 4,84:1,
    // che passa AA ma resta una utility FUORI dal tema, quindi invisibile sia
    // all'Alto Contrasto sia a `testo-muted-allowlist`. Il token `kidville-sub`
    // vale 6,46:1 ed è quello che il repo usa per il testo secondario.
    // Si misura sull'albero RESO: una classe che arriva da una costante
    // importata sfuggirebbe a un grep sul sorgente.
    const fuoriTema = Array.from(container.querySelectorAll<HTMLElement>('*')).filter((el) =>
      /(^|\s)text-(gray|zinc|slate|neutral|stone)-\d{2,3}(\s|$)/.test(el.className || ''),
    )
    expect(fuoriTema.map((el) => el.className)).toEqual([])
  })

  it('le chiavi dei nomi accessibili esistono in ENTRAMBE le lingue', () => {
    // next-intl in produzione mostra il PERCORSO della chiave quando manca, e il
    // mock dei test risolve i soli messaggi italiani: senza questa riga, un ✕
    // chiamato «parentForms.chiudi» in inglese passerebbe tutta la suite.
    for (const chiave of ['chiudi', 'ariaCodiceFirma', 'firmaElettronica', 'moduloFirmato'] as const) {
      expect(itForms, `manca ${chiave} in italiano`).toHaveProperty(chiave)
      expect(enForms, `manca ${chiave} in inglese`).toHaveProperty(chiave)
      expect(String(enForms[chiave]).trim()).not.toBe('')
    }
  })
})
