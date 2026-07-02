import { describe, it, expect } from 'vitest'
import { estraiConsensi, consensiObbligatoriMancanti } from '@/lib/forms/consensi'
import type { FormField, FormPage } from '@/types/database.types'

const consent = (id: string, extra: Partial<FormField> = {}): FormField => ({
  id,
  type: 'consent',
  label: extra.label ?? `Consenso ${id}`,
  required: extra.required,
  text: extra.text,
  link: extra.link,
})

const text = (id: string): FormField => ({ id, type: 'text', label: id })

const pagine = (...fields: FormField[]): FormPage[] => [
  { id: 'p1', title: 'P', fields },
]

const AT = '2026-06-26T10:00:00.000Z'

describe('estraiConsensi', () => {
  it('produce uno snapshot per ogni campo consent, con testo+link+timestamp', () => {
    const pages = pagine(
      consent('privacy', { label: 'Trattamento dati', text: 'Acconsento al trattamento…', link: 'https://x/privacy' }),
      text('nome'),
    )
    const out = estraiConsensi(pages, { privacy: true, nome: 'Marco' }, AT)
    expect(out).toEqual([
      {
        field_id: 'privacy',
        label: 'Trattamento dati',
        text: 'Acconsento al trattamento…',
        link: 'https://x/privacy',
        accepted: true,
        accepted_at: AT,
      },
    ])
  })

  it('registra accepted=false quando la checkbox non è spuntata', () => {
    const pages = pagine(consent('foto'))
    expect(estraiConsensi(pages, { foto: false }, AT)[0].accepted).toBe(false)
    expect(estraiConsensi(pages, {}, AT)[0].accepted).toBe(false)
  })

  it('ignora i campi non-consent e attraversa più pagine', () => {
    const pages: FormPage[] = [
      { id: 'p1', title: 'A', fields: [text('x'), consent('c1')] },
      { id: 'p2', title: 'B', fields: [consent('c2'), text('y')] },
    ]
    expect(estraiConsensi(pages, { c1: true, c2: true }, AT).map(c => c.field_id)).toEqual(['c1', 'c2'])
  })

  it('non include text/link quando assenti', () => {
    const [snap] = estraiConsensi(pagine(consent('c')), { c: true }, AT)
    expect(snap).not.toHaveProperty('text')
    expect(snap).not.toHaveProperty('link')
  })
})

describe('consensiObbligatoriMancanti', () => {
  it('elenca i consensi obbligatori non spuntati', () => {
    const pages = pagine(
      consent('obblig', { required: true }),
      consent('facolt', { required: false }),
    )
    expect(consensiObbligatoriMancanti(pages, { facolt: true })).toEqual(['obblig'])
  })

  it('vuoto quando tutti gli obbligatori sono spuntati', () => {
    const pages = pagine(consent('a', { required: true }), consent('b', { required: true }))
    expect(consensiObbligatoriMancanti(pages, { a: true, b: true })).toEqual([])
  })

  it('un consenso facoltativo non spuntato non è mancante', () => {
    expect(consensiObbligatoriMancanti(pagine(consent('opt', { required: false })), {})).toEqual([])
  })
})
