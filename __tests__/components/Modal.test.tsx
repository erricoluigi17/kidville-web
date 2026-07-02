import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
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
})
