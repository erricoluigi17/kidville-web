import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * IL CONTO ALLA ROVESCIA DEL CESTINO NON DEVE MENTIRE.
 *
 * ─── PERCHÉ ESISTE QUESTO LOCK ──────────────────────────────────────────────
 * I giorni di custodia del cestino della galleria vivono in DUE punti, e non per
 * sciatteria:
 *
 *  · `src/lib/gallery/cestino.ts` → `GIORNI_CESTINO_GALLERIA`, che è la casa del
 *    numero: lo usano la purga e la route che elenca il cestino;
 *  · `src/app/(dashboard)/admin/gallery/page.tsx` → `GIORNI_CESTINO`, perché quella
 *    pagina è `'use client'` e `cestino.ts` importa `logEvento` da
 *    `@/lib/logging/logger`, cioè il logger del SERVER: importarlo da lì lo
 *    impacchetterebbe nel bundle del browser.
 *
 * La ripetizione è quindi dovuta. Ciò che NON è accettabile è che i due divergano:
 * il numero del client è quello che la segreteria LEGGE («Restano 12 giorni»), il
 * numero del server è quello che la purga APPLICA. Se qualcuno portasse la custodia
 * a sessanta giorni cambiando solo la costante del server, la schermata continuerebbe
 * a promettere trenta — e una segreteria che crede di avere una settimana quando ne
 * ha cinque rinuncia a ripristinare una foto che si poteva ancora salvare. Il verso
 * opposto è peggio: prometterne di più di quanti la purga ne concede significa dire
 * «puoi ancora ripescarla» di una foto già distrutta.
 *
 * ─── PERCHÉ UN LOCK E NON UN COMMENTO ───────────────────────────────────────
 * Un commento che dice «tieni allineati i due numeri» è un promemoria, e un
 * promemoria non è un meccanismo: la prima volta che serve, nessuno lo sta leggendo.
 * Questo file fallisce, e dice quale dei due cambiare.
 */

const RADICE = join(__dirname, '..', '..');

function leggi(percorso: string): string {
    return readFileSync(join(RADICE, percorso), 'utf8');
}

/** Il numero dichiarato in un file, da una `const` con quel nome esatto. */
function costante(sorgente: string, nome: string): number | null {
    const m = sorgente.match(new RegExp(`\\b${nome}\\s*(?::\\s*number\\s*)?=\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
}

const SORGENTE_SERVER = 'src/lib/gallery/cestino.ts';
const SORGENTE_CLIENT = 'src/app/(dashboard)/admin/gallery/page.tsx';

describe('lock — i giorni del cestino sono UN numero, scritto in due posti', () => {
    it('entrambe le costanti esistono ancora', () => {
        // Se una sparisce o cambia nome, il `null` qui è il segnale: senza questa
        // prova il confronto sotto passerebbe confrontando `null` con `null`, cioè
        // sarebbe verde per il motivo peggiore — nessuno dei due numeri trovato.
        expect(costante(leggi(SORGENTE_SERVER), 'GIORNI_CESTINO_GALLERIA'), SORGENTE_SERVER).not.toBeNull();
        expect(costante(leggi(SORGENTE_CLIENT), 'GIORNI_CESTINO'), SORGENTE_CLIENT).not.toBeNull();
    });

    it('i due numeri coincidono', () => {
        const server = costante(leggi(SORGENTE_SERVER), 'GIORNI_CESTINO_GALLERIA');
        const client = costante(leggi(SORGENTE_CLIENT), 'GIORNI_CESTINO');
        expect(
            client,
            `I giorni del cestino divergono: il server ne applica ${server}, la schermata della ` +
                `segreteria ne mostra ${client}. Il numero che vale è quello del server ` +
                `(${SORGENTE_SERVER}): allinea ${SORGENTE_CLIENT}. Non il contrario, e non ` +
                `alzando la soglia di questo lock.`,
        ).toBe(server);
    });

    it('il client NON importa da `@/lib/gallery/cestino` (ci trascinerebbe il logger del server)', () => {
        // È la ragione per cui il numero è ripetuto: se un domani l'import comparisse,
        // la ripetizione non serve più e questo lock va cancellato insieme a essa —
        // ma finché c'è, l'import non deve esserci. Un modulo server in un bundle
        // client non è un errore di stile: è `logEvento` che tenta di scrivere in
        // `app_log` dal browser.
        expect(leggi(SORGENTE_CLIENT)).not.toMatch(/from\s+['"]@\/lib\/gallery\/cestino['"]/);
    });
});
