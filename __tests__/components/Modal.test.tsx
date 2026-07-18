import { describe, it, expect, vi } from 'vitest'
import { useRef, useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { Modal } from '@/components/ui/Modal'

describe('Modal (primitive accessibile)', () => {
  it('espone role="dialog" + aria-modal + aria-label', () => {
    render(
      <Modal open onClose={() => {}} title="Titolo">
        <button>ok</button>
      </Modal>
    )
    const d = screen.getByRole('dialog')
    expect(d).toHaveAttribute('aria-modal', 'true')
    expect(d).toHaveAttribute('aria-label', 'Titolo')
  })

  it('non renderizza nulla quando chiuso', () => {
    render(
      <Modal open={false} onClose={() => {}} title="X">
        <button>ok</button>
      </Modal>
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Escape chiama onClose', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="X">
        <button>ok</button>
      </Modal>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('focalizza il primo elemento focusabile all’apertura', () => {
    render(
      <Modal open onClose={() => {}} title="X">
        <button>primo</button>
        <button>secondo</button>
      </Modal>
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'primo' }))
  })

  it('ripristina il focus al trigger alla chiusura', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button data-testid="trigger" onClick={() => setOpen(true)}>apri</button>
          <Modal open={open} onClose={() => setOpen(false)} title="X">
            <button>dentro</button>
          </Modal>
        </>
      )
    }
    render(<Harness />)
    const trigger = screen.getByTestId('trigger')
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
  })

  it('con returnFocusRef ripristina il focus al trigger anche se all’apertura activeElement era body', () => {
    // Regressione WCAG 2.4.3: il trigger è `disabled` durante la POST async che
    // precede l’apertura, quindi al momento del capture activeElement è già <body>.
    // Senza returnFocusRef il focus tornerebbe a body; col ref torna al bottone.
    function Harness() {
      const [open, setOpen] = useState(false)
      const triggerRef = useRef<HTMLButtonElement>(null)
      return (
        <>
          <button ref={triggerRef} data-testid="trigger" onClick={() => setOpen(true)}>apri</button>
          <Modal open={open} onClose={() => setOpen(false)} title="X" returnFocusRef={triggerRef}>
            <button>dentro</button>
          </Modal>
        </>
      )
    }
    render(<Harness />)
    const trigger = screen.getByTestId('trigger')
    // Non mettiamo a fuoco il trigger: in jsdom fireEvent.click NON dà il focus,
    // quindi all’apertura activeElement è <body> (simula il bottone disabilitato).
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
  })

  it('senza returnFocusRef, se all’apertura activeElement era body, alla chiusura il focus NON viene forzato al trigger', () => {
    // Retrocompatibilità: il comportamento storico (focus torna a previouslyFocused,
    // cioè body) resta invariato quando non si passa il ref di fallback.
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button data-testid="trigger" onClick={() => setOpen(true)}>apri</button>
          <Modal open={open} onClose={() => setOpen(false)} title="X">
            <button>dentro</button>
          </Modal>
        </>
      )
    }
    render(<Harness />)
    const trigger = screen.getByTestId('trigger')
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).not.toBe(trigger)
  })

  it('usa aria-labelledby (e omette aria-label) quando labelledBy è passato', () => {
    render(
      <Modal open onClose={() => {}} title="Titolo" labelledBy="h">
        <h2 id="h">Intestazione</h2>
        <button>ok</button>
      </Modal>
    )
    const d = screen.getByRole('dialog')
    expect(d).toHaveAttribute('aria-labelledby', 'h')
    expect(d).not.toHaveAttribute('aria-label')
  })

  it('con dialoghi annidati Escape chiude SOLO quello in cima (stack)', () => {
    const onCloseBottom = vi.fn()
    const onCloseTop = vi.fn()
    function Harness() {
      const [topOpen, setTopOpen] = useState(true)
      return (
        <>
          <Modal open onClose={onCloseBottom} title="Sotto">
            <button>sotto</button>
          </Modal>
          <Modal open={topOpen} onClose={() => { onCloseTop(); setTopOpen(false) }} title="Sopra">
            <button>sopra</button>
          </Modal>
        </>
      )
    }
    render(<Harness />)
    // Primo Escape: chiude solo il dialogo in cima.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCloseTop).toHaveBeenCalledTimes(1)
    expect(onCloseBottom).not.toHaveBeenCalled()
    // Secondo Escape: ora il dialogo di sotto è in cima e risponde.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCloseBottom).toHaveBeenCalledTimes(1)
  })

  it('un onClose inline (ricreato a ogni render) non ruba il focus a ogni render', () => {
    function Harness() {
      const [, setTick] = useState(0)
      return (
        <>
          <button data-testid="rerender" onClick={() => setTick((t) => t + 1)}>tick</button>
          {/* onClose inline: nuova funzione a ogni render */}
          <Modal open onClose={() => {}} title="X">
            <button>primo</button>
            <button data-testid="secondo">secondo</button>
          </Modal>
        </>
      )
    }
    render(<Harness />)
    const secondo = screen.getByTestId('secondo')
    secondo.focus()
    expect(document.activeElement).toBe(secondo)
    // Un re-render del genitore NON deve rifar partire l'effetto e riportare il
    // focus al primo controllo (regressione del focus-steal con deps [open,onClose]).
    fireEvent.click(screen.getByTestId('rerender'))
    expect(document.activeElement).toBe(secondo)
  })
})
