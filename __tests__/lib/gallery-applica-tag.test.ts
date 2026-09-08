import { describe, it, expect } from 'vitest';
import { fotoDaConfigurare, fotoGiaConfigurate, applicaTagATutte } from '@/lib/gallery/applica-tag';

/**
 * «✨ Applica a tutte» non deve buttare via il lavoro fatto foto per foto.
 *
 * ─── IL DIFETTO, MISURATO ──────────────────────────────────────────────────
 * Il 6 settembre 2026 un'insegnante ha caricato 37 foto taggando i bambini
 * presenti in ognuna. In `galleria_media_v2` tutte e 37 hanno l'IMPRONTA DI TAG
 * IDENTICA: gli stessi 2 bambini, entrambi con `consenso_privacy = true`
 * (il lucchetto privacy non c'entra). Le famiglie degli altri bambini non
 * hanno visto niente, e quelle due hanno ricevuto tutte e 37 le foto.
 *
 * `handleApplyToAll` copiava i tag della foto attiva su TUTTE le altre e
 * avvisava DOPO, con un `alert`, senza nessun modo di annullare.
 *
 * ─── IL CONTRATTO ──────────────────────────────────────────────────────────
 * Di norma si applica solo alle foto ANCORA DA CONFIGURARE. Sostituire il
 * lavoro già fatto resta possibile, ma è una scelta esplicita — e chi la fa
 * sa quante foto sta sovrascrivendo PRIMA di toccarle.
 */

const f = (tag: string[], broadcast = false) => ({ tag_students: tag, is_broadcast: broadcast });

describe('fotoGiaConfigurate — quante ne perderei', () => {
    it('non conta la foto attiva: è quella da cui sto copiando', () => {
        expect(fotoGiaConfigurate([f(['a']), f([]), f([])], 0)).toBe(0);
    });

    it('conta le altre che hanno tag propri', () => {
        expect(fotoGiaConfigurate([f(['a']), f(['b']), f(['c']), f([])], 0)).toBe(2);
    });

    it('una foto in broadcast è configurata: ha già una destinazione dichiarata', () => {
        expect(fotoGiaConfigurate([f(['a']), f([], true), f([])], 0)).toBe(1);
    });

    it('indice attivo fuori range: non esplode e non conta niente di magico', () => {
        expect(fotoGiaConfigurate([f(['a']), f(['b'])], 9)).toBe(2);
        expect(fotoGiaConfigurate([], 0)).toBe(0);
    });
});

describe('applicaTagATutte — di norma tocca solo le foto ancora vuote', () => {
    it('riempie le vuote e LASCIA STARE quelle già taggate', () => {
        const out = applicaTagATutte([f(['a']), f(['b']), f([])], 0);
        expect(out[1].tag_students).toEqual(['b']);   // ← il lavoro fatto resta
        expect(out[2].tag_students).toEqual(['a']);
    });

    it('è il caso delle 37 foto: senza sovrascrittura, chi era già taggato non si perde', () => {
        const foto = [f(['ada']), f(['bea']), f(['ciro']), f([]), f([])];
        const out = applicaTagATutte(foto, 0);
        expect(out.map(x => x.tag_students)).toEqual([['ada'], ['bea'], ['ciro'], ['ada'], ['ada']]);
    });

    it('con `sovrascrivi` sostituisce tutto — ma è una scelta esplicita', () => {
        const out = applicaTagATutte([f(['a']), f(['b']), f([])], 0, { sovrascrivi: true });
        expect(out.map(x => x.tag_students)).toEqual([['a'], ['a'], ['a']]);
    });

    it('non lascia il riferimento all\'array della foto attiva: modificarne una non tocca le altre', () => {
        const out = applicaTagATutte([f(['a']), f([])], 0);
        out[1].tag_students.push('intruso');
        expect(out[0].tag_students).toEqual(['a']);
    });

    it('propaga anche `is_broadcast`, che è metà della destinazione', () => {
        const out = applicaTagATutte([f([], true), f([])], 0);
        expect(out[1].is_broadcast).toBe(true);
        expect(out[1].tag_students).toEqual([]);
    });

    it('non tocca una foto già in broadcast quando copio dei tag', () => {
        const out = applicaTagATutte([f(['a']), f([], true)], 0);
        expect(out[1]).toMatchObject({ is_broadcast: true, tag_students: [] });
    });

    it('conserva i campi che non le appartengono (file, preview)', () => {
        const out = applicaTagATutte(
            [{ ...f(['a']), nome: 'uno' }, { ...f([]), nome: 'due' }], 0);
        expect(out[1].nome).toBe('due');
    });

    it('foto attiva inesistente: restituisce l\'elenco intatto invece di svuotarlo', () => {
        const foto = [f(['a']), f(['b'])];
        expect(applicaTagATutte(foto, 9)).toEqual(foto);
    });
});

describe('fotoDaConfigurare — quante ne riempirei', () => {
    it('conta solo le vuote e non-broadcast, esclusa l\'attiva', () => {
        expect(fotoDaConfigurare([f(['a']), f([]), f([]), f([], true)], 0)).toBe(2);
    });
});
