import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EVENTI_NOTI, EVENTI_PERSISTITI } from '@/lib/logging/logger';

/**
 * Coverage-lock del VOCABOLARIO degli eventi: `app_log.evento` ha un elenco chiuso.
 *
 * PERCHÉ È UN LOCK E NON UNA CONVENZIONE. `evento` è la colonna su cui si raggruppa per
 * chiedere «questa categoria di cose funziona?» — «i cron stanno girando?» è
 * `where evento = 'cron'`. Un sinonimo non rompe niente, non fa fallire niente e non avvisa
 * nessuno: SPEZZA LA QUERY IN SILENZIO. Al 2026-07-31, prima di questo lock, il repo aveva
 * `galleria` (9 usi) accanto a `gallery` (1), `modulistica` (34) accanto a `forms` (3),
 * `pagamento` (39) accanto a `pagamenti` (1): chi avesse contato gli invii di modulistica ne
 * avrebbe persi tre senza alcun modo di accorgersene.
 *
 * E c'era un modo peggiore di sbagliare, già armato: `EVENTI_PERSISTITI` contiene `pagamento`
 * al SINGOLARE. Un `logEvento('pagamenti', 'info', …)` di successo non sarebbe stato
 * persistito affatto — cioè il fallimento silenzioso che l'intero modulo di logging esiste
 * per impedire (AGENTS, «Logging obbligatorio», regola 5).
 *
 * Modellato su `logging-coverage.test.ts`, con la stessa disciplina: si scandisce il SORGENTE,
 * non si importa il codice (un import non dimostra un uso), e c'è un'asserzione di
 * autoinganno — se lo scanner non trova più niente, il lock deve cadere invece di passare.
 *
 * FUORI PERIMETRO, deliberatamente:
 *  · gli eventi del CLIENT (`client:fetch`, `client:js`, …): li conia `/api/logs` col prefisso
 *    `client:`, che è il presidio vero (rende impossibile impersonare un evento del server) e
 *    lascia il vocabolario aperto per progetto;
 *  · il campo `evento` di `logErrore({ operazione, evento })`, che oggi porta ~35 etichette
 *    ad-hoc di sotto-passo (`bonifica_cassa`, `patch_parent`, … in `gdpr/esegui.ts`). Sono
 *    sempre livello `error`, quindi sempre persistite: il difetto dell'allowlist non le tocca.
 *    Restano però una seconda tassonomia non governata sulla stessa colonna — vedi il warning
 *    in fondo al file.
 */

const SRC = path.join(process.cwd(), 'src');

/** `logEvento('nome', …)` con nome LETTERALE. Multiriga: il prettier spezza le chiamate lunghe. */
const CHIAMATA = /logEvento\(\s*'([a-z_][a-z_0-9]*)'/g;

/**
 * Righe di sola PROSA: corpo di un JSDoc (` * …`), commento di riga (`// …`), apertura di
 * blocco (`/* …`). Si tolgono prima di scandire perché in questo repo la documentazione cita
 * il codice — il commento di `EVENTI_NOTI` nomina `logEvento('pagamenti', …)` proprio per
 * spiegare perché quel nome è vietato, e senza questo filtro il lock accuserebbe la spiegazione
 * di essere il difetto.
 *
 * Si filtra PER RIGA, non con uno stripper di commenti: uno stripper vero deve capire anche le
 * stringhe (`'https://…'` contiene `//`) e, sbagliando, cancellerebbe una chiamata VERA — cioè
 * un falso negativo, che su un lock è il modo peggiore di fallire. Nessuna riga di codice
 * comincia con `*` o `//`, quindi qui il rischio non c'è.
 */
const SOLA_PROSA = /^\s*(\/\/|\*|\/\*)/;

/** L'unione delle aree di `supabase-fetch`, che diventano nomi di evento a runtime. */
const AREE = /area:\s*((?:'[a-z_]+'\s*\|\s*)*'[a-z_]+')\s*;/;

function sorgenti(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...sorgenti(full));
        else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
}

const FILES = sorgenti(SRC);

interface Uso {
    evento: string;
    file: string;
}

const USI: Uso[] = FILES.flatMap((f) => {
    const src = fs.readFileSync(f, 'utf8')
        .split('\n').filter((r) => !SOLA_PROSA.test(r)).join('\n');
    return [...src.matchAll(CHIAMATA)].map((m) => ({
        evento: m[1],
        file: path.relative(process.cwd(), f),
    }));
});

describe('vocabolario chiuso degli eventi di log', () => {
    it("ci sono chiamate da controllare (se questa cade, il test si sta autoingannando)", () => {
        // Senza, un errore nel path o nella regex renderebbe VERDI tutti i test qui sotto
        // semplicemente perché non troverebbero niente da controllare.
        expect(USI.length).toBeGreaterThan(400);
        expect(EVENTI_NOTI.size).toBeGreaterThan(20);
    });

    it('nessun `logEvento` usa un nome fuori dall\'elenco chiuso', () => {
        const fuori = [...new Set(
            USI.filter((u) => !EVENTI_NOTI.has(u.evento)).map((u) => `${u.file} → '${u.evento}'`),
        )].sort();
        expect(
            fuori,
            "nomi di evento non dichiarati in EVENTI_NOTI (src/lib/logging/logger.ts). "
            + "Se è un nome NUOVO va aggiunto lì, deliberatamente; se è un sinonimo di uno "
            + "esistente va corretto qui — un sinonimo spezza le query in silenzio.",
        ).toEqual([]);
    });

    it('i sinonimi già costati un\'incoerenza non possono tornare', () => {
        // Regressione mirata: sono i tre trovati dal collaudo del 2026-07-31. Il test sopra
        // li prenderebbe comunque, ma solo finché nessuno li aggiunge a EVENTI_NOTI "per far
        // passare il lock" — che è esattamente il modo in cui un lock muore.
        for (const sinonimo of ['gallery', 'forms', 'pagamenti']) {
            expect(EVENTI_NOTI.has(sinonimo), `'${sinonimo}' è un sinonimo, non un evento`).toBe(false);
        }
        for (const buono of ['galleria', 'modulistica', 'pagamento']) {
            expect(EVENTI_NOTI.has(buono)).toBe(true);
        }
    });

    it('ogni evento in `EVENTI_PERSISTITI` è un evento NOTO', () => {
        // È il difetto strutturale che questo lock chiude: un refuso nell'allowlist non
        // rompe niente e non si vede — semplicemente quei successi non arrivano mai in
        // tabella, e «nessun log» non distingue «tutto ok» da «non è mai partito niente».
        const orfani = [...EVENTI_PERSISTITI].filter((e) => !EVENTI_NOTI.has(e)).sort();
        expect(orfani, 'eventi in allowlist di persistenza che nessun nome noto produce').toEqual([]);
    });

    it('le AREE di `supabase-fetch` sono nomi di evento noti (le passa a `logEvento` a runtime)', () => {
        // `logEvento(b.area, …)`: le aree non compaiono mai come letterale in una chiamata,
        // quindi lo scanner sopra non le vede. Se un domani se ne aggiungesse una
        // (`realtime`, `functions`…), finirebbe in `app_log.evento` senza che nessuno l'abbia
        // dichiarata — e la query per categoria tornerebbe a mentire per omissione.
        const src = fs.readFileSync(path.join(SRC, 'lib', 'logging', 'supabase-fetch.ts'), 'utf8');
        const m = AREE.exec(src);
        expect(m, "l'unione `area:` di supabase-fetch non è più riconoscibile: aggiornare il lock").not.toBeNull();
        const aree = [...(m as RegExpExecArray)[1].matchAll(/'([a-z_]+)'/g)].map((a) => a[1]);
        expect(aree.length).toBeGreaterThan(3);
        expect(aree.filter((a) => !EVENTI_NOTI.has(a)), 'aree di supabase-fetch non dichiarate').toEqual([]);
    });

    it('il default di `externalFetch` e il ripiego del sink sono nomi noti', () => {
        // Due nomi che nascono da un `??`, quindi invisibili allo scanner: `esterno` quando il
        // chiamante di `externalFetch` non nomina l'evento, `sconosciuto` quando la riga
        // arriva senza. Sono i due nomi sotto cui finisce ciò che nessuno ha classificato: se
        // sparissero dall'elenco, la query «cosa non è classificato?» non si potrebbe più fare.
        expect(fs.readFileSync(path.join(SRC, 'lib', 'logging', 'external.ts'), 'utf8'))
            .toContain("'esterno'");
        expect(fs.readFileSync(path.join(SRC, 'lib', 'logging', 'app-log.ts'), 'utf8'))
            .toContain("'sconosciuto'");
        expect(EVENTI_NOTI.has('esterno')).toBe(true);
        expect(EVENTI_NOTI.has('sconosciuto')).toBe(true);
    });

    it("nessun nome dell'elenco comincia per `client:` (quello spazio è del client, e solo suo)", () => {
        // `/api/logs` prefissa `client:` per rendere impossibile a un browser ostile scrivere
        // righe con `evento = 'cron'` e far MENTIRE la query di sorveglianza. Se un evento del
        // server prendesse quel prefisso, la garanzia «nessun evento del server comincia così»
        // decadrebbe — e con lei il presidio.
        const invasori = [...EVENTI_NOTI].filter((e) => e.startsWith('client:')).sort();
        expect(invasori).toEqual([]);
    });
});
