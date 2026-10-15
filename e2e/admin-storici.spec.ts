import { test, expect } from '@playwright/test'
import { STORAGE } from './fixtures'
import { CATALOGO_STORICI } from '../src/lib/storici/catalogo'

test.use({ storageState: STORAGE.admin })
// Il percorso UI viene provato in CI anche quando il DB separato non ha ancora
// la nuova migrazione. Scope e file sono collaudati nelle API, senza dati reali.
test('centro stampe: alunno archiviato, 55 categorie, generazione parziale dichiarata', async ({ page }) => {
  const scuolaId = 'e2e00000-0000-4000-8000-000000000001'
  const alunnoId = 'e2e00000-0000-4000-8000-000000000002'
  const errori: string[] = []
  let lavori: object[] = []
  page.on('pageerror', e => errori.push(e.message))
  await page.route('**/api/admin/sections/scoped*', r => r.fulfill({ json: { data: [{ scuolaId, scuolaNome: 'Sede prova storici', sezioni: [{ id: 'classe-prova', name: 'Classe prova' }] }] } }))
  await page.route('**/api/admin/storici/**', async r => {
    const url = new URL(r.request().url())
    if (url.pathname.endsWith('/catalogo')) return r.fulfill({ json: { alunni: [{ id: alunnoId, nome: 'Alunno', cognome: 'Archiviato', archiviato_il: '2025-06-30' }], classiStoriche: [], categorie: CATALOGO_STORICI.map(c => ({ ...c, disponibile: true })) } })
    if (url.pathname.endsWith('/anteprima')) return r.fulfill({ json: { titolo: 'Archiviato Alunno', alunni: 1, sezioni: [{ id: 'diario_note', titolo: 'Note' }], avvisi: ['Appartenenze da completare'] } })
    if (url.pathname.endsWith('/generazioni')) {
      if (r.request().method() === 'POST') {
        const body = r.request().postDataJSON()
        expect(body).toMatchObject({ scuolaId, alunnoId, dal: '2020-09-01', al: '2021-06-30', formato: 'xlsx' })
        lavori = [{ id: 'prova', stato: 'parziale', cursore: 7, richiesta: body, titolo: 'Archiviato Alunno', avvisi: ['Originale non incorporato: documento mancante.'], errore: null }]
        return r.fulfill({ status: 202, json: { id: 'prova', stato: 'in_coda' } })
      }
      return r.fulfill({ json: { data: lavori } })
    }
    return r.fulfill({ json: { data: [], candidati: [] } })
  })
  await page.goto(`/admin/storici?scuolaId=${scuolaId}&alunnoId=${alunnoId}`)
  await expect(page.getByRole('heading', { name: 'Storici e stampe', exact: true })).toBeVisible()
  await expect(page.getByRole('checkbox')).toHaveCount(55)
  await expect(page.getByRole('option', { name: 'Archiviato Alunno (archiviato)' })).toBeAttached()
  await page.getByLabel('Dal', { exact: true }).first().fill('2020-09-01')
  await page.getByLabel('Al', { exact: true }).first().fill('2021-06-30')
  await page.getByLabel('Formato', { exact: true }).selectOption('xlsx')
  await page.getByRole('button', { name: 'Verifica selezione', exact: true }).click()
  await expect(page.getByText('Appartenenze da completare', { exact: true })).toBeVisible()
  const richiesta = page.waitForResponse(r => r.url().includes('/api/admin/storici/generazioni') && r.request().method() === 'POST')
  await expect(page.getByRole('button', { name: 'Genera file', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Genera file', exact: true }).click()
  expect((await richiesta).status()).toBe(202)
  await expect(page.getByRole('status').filter({ hasText: 'Pronto con avvertenze' })).toBeVisible()
  await page.getByText('Leggi le avvertenze di completezza', { exact: true }).click()
  await expect(page.getByText('Originale non incorporato: documento mancante.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Scarica', exact: true })).toBeEnabled()
  expect(errori).toEqual([])
})
