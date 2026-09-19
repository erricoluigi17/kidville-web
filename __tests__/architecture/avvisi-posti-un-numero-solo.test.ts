// @vitest-environment node
/**
 * LOCK · i numeri dei POSTI e dei PARTECIPANTI di un avviso sono UN numero solo,
 * scritto in due linguaggi.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * `src/lib/validation/avvisi.ts` si autodefinisce, parola per parola, «gemello
 * pinnato del DDL»:
 *
 *     ⚠️ SONO GEMELLI PINNATI. Queste costanti e quel `CHECK` sono lo stesso
 *     numero scritto in due linguaggi […] Il lock che li confronta lo scrive il
 *     cantiere D1 […] Finché quel lock non esiste, chi cambia un numero cambia
 *     entrambi i posti a mano.
 *
 * Il lock non esisteva. Una dichiarazione di gemellanza senza un meccanismo è un
 * promemoria, e un promemoria non protegge niente: la prima volta che serve,
 * nessuno lo sta leggendo. Questo file è quel meccanismo.
 *
 * ─── COSA SUCCEDE SE DIVERGONO, NEI DUE VERSI ───────────────────────────────
 *
 *  · TS più STRETTO del DDL (999 qui, 1500 là): il modulo rifiuta con un 400 dati
 *    che il database accetterebbe. La segreteria vede «non può superare 999» su
 *    un vincolo che non esiste più, e nessuno sa dove sia scritto quel numero.
 *  · TS più LARGO del DDL (1500 qui, 999 là): il 400 di validazione diventa un
 *    **500 con dentro il testo del vincolo di Postgres** — cioè il rilievo F1 del
 *    collaudo del 2026-07-31, riaperto sulla colonna accanto.
 *  · Il DEFAULT (`numero_max DEFAULT 20`) che diverge dal predefinito mostrato dal
 *    modulo: la segreteria legge «20» e la colonna ne scrive un altro, su avvisi
 *    creati da una route che non manda il campo.
 *
 * E nessuna delle tre fa fallire nulla, perché **ciascuna delle due metà, da
 * sola, è perfettamente coerente**. È la stessa forma di difetto di
 * `cestino-giorni-un-numero-solo` (il numero che la purga applica contro quello
 * che la schermata promette), e questo file ne è il gemello.
 *
 * ─── IL GEMELLO DELL'ARITMETICA, CHE È IL PEGGIORE DEI TRE ──────────────────
 *
 * 🔑 `COALESCE(numero_partecipanti, 1)` dentro `avviso_posti_occupati` e
 * `personeDellaRiga` in `@/lib/avvisi/posti` sono la stessa regola con due
 * mestieri diversi: **quella decide chi entra, questa mostra il totale**. Se una
 * delle due contasse le righe senza numero come ZERO, la schermata direbbe «22 su
 * 50» mentre il database rifiuta la ventitreesima adesione — e non ci sarebbe
 * nessun errore da leggere, perché il numero sbagliato è un numero valido.
 *
 * ─── COME LEGGE, E PERCHÉ NON SI FA CON UNA `grep` ──────────────────────────
 *
 * ⚠️ Un test che legge un file come TESTO legge anche i commenti, e questa
 * migrazione è scritta apposta con i numeri dentro le spiegazioni: la
 * `COMMENT ON COLUMN … numero_max` contiene la frase «Tetto assoluto 999», e il
 * riquadro in testa a `validation/avvisi.ts` ribatte il `CHECK` per esteso. Una
 * `grep /999/` si immunizzerebbe da sola — troverebbe il numero nella propria
 * spiegazione e sarebbe verde anche col DDL cambiato.
 *
 * Perciò: il SQL passa da `soloSql()` (via i commenti `--` e il contenuto delle
 * stringhe, `COMMENT ON … IS '…'` compreso) e il TypeScript da `mascheraSorgente`
 * (la stessa che usano gli altri lock di forma). E i confronti si ancorano alla
 * FORMA del DDL (`numero_max smallint … DEFAULT 20`), non al numero nudo.
 *
 * ─── L'ASSERZIONE DI AUTOINGANNO ────────────────────────────────────────────
 *
 * Se lo scanner non trova più niente da confrontare — colonna rinominata,
 * `CHECK` spostato in un'altra migrazione, costante ribattezzata — questo lock
 * **cade**, invece di passare confrontando `null` con `null`. È il modo in cui
 * `cestino-giorni-un-numero-solo` evita di diventare una decorazione, ed è
 * l'unica differenza fra un lock e un commento ottimista.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mascheraSorgente } from '../fixtures/sorgente';
import { riepilogoPosti } from '@/lib/avvisi/posti';
import {
    NUMERO_PARTECIPANTI_MIN,
    NUMERO_PARTECIPANTI_MAX_ASSOLUTO,
    NUMERO_PARTECIPANTI_MAX_PREDEFINITO,
    MAX_ETICHETTA_NUMERO,
} from '@/lib/validation/avvisi';

const RADICE = join(__dirname, '..', '..');

const MIGRAZIONE = join(
    'supabase',
    'migrations',
    '20260919132612_avvisi_scadenze_posti_e_partecipanti.sql',
);
const SORGENTE_TS = join('src', 'lib', 'validation', 'avvisi.ts');

function leggi(percorso: string): string {
    return readFileSync(join(RADICE, percorso), 'utf8');
}

/**
 * Il SQL senza commenti e senza il CONTENUTO delle stringhe.
 *
 * Sostituisce con spazi invece di tagliare: la lunghezza non cambia, quindi un
 * indice resta un indice e un messaggio d'errore può ancora nominare la riga.
 * I delimitatori vengono spenti insieme al contenuto — qui non serve distinguerli,
 * serve solo che `'Tetto assoluto 999'` non sia più leggibile come un 999.
 */
function soloSql(testo: string): string {
    let out = '';
    let i = 0;
    const bianco = (da: number, a: number) => {
        for (let k = da; k < a; k++) out += testo[k] === '\n' ? '\n' : ' ';
    };
    while (i < testo.length) {
        if (testo[i] === '-' && testo[i + 1] === '-') {
            let j = testo.indexOf('\n', i);
            if (j < 0) j = testo.length;
            bianco(i, j);
            i = j;
            continue;
        }
        if (testo[i] === '/' && testo[i + 1] === '*') {
            const fine = testo.indexOf('*/', i + 2);
            const j = fine < 0 ? testo.length : fine + 2;
            bianco(i, j);
            i = j;
            continue;
        }
        if (testo[i] === "'") {
            let j = i + 1;
            while (j < testo.length) {
                // `''` è un apice LETTERALE dentro la stringa, non la sua fine.
                if (testo[j] === "'" && testo[j + 1] === "'") {
                    j += 2;
                    continue;
                }
                if (testo[j] === "'") {
                    j += 1;
                    break;
                }
                j += 1;
            }
            bianco(i, j);
            i = j;
            continue;
        }
        out += testo[i];
        i += 1;
    }
    return out;
}

/** Il primo gruppo catturato, come numero. `null` se la forma non c'è più. */
function numero(testo: string, forma: RegExp, gruppo = 1): number | null {
    const m = testo.match(forma);
    return m && m[gruppo] !== undefined ? Number(m[gruppo]) : null;
}

const SQL = soloSql(leggi(MIGRAZIONE));
const TS = mascheraSorgente(leggi(SORGENTE_TS)).senzaCommenti;

// Le FORME cercate nel DDL. Ancorate al nome della colonna e alla sua sintassi,
// mai al numero nudo: un `999` trovato da solo potrebbe venire da qualunque riga.
const DDL = {
    minDefault: /numero_min\s+smallint[^,;()]*?DEFAULT\s+(\d+)/,
    maxDefault: /numero_max\s+smallint[^,;()]*?DEFAULT\s+(\d+)/,
    etichetta: /etichetta_numero\s+varchar\(\s*(\d+)\s*\)/,
    intervalloMin: /CHECK\s*\(\s*numero_min\s*>=\s*(\d+)\s+AND\s+numero_max\s*>=\s*numero_min\s+AND\s+numero_max\s*<=\s*\d+\s*\)/,
    intervalloMax: /CHECK\s*\(\s*numero_min\s*>=\s*\d+\s+AND\s+numero_max\s*>=\s*numero_min\s+AND\s+numero_max\s*<=\s*(\d+)\s*\)/,
    rispostaMin: /numero_partecipanti\s+BETWEEN\s+(\d+)\s+AND\s+\d+/,
    rispostaMax: /numero_partecipanti\s+BETWEEN\s+\d+\s+AND\s+(\d+)/,
    coalesce: /COALESCE\(\s*(?:\w+\.)?numero_partecipanti\s*,\s*(\d+)\s*\)/,
} as const;

const TS_COSTANTI = {
    NUMERO_PARTECIPANTI_MIN: /\bNUMERO_PARTECIPANTI_MIN\s*(?::\s*number\s*)?=\s*(\d+)/,
    NUMERO_PARTECIPANTI_MAX_ASSOLUTO: /\bNUMERO_PARTECIPANTI_MAX_ASSOLUTO\s*(?::\s*number\s*)?=\s*(\d+)/,
    NUMERO_PARTECIPANTI_MAX_PREDEFINITO: /\bNUMERO_PARTECIPANTI_MAX_PREDEFINITO\s*(?::\s*number\s*)?=\s*(\d+)/,
    MAX_ETICHETTA_NUMERO: /\bMAX_ETICHETTA_NUMERO\s*(?::\s*number\s*)?=\s*(\d+)/,
} as const;

describe('LOCK · autoinganno — se non c’è più niente da confrontare, il lock CADE', () => {
    it('il mascheramento del SQL ha davvero spento commenti e stringhe', () => {
        // Se `soloSql` diventasse l'identità (o si rompesse su un apice), ogni
        // confronto qui sotto potrebbe pescare un numero da una PROSA. Queste due
        // frasi vivono solo dentro un `COMMENT ON … IS '…'` e dentro un `--`: se
        // sopravvivono al mascheramento, il resto del file non vale niente.
        expect(SQL, 'il contenuto delle stringhe SQL non è stato spento').not.toContain('Tetto assoluto');
        expect(SQL, 'i commenti `--` non sono stati spenti').not.toContain('LA SOMMA GIRA DENTRO IL LOCK');
        // …e non ha spento TUTTO: un mascheratore che restituisse spazi sarebbe
        // verde su ogni asserzione negativa.
        expect(SQL).toContain('ALTER TABLE public.avvisi');
    });

    it('il mascheramento del TypeScript ha spento i commenti (dove il DDL è RIBATTUTO per esteso)', () => {
        // La testata di `validation/avvisi.ts` contiene, dentro un commento, una
        // copia del `CHECK` e dei due `DEFAULT`. Letta come testo grezzo, una
        // ricerca di forma li troverebbe lì — e il lock sarebbe verde confrontando
        // il file con sé stesso.
        expect(TS, 'i commenti del TypeScript non sono stati spenti').not.toContain('SONO GEMELLI PINNATI');
        expect(TS).toContain('export const NUMERO_PARTECIPANTI_MIN');
    });

    it('ogni forma cercata nel DDL esiste ancora', () => {
        for (const [nome, forma] of Object.entries(DDL)) {
            expect(
                numero(SQL, forma),
                `Nel DDL non si trova più la forma «${nome}» (${forma}). O la migrazione ` +
                    `${MIGRAZIONE} è cambiata, o questo lock sta confrontando il nulla: ` +
                    `aggiorna la forma, non cancellare l'asserzione.`,
            ).not.toBeNull();
        }
    });

    it('ogni costante cercata nel TypeScript esiste ancora', () => {
        for (const [nome, forma] of Object.entries(TS_COSTANTI)) {
            expect(
                numero(TS, forma),
                `In ${SORGENTE_TS} non si trova più la costante «${nome}». Se l'hai ` +
                    `rinominata, rinominala anche qui: senza, il confronto passerebbe ` +
                    `perché entrambi i lati sarebbero NULL.`,
            ).not.toBeNull();
        }
    });
});

describe('LOCK · i numeri dei partecipanti sono gli stessi in TypeScript e nel DDL', () => {
    it('`NUMERO_PARTECIPANTI_MIN` = il `>= 1` del CHECK = il `DEFAULT` di `numero_min`', () => {
        const check = numero(SQL, DDL.intervalloMin);
        const def = numero(SQL, DDL.minDefault);
        expect(
            NUMERO_PARTECIPANTI_MIN,
            `Il minimo di un'adesione diverge: TypeScript ne dichiara ` +
                `${NUMERO_PARTECIPANTI_MIN}, il CHECK della migrazione ${check}. Il numero ` +
                `che VALE è quello del database: allinea ${SORGENTE_TS}.`,
        ).toBe(check);
        expect(def, 'il DEFAULT di `numero_min` e il minimo del CHECK sono lo stesso numero').toBe(check);
    });

    it('`NUMERO_PARTECIPANTI_MAX_ASSOLUTO` = il `<= 999` del CHECK', () => {
        const check = numero(SQL, DDL.intervalloMax);
        expect(
            NUMERO_PARTECIPANTI_MAX_ASSOLUTO,
            `Il tetto assoluto diverge: TypeScript ne dichiara ` +
                `${NUMERO_PARTECIPANTI_MAX_ASSOLUTO}, il CHECK della migrazione ${check}. ` +
                `Se è il DDL ad essere salito, salga anche ${SORGENTE_TS}: finché non lo fa, ` +
                `un 400 rifiuta dati che il database accetta.`,
        ).toBe(check);
    });

    it('il CHECK sulla RISPOSTA ha lo stesso intervallo di quello sull’avviso', () => {
        // `avvisi_risposte_numero_partecipanti_chk` è la rete sotto la validazione,
        // non un suo doppione allentato: se i due CHECK divergessero, una famiglia
        // potrebbe archiviare un numero che l'avviso dichiara impossibile.
        expect(numero(SQL, DDL.rispostaMin)).toBe(NUMERO_PARTECIPANTI_MIN);
        expect(numero(SQL, DDL.rispostaMax)).toBe(NUMERO_PARTECIPANTI_MAX_ASSOLUTO);
    });

    it('`NUMERO_PARTECIPANTI_MAX_PREDEFINITO` = il `DEFAULT 20` di `numero_max`', () => {
        const def = numero(SQL, DDL.maxDefault);
        expect(
            NUMERO_PARTECIPANTI_MAX_PREDEFINITO,
            `Il predefinito diverge: il modulo mostra ${NUMERO_PARTECIPANTI_MAX_PREDEFINITO}, ` +
                `la colonna ne scrive ${def}. Un avviso creato da una route che non manda il ` +
                `campo prende il numero della colonna, non quello della schermata.`,
        ).toBe(def);
    });

    it('`MAX_ETICHETTA_NUMERO` = la larghezza di `etichetta_numero varchar(120)`', () => {
        const larghezza = numero(SQL, DDL.etichetta);
        expect(
            MAX_ETICHETTA_NUMERO,
            `Il massimo dell'etichetta diverge: zod ne ammette ${MAX_ETICHETTA_NUMERO}, la ` +
                `colonna ne tiene ${larghezza}. Più largo = 400-travestito-da-500 (rilievo F1), ` +
                `più stretto = dati legittimi rifiutati.`,
        ).toBe(larghezza);
    });
});

describe('LOCK · il gemello dell’ARITMETICA: una riga senza numero vale UNA persona', () => {
    it('`COALESCE(numero_partecipanti, 1)` in SQL e `riepilogoPosti` in TypeScript contano uguale', () => {
        const fallbackSql = numero(SQL, DDL.coalesce);

        // Il lato TypeScript si MISURA invece di leggerlo: una riga ammessa senza
        // `numero_partecipanti` deve pesare esattamente quanto il `COALESCE` le dà.
        // Leggere anche questo come testo lascerebbe fuori il caso che conta — il
        // `NaN`, che è un `number` e che una lettura del sorgente non vede.
        const senzaNumero = riepilogoPosti([{ stato_adesione: 'ammessa', parent_id: 'p1' }], null);
        const conNaN = riepilogoPosti(
            [{ stato_adesione: 'ammessa', parent_id: 'p1', numero_partecipanti: Number.NaN }],
            null,
        );

        expect(
            senzaNumero.persone,
            `Divergenza fra il totale MOSTRATO e il tetto APPLICATO: la funzione SQL ` +
                `avviso_posti_occupati conta una riga senza numero come ${fallbackSql}, ` +
                `src/lib/avvisi/posti.ts come ${senzaNumero.persone}. La schermata direbbe un ` +
                `numero e il database ne applicherebbe un altro, e nessuna delle due metà ` +
                `sarebbe incoerente da sola.`,
        ).toBe(fallbackSql);
        expect(conNaN.persone, 'un `NaN` non deve poter entrare nel totale').toBe(fallbackSql);
    });

    it('il fallback è 1 e non 0 (uno zero renderebbe il totale più piccolo del numero di adesioni)', () => {
        // Controllo positivo: senza questa riga, il confronto qui sopra sarebbe
        // verde anche se ENTRAMBE le metà passassero a zero insieme — cioè proprio
        // il modo in cui una coppia di gemelli diverge dal MONDO restando
        // d'accordo fra loro.
        expect(numero(SQL, DDL.coalesce)).toBe(1);
        expect(riepilogoPosti([{ stato_adesione: 'ammessa' }], null).persone).toBe(1);
    });
});
