import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { assertSezioneScrivibile, assertSezionePrimariaFirmabile } from '@/lib/auth/scope'
import shared from '../../messages/it/shared.json'
import sharedEn from '../../messages/en/shared.json'

/**
 * COMPITO 4.9.4 · UNA CLASSE IN CHIUSURA NON È «DI UN ANNO PASSATO».
 *
 * Il docente che prova a scrivere su una classe dell'anno `in_chiusura` riceve 403 `SEZIONE_IN_CHIUSURA` (frase senza «passato»);
 * per un anno `chiuso` resta `SEZIONE_SOLA_LETTURA`. Lo stato che non si legge ripiega sul rifiuto di sempre: mai un errore nuovo.
 */

const DOCENTE = '33333333-3333-4333-8333-333333333333'
const SEDE = '22222222-2222-4222-8222-222222222222'
const S_CHIUSURA = '55555555-5555-4555-8555-555555555551'
const S_CHIUSA = '55555555-5555-4555-8555-555555555552'
const S_SENZA_ANNO = '55555555-5555-4555-8555-555555555553'
const A_CHIUSURA = 'a1111111-1111-4111-8111-111111111111'
const A_CHIUSO = 'a2222222-2222-4222-8222-222222222222'

const docente = { id: DOCENTE, role: 'educator', scuola_id: SEDE, scuole_ids: [SEDE] } as never

const db = (): DBFinto =>
    ({
        utenti: [{ id: DOCENTE, scuola_id: SEDE, scuole_ids: [SEDE], role: 'educator' }],
        utenti_sezioni: [S_CHIUSURA, S_CHIUSA, S_SENZA_ANNO].map((s) => ({ utente_id: DOCENTE, section_id: s })),
        sections: [
            { id: S_CHIUSURA, name: 'A', scuola_id: SEDE, anno_id: A_CHIUSURA, school_type: 'primaria' },
            { id: S_CHIUSA, name: 'B', scuola_id: SEDE, anno_id: A_CHIUSO, school_type: 'primaria' },
            { id: S_SENZA_ANNO, name: 'C', scuola_id: SEDE, anno_id: null, school_type: 'primaria' },
        ],
        anni_sede: [
            { id: 'x1', scuola_id: SEDE, anno_id: A_CHIUSURA, stato: 'in_chiusura' },
            { id: 'x2', scuola_id: SEDE, anno_id: A_CHIUSO, stato: 'chiuso' },
        ],
    }) as unknown as DBFinto

const sb = (d = db()): SupabaseClient =>
    creaFintoSupabase(d, [], {
        rpc: {
            sezioni_visibili_docente: () => ({
                data: [S_CHIUSURA, S_CHIUSA, S_SENZA_ANNO].map((s) => ({ section_id: s, sola_lettura: true })),
                error: null,
            }),
        } as never,
    })

describe('assertSezioneScrivibile · il codice dice in che anno è la classe', () => {
    it('anno in_chiusura → 403 SEZIONE_IN_CHIUSURA, e la frase non dice «passato»', async () => {
        const res = await assertSezioneScrivibile(sb(), docente, S_CHIUSURA)
        expect(res?.status).toBe(403)
        const j = await res!.json()
        expect(j.codice).toBe('SEZIONE_IN_CHIUSURA')
        expect(j.error).not.toMatch(/passat/i)
    })
    it('anno chiuso → 403 SEZIONE_SOLA_LETTURA, invariato', async () => {
        const res = await assertSezioneScrivibile(sb(), docente, S_CHIUSA)
        expect(res?.status).toBe(403)
        expect((await res!.json()).codice).toBe('SEZIONE_SOLA_LETTURA')
    })
    it('stato dell’anno illeggibile → ripiego SEZIONE_SOLA_LETTURA, mai un errore nuovo', async () => {
        const rotto = creaFintoSupabase(db(), [], {
            errori: { 'anni_sede:select': { code: '57014' } },
            rpc: { sezioni_visibili_docente: () => ({ data: [{ section_id: S_CHIUSURA, sola_lettura: true }], error: null }) } as never,
        })
        const res = await assertSezioneScrivibile(rotto, docente, S_CHIUSURA)
        expect(res?.status).toBe(403)
        expect((await res!.json()).codice).toBe('SEZIONE_SOLA_LETTURA')
    })
    it('sezione senza anno → SEZIONE_SOLA_LETTURA', async () => {
        const res = await assertSezioneScrivibile(sb(), docente, S_SENZA_ANNO)
        expect((await res!.json()).codice).toBe('SEZIONE_SOLA_LETTURA')
    })
})

describe('assertSezionePrimariaFirmabile · stessa distinzione', () => {
    it('anno in_chiusura → SEZIONE_IN_CHIUSURA; anno chiuso → SEZIONE_SOLA_LETTURA', async () => {
        const a = await assertSezionePrimariaFirmabile(sb(), docente, S_CHIUSURA)
        const b = await assertSezionePrimariaFirmabile(sb(), docente, S_CHIUSA)
        expect('response' in a && a.response?.status).toBe(403)
        expect('response' in a && (await a.response!.json()).codice).toBe('SEZIONE_IN_CHIUSURA')
        expect('response' in b && (await b.response!.json()).codice).toBe('SEZIONE_SOLA_LETTURA')
    })
})

describe('le frasi in catalogo', () => {
    it('erroreSezioneInChiusura c’è in it e en, e nessuna dice «passato/past»', () => {
        const it = (shared as Record<string, string>).erroreSezioneInChiusura
        const en = (sharedEn as Record<string, string>).erroreSezioneInChiusura
        expect(it).toBeTruthy()
        expect(en).toBeTruthy()
        expect(it).not.toMatch(/passat/i)
        expect(en).not.toMatch(/\bpast\b/i)
    })
})
