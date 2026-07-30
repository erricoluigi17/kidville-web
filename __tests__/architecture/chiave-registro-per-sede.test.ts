import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CHIAVE_REGISTRO, CHIAVE_REGISTRO_LEGACY, vincoloConflittoAssente } from '@/lib/registro/chiave-orario';

/**
 * Lock: nessun upsert può usare come chiave di conflitto una tupla che parte da
 * `classe_sezione` senza la sede.
 *
 * Perché è un lock e non un test di comportamento: il difetto era **invisibile**.
 * Il vincolo `UNIQUE (classe_sezione, data, ora_lezione)` non falliva mai, non
 * lanciava, non compariva nei log — semplicemente faceva scrivere il «2 ANNI» di
 * Aversa e quello di Cesa sulla STESSA riga di registro, sovrascrivendo
 * argomento, compiti e firme dell'altra sede. Il gate di scope sulle due route
 * c'era già, quindi in lettura non si vedeva nulla di strano.
 *
 * Il giorno in cui qualcuno scrive un upsert nuovo copiando la vecchia chiave,
 * lo trova questo test — non un genitore che non ritrova i compiti.
 */

const SRC = path.join(process.cwd(), 'src');

/** `onConflict: 'classe_sezione,...'` scritto a mano, in qualunque quoting. */
const CHIAVE_NUDA = /onConflict:\s*['"`]classe_sezione[^'"`]*['"`]/g;

function filesTs(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...filesTs(full));
        else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(full);
    }
    return out;
}

describe('chiave di conflitto del registro — lock per sede', () => {
    it('la costante include scuola_id, ed è la PRIMA colonna', () => {
        expect(CHIAVE_REGISTRO.split(',')[0]).toBe('scuola_id');
        expect(CHIAVE_REGISTRO).toContain('classe_sezione');
    });

    it('la chiave legacy è conservata solo come ripiego, e non contiene la sede', () => {
        // Se un domani qualcuno "sistemasse" anche questa aggiungendoci la sede,
        // il ripiego per il DB E2E non migrato smetterebbe di funzionare in
        // silenzio: resterebbe un 42P10 non gestito.
        expect(CHIAVE_REGISTRO_LEGACY).not.toContain('scuola_id');
    });

    it('riconosce 42P10 (vincolo di conflitto inesistente) e nient\'altro', () => {
        expect(vincoloConflittoAssente({ code: '42P10' })).toBe(true);
        expect(vincoloConflittoAssente({ code: '23505' })).toBe(false);
        expect(vincoloConflittoAssente(null)).toBe(false);
        expect(vincoloConflittoAssente(undefined)).toBe(false);
    });

    it('nessun file di src/ usa una chiave di conflitto che parte da classe_sezione', () => {
        const colpevoli: string[] = [];
        for (const f of filesTs(SRC)) {
            // Il modulo che DEFINISCE la chiave legacy è l'unica eccezione lecita.
            if (f.endsWith(path.join('lib', 'registro', 'chiave-orario.ts'))) continue;
            const testo = fs.readFileSync(f, 'utf8');
            if (CHIAVE_NUDA.test(testo)) colpevoli.push(path.relative(process.cwd(), f));
            CHIAVE_NUDA.lastIndex = 0;
        }
        expect(colpevoli).toEqual([]);
    });

    it('ci sono file da controllare (se cade, il test si sta autoingannando)', () => {
        expect(filesTs(SRC).length).toBeGreaterThan(200);
    });
});
