import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'sconosciuto') }))

import {
    MOTIVO_CORREZIONE_MAX,
    MOTIVO_CORREZIONE_MIN,
    eCorrezionePossibile,
    zCorrezione,
} from '@/lib/anno/correzione'
import { conCorrezioneNelCorpo, inviaChiedendoLaCorrezione } from '@/lib/ui/correzione-fetch'

/** COMPITO 4.9.3 · il contratto della correzione, senza rete e senza React. */

beforeEach(() => h.logClient.mockClear())

const r409 = (over: Record<string, unknown> = {}) =>
    Response.json({ error: 'Anno chiuso', codice: 'ANNO_CHIUSO', correzione_possibile: true, ...over }, { status: 409 })

describe('zCorrezione', () => {
    it('7 caratteri no, 8 sì, 500 sì, 501 no', () => {
        expect(MOTIVO_CORREZIONE_MIN).toBe(8)
        expect(MOTIVO_CORREZIONE_MAX).toBe(500)
        expect(zCorrezione.safeParse({ motivo: 'a'.repeat(7) }).success).toBe(false)
        expect(zCorrezione.safeParse({ motivo: 'a'.repeat(8) }).success).toBe(true)
        expect(zCorrezione.safeParse({ motivo: 'a'.repeat(500) }).success).toBe(true)
        expect(zCorrezione.safeParse({ motivo: 'a'.repeat(501) }).success).toBe(false)
    })
    it('gli spazi ai bordi non fanno lunghezza e vengono tolti', () => {
        expect(zCorrezione.safeParse({ motivo: '   1234567   ' }).success).toBe(false)
        expect(zCorrezione.parse({ motivo: '  12345678  ' }).motivo).toBe('12345678')
    })
    it('un motivo che non è testo non passa', () => {
        expect(zCorrezione.safeParse({ motivo: 12345678 }).success).toBe(false)
        expect(zCorrezione.safeParse({}).success).toBe(false)
    })
})

describe('eCorrezionePossibile', () => {
    it('solo 409 ANNO_CHIUSO con il flag', () => {
        expect(eCorrezionePossibile(409, { codice: 'ANNO_CHIUSO', correzione_possibile: true })).toBe(true)
        expect(eCorrezionePossibile(409, { codice: 'ANNO_CHIUSO' })).toBe(false)
        expect(eCorrezionePossibile(409, { codice: 'ANNO_CHIUSO', correzione_possibile: false })).toBe(false)
        expect(eCorrezionePossibile(403, { codice: 'ANNO_CHIUSO', correzione_possibile: true })).toBe(false)
        expect(eCorrezionePossibile(409, { codice: 'ALTRO', correzione_possibile: true })).toBe(false)
        expect(eCorrezionePossibile(409, null)).toBe(false)
    })
})

describe('conCorrezioneNelCorpo', () => {
    it('aggiunge `correzione` a un corpo JSON e conserva il resto', () => {
        const out = conCorrezioneNelCorpo({ method: 'POST', body: JSON.stringify({ a: 1 }) }, { motivo: 'abcdefgh' })
        expect(out.method).toBe('POST')
        expect(JSON.parse(out.body as string)).toEqual({ a: 1, correzione: { motivo: 'abcdefgh' } })
    })
    it('un corpo non JSON, un array o l’assenza di corpo restano come sono', () => {
        const c = { motivo: 'abcdefgh' }
        expect(conCorrezioneNelCorpo({ body: 'non json' }, c)).toEqual({ body: 'non json' })
        expect(conCorrezioneNelCorpo({ body: '[1]' }, c)).toEqual({ body: '[1]' })
        expect(conCorrezioneNelCorpo({}, c)).toEqual({})
        const fd = new FormData()
        expect(conCorrezioneNelCorpo({ body: fd }, c).body).toBe(fd)
    })
})

describe('i catch del lato browser non sono muti (AGENTS.md, regola 6)', () => {
    it('un corpo che non è JSON resta com\u2019è E lascia una riga di log, senza il testo del corpo', () => {
        const out = conCorrezioneNelCorpo({ body: 'non json XQZ-SEGRETO' }, { motivo: 'abcdefgh' })
        expect(out).toEqual({ body: 'non json XQZ-SEGRETO' })
        expect(h.logClient).toHaveBeenCalledTimes(1)
        expect(h.logClient.mock.calls[0][0]).toMatchObject({ evento: 'fetch', livello: 'warn' })
        expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('XQZ-SEGRETO')
        expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('abcdefgh')
    })
    it('un 409 dal corpo illeggibile non apre il dialogo E lascia una riga di log', async () => {
        const invia = vi.fn().mockResolvedValue(new Response('<html>', { status: 409 }))
        await inviaChiedendoLaCorrezione(invia, vi.fn())
        expect(h.logClient).toHaveBeenCalledTimes(1)
        expect(h.logClient.mock.calls[0][0]).toMatchObject({ evento: 'fetch', livello: 'warn', stato: 409 })
    })
    it('nessun log quando va tutto bene', async () => {
        conCorrezioneNelCorpo({ body: JSON.stringify({ a: 1 }) }, { motivo: 'abcdefgh' })
        await inviaChiedendoLaCorrezione(vi.fn().mockResolvedValue(new Response('{}', { status: 201 })), vi.fn())
        expect(h.logClient).not.toHaveBeenCalled()
    })
})

describe('l\u2019etichetta dell\u2019anno viaggia dal 409 al dialogo (S8)', () => {
    it('il dialogo riceve l\u2019etichetta scritta dal server', async () => {
        const invia = vi.fn().mockResolvedValueOnce(r409({ etichetta: '2025/26' })).mockResolvedValueOnce(new Response('{}', { status: 201 }))
        const chiedi = vi.fn().mockResolvedValue('rettifica voto')
        await inviaChiedendoLaCorrezione(invia, chiedi)
        expect(chiedi).toHaveBeenCalledWith('2025/26')
    })
    it('un 409 senza etichetta (o con un\u2019etichetta che non è testo) chiede il motivo senza anno', async () => {
        const chiedi = vi.fn().mockResolvedValue(null)
        await inviaChiedendoLaCorrezione(vi.fn().mockResolvedValue(r409()), chiedi)
        await inviaChiedendoLaCorrezione(vi.fn().mockResolvedValue(r409({ etichetta: 42 })), chiedi)
        expect(chiedi).toHaveBeenNthCalledWith(1, undefined)
        expect(chiedi).toHaveBeenNthCalledWith(2, undefined)
    })
})

describe('inviaChiedendoLaCorrezione', () => {
    it('una risposta che non è 409 non chiede niente', async () => {
        const invia = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }))
        const chiedi = vi.fn()
        expect((await inviaChiedendoLaCorrezione(invia, chiedi)).status).toBe(201)
        expect(chiedi).not.toHaveBeenCalled()
        expect(invia).toHaveBeenCalledTimes(1)
    })
    it('un 409 senza `correzione_possibile` (docente, anno in chiusura) non apre il dialogo', async () => {
        const invia = vi.fn().mockResolvedValue(r409({ correzione_possibile: undefined }))
        const chiedi = vi.fn()
        expect((await inviaChiedendoLaCorrezione(invia, chiedi)).status).toBe(409)
        expect(chiedi).not.toHaveBeenCalled()
        expect(invia).toHaveBeenCalledTimes(1)
    })
    it('un 409 con corpo illeggibile non apre il dialogo', async () => {
        const invia = vi.fn().mockResolvedValue(new Response('<html>', { status: 409 }))
        const chiedi = vi.fn()
        expect((await inviaChiedendoLaCorrezione(invia, chiedi)).status).toBe(409)
        expect(chiedi).not.toHaveBeenCalled()
    })
    it('annullare restituisce il 409 e NON rimanda la richiesta', async () => {
        const invia = vi.fn().mockResolvedValue(r409())
        const chiedi = vi.fn().mockResolvedValue(null)
        expect((await inviaChiedendoLaCorrezione(invia, chiedi)).status).toBe(409)
        expect(chiedi).toHaveBeenCalledTimes(1)
        expect(invia).toHaveBeenCalledTimes(1)
    })
    it('con il motivo rimanda UNA volta, con la correzione', async () => {
        const invia = vi.fn().mockResolvedValueOnce(r409()).mockResolvedValueOnce(new Response('{}', { status: 201 }))
        const chiedi = vi.fn().mockResolvedValue('rettifica voto')
        expect((await inviaChiedendoLaCorrezione(invia, chiedi)).status).toBe(201)
        expect(invia).toHaveBeenCalledTimes(2)
        expect(invia).toHaveBeenNthCalledWith(2, { motivo: 'rettifica voto' })
    })
    it('se anche la seconda risposta è 409 non chiede una seconda volta', async () => {
        const invia = vi.fn().mockImplementation(async () => r409())
        const chiedi = vi.fn().mockResolvedValue('rettifica voto')
        expect((await inviaChiedendoLaCorrezione(invia, chiedi)).status).toBe(409)
        expect(chiedi).toHaveBeenCalledTimes(1)
        expect(invia).toHaveBeenCalledTimes(2)
    })
})
