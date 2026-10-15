import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CATALOGO_STORICI } from '@/lib/storici/catalogo'
const h = vi.hoisted(() => ({ query: new URLSearchParams('scuolaId=sede&alunnoId=archiviato'), richieste: [] as Array<{url:string;body:unknown}>, scarica: vi.fn(), apiAssente: false }))
vi.mock('next/navigation', () => ({ useSearchParams: () => h.query, usePathname: () => '/admin/storici', useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/auth/use-session-identity', () => ({ useSessionIdentity: () => ({ userId: 'staff', role: 'segreteria' }) }))
vi.mock('@/lib/native/scarica', () => ({ apriDocumento: h.scarica, scaricaDocumento: h.scarica }))
vi.mock('next-intl', async () => {
  const { createTranslator } = await import('use-intl')
  const { default: storici } = await import('../../messages/it/storici.json')
  return { useTranslations: (namespace: string) => namespace === 'storici' ? createTranslator({ locale: 'it', messages: { storici }, namespace: 'storici' }) : (chiave: string) => chiave, useLocale: () => 'it' }
})
import { StoriciPanel } from '@/components/features/admin/storici/StoriciPanel'
beforeEach(() => {
  h.richieste = []; h.apiAssente = false; h.scarica.mockReset().mockResolvedValue({ esito: 'web-blob' })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (body) h.richieste.push({ url, body })
    let risposta: unknown = { data: [] }, ok = true
    if (url.includes('/api/admin/sections/scoped')) risposta = { data: [{ scuolaId: 'sede', scuolaNome: 'Sede fittizia', sezioni: [{ id: 'classe', name: 'Classe fittizia' }] }] }
    if (url.includes('/catalogo')) { risposta = h.apiAssente ? { error: 'La struttura degli storici non è ancora disponibile su questo ambiente.' } : { alunni: [{ id: 'archiviato', nome: 'Alunno', cognome: 'Fittizio', archiviato_il: '2020-06-30' }], classiStoriche: [], categorie: CATALOGO_STORICI.map(c => ({ ...c, disponibile: true })) }; ok = !h.apiAssente }
    if (url.includes('/anteprima')) risposta = { titolo: 'Fittizio Alunno', alunni: 1, sezioni: [{ id: 'diario_note', titolo: 'Note' }], avvisi: ['Copertura da completare'] }
    if (url.includes('/generazioni') && init?.method !== 'POST') risposta = { data: [{ id: 'lavoro', titolo: 'Fittizio Alunno', stato: 'parziale', cursore: 1, errore: null, avvisi: ['Originale non incorporato'], richiesta: { dal: '2020-09-01', al: '2021-06-30', categorie: ['diario_note'], formato: 'pdf' } }] }
    return { ok, json: async () => risposta }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('centro storico staff', () => {
  it('l’etichetta visibile del formato è distinta dal testo delle opzioni', async () => {
    render(<StoriciPanel />)
    await screen.findByRole('option', { name: 'Fittizio Alunno (archiviato)' })
    const formato = screen.getByRole('combobox', { name: 'Formato' }) as HTMLSelectElement
    expect(Array.from(formato.labels ?? []).map(l => l.textContent?.trim())).toEqual(['Formato'])
  })
  it('include gli archiviati, tutte le categorie e invia le date scelte', async () => {
    render(<StoriciPanel />)
    await screen.findByRole('option', { name: 'Fittizio Alunno (archiviato)' })
    expect(screen.getAllByRole('checkbox')).toHaveLength(55)
    fireEvent.change(screen.getAllByLabelText('Dal', { exact: true })[0], { target: { value: '2020-09-01' } })
    fireEvent.change(screen.getAllByLabelText('Al', { exact: true })[0], { target: { value: '2021-06-30' } })
    fireEvent.change(screen.getByLabelText('Formato'), { target: { value: 'xlsx' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verifica selezione' }))
    expect(await screen.findByText('Copertura da completare')).toBeTruthy()
    expect(h.richieste[0].body).toMatchObject({ scuolaId: 'sede', alunnoId: 'archiviato', dal: '2020-09-01', al: '2021-06-30', formato: 'xlsx' })
  })
  it('dichiara la parzialità e apre il file attraverso lo strumento nativo condiviso', async () => {
    render(<StoriciPanel />)
    const apri = await screen.findByRole('button', { name: 'Apri e stampa' })
    expect(screen.getByText('Pronto con avvertenze', { exact: false })).toBeTruthy()
    fireEvent.click(apri)
    await waitFor(() => expect(h.scarica).toHaveBeenCalledWith(expect.objectContaining({ sorgente: expect.stringContaining('/api/admin/storici/generazioni/lavoro/file'), mime: 'application/pdf' })))
  })
  it('mostra un errore esplicito sul database non migrato', async () => {
    h.apiAssente = true
    render(<StoriciPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('non è ancora disponibile')
  })
})
