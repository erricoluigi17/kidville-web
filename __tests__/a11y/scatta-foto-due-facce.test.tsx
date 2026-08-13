import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'
import { fotocameraNativaDisponibile } from '@/lib/native/camera'
import { FileField } from '@/components/features/forms/FieldRenderer'
import { PERSONALE_FIELDS } from '@/lib/forms/personale-template'
import itParentForms from '../../messages/it/parentForms.json'
import enParentForms from '../../messages/en/parentForms.json'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  DUE BOTTONI «SCATTA FOTO», UNO SOPRA L'ALTRO, CHE SI CHIAMAVANO UGUALE   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── IL DIFETTO, E PERCHÉ NESSUN TEST LO VEDEVA ──────────────────────────────
 *
 * Dal 12/08/2026 il passo «Documento» di `/anagrafica-personale` chiede DUE
 * scansioni (fronte e retro). Ogni `FileField` che ammette immagini rende un
 * `ScattaFotoButton`, e quel bottone sta FUORI dalla `<label>` del campo — deve
 * starci, altrimenti un clic riaprirebbe il selettore di file — quindi non eredita
 * nessun nome dall'etichetta. Risultato: due bottoni con lo stesso identico nome
 * accessibile, «Scatta foto», e niente che dicesse quale fosse quale.
 *
 * `ScattaFotoButton` fa `if (!nativo) return null`: su web e in jsdom NON ESISTE. È
 * per questo che nessuna prova esistente poteva accorgersene, e nell'app Capacitor
 * quello è — per ammissione del commento in `FieldRenderer` — «il modo normale di
 * consegnare la scansione del documento».
 *
 * ── PERCHÉ QUESTO FILE HA UN MOCK DI `next-intl` TUTTO SUO ──────────────────
 *
 * Il mock globale (`test/setup.ts`) risolve le chiavi sui messaggi italiani veri ma
 * **butta via i valori**: `t('scattaFotoDi', { campo })` tornerebbe la stringa grezza
 * `«Scatta foto: {campo}»` per tutti e due i campi, cioè i due nomi resterebbero
 * identici e questa prova sarebbe rossa su un prodotto sano. Qui l'interpolazione si
 * fa davvero — è l'unico modo di misurare la cosa che conta, che è la DIFFERENZA fra
 * i due nomi.
 */

vi.mock('@/lib/native/camera', () => ({
  fotocameraNativaDisponibile: vi.fn(),
  scegliFotoNativa: vi.fn(async () => []),
}))

// ⚠️ FABBRICA `async` E IMPORT DENTRO: `vi.mock` è issata in cima al file, quindi una
// variabile di modulo (`itParentForms`) qui dentro non è ancora inizializzata — è lo
// stesso motivo per cui `test/setup.ts` importa i messaggi dentro la fabbrica.
vi.mock('next-intl', async () => {
  const gruppi: Record<string, Record<string, string>> = {
    parentForms: (await import('../../messages/it/parentForms.json')).default as Record<
      string,
      string
    >,
    shared: (await import('../../messages/it/shared.json')).default as unknown as Record<
      string,
      string
    >,
  }
  const useTranslations = (ns?: string) => {
    const t = (chiave: string, valori?: Record<string, string | number>) => {
      const grezzo = (ns ? gruppi[ns]?.[chiave] : undefined) ?? `${ns}.${chiave}`
      if (!valori) return grezzo
      return grezzo.replace(/\{(\w+)\}/g, (intero, nome: string) =>
        nome in valori ? String(valori[nome]) : intero,
      )
    }
    return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: String, dateTime: String }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

const mockDisponibile = vi.mocked(fotocameraNativaDisponibile)

/** Le due facce, LETTE DAL TEMPLATE: le etichette sono quelle vere del modulo. */
const FACCE = PERSONALE_FIELDS.filter((f) => f.type === 'file')

beforeEach(() => {
  vi.clearAllMocks()
  // Senza questo il componente non rende NULLA e ogni asserzione qui sotto sarebbe
  // verde per il motivo sbagliato — il difetto vive solo nell'app nativa.
  mockDisponibile.mockReturnValue(true)
})
afterEach(() => cleanup())

function renderFaccia(indice: number) {
  const campo = FACCE[indice]
  return render(
    <FileField
      modelId="pratiche_personale"
      value=""
      onChange={() => {}}
      accept={campo.accept}
      maxSizeMb={campo.max_size_mb}
      fieldId={campo.id}
      etichettaCampo={campo.label}
    />,
  )
}

describe('a11y — «Scatta foto» al passo del documento', () => {
  it('la premessa regge: il passo chiede DUE facce, con etichette diverse', () => {
    // Se un giorno tornassero a essere una sola, questo file misurerebbe il nulla e
    // resterebbe verde. Meglio che diventi rosso qui, dove c'è scritto perché.
    expect(FACCE).toHaveLength(2)
    expect(FACCE[0].label).not.toBe(FACCE[1].label)
  })

  it('i due bottoni hanno nomi accessibili DIVERSI, e ognuno dice la sua faccia', () => {
    const { container: fronte } = renderFaccia(0)
    const { container: retro } = renderFaccia(1)

    const nome = (radice: HTMLElement) =>
      within(radice).getByRole('button').getAttribute('aria-label') ?? ''

    const nomeFronte = nome(fronte)
    const nomeRetro = nome(retro)

    expect(
      nomeFronte,
      'i due bottoni «Scatta foto» si chiamano ancora allo stesso modo: chi non vede lo schermo non ha modo di sapere quale faccia sta fotografando',
    ).not.toBe(nomeRetro)
    expect(nomeFronte).toContain(FACCE[0].label)
    expect(nomeRetro).toContain(FACCE[1].label)
  })

  /**
   * ⚠️ WCAG 2.5.3 «Label in Name»: il nome accessibile deve CONTENERE il testo
   * visibile. Chi comanda a voce pronuncia ciò che legge — «scatta foto» — e un nome
   * che non contenesse quelle parole renderebbe il bottone inattivabile invece che
   * più chiaro. È la ragione per cui il nome è «Scatta foto: <campo>» e non «<campo>».
   */
  it('il nome accessibile contiene il testo che si vede', () => {
    const { container } = renderFaccia(0)
    const bottone = within(container).getByRole('button')
    const visibile = bottone.textContent ?? ''
    expect(visibile).toBe(itParentForms.scattaFoto)
    expect(bottone.getAttribute('aria-label')).toContain(visibile)
    // Il `title` segue l'aria-label: due suggerimenti identici sotto il puntatore
    // sarebbero la stessa ambiguità, spostata sul mouse.
    expect(bottone.getAttribute('title')).toBe(bottone.getAttribute('aria-label'))
  })

  it('la chiave del nome esiste in italiano e in inglese, col suo segnaposto', () => {
    for (const [lingua, messaggi] of [
      ['it', itParentForms],
      ['en', enParentForms],
    ] as const) {
      const testo = (messaggi as Record<string, string>).scattaFotoDi
      expect(testo, `manca «scattaFotoDi» in ${lingua}`).toBeTruthy()
      expect(testo, `«scattaFotoDi» in ${lingua} non interpola il campo`).toContain('{campo}')
      // Deve contenere anche il testo visibile della stessa lingua, altrimenti
      // «Label in Name» cade nella traduzione e non in italiano — cioè dove nessuno
      // guarda.
      expect(testo).toContain((messaggi as Record<string, string>).scattaFoto)
    }
  })
})
