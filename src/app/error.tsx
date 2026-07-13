'use client';

import { useEffect, useRef } from 'react';
import { logClient, flush } from '@/lib/logging/client';
import { Btn } from '@/components/ui/Btn';

/**
 * Boundary d'errore di segmento: copre tutto ciò che sta SOTTO il root layout (pagine,
 * layout annidati, Server Component). Il layout radice resta montato, quindi qui la AppBar
 * e la navigazione ci sono ancora: l'utente non è in un vicolo cieco.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ IL LOG QUI DENTRO È OBBLIGATORIO (e non un "di più" rispetto a window.onerror).
 *
 * È il punto controintuitivo dell'intero lavoro. Senza `error.tsx`, un errore React non
 * catturato passa dalla boundary IMPLICITA di Next, che lo rilancia a `reportError()` — e da lì
 * `window.onerror` (installato da `installaLoggerClient`) lo vede. Nel momento in cui si aggiunge
 * QUESTO file, lo stesso errore diventa "catturato da una boundary esplicita": in produzione Next
 * si limita a `console.error`, senza `reportError()`. `window.onerror` non spara più.
 *
 * I due meccanismi NON si sommano: si SOTTRAGGONO. Aggiungere una boundary senza loggarci dentro
 * significherebbe vedere MENO errori dopo il deploy di prima — e crederli scomparsi.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * IL DIGEST È IL DATO, NON IL MESSAGGIO. In produzione Next sostituisce il messaggio degli errori
 * dei Server Component con un testo generico e identico per tutto il progetto ("An error occurred
 * in the Server Components render…"): il messaggio VERO e lo stack restano sul server, e l'unica
 * cosa che attraversa il confine è il `digest`. È quindi il digest — non il messaggio — la chiave
 * che incrocia questa riga con quella emessa da `src/instrumentation.ts`, dove c'è lo stack vero.
 * Per lo stesso motivo lo si MOSTRA all'utente: è il codice che darà alla segreteria, e senza di
 * lui una segnalazione ("non funziona niente") non è correlabile a nulla.
 *
 * HYDRATION — il precedente storico. In questo repo un `app/loading.tsx` alla radice ha già rotto
 * l'hydration delle pagine client data-heavy (l'appello docente restava bloccato su "Caricamento
 * alunni"). La causa era il SUSPENSE che `loading.tsx` introduce: sospendendo l'albero, blocca gli
 * `useEffect` dei figli, cioè proprio le fetch di primo caricamento. Una boundary d'errore è un
 * meccanismo diverso: aggiunge un componente a classe con `componentDidCatch` attorno al segmento,
 * NON un confine Suspense — non sospende nulla e non ritarda nessun effetto. Il rischio è ragionato,
 * non ignorato; resta verificato dall'E2E `teacher-attendance`, che è il canarino di quell'incidente.
 *
 * DIPENDENZE AL MINIMO, di proposito: React e il logger. Questa è l'ultima rete prima della pagina
 * bianca, e se il modulo che ha causato il crash finisse anche fra i SUOI import, la boundary
 * fallirebbe a sua volta e l'errore salirebbe a `global-error.tsx` — perdendo il digest e la UI.
 * `Btn` è una funzione pura (nessun hook, nessun contesto, nessun dato): dà coerenza col design a
 * costo di rischio nullo. Una `Card`, un provider o un hook di dati qui NON entrano.
 */
export default function ErroreDiSegmento({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    /**
     * Dedup locale. In sviluppo StrictMode monta ogni componente DUE volte (effetto → cleanup →
     * effetto): senza guardia, ogni errore verrebbe accodato due volte. Il `useRef` sopravvive al
     * doppio montaggio — è lo stato del fiber, che React preserva — mentre una variabile di modulo
     * sarebbe condivisa fra boundary diverse e una `useState` farebbe scattare un secondo render.
     *
     * La chiave è il `digest` quando c'è (in produzione è l'identità dell'errore) e la coppia
     * nome+messaggio altrimenti: così un errore DIVERSO che arriva alla stessa boundary — succede,
     * se l'utente preme "Riprova" e va storto qualcos'altro — viene comunque loggato, invece di
     * essere silenziosamente scambiato per il precedente.
     *
     * È la prima delle due reti: la seconda è il throttle di `logClient` (stesso messaggio entro
     * 60 s), che protegge dalle tempeste. Questa protegge dal doppio montaggio, che il throttle
     * coglierebbe comunque — ma solo per fortuna, perché i due montaggi distano millisecondi.
     */
    const inviato = useRef<string | null>(null);

    useEffect(() => {
        const chiave = error.digest ?? `${error.name}:${error.message}`;
        if (inviato.current === chiave) return;
        inviato.current = chiave;

        logClient({
            livello: 'error',
            // `react` e non `boundary`: `EventoNome` è un'unione CHIUSA, e `react` è lo slug che il
            // client riserva alle boundary. In tabella diventa `client:react` (il prefisso lo mette
            // `/api/logs`, perché nessun evento del server possa essere impersonato dal browser).
            evento: 'react',
            messaggio: error.message || 'errore di rendering',
            // In produzione lo stack di un errore di Server Component non c'è (è rimasto sul
            // server, ed è `instrumentation.ts` a registrarlo). Su un errore CLIENT invece c'è, ed
            // è tutto ciò che serve: `/api/logs` lo persiste così com'è.
            stack: error.stack,
            digest: error.digest,
            route: percorso(),
        });
        // Fire-and-forget via `sendBeacon`. Il flush è ESPLICITO e non differito perché una pagina
        // d'errore è, statisticamente, l'ultima che l'utente vede prima di chiudere l'app: una coda
        // che aspetta il prossimo evento è una coda che muore con la scheda.
        flush();
    }, [error]);

    return (
        <div
            role="alert"
            className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 py-10 text-center"
        >
            <h2 className="font-barlow text-[26px] font-black uppercase leading-none text-kidville-green">
                Qualcosa è andato storto
            </h2>

            <p className="max-w-md font-maven text-sm leading-relaxed text-kidville-sub">
                Si è verificato un errore imprevisto. Puoi riprovare: se il problema si ripete,
                segnalalo alla segreteria indicando il codice qui sotto.
            </p>

            {/*
             * Il digest è l'unico ponte fra ciò che l'utente vede e ciò che noi possiamo cercare
             * (`app_log.contesto->>'digest'`, e la riga gemella di `instrumentation.ts` con lo stack).
             * `select-all` perché il gesto vero è "copio e incollo alla segreteria", spesso da un
             * telefono, dove selezionare otto caratteri a mano è un piccolo supplizio.
             */}
            {error.digest && (
                <code className="select-all rounded-input bg-kidville-neutral-soft px-3 py-1.5 font-mono text-xs tracking-wider text-kidville-ink">
                    {error.digest}
                </code>
            )}

            <Btn onClick={reset} className="mt-2">
                Riprova
            </Btn>
        </div>
    );
}

/**
 * La rotta della PAGINA: il luogo dell'incidente. Mai la query string — in questa app trasporta
 * `?userId=` ed è quindi un dato personale (il server ridurrebbe comunque il path a pattern, ma la
 * prima potatura si fa qui). Il `try` non è scaramantico: questa funzione gira dentro un gestore
 * d'errore, cioè nell'unico posto del sistema in cui una seconda eccezione non ha più nessuno sopra
 * di sé a raccoglierla.
 */
function percorso(): string | undefined {
    try {
        return typeof location === 'undefined' ? undefined : location.pathname;
    } catch {
        return undefined;
    }
}
