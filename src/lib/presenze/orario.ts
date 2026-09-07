import { APP_TIMEZONE } from '@/i18n/config';
import { istanteCivile } from '@/lib/format/confini-giorno';

/**
 * ─── L'ORARIO DI UNA PRESENZA, LETTO E SCRITTO IN UN POSTO SOLO ──────────────
 *
 * `presenze.orario_entrata` e `presenze.orario_uscita` sono colonne `text`, e in
 * produzione ci convivono TRE forme scritte da tre epoche del prodotto (misurato
 * il 2026-09-07, 1.244 righe non nulle):
 *
 *   · 1.219  `2026-09-07T10:35:04.428Z`  ISO con fuso    — lo 0-6, `toISOString()`
 *   ·    19  `08:45`                     HH:MM nudo      — storico e seed E2E
 *   ·     6  `2026-09-04T09:40:00`       ISO NAÏVE       — la primaria, `${data}T${ora}:00`
 *
 * Prima di questo modulo le leggevano in tre modi diversi, e nessuno dei tre era
 * d'accordo con gli altri:
 *
 *   · `.slice(0, 5)` — corretto su `HH:MM`, e sull'ISO rendeva la stringa **`2026-`**.
 *     Sulla home del genitore usciva «Ingresso alle 2026-»: 450 righe d'appello su
 *     450, 490 famiglie, ogni giorno, e nessun test lo vedeva.
 *   · `getHours()` — l'ora LOCALE DEL PROCESSO, che su Vercel è UTC: l'ISO valeva
 *     due ore in meno, e l'`HH:MM` valeva `null`, cioè un ritardo contato ZERO.
 *   · `Intl` con `timeZone` — l'unico che avesse ragione, e stava nella sola riga
 *     dell'appello.
 *
 * ⚠️ IL DIFETTO DI `getHours()` NON ERA VIVO, ED È LA PARTE CHE VALE LA PENA AVER
 * CAPITO. Sulle righe naïve si annullava da solo — JS le parsa come ora locale e
 * `getHours()` le rilegge come ora locale — quindi con `TZ=UTC` il conto tornava
 * PER CASO. Si sarebbe armato al primo istante `…Z` scritto in una riga che
 * `calcolaOreAssenza` legge; la rettifica manuale dell'orario è esattamente quel
 * writer. Correggere il lettore, qui, non è ereditare un bug: è non causarlo.
 *
 * ─── PERCHÉ NON SI NORMALIZZA LO STORAGE (per ora) ───────────────────────────
 *
 * Le righe devianti sono 25 su 1.244: il 98% del dato è già canonico. Ma
 * normalizzare PRIMA di unificare i lettori li romperebbe uno alla volta e in
 * direzioni diverse, e senza un `CHECK` sulla colonna il writer della primaria
 * reintrodurrebbe la quarta forma il giorno dopo. L'ordine sicuro è l'opposto:
 * prima un lettore solo (questo file), poi il backfill delle 25 righe insieme al
 * vincolo — quando questo modulo è in produzione da un rilascio.
 *
 * ─── IL CANONICO IN SCRITTURA È L'ISTANTE ISO ────────────────────────────────
 *
 * La domanda a cui la colonna deve saper rispondere è «a che ora è arrivato questo
 * bambino», che è un ISTANTE. `HH:MM` nudo perde il giorno, e obbliga ogni lettore
 * a sapere da sé se era ora legale. Sul FILO, invece, viaggia `HH:MM`: è ciò che
 * `<input type="time">` produce, ed è l'unica forma che `@/lib/logging/redact` non
 * lascia passare in chiaro (un ISO matcha `DATA_ISO` e uscirebbe intero in
 * `app_log` — l'istante d'arrivo di un minore). La conversione la fa il SERVER,
 * dove il fuso è dichiarato e non dipende dall'orologio del tablet della maestra.
 */

/** `HH:MM` o `H:MM`, con secondi facoltativi. Nient'altro. */
const FORMA_HHMM = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/;

/**
 * ISO **senza fuso**: `2026-09-04T09:40:00`. Le sue cifre sono già ora italiana per
 * costruzione — le scrive la primaria concatenando la data dell'appello con l'ora
 * digitata dal docente. Passarle da `new Date()` significherebbe reinterpretarle
 * col fuso del processo, che è il punto esatto in cui il codice di prima era
 * corretto per caso.
 */
const FORMA_ISO_NAIVE = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/** `HH:MM` da minuti-da-mezzanotte, sempre a due cifre. */
function formatta(minuti: number): string {
    const h = Math.floor(minuti / 60);
    const m = minuti % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * L'ora italiana di un istante, in minuti da mezzanotte.
 *
 * ⚠️ `en-CA` e `hourCycle: 'h23'`, e nessuno dei due è arbitrario. Il locale: il
 * lock `date-con-timezone` vieta `en-GB`/`en-US` fuori da `src/i18n/config.ts`, e
 * `en-CA` è lo stesso formato macchina che `dataCivile` e `confini-giorno` usano
 * già. Il ciclo orario: senza, mezzanotte esce come `24` in alcuni ICU e
 * `oraDiRoma` renderebbe `24:00` per una riga di mezzanotte.
 */
function minutiDiIstante(istante: Date): number | null {
    if (Number.isNaN(istante.getTime())) return null;
    const parti = new Intl.DateTimeFormat('en-CA', {
        timeZone: APP_TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(istante);
    const h = Number(parti.find((p) => p.type === 'hour')?.value);
    const m = Number(parti.find((p) => p.type === 'minute')?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    // `h23` rende 00 a mezzanotte, ma un ICU vecchio può rendere 24: si normalizza
    // invece di fidarsi, come fa già `inizioGiornoRomaISO`.
    return (h % 24) * 60 + m;
}

/**
 * I minuti da mezzanotte (ora italiana) di un orario di presenza, in qualunque
 * delle forme che la colonna contiene. `null` se non è un orario — e `null`
 * significa «non lo so», mai «zero»: chi calcola un monte ore deve SALTARE la
 * riga, non contarla come puntuale.
 */
export function minutiDiRoma(valore: string | null | undefined): number | null {
    if (typeof valore !== 'string') return null;
    const v = valore.trim();
    if (!v) return null;

    // 1. HH:MM[:SS] — è già ora italiana per costruzione.
    const hhmm = FORMA_HHMM.exec(v);
    if (hhmm) {
        const h = Number(hhmm[1]);
        const m = Number(hhmm[2]);
        if (h > 23) return null;
        return h * 60 + m;
    }

    // 2. ISO senza fuso — si prendono le CIFRE LETTERALI. Mai `new Date()`: sarebbe
    //    una reinterpretazione col fuso del processo.
    const naive = FORMA_ISO_NAIVE.exec(v);
    if (naive) {
        const h = Number(naive[1]);
        const m = Number(naive[2]);
        if (h > 23) return null;
        return h * 60 + m;
    }

    // 3. Istante con fuso (`…Z`, `…+02:00`) — si legge a Roma.
    return minutiDiIstante(new Date(v));
}

/** L'ora italiana `HH:MM` di un orario di presenza, per lo schermo. */
export function oraDiRoma(valore: string | null | undefined): string | null {
    const minuti = minutiDiRoma(valore);
    return minuti === null ? null : formatta(minuti);
}

/**
 * L'istante da SCRIVERE, da una data `YYYY-MM-DD` e un'ora `HH:MM` italiane.
 *
 * La matematica del fuso non è qui: `istanteCivile` vive in
 * `@/lib/format/confini-giorno`, stima l'offset due volte (perché il 29 marzo Roma
 * non ha lo stesso offset a mezzanotte e a mezzogiorno) ed è già provata sui due
 * giorni di cambio ora. Riscriverla qui sarebbe un secondo calendario nel repo.
 */
export function aOrarioIso(data: string, ora: string): string | null {
    const m = FORMA_HHMM.exec((ora ?? '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    if (h > 23) return null;
    const hhmmss = `${String(h).padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}.000`;
    return istanteCivile(data, hhmmss);
}

/** L'ora italiana di adesso, `HH:MM` — il default che si propone al docente. */
export function oraDiRomaAdesso(adesso: Date = new Date()): string {
    const minuti = minutiDiIstante(adesso);
    return formatta(minuti ?? 0);
}
