import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseBody, parseQuery, parseData } from '@/lib/validation/http';
import { zUuid, zDataYMD, zAnnoMese, zPaginazione, zBool } from '@/lib/validation/common';

function jsonRequest(body: unknown): Request {
    return new Request('http://localhost/api/test', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
    });
}

describe('parseBody', () => {
    const schema = z.object({ nome: z.string(), eta: z.number().optional() });

    it('ritorna { data } tipizzato su body valido', async () => {
        const r = await parseBody(jsonRequest({ nome: 'Anna', eta: 6 }), schema);
        expect('data' in r && r.data).toEqual({ nome: 'Anna', eta: 6 });
    });

    it('ritorna 400 { error, details:[{path,message}] } su body non valido', async () => {
        const r = await parseBody(jsonRequest({ eta: 'sei' }), schema);
        if (!('response' in r)) throw new Error('atteso response');
        expect(r.response.status).toBe(400);
        const payload = await r.response.json();
        expect(payload.error).toBe('Dati non validi');
        expect(payload.details).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: 'nome', message: expect.any(String) }),
                expect.objectContaining({ path: 'eta', message: expect.any(String) }),
            ])
        );
    });

    it('ritorna 400 su JSON malformato', async () => {
        const req = new Request('http://localhost/api/test', { method: 'POST', body: '{non-json' });
        const r = await parseBody(req, schema);
        if (!('response' in r)) throw new Error('atteso response');
        expect(r.response.status).toBe(400);
        const payload = await r.response.json();
        expect(payload.error).toBe('Dati non validi');
    });
});

describe('parseQuery', () => {
    it('valida e coercizza i query param', () => {
        const req = new Request('http://localhost/api/test?data=2026-07-02&limit=10');
        const r = parseQuery(req, z.object({ data: zDataYMD, limit: z.coerce.number() }));
        expect('data' in r && r.data).toEqual({ data: '2026-07-02', limit: 10 });
    });

    it('applica i default su param assenti', () => {
        const req = new Request('http://localhost/api/test');
        const r = parseQuery(req, zPaginazione);
        expect('data' in r && r.data).toEqual({ limit: 50, offset: 0 });
    });

    it('chiavi ripetute diventano array', () => {
        const req = new Request('http://localhost/api/test?id=a&id=b');
        const r = parseQuery(req, z.object({ id: z.array(z.string()) }));
        expect('data' in r && r.data).toEqual({ id: ['a', 'b'] });
    });

    it('ritorna 400 su param non valido', async () => {
        const req = new Request('http://localhost/api/test?data=oggi');
        const r = parseQuery(req, z.object({ data: zDataYMD }));
        if (!('response' in r)) throw new Error('atteso response');
        expect(r.response.status).toBe(400);
    });
});

describe('parseData', () => {
    it('valida un valore già estratto (es. param dinamico)', () => {
        const ok = parseData(zUuid, '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
        expect('data' in ok).toBe(true);
        const ko = parseData(zUuid, 'non-un-uuid');
        expect('response' in ko).toBe(true);
    });
});

describe('schemi comuni', () => {
    it('zUuid accetta anche gli ID seedati non-RFC (guid lasco)', () => {
        expect(zUuid.safeParse('33333333-3333-3333-3333-333333333333').success).toBe(true);
        expect(zUuid.safeParse('33333333').success).toBe(false);
    });

    it('zDataYMD accetta solo YYYY-MM-DD', () => {
        expect(zDataYMD.safeParse('2026-07-02').success).toBe(true);
        expect(zDataYMD.safeParse('02/07/2026').success).toBe(false);
    });

    it('zAnnoMese accetta solo YYYY-MM con mese 01-12', () => {
        expect(zAnnoMese.safeParse('2026-07').success).toBe(true);
        expect(zAnnoMese.safeParse('2026-13').success).toBe(false);
    });

    it('zPaginazione limita 1-200 con default 50', () => {
        expect(zPaginazione.parse({ limit: '200' }).limit).toBe(200);
        expect(zPaginazione.safeParse({ limit: '500' }).success).toBe(false);
        expect(zPaginazione.safeParse({ limit: '0' }).success).toBe(false);
    });

    it('zBool interpreta le stringhe dei query param', () => {
        expect(zBool.parse('true')).toBe(true);
        expect(zBool.parse('0')).toBe(false);
        expect(zBool.safeParse('boh').success).toBe(false);
    });
});
