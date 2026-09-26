import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CodaFoto } from '@/components/features/gallery/CodaFoto'
import type { LocalGalleryMedia } from '@/lib/offline/db'

const row = (extra: Partial<LocalGalleryMedia>): LocalGalleryMedia => ({
  id: '11111111-1111-4111-8111-111111111111', uploaded_by: 'owner', scuola_id: 'school',
  caption: 'foto.jpg', tag_students: [], is_broadcast: false, target_classes: null,
  file_type: 'foto', file_blob: new Blob(['x'], { type: 'image/jpeg' }), file_name: 'foto.jpg',
  sync_status: 'error', phase: 'publish', storage_path: 'uploads/owner/a.jpg',
  creato_il: '2026-09-25T10:00:00.000Z', ...extra,
})

describe('CodaFoto', () => {
  it('mostra gli errori per file, i conteggi e il gesto Riprova caricamenti', () => {
    const onRetryAll = vi.fn()
    const onRetryRow = vi.fn()
    render(<CodaFoto rows={[row({ last_error: 'publish' }), row({ id: '22222222-2222-4222-8222-222222222222', sync_status: 'pending' })]}
      onRetryAll={onRetryAll} onRetryRow={onRetryRow} onDiscard={vi.fn()} onAssignSchool={vi.fn()} />)
    expect(screen.getByText(/1.*errore/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Riprova caricamenti/i }))
    expect(onRetryAll).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getAllByRole('button', { name: /^Riprova foto$/i })[0])
    expect(onRetryRow).toHaveBeenCalled()
  })

  it('una riga senza sede propone una scelta esplicita', () => {
    const onAssignSchool = vi.fn()
    render(<CodaFoto rows={[row({ scuola_id: null })]} onRetryAll={vi.fn()} onRetryRow={vi.fn()}
      onDiscard={vi.fn()} onAssignSchool={onAssignSchool} />)
    fireEvent.click(screen.getByRole('button', { name: /assegna.*sede/i }))
    expect(onAssignSchool).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111')
  })

  it('durante una pubblicazione incerta impedisce lo scarto e spiega che deve riconciliare', () => {
    const onDiscard = vi.fn()
    render(<CodaFoto rows={[row({ phase: 'publishing', sync_status: 'error', last_error: 'publish' })]}
      onRetryAll={vi.fn()} onRetryRow={vi.fn()} onDiscard={onDiscard} onAssignSchool={vi.fn()} />)
    expect(screen.getByText(/esito della pubblicazione/i)).toBeInTheDocument()
    const scarta = screen.getByRole('button', { name: /scarta foto/i })
    expect(scarta).toBeDisabled()
    fireEvent.click(scarta)
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('mostra l’orario locale del prossimo tentativo dopo Retry-After', () => {
    const now = new Date('2026-09-25T12:00:00.000Z').getTime()
    const ripresa = now + 60_000
    render(<CodaFoto rows={[row({ next_attempt_at: ripresa })]} now={now}
      onRetryAll={vi.fn()} onRetryRow={vi.fn()} onDiscard={vi.fn()} onAssignSchool={vi.fn()} />)
    expect(screen.getByText(/14:01/)).toBeInTheDocument()
    expect(screen.queryByText(/più tardi/i)).not.toBeInTheDocument()
  })

  it('anche durante il Retry-After spiega perché la foto non si può scartare', () => {
    const now = Date.now()
    render(<CodaFoto rows={[row({ phase: 'publishing', next_attempt_at: now + 60_000 })]} now={now}
      onRetryAll={vi.fn()} onRetryRow={vi.fn()} onDiscard={vi.fn()} onAssignSchool={vi.fn()} />)
    expect(screen.getByText(/esito della pubblicazione/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /scarta foto/i })).toBeDisabled()
  })

  it('mostra il prossimo tentativo nel fuso di Roma anche se il dispositivo è in UTC', () => {
    const ripresa = Date.parse('2026-07-30T22:30:00Z')
    render(<CodaFoto rows={[row({ next_attempt_at: ripresa })]} now={ripresa - 60_000}
      onRetryAll={vi.fn()} onRetryRow={vi.fn()} onDiscard={vi.fn()} onAssignSchool={vi.fn()} />)
    expect(screen.getByText(/31\/07\/26, 00:30/)).toBeInTheDocument()
  })
})
