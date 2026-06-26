import { describe, it, expect } from 'vitest'
import {
  valutaCondizione,
  campoVisibile,
  campiVisibili,
  pulisciNascosti,
} from '@/lib/forms/conditional'
import type { FormField, FormPage } from '@/types/database.types'

const campo = (id: string, condition?: FormField['condition']): FormField => ({
  id,
  type: 'text',
  label: id,
  condition,
})

describe('valutaCondizione', () => {
  it('eq: vero quando i valori coincidono (anche string↔number)', () => {
    expect(valutaCondizione({ field_id: 'x', operator: 'eq', value: 'si' }, { x: 'si' })).toBe(true)
    expect(valutaCondizione({ field_id: 'n', operator: 'eq', value: 5 }, { n: '5' })).toBe(true)
    expect(valutaCondizione({ field_id: 'x', operator: 'eq', value: 'si' }, { x: 'no' })).toBe(false)
  })
  it('neq: negazione di eq', () => {
    expect(valutaCondizione({ field_id: 'x', operator: 'neq', value: 'si' }, { x: 'no' })).toBe(true)
    expect(valutaCondizione({ field_id: 'x', operator: 'neq', value: 'si' }, { x: 'si' })).toBe(false)
  })
  it('contains: stringa e array', () => {
    expect(valutaCondizione({ field_id: 's', operator: 'contains', value: 'lat' }, { s: 'gelato' })).toBe(true)
    expect(valutaCondizione({ field_id: 'a', operator: 'contains', value: 'b' }, { a: ['a', 'b', 'c'] })).toBe(true)
    expect(valutaCondizione({ field_id: 'a', operator: 'contains', value: 'z' }, { a: ['a', 'b'] })).toBe(false)
  })
  it('gt / lt: confronto numerico', () => {
    expect(valutaCondizione({ field_id: 'n', operator: 'gt', value: 3 }, { n: 5 })).toBe(true)
    expect(valutaCondizione({ field_id: 'n', operator: 'gt', value: 3 }, { n: 2 })).toBe(false)
    expect(valutaCondizione({ field_id: 'n', operator: 'lt', value: 3 }, { n: 2 })).toBe(true)
  })
  it('valore referenziato assente: eq→false, neq→true', () => {
    expect(valutaCondizione({ field_id: 'x', operator: 'eq', value: 'si' }, {})).toBe(false)
    expect(valutaCondizione({ field_id: 'x', operator: 'neq', value: 'si' }, {})).toBe(true)
  })
})

describe('campoVisibile', () => {
  it('campo senza condizione è sempre visibile', () => {
    expect(campoVisibile(campo('a'), {})).toBe(true)
  })
  it('campo condizionato segue la condizione', () => {
    const c = campo('motivo', { field_id: 'tipo', operator: 'eq', value: 'altro' })
    expect(campoVisibile(c, { tipo: 'altro' })).toBe(true)
    expect(campoVisibile(c, { tipo: 'standard' })).toBe(false)
  })
})

describe('campiVisibili', () => {
  it('filtra i campi nascosti', () => {
    const fields = [campo('tipo'), campo('motivo', { field_id: 'tipo', operator: 'eq', value: 'altro' })]
    expect(campiVisibili(fields, { tipo: 'std' }).map((f) => f.id)).toEqual(['tipo'])
    expect(campiVisibili(fields, { tipo: 'altro' }).map((f) => f.id)).toEqual(['tipo', 'motivo'])
  })
})

describe('pulisciNascosti', () => {
  it('rimuove i valori dei campi nascosti, conserva i visibili', () => {
    const pages: FormPage[] = [
      { id: 'p1', title: 'P', fields: [campo('tipo'), campo('motivo', { field_id: 'tipo', operator: 'eq', value: 'altro' })] },
    ]
    const out = pulisciNascosti(pages, { tipo: 'std', motivo: 'residuo' })
    expect(out).toEqual({ tipo: 'std' })
  })
  it('conserva il valore quando il campo è visibile', () => {
    const pages: FormPage[] = [
      { id: 'p1', title: 'P', fields: [campo('tipo'), campo('motivo', { field_id: 'tipo', operator: 'eq', value: 'altro' })] },
    ]
    expect(pulisciNascosti(pages, { tipo: 'altro', motivo: 'X' })).toEqual({ tipo: 'altro', motivo: 'X' })
  })
})
