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
 * Nome letterale + il LIVELLO che lo segue, così com'è scritto nel sorgente. Il secondo gruppo
 * si ferma alla prima `,` o `(`: basta a riconoscere i due letterali che ci interessano
 * (`'warn'`, `'error'`), e su qualunque altra forma — ternario, variabile, chiamata di funzione
 * — restituisce qualcosa che non è nessuno dei due. È voluto: vedi `POTENZIALMENTE_INFO`.
 */
const CHIAMATA_CON_LIVELLO = /logEvento\(\s*'([a-z_][a-z_0-9]*)'\s*,\s*([^,()]*)/g;

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

function senzaProsa(f: string): string {
    return fs.readFileSync(f, 'utf8').split('\n').filter((r) => !SOLA_PROSA.test(r)).join('\n');
}

const USI: Uso[] = FILES.flatMap((f) => {
    const src = senzaProsa(f);
    return [...src.matchAll(CHIAMATA)].map((m) => ({
        evento: m[1],
        file: path.relative(process.cwd(), f),
    }));
});

/**
 * «QUESTO `info` ARRIVA DAVVERO IN TABELLA?» — il lock che mancava, e che è costato F1.
 *
 * `vaPersistito()` manda in `app_log` tutto ciò che è `warn` o `error`, e degli `info` solo
 * quelli il cui EVENTO è in `EVENTI_PERSISTITI`. Un `logEvento('x', 'info', …)` su un evento
 * fuori allowlist non è un log: è una riga che vive qualche giorno sui Runtime Logs di Vercel
 * e poi sparisce, senza che nessuno possa interrogarla in SQL. Non rompe niente, non fa
 * fallire niente, non avvisa nessuno.
 *
 * È successo, misurato in produzione il 2026-07-31: `avvisi:POST` emetteva il log di successo
 * della pubblicazione — con `n_destinatari`, il dato che serve a scoprire che un avviso di
 * classe ha raggiunto meno famiglie di quante ce ne siano — e `select count(*) from app_log
 * where evento='avvisi' and livello='info'` rispondeva **0 da sempre**, con 10 avvisi
 * pubblicati in 30 giorni. Log e allowlist erano stati scritti nello STESSO commit, da chi
 * aveva misurato «zero chiamate» prima di aggiungere la propria. Il vocabolario era chiuso, i
 * nomi erano giusti, il lock era verde.
 *
 * Perciò qui la domanda è un'altra: non «questo nome esiste?» ma «questo successo si ritrova
 * domani?». Ogni `info` o è persistito, o sta in `DEROGHE_INFO_NON_PERSISTITI` con scritto
 * accanto PERCHÉ non serve ritrovarlo.
 *
 * FAIL-CLOSED SUL LIVELLO. Si escludono solo i due letterali `'warn'` e `'error'`: qualunque
 * altra forma (`x ? 'info' : 'error'`, `livello4xx(stato)`, una variabile) può valere `info` a
 * runtime, quindi vale la stessa regola. Sbagliare qui costa un evento in più da motivare;
 * sbagliare nell'altro verso costa un log che non arriva da nessuna parte.
 */
interface UsoInfo extends Uso {
    livello: string;
}

const POTENZIALMENTE_INFO: UsoInfo[] = FILES.flatMap((f) => {
    const src = senzaProsa(f);
    return [...src.matchAll(CHIAMATA_CON_LIVELLO)]
        .filter((m) => !["'warn'", "'error'"].includes(m[2].trim()))
        .map((m) => ({
            evento: m[1],
            livello: m[2].trim(),
            file: path.relative(process.cwd(), f),
        }));
});

/**
 * Gli eventi i cui `info` NON vanno in tabella, e la ragione di ciascuno. La deroga si concede
 * a un EVENTO, non a una riga: chi aggiunge qui un nome sta dicendo «di questa categoria non mi
 * serve sapere in SQL che è andata bene». Se un domani uno di questi eventi acquista un
 * SUCCESSO che conta (una consegna, un incasso, una pubblicazione), la deroga non lo copre —
 * va tolto di qui e messo in `EVENTI_PERSISTITI`, che è l'unico posto che fa arrivare la riga.
 */
const DEROGHE_INFO_NON_PERSISTITI = new Map<string, string>([
    ['route', 'la riga di esito di `withRoute`: 401/403/404 a `info` per non riempire la tabella a ogni sessione scaduta (with-route.ts, testata). I 5xx sono `error` e si persistono per livello.'],
    ['auth', 'sono i rifiuti dei gate (`require-staff` logga OGNI 401/403) e le risposte non-ok di GoTrue: rumore per progetto. Gli `auth` che servono all\'audit sono `warn`/`error`.'],
    ['db', 'degradi di schema del DB E2E non migrato (`colonna-assente-rimossa`, `dedup-soft-non-disponibile`): note tecniche di una scrittura che ha comunque il suo esito altrove, ed è l\'area a più alto volume di `supabase-fetch`.'],
    ['app_log', 'è il sink che si segnala da solo: persistere le sue righe significherebbe scrivere su `app_log` per raccontare `app_log`.'],
    ['notifica', 'gli `info` sono degradi di schema in `destinatari.ts`, non consegne. La consegna vera si logga su `push` ed `email`, entrambi persistiti.'],
    ['mensa', 'prenotazioni e alternative: una riga per alunno per giorno. L\'audit delle scritture passa da `logScrittura` (tabella `audit_scritture`), non da `app_log`.'],
    ['anagrafica', 'note di `ensureParentIdentity` su percorsi già coperti da `warn`/`error` quando falliscono davvero.'],
    ['registro', 'degradi di colonna sulle lezioni: il registro ha il suo dato in tabella, il log è diagnostica.'],
    ['diary', 'degrado di colonna sulle voci di diario: stessa ragione del registro.'],
    ['protocolli', 'note sulle categorie di protocollo (schema assente): nessun successo di dominio.'],
    ['sidi', 'note di sincronizzazione dello store SIDI: l\'esito dell\'import è `warn`/`error`.'],
]);

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

    /* ── «Questo `info` arriva davvero in tabella?» (F1 del collaudo 2026-07-31) ── */

    it('ci sono `info` da controllare (autoinganno: se lo scanner del livello non trova più niente, il lock cade)', () => {
        expect(POTENZIALMENTE_INFO.length).toBeGreaterThan(150);
        // …e deve trovarne MENO delle chiamate totali, altrimenti sta ignorando il livello
        // e considerando `info` anche i `warn`/`error` — cioè non sta filtrando nulla.
        expect(POTENZIALMENTE_INFO.length).toBeLessThan(USI.length);
    });

    it("ogni `logEvento(evento,'info')` o è persistito o ha una deroga MOTIVATA", () => {
        const fuori = [...new Set(
            POTENZIALMENTE_INFO
                .filter((u) => !EVENTI_PERSISTITI.has(u.evento))
                .filter((u) => !DEROGHE_INFO_NON_PERSISTITI.has(u.evento))
                .map((u) => `${u.file} → '${u.evento}' (livello: ${u.livello})`),
        )].sort();
        expect(
            fuori,
            "eventi con un log a livello `info` che NON arriva in `app_log`: vive qualche giorno "
            + "sui Runtime Logs di Vercel e poi sparisce, e «nessun log» non distingue «tutto ok» "
            + "da «non è mai partito niente» (AGENTS.md, Logging obbligatorio, regola 5). "
            + "O l'evento va in EVENTI_PERSISTITI (src/lib/logging/logger.ts), o va in "
            + "DEROGHE_INFO_NON_PERSISTITI qui sopra CON IL PERCHÉ scritto accanto.",
        ).toEqual([]);
    });

    it('`avvisi` e `storage` sono persistiti: sono i due successi che erano invisibili in SQL', () => {
        // REGRESSIONE MIRATA sul difetto misurato in produzione il 2026-07-31.
        //  · `avvisi`: `avvisi:POST` logga la pubblicazione con `n_destinatari` — 0 righe in
        //    tabella a fronte di 10 avvisi in 30 giorni.
        //  · `storage`: `avvisi/upload:POST` e `tasks/upload:POST` sono passati da bucket
        //    pubblico a link firmato. «L'allegato non si apre» è un guasto NUOVO: senza una
        //    riga di successo, «nessun log di upload» non distingue «nessuno ha caricato» da
        //    «gli upload non partono più».
        expect(EVENTI_PERSISTITI.has('avvisi')).toBe(true);
        expect(EVENTI_PERSISTITI.has('storage')).toBe(true);
        // CONTROLLO POSITIVO/NEGATIVO: l'allowlist non è diventata "tutto passa".
        expect(EVENTI_PERSISTITI.has('route')).toBe(false);
        expect(EVENTI_PERSISTITI.has('auth')).toBe(false);
    });

    it('nessuna deroga è morta, e nessuna deroga è anche in allowlist', () => {
        // Una deroga che non copre più nessuna chiamata è una riga di documentazione che
        // mente: dice «di questa categoria non ci interessa il successo» su una categoria che
        // non ne emette più. Va tolta, così la lista resta la fotografia di una decisione.
        const usati = new Set(POTENZIALMENTE_INFO.map((u) => u.evento));
        const morte = [...DEROGHE_INFO_NON_PERSISTITI.keys()].filter((e) => !usati.has(e)).sort();
        expect(morte, 'deroghe che non coprono più nessun `info`: rimuoverle').toEqual([]);

        // E una deroga che è ANCHE in allowlist direbbe due cose opposte sullo stesso evento.
        const doppie = [...DEROGHE_INFO_NON_PERSISTITI.keys()].filter((e) => EVENTI_PERSISTITI.has(e)).sort();
        expect(doppie, 'eventi insieme derogati e persistiti: la deroga va tolta').toEqual([]);

        // Ogni deroga porta una motivazione VERA, non una stringa vuota messa per far passare.
        for (const [evento, perche] of DEROGHE_INFO_NON_PERSISTITI) {
            expect(perche.length, `la deroga per '${evento}' non è motivata`).toBeGreaterThan(40);
            expect(EVENTI_NOTI.has(evento), `'${evento}' non è nemmeno un evento noto`).toBe(true);
        }
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
