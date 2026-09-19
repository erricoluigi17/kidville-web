// @vitest-environment node
/**
 * LOCK · i ruoli che possono SCRIVERE su un'adesione sono UN insieme solo,
 * scritto in tre punti.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * Tre elenchi identici, e nessun meccanismo che li tenesse insieme:
 *
 *   · `RUOLI_SCRITTURA_ADESIONI` in `admin/avvisi/[id]/page.tsx` — decide se i
 *     comandi (correggi · ammetti · togli · esporta) ESISTONO nell'albero;
 *   · `requireStaff(request, […])` su `PATCH …/risposte/[rispostaId]` — decide chi
 *     può davvero scrivere;
 *   · `requireStaff(request, […])` sulla rotta di esportazione — decide chi può
 *     portarsi via un file con dentro nomi di bambini e di genitori.
 *
 * Il primo è un AFFORDANCE GATE e lo dichiara: il ruolo da cui si calcola arriva
 * da `useSessionIdentity`, che lo legge dal `localStorage`. Non è lì la sicurezza.
 * Ma la sicurezza non è nemmeno il punto di questo lock: il punto è che **due
 * soglie per la stessa porta divergono al primo cambio**, e le due divergenze
 * possibili fanno danni opposti e ugualmente silenziosi.
 *
 *  · La schermata PIÙ LARGA del server: a un ruolo compaiono comandi che il
 *    server respinge con un 403. Chi li preme legge «operazione fallita» su una
 *    funzione che per lui non esisterà mai, e nessuno sa dire se è un guasto.
 *  · La schermata PIÙ STRETTA del server: un ruolo che ha il diritto di scrivere
 *    non vede i comandi, e la funzione è morta per lui senza che nessun errore lo
 *    dica. È la peggiore delle due, perché non produce nemmeno una riga di log.
 *
 * E nessuna delle due fa fallire niente: ciascun file, da solo, è coerente.
 *
 * ─── PERCHÉ UN LOCK E NON UNA COSTANTE CONDIVISA ────────────────────────────
 *
 * Una costante sola sarebbe meglio, e il suo posto è `@/lib/auth`. Finché non ci
 * arriva — le due rotte appartengono a un altro perimetro — questo file è il
 * meccanismo che tiene i tre elenchi allineati: un promemoria scritto in un
 * commento non protegge niente, perché la prima volta che serve nessuno lo sta
 * leggendo. Chi crea la costante cancelli questo lock e ne scriva uno che
 * verifichi che i tre punti la IMPORTINO.
 *
 * ─── COME LEGGE ─────────────────────────────────────────────────────────────
 *
 * ⚠️ Un test che legge un file come TESTO legge anche i commenti, e questi tre
 * file sono pieni di commenti che ribattono per esteso
 * `requireStaff(['admin','coordinator','segreteria'])` per spiegare dove sta la
 * difesa. Una `grep` si immunizzerebbe da sola: troverebbe l'elenco giusto dentro
 * la PROSA anche con il codice cambiato. Perciò si passa da `mascheraSorgente`,
 * che spegne i commenti lasciando leggibili le stringhe — che qui sono
 * esattamente il dato da confrontare.
 *
 * ─── L'ASSERZIONE DI AUTOINGANNO ────────────────────────────────────────────
 *
 * Se una delle tre forme non si trova più (costante rinominata, gate spostato,
 * `requireStaff` sostituito) questo lock **cade**, invece di passare confrontando
 * `[]` con `[]`. È l'unica differenza fra un lock e un commento ottimista.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mascheraSorgente } from '../fixtures/sorgente';

const RADICE = join(__dirname, '..', '..');

/** L'affordance gate: la schermata che decide che cosa MOSTRARE. */
const SCHERMATA = join('src', 'app', '(dashboard)', 'admin', 'avvisi', '[id]', 'page.tsx');

/** Le due porte vere, quelle che rispondono 403. */
const ROTTE = [
    join('src', 'app', 'api', 'avvisi', '[id]', 'risposte', '[rispostaId]', 'route.ts'),
    join('src', 'app', 'api', 'avvisi', '[id]', 'risposte', 'esporta', 'route.ts'),
];

function senzaCommenti(relativo: string): string {
    return mascheraSorgente(readFileSync(join(RADICE, relativo), 'utf8')).senzaCommenti;
}

/** I ruoli di un array letterale, normalizzati e ordinati. `null` se la forma non c'è. */
function ruoliDi(testo: string, forma: RegExp): string[] | null {
    const m = testo.match(forma);
    if (!m || m[1] === undefined) return null;
    return [...m[1].matchAll(/['"]([a-z_]+)['"]/g)].map((r) => r[1]).sort();
}

const FORMA_COSTANTE = /RUOLI_SCRITTURA_ADESIONI\s*(?::[^=]*)?=\s*\[([^\]]*)\]/;
const FORMA_GATE = /requireStaff\s*\(\s*request\s*,\s*\[([^\]]*)\]/;

const DELLA_SCHERMATA = ruoliDi(senzaCommenti(SCHERMATA), FORMA_COSTANTE);
const DELLE_ROTTE = ROTTE.map((r) => ({ file: r, ruoli: ruoliDi(senzaCommenti(r), FORMA_GATE) }));

describe('LOCK · autoinganno — se non c’è più niente da confrontare, il lock CADE', () => {
    it('il mascheramento ha spento i commenti (dove i ruoli sono RIBATTUTI per esteso)', () => {
        const schermata = senzaCommenti(SCHERMATA);
        // Questa frase vive solo dentro il riquadro che spiega la costante: se
        // sopravvive, il confronto qui sotto potrebbe leggere una PROSA.
        expect(schermata, 'i commenti non sono stati spenti').not.toContain('AFFORDANCE GATE');
        // …e non ha spento tutto: un mascheratore che restituisse spazi sarebbe
        // verde su ogni asserzione negativa.
        expect(schermata).toContain('const RUOLI_SCRITTURA_ADESIONI');
    });

    it('le tre forme cercate esistono ancora', () => {
        expect(
            DELLA_SCHERMATA,
            `In ${SCHERMATA} non si trova più \`RUOLI_SCRITTURA_ADESIONI = [ … ]\`. Se l'hai ` +
                'rinominata, rinomina anche la forma qui: senza, il confronto passerebbe perché ' +
                'entrambi i lati sarebbero nulli.',
        ).not.toBeNull();
        for (const { file, ruoli } of DELLE_ROTTE) {
            expect(
                ruoli,
                `In ${file} non si trova più \`requireStaff(request, [ … ])\`. O il gate è stato ` +
                    'tolto — e allora il problema è molto più grande di questo lock — o è cambiato ' +
                    'di forma: aggiorna la forma, non cancellare l\'asserzione.',
            ).not.toBeNull();
        }
    });

    it('l’insieme non è vuoto, e la segreteria ci sta dentro', () => {
        // Controllo positivo: senza, il confronto sarebbe verde anche se TUTTI e
        // tre gli elenchi diventassero vuoti insieme — cioè tre gemelli che
        // restano d'accordo fra loro mentre divergono dal mondo. E la segreteria
        // è il ruolo per cui questa funzione esiste: «chi va in gita lo decide la
        // segreteria» è la decisione del committente.
        expect(DELLA_SCHERMATA).toContain('segreteria');
        expect((DELLA_SCHERMATA ?? []).length).toBeGreaterThan(1);
    });
});

describe('LOCK · la schermata mostra esattamente ciò che il server accetta', () => {
    for (const { file, ruoli } of DELLE_ROTTE) {
        it(`${file} pretende gli stessi ruoli di \`RUOLI_SCRITTURA_ADESIONI\``, () => {
            expect(
                ruoli,
                'I ruoli divergono fra la schermata e la porta:\n' +
                    `  · ${SCHERMATA} → ${JSON.stringify(DELLA_SCHERMATA)}\n` +
                    `  · ${file} → ${JSON.stringify(ruoli)}\n` +
                    'Il numero che VALE è quello del server. Se la schermata è più larga, a ' +
                    'qualcuno compaiono comandi che riceveranno un 403; se è più stretta, un ' +
                    'ruolo che ha il diritto di scrivere non vede i comandi e la funzione è ' +
                    'morta per lui senza una riga di log. Allinea i tre punti insieme.',
            ).toEqual(DELLA_SCHERMATA);
        });
    }
});
