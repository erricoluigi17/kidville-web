// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  sha256Impronta,
  slugNomeFile,
  pathStaging,
  pathDefinitivi,
  SCHEMA_MANCANTE,
} from '@/lib/protocolli/store'
import { logoLightBytes } from '@/lib/protocolli/assets'

describe('sha256Impronta (art. 53: impronta del documento)', () => {
  it('convenzione repo SHA256-<HEX maiuscolo>', () => {
    // sha256("ciao") noto
    expect(sha256Impronta(new TextEncoder().encode('ciao'))).toBe(
      'SHA256-B133A0C0E9BEE3BE20163D2AD31D6248DB292AA6DCB1EE087A2AA50E0FC75AE2'
    )
  })
  it('stesso contenuto → stessa impronta; contenuto diverso → impronta diversa', () => {
    const a = sha256Impronta(new TextEncoder().encode('x'))
    expect(sha256Impronta(new TextEncoder().encode('x'))).toBe(a)
    expect(sha256Impronta(new TextEncoder().encode('y'))).not.toBe(a)
  })
})

describe('slugNomeFile', () => {
  it('sanifica spazi, accenti e caratteri speciali', () => {
    expect(slugNomeFile('Delibera n° 5 — città.pdf')).toBe('delibera-n-5-citta.pdf')
  })
  it('tronca nomi lunghissimi preservando l\'estensione', () => {
    const slug = slugNomeFile(`${'a'.repeat(200)}.pdf`)
    expect(slug.length).toBeLessThanOrEqual(80)
    expect(slug.endsWith('.pdf')).toBe(true)
  })
})

describe('path nello storage', () => {
  it('staging: cartella staging con uuid e nome sanificato', () => {
    const p = pathStaging('Lettera Comune.pdf')
    expect(p).toMatch(/^staging\/[0-9a-f-]{36}-lettera-comune\.pdf$/)
  })
  it('definitivi: scuola/anno/numero a 7 cifre', () => {
    const percorsi = pathDefinitivi('11111111-2222-3333-4444-555555555555', 2026, 42)
    expect(percorsi.originale('pdf')).toBe(
      '11111111-2222-3333-4444-555555555555/2026/0000042-originale.pdf'
    )
    expect(percorsi.timbrato).toBe(
      '11111111-2222-3333-4444-555555555555/2026/0000042-timbrato.pdf'
    )
    expect(percorsi.allegato(2, 'Delega firmata.jpg')).toBe(
      '11111111-2222-3333-4444-555555555555/2026/0000042-allegati/2-delega-firmata.jpg'
    )
  })
})

describe('SCHEMA_MANCANTE (degradazione E2E CI su DB non migrato)', () => {
  it('riconosce i codici PostgREST/Postgres di schema assente', () => {
    for (const codice of ['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205']) {
      expect(SCHEMA_MANCANTE.has(codice)).toBe(true)
    }
    expect(SCHEMA_MANCANTE.has('23505')).toBe(false)
  })
})

describe('logo inline (assets generati)', () => {
  it('decodifica in un PNG valido (magic bytes)', () => {
    const bytes = logoLightBytes()
    expect(bytes.length).toBeGreaterThan(1000)
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]) // \x89PNG
  })
})
