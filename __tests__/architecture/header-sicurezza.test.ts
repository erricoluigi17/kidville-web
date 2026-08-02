import { describe, it, expect } from 'vitest';
import type { NextConfig } from 'next';
import config from '../../next.config';

/**
 * LOCK — le risposte HTTP portano gli header di sicurezza.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL GUASTO CHE QUESTO LOCK ESISTE PER IMPEDIRE.
 *
 * Collaudo del 2026-07-31, categoria sicurezza, warning W4: `curl -sI` su qualunque rotta
 * non restituiva **nessun** header di sicurezza — né CSP, né HSTS, né `X-Frame-Options`,
 * né `X-Content-Type-Options`, né `Referrer-Policy`, né `Permissions-Policy`. Nessun
 * `headers()` in `next.config`, nessun `vercel.json`.
 *
 * `Referrer-Policy` qui non è cosmetica. `src/middleware.ts` documenta esso stesso, per
 * spiegare perché non logga il path grezzo, che «in questo repo il path È una credenziale»
 * — `/m/<token>` del modulo pubblico è una capability — e che «gli id dei minori sono
 * segmenti di rotta». Senza una policy dichiarata, quel token e quegli uuid viaggiano
 * nell'header `Referer` verso qualunque origine esterna a cui la pagina rimandi: la
 * credenziale esce dal perimetro senza che nessuno la mandi.
 *
 * `X-Frame-Options` / `frame-ancestors` chiudono l'altra metà: senza, la console di
 * segreteria è incorniciabile da un sito terzo (clickjacking su un'interfaccia che
 * cancella alunni e incassa pagamenti).
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ LA CSP QUI NON HA `script-src`, e perché il lock lo PRETENDE.
 *
 * Una `script-src` seria in Next.js App Router richiede un **nonce per richiesta**: il
 * runtime emette gli script inline di bootstrap dell'idratazione, e in sviluppo usa `eval`
 * per l'HMR. Una `script-src 'self'` scritta in `next.config` — che è statica per
 * definizione — non rende l'app più sicura: la rende **bianca**. E `default-src 'self'`
 * porterebbe con sé `frame-src` per ereditarietà, spegnendo gli embed Instagram e i video
 * della sezione News, che sono iframe verso origini terze.
 *
 * Quindi la CSP dichiara SOLO le direttive che chiudono una classe di attacco senza
 * fallback impliciti (`frame-ancestors`, `base-uri`, `object-src`, `form-action`), e il
 * lock verifica **anche** che non ci siano `default-src`/`script-src`/`frame-src`: non per
 * pigrizia, ma perché una di quelle direttive introdotta di fretta romperebbe l'app in
 * produzione e in modo invisibile ai test (nessun test unitario carica un iframe).
 * Il nonce resta debito dichiarato — vedi il PRD.
 *
 * DISCIPLINA. Come negli altri lock del repo: si misura il valore VERO (si chiama
 * `headers()` e si leggono le coppie che ne escono, non si cerca una stringa nel sorgente),
 * e ogni asserzione negativa ha il suo controllo positivo — un lock che ha smesso di
 * trovare qualunque cosa deve CADERE, non passare.
 */

type Coppia = { key: string; value: string };
type Regola = { source: string; headers: Coppia[] };

/** Gli header dichiarati per un percorso, indicizzati per nome in minuscolo. */
async function headerPer(percorso: string): Promise<Map<string, string>> {
    const fn = (config as NextConfig).headers;
    expect(
        typeof fn,
        'next.config non dichiara `headers()`: nessuna risposta dell’app porta un header di ' +
            'sicurezza. È il warning W4 del collaudo 2026-07-31.',
    ).toBe('function');

    const regole = (await fn!()) as unknown as Regola[];
    const fuori = new Map<string, string>();
    for (const r of regole) {
        if (!combacia(r.source, percorso)) continue;
        for (const h of r.headers) fuori.set(h.key.toLowerCase(), h.value);
    }
    return fuori;
}

/**
 * Il sottoinsieme di `path-to-regexp` che serve qui: `/:path*` e `/(.*)`  valgono per
 * tutto, un percorso letterale vale per sé. Deliberatamente minimo — se un giorno la regola
 * diventasse più fine, questa funzione va resa più fine con lei, non aggirata.
 */
function combacia(source: string, percorso: string): boolean {
    if (source === '/:path*' || source === '/(.*)' || source === '/:path*/') return true;
    return source === percorso;
}

/** Le direttive di una CSP, indicizzate per nome. */
function direttive(csp: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const pezzo of csp.split(';')) {
        const t = pezzo.trim();
        if (!t) continue;
        const spazio = t.indexOf(' ');
        out.set(
            (spazio < 0 ? t : t.slice(0, spazio)).toLowerCase(),
            spazio < 0 ? '' : t.slice(spazio + 1).trim(),
        );
    }
    return out;
}

const PERCORSI = ['/', '/api/parent/forms/otp', '/m/token-di-prova', '/parent/diary'];

describe('lock — gli header di sicurezza sono dichiarati', () => {
    it('la misura vede davvero degli header (controllo positivo)', async () => {
        // Senza questo, un `headers()` che restituisce `[]` — o un matcher che non combacia
        // con niente — renderebbe VERDI tutte le regole qui sotto: «nessun header vietato»
        // e «nessun header» hanno lo stesso colore.
        const h = await headerPer('/');
        expect(h.size, 'headers() non produce alcun header per `/`').toBeGreaterThanOrEqual(6);
    });

    it.each(PERCORSI)('%s porta Referrer-Policy, X-Frame-Options e X-Content-Type-Options', async (p) => {
        const h = await headerPer(p);

        // Il path È una credenziale (`/m/<token>`) e gli uuid dei minori sono segmenti di
        // rotta: la policy deve impedire che escano nel `Referer` verso un'altra origine.
        const ref = h.get('referrer-policy');
        expect(ref, `nessuna Referrer-Policy su ${p}`).toBeTruthy();
        expect(
            ['no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'],
            `Referrer-Policy «${ref}» lascia uscire il path verso origini terze`,
        ).toContain(ref);

        // Anti-clickjacking sulla console di segreteria.
        expect(['DENY', 'SAMEORIGIN']).toContain(h.get('x-frame-options'));

        // Il MIME dichiarato dal server è l'unico che vale: nessun sniffing.
        expect(h.get('x-content-type-options')).toBe('nosniff');
    });

    it('/ porta HSTS e Permissions-Policy', async () => {
        const h = await headerPer('/');

        const hsts = h.get('strict-transport-security') ?? '';
        const maxAge = Number(hsts.match(/max-age=(\d+)/)?.[1] ?? 0);
        expect(maxAge, `HSTS assente o con max-age troppo basso: «${hsts}»`).toBeGreaterThanOrEqual(
            31536000,
        );

        // Le funzioni del browser che l'app non usa restano spente: la fotocamera passa dal
        // plugin NATIVO (`@capacitor/camera`), non da `getUserMedia`.
        const pp = h.get('permissions-policy') ?? '';
        for (const spenta of ['microphone', 'geolocation', 'payment']) {
            expect(pp, `Permissions-Policy non spegne ${spenta}: «${pp}»`).toMatch(
                new RegExp(`${spenta}=\\(\\)`),
            );
        }
    });

    it('la CSP chiude clickjacking, base-tag, plugin e form verso terzi', async () => {
        const h = await headerPer('/');
        const csp = h.get('content-security-policy');
        expect(csp, 'nessuna Content-Security-Policy').toBeTruthy();

        const d = direttive(csp!);
        expect(d.get('frame-ancestors'), 'frame-ancestors mancante o troppo larga').toMatch(
            /^'(none|self)'$/,
        );
        expect(d.get('base-uri')).toBe("'self'");
        expect(d.get('object-src')).toBe("'none'");
        expect(d.get('form-action')).toBe("'self'");
    });

    it('la CSP NON dichiara default-src/script-src/frame-src (romperebbero l’app in silenzio)', async () => {
        const h = await headerPer('/');
        const d = direttive(h.get('content-security-policy') ?? '');

        // `default-src` porta con sé `frame-src` per ereditarietà → gli embed Instagram e i
        // video della sezione News smettono di caricare, e nessun test unitario lo vede.
        // `script-src` senza nonce spegne l'idratazione di Next. Se un giorno servono
        // davvero, servono INSIEME al nonce per richiesta, non da soli.
        for (const vietata of ['default-src', 'script-src', 'frame-src']) {
            expect(
                d.has(vietata),
                `La CSP dichiara «${vietata}». Senza il nonce per richiesta (che vive nel ` +
                    'middleware, non in next.config) questa direttiva non rende l’app più sicura: ' +
                    'la rende bianca — o le toglie gli embed della sezione News.',
            ).toBe(false);
        }
    });

    it('X-Frame-Options e frame-ancestors dicono la stessa cosa', async () => {
        // Due presidi per lo stesso attacco: se dicono cose diverse, il comportamento dipende
        // da quale dei due il browser onora — cioè non è deciso da noi.
        const h = await headerPer('/');
        const xfo = h.get('x-frame-options');
        const fa = direttive(h.get('content-security-policy') ?? '').get('frame-ancestors');
        const atteso = xfo === 'DENY' ? "'none'" : "'self'";
        expect(fa, `X-Frame-Options=${xfo} ma frame-ancestors=${fa}`).toBe(atteso);
    });
});
