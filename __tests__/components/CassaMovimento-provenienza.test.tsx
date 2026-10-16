import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CassaMovimentoModal } from '@/components/features/admin/pagamenti/CassaMovimentoModal'

function prepara(sedi = [{ id: 'sede', nome: 'Sede' }]) {
  const salvataggi: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    const corpo = u.includes('/admin/settings/categorie') ? { success: true, data: [{ id: 'cat-incasso', nome: 'Gita', scuola_id: null, attivo: true }] }
      : u.includes('/cassa/categorie') ? { disponibile: true, categorie: [{ id: 'spesa', nome: 'Trasporto', slug: 'trasporto', attivo: true, ordine: 1 }] }
      : { movimento: { id: 'mov' } }
    if (init?.method === 'POST' && u.includes('/cassa/movimenti')) salvataggi.push(JSON.parse(String(init.body)))
    return { ok: true, status: 200, json: async () => corpo } as Response
  }))
  render(<CassaMovimentoModal userId="operatore" sedi={sedi} sedeIniziale="sede" tipoIniziale="uscita" onClose={() => {}} onDone={() => {}} />)
  return salvataggi
}
afterEach(() => vi.unstubAllGlobals())

describe('Scelta esplicita della cassa di provenienza', () => {
  it('blocca il salvataggio finché non si indica da quale cassa togliere il denaro', async () => {
    const salvataggi = prepara()
    await screen.findByRole('option', { name: 'Trasporto' })
    fireEvent.change(screen.getByLabelText(/Importo/), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText(/Categoria/), { target: { value: 'spesa' } })
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/cassa/i)
    expect(salvataggi).toHaveLength(0)
  })
  it.each([['generale', null], ['cat-incasso', 'cat-incasso']])('invia la scelta %s separata dalla categoria di spesa', async (valore, atteso) => {
    const salvataggi = prepara()
    await screen.findByRole('option', { name: 'Gita' })
    fireEvent.change(screen.getByLabelText(/Importo/), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText(/Categoria/), { target: { value: 'spesa' } })
    fireEvent.change(screen.getByLabelText(/Cassa di provenienza/), { target: { value: valore } })
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }))
    await waitFor(() => expect(salvataggi).toHaveLength(1))
    expect(salvataggi[0]).toMatchObject({ categoria_id: 'spesa', cassa_categoria_id: atteso })
  })
  it('cambiare sede azzera anche la cassa già scelta, compresa la generale', async () => {
    prepara([{ id: 'sede', nome: 'Alfa' }, { id: 'altra', nome: 'Beta' }])
    await screen.findByRole('option', { name: 'Gita' })
    const fonte = screen.getByLabelText(/Cassa di provenienza/)
    fireEvent.change(fonte, { target: { value: 'generale' } })
    fireEvent.change(screen.getByRole('combobox', { name: /^Sede/ }), { target: { value: 'altra' } })
    expect(fonte).toHaveValue('')
  })
})
