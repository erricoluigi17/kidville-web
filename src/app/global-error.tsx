'use client';

import { useEffect, useRef } from 'react';
import { logClient, flush } from '@/lib/logging/client';
import { useClientValue } from '@/lib/hooks/use-client-value';

/**
 * L'ULTIMA rete: copre l'unico guasto che `error.tsx` non può coprire, cioè il crash del ROOT
 * LAYOUT (`src/app/layout.tsx` — legge il cookie del contrasto, monta i font e `RootProviders`).
 * Se salta quello, non esiste più nessun albero dentro cui una boundary di segmento possa
 * disegnarsi: Next scarta l'intero documento e monta QUESTO al suo posto.
 *
 * Da qui discende tutto il resto del file: `global-error` SOSTITUISCE il root layout, quindi
 * deve ridichiarare `<html>` e `<body>` da sé, e non può esportare `metadata` (non c'è più un
 * layout dove appenderla). È l'unico componente del repo che disegna il documento intero.
 *
 * Vale la stessa ragione di fondo di `error.tsx` — con una boundary esplicita Next non chiama più
 * `reportError()`, quindi `window.onerror` NON vede più questi errori: se non si loggasse qui,
 * il crash più grave che l'app possa avere sarebbe anche l'unico invisibile.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ QUI NON SI IMPORTA `./globals.css` (il piano lo faceva; è una trappola).
 *
 * Non è vietato — Next accetta l'import di CSS globale da qualunque file sotto `app/`, e la build
 * passerebbe. È che consegnerebbe una pagina VESTITA A METÀ, e la ragione è precisa:
 *
 *   globals.css:76   body { font-family: var(--font-maven) }
 *   globals.css:41   --font-maven: var(--loaded-maven), "Maven Pro", sans-serif
 *
 * e `--loaded-maven` (come `--loaded-barlow`) NON sta in globals.css: lo inietta `next/font` sotto
 * forma di classe sull'`<html>` DEL ROOT LAYOUT — cioè esattamente il layout che questo componente
 * ha appena sostituito. Senza quella classe la variabile non esiste, `var(--loaded-maven)` è priva
 * di fallback, `--font-maven` diventa guaranteed-invalid e `font-family` finisce "invalid at
 * computed-value time": il testo esce nel font di default del browser. Si otterrebbero i colori
 * del brand e la tipografia di nessuno.
 *
 * E il prezzo di quel mezzo risultato sarebbe trascinare l'INTERO foglio Tailwind dentro l'unica
 * rotta il cui compito è disegnarsi mentre tutto il resto sta bruciando — inclusa la possibilità,
 * niente affatto teorica, che sia proprio il chunk CSS a non essersi caricato (un deploy con un
 * asset stantìo è una delle cause tipiche di un crash del layout radice).
 *
 * Perciò: stili INLINE, zero dipendenze di build, colori del brand copiati a mano. Sono sei
 * dichiarazioni; il duplicato è deliberato e questa è la sua motivazione.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ LE DUE LINGUE SONO QUI DENTRO E NON NEI CATALOGHI (2026-08-08, Q15).
 *
 * Stessa radice del paragrafo precedente, applicata al testo invece che al CSS: questo componente
 * SOSTITUISCE il root layout, cioè l'unico posto in cui vive il `NextIntlClientProvider`. Quando
 * viene reso, `useTranslations` non ha più nessun contesto da cui leggere — non è una scelta di
 * comodità, è che il provider non esiste più. `src/app/error.tsx`, che il layout ce l'ha ancora
 * sopra, legge invece il catalogo come ogni altra schermata.
 *
 * La forma adottata è quella già in uso nelle altre due superfici che devono reggere quando non
 * regge il resto — `ChunkErrorBoundary` e la pagina `/offline`: entrambe le lingue nel documento,
 * e la scelta fatta leggendo il cookie `KV_LOCALE`, lo stesso che usa next-intl. La lettura sta in
 * un `useEffect` e non nel corpo del render perché durante l'SSR di questa pagina `document` non
 * esiste: partire dall'italiano e correggere subito dopo evita un disallineamento d'idratazione
 * dentro la schermata che dovrebbe segnalarli.
 *
 * `lang` segue la stessa variabile: fino a oggi era cablato a `it`, quindi uno screen reader
 * leggeva un testo italiano con fonetica italiana (giusto per caso) e avrebbe letto un testo
 * inglese con la stessa fonetica (sbagliato) appena il testo fosse diventato bilingue.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/* I colori del brand, cablati: qui non c'è nessun `@theme` a risolverli (vedi sopra). */
const VERDE = '#006A5F';
const GIALLO = '#FDC400';
const CREMA = '#FEF1E4';
const INCHIOSTRO = '#1F3D38';
const SECONDARIO = '#55615C';

/** Le tre frasi, nelle due lingue. Non hanno una chiave di catalogo perché qui il catalogo non c'è. */
const TESTI = {
    it: {
        titolo: 'Kidville non è riuscita ad avviarsi',
        corpo:
            'Si è verificato un errore imprevisto. Riprova: se il problema si ripete, ' +
            'segnalalo alla segreteria indicando il codice qui sotto.',
        bottone: 'Riprova',
    },
    en: {
        titolo: 'Kidville could not start',
        corpo:
            'An unexpected error occurred. Try again: if it keeps happening, report it ' +
            'to the school office quoting the code below.',
        bottone: 'Try again',
    },
} as const;

/** `it` salvo cookie `KV_LOCALE=en`. Non lancia: gira dentro un gestore d'errore. */
function linguaCorrente(): 'it' | 'en' {
    try {
        const m = document.cookie.match(/(?:^|; )KV_LOCALE=([^;]*)/);
        return m && decodeURIComponent(m[1]) === 'en' ? 'en' : 'it';
    } catch {
        return 'it';
    }
}

export default function ErroreGlobale({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    /** Stessa guardia di `error.tsx`: StrictMode monta due volte, il ref sopravvive al rimontaggio. */
    const inviato = useRef<string | null>(null);
    /**
     * La lingua si legge SOLO lato client: durante l'SSR di questa pagina `document`
     * non esiste, e il ripiego è l'italiano (la lingua di default dell'app).
     *
     * `useClientValue` e non `useState` + `useEffect`: scrivere lo stato dentro un
     * effect è vietato dal lock `react-hooks/set-state-in-effect` — ed è vietato per
     * una ragione, non per gusto. Il hook è tre righe su `useSyncExternalStore` e non
     * porta con sé nessuna dipendenza oltre a React: non contraddice la regola delle
     * dipendenze al minimo che governa questo file.
     */
    const lingua = useClientValue<'it' | 'en'>(linguaCorrente, 'it');

    useEffect(() => {
        const chiave = error.digest ?? `${error.name}:${error.message}`;
        if (inviato.current === chiave) return;
        inviato.current = chiave;

        logClient({
            livello: 'error',
            // `react`: `EventoNome` è un'unione chiusa e non ha uno slug dedicato al layout radice.
            // La distinzione dalla boundary di segmento la porta il MESSAGGIO, con il prefisso qui
            // sotto — che è una colonna vera e in chiaro (`app_log.messaggio`), quindi cercabile:
            // un `messaggio like 'layout radice%'` isola in una query il crash più grave che c'è.
            evento: 'react',
            messaggio: `layout radice — ${error.message || 'errore fatale'}`,
            stack: error.stack,
            digest: error.digest,
            // Nessuna `route`: quando salta il layout radice il guasto non è DI una pagina, è
            // dell'applicazione. Attribuirlo alla rotta su cui l'utente si trovava per caso
            // manderebbe l'indagine a cercare il bug nel posto sbagliato.
        });
        flush();
    }, [error]);

    const t = TESTI[lingua];

    return (
        // `lang`: senza il root layout non lo dichiara più nessuno, e uno screen reader leggerebbe
        // il testo con la pronuncia della lingua di sistema. Segue la lingua scelta, non un valore
        // cablato: un testo inglese dentro un documento `lang="it"` è il difetto, non il rimedio.
        <html lang={lingua}>
            <body style={{ margin: 0, backgroundColor: CREMA, color: INCHIOSTRO, fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }}>
                <div
                    role="alert"
                    style={{
                        minHeight: '100vh',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 16,
                        padding: 24,
                        textAlign: 'center',
                    }}
                >
                    <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: VERDE, textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                        {t.titolo}
                    </h1>

                    <p style={{ margin: 0, maxWidth: 420, fontSize: 14, lineHeight: 1.6, color: SECONDARIO }}>
                        {t.corpo}
                    </p>

                    {/* Il digest è il codice da dare alla segreteria: l'unica chiave che lega questa
                        schermata alla riga con lo stack vero, registrata da `instrumentation.ts`. */}
                    {error.digest && (
                        <code
                            style={{
                                userSelect: 'all',
                                background: 'rgba(31,61,56,.07)',
                                padding: '6px 12px',
                                borderRadius: 12,
                                fontSize: 12,
                                letterSpacing: '0.08em',
                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            }}
                        >
                            {error.digest}
                        </code>
                    )}

                    {/* Verde su giallo: il bottone primario del design (`Btn variant="primary"`),
                        riprodotto a mano perché qui non c'è Tailwind. */}
                    <button
                        type="button"
                        onClick={reset}
                        style={{
                            marginTop: 8,
                            background: VERDE,
                            color: GIALLO,
                            border: 0,
                            borderRadius: 9999,
                            padding: '14px 30px',
                            fontSize: 15,
                            fontWeight: 800,
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                            cursor: 'pointer',
                        }}
                    >
                        {t.bottone}
                    </button>
                </div>
            </body>
        </html>
    );
}
