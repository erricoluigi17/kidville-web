import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import itAdminStudents from '../../messages/it/adminStudents.json'
import enAdminStudents from '../../messages/en/adminStudents.json'

/**
 * Localizzazione — i placeholder del modulo anagrafica vengono dal catalogo.
 *
 * Il collaudo del 2026-07-31: `StudentRegistryForm.tsx` aveva
 * `placeholder="Dettagli aggiuntivi..."` e `placeholder="Via Roma, 1"` scritti nel
 * TSX, mentre le chiavi (`phDettagliAggiuntivi`, `phVia`) esistevano già ed erano
 * già usate dal modulo gemello. In inglese quei due campi restavano italiani.
 *
 * Perché il mock locale restituisce un testo RICONOSCIBILE e non il catalogo vero:
 * `phDettagliAggiuntivi` valeva «Dettagli aggiuntivi...», cioè **esattamente** la
 * stringa cablata. Un'asserzione contro il valore di catalogo sarebbe stata verde
 * anche col difetto in piedi — l'asserzione-fantoccio da manuale. Marcando la
 * traduzione, il test distingue «viene dal catalogo» da «è la stessa frase».
 *
 * ⚠️ NOTA per chi legge: `StudentRegistryForm` oggi non è montato da nessuna parte
 * (`FamilyRegistryManager` usa `ScrollableStudentForm`). Il difetto quindi non
 * raggiunge nessun utente, e le altre ~25 etichette del file restano italiane
 * cablate: qui si chiude il rilievo, non si traduce un componente morto.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))
vi.mock('@/lib/utils/fiscalCodeApi', () => ({ fetchFiscalCode: vi.fn(async () => '') }))

const MARCA = (chiave: string) => `⟦adminStudents.${chiave}⟧`

vi.mock('next-intl', () => {
  const t = (key: string) => MARCA(key)
  const useTranslations = () => Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
  return {
    useTranslations,
    useLocale: () => 'it',
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

import { StudentRegistryForm } from '@/components/features/admin/StudentRegistryForm'

/** Porta il wizard al passo indicato premendo «Avanti». */
function vaiAlPasso(passo: number) {
  render(<StudentRegistryForm />)
  for (let i = 1; i < passo; i++) fireEvent.click(screen.getByText(/Avanti/i))
}

describe('StudentRegistryForm — i placeholder passano dal catalogo', () => {
  it('l\'indirizzo di residenza usa `phVia`, non una via scritta nel TSX', () => {
    vaiAlPasso(2)
    const campo = document.querySelector('input[name="indirizzo_residenza"]') as HTMLInputElement
    expect(campo).toBeTruthy()
    expect(campo.placeholder).toBe(MARCA('phVia'))
  })

  it('le note BES/DSA usano `phDettagliAggiuntivi`, non la stessa frase scritta a mano', () => {
    vaiAlPasso(3)
    fireEvent.click(document.querySelector('input[name="is_bes_dsa"]') as HTMLInputElement)
    const campo = document.querySelector('textarea[name="note_bes"]') as HTMLTextAreaElement
    expect(campo).toBeTruthy()
    expect(campo.placeholder).toBe(MARCA('phDettagliAggiuntivi'))
  })

  it('le due chiavi esistono in ENTRAMBI i cataloghi (senza, in inglese si vedrebbe il nome della chiave)', () => {
    for (const chiave of ['phVia', 'phDettagliAggiuntivi']) {
      expect(itAdminStudents).toHaveProperty(chiave)
      expect(enAdminStudents).toHaveProperty(chiave)
    }
    // Controllo positivo del mock: se restituisse il catalogo vero invece della
    // marca, le due asserzioni qui sopra sarebbero verdi anche col difetto.
    expect(MARCA('phDettagliAggiuntivi')).not.toBe(
      (itAdminStudents as Record<string, string>).phDettagliAggiuntivi,
    )
  })
})
