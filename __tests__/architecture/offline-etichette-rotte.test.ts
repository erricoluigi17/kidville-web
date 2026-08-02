import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * L'elenco di /offline non può cadere sul nome dell'URL.
 *
 * `script-offline.ts` traduce ogni rotta in cache con `etichetta()`: cerca prima
 * il percorso esatto, poi l'ULTIMO SEGMENTO nel dizionario, e se non lo trova
 * capitalizza il segmento dell'URL. Quel ramo finale non è un ripiego neutro: è
 * italiano travestito da traduzione. `/admin/mensa/cucina` in inglese rendeva
 * «Cucina» accanto a «Office home», «Notices», «Settings» — e in italiano
 * sembrava giusto per pura coincidenza lessicale, che è esattamente il motivo
 * per cui nessuno se n'era accorto in due anni.
 *
 * Il rimedio non è tradurre «cucina»: è togliere all'errore la possibilità di
 * ripetersi. Questo lock confronta i segmenti delle rotte REALMENTE raggiungibili
 * sotto `src/app/(dashboard)` con le chiavi dei due cataloghi. È lo stesso metodo
 * con cui `isolamento-sede-coverage` ha scovato 9 route sfuggite all'inventario
 * umano: la copertura si misura sull'albero dei file, non su un elenco a mano.
 *
 * Quando nasce una rotta nuova questo test diventa rosso e chiede due parole al
 * dizionario. È il costo giusto: due parole, una volta, contro una voce sbagliata
 * per sempre su una schermata che serve proprio a orientarsi.
 */

const RADICE = process.cwd();
const DASHBOARD = path.join(RADICE, 'src/app/(dashboard)');

function catalogo(lingua: 'it' | 'en') {
    const j = JSON.parse(fs.readFileSync(path.join(RADICE, 'messages', lingua, 'offline.json'), 'utf8'));
    return j.etichette as { esatte: Record<string, string>; segmenti: Record<string, string> };
}

/** Ogni `page.tsx` sotto (dashboard), come rotta con lo slash iniziale. */
function rotte(dir = DASHBOARD, prefisso = ''): string[] {
    const out: string[] = [];
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
        if (voce.isDirectory()) {
            // I gruppi `(nome)` non compaiono nell'URL.
            const seg = voce.name.startsWith('(') ? '' : `/${voce.name}`;
            out.push(...rotte(path.join(dir, voce.name), prefisso + seg));
        } else if (voce.name === 'page.tsx') {
            out.push(prefisso || '/');
        }
    }
    return out;
}

/**
 * L'etichetta che `script-offline.ts` mostrerebbe: percorso esatto → segmento →
 * ripiego. Riproduce `etichetta()` per la parte che conta, cioè QUALE ramo vince.
 * I segmenti dinamici (`[id]`) non arrivano mai in cache con quel nome: la rotta
 * concreta finisce con un uuid, che nessun dizionario può coprire e che il
 * ripiego rende come tale. Quelli si saltano, ed è dichiarato.
 */
function segmentoDaCoprire(rotta: string): string | null {
    const parti = rotta.split('/').filter(Boolean);
    for (let i = parti.length - 1; i >= 0; i--) {
        if (!parti[i].startsWith('[')) return parti[i];
    }
    return null;
}

describe('lock — le etichette di /offline coprono le rotte reali', () => {
    const rotteTrovate = rotte();

    it('esistono rotte da coprire (il lock non è vuoto per un errore di scansione)', () => {
        expect(rotteTrovate.length).toBeGreaterThan(30);
    });

    for (const lingua of ['it', 'en'] as const) {
        it(`nessuna rotta di (dashboard) cade sul ripiego in ${lingua.toUpperCase()}`, () => {
            const { esatte, segmenti } = catalogo(lingua);
            const scoperte: string[] = [];
            for (const r of rotteTrovate) {
                if (esatte[r]) continue;
                const seg = segmentoDaCoprire(r);
                if (!seg) continue;
                if (!segmenti[seg]) scoperte.push(`${r} → segmento «${seg}»`);
            }
            expect(
                [...new Set(scoperte)].sort(),
                `segmenti senza etichetta in messages/${lingua}/offline.json: l'elenco offline li renderebbe capitalizzando l'URL`,
            ).toEqual([]);
        });
    }

    it('i due cataloghi hanno esattamente le stesse chiavi', () => {
        const it = catalogo('it');
        const en = catalogo('en');
        expect(Object.keys(en.segmenti).sort()).toEqual(Object.keys(it.segmenti).sort());
        expect(Object.keys(en.esatte).sort()).toEqual(Object.keys(it.esatte).sort());
    });

    it('nessuna etichetta EN è rimasta identica a quella italiana senza motivo', () => {
        // Una voce italiana lasciata nel catalogo inglese è il difetto originale
        // travestito da traduzione. Le eccezioni sono parole che in inglese si
        // scrivono uguale, o sigle: si dichiarano, una per una.
        const UGUALI_DI_PROPOSITO = new Set([
            'chat',        // parola inglese entrata in italiano, identica
            'news',        // idem
            'merchandise', // idem
            'gdpr',        // sigla → resa «Privacy» in entrambe le lingue
            'sidi',        // sigla del Ministero, non si traduce
        ]);
        const it = catalogo('it').segmenti;
        const en = catalogo('en').segmenti;
        const sospette = Object.keys(it).filter(
            (k) => !UGUALI_DI_PROPOSITO.has(k) && it[k] === en[k],
        );
        expect(sospette, 'etichette EN identiche all\'italiano: tradurle o dichiararle').toEqual([]);
    });
});
