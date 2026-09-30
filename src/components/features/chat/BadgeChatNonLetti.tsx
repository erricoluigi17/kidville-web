'use client';

import { useId, type ReactNode } from 'react';
import { useChatNonLetti } from './contatore-non-letti';

/**
 * IL NUMERO DEI MESSAGGI DI CHAT NON LETTI SULLA BARRA IN BASSO — voce «Messaggi» (maestre) e
 * «Chat» (genitori), in un posto solo.
 *
 * Era scritto due volte, identico, nelle due barre: ~45 righe fra costanti, JSX e i commenti che
 * spiegano le due trappole qui sotto. Due copie di una regola sono due posti in cui domani una
 * delle due cambia, e in questo repo una regola valida per più strade vive in un posto solo.
 *
 * ─── TRAPPOLA 1 · IL NOME ACCESSIBILE NON SI TOCCA ──────────────────────────────────────
 *
 * Il numero va in una DESCRIZIONE (`aria-describedby`), mai in un `aria-label`: l'`aria-label`
 * SOSTITUISCE il nome accessibile («Messaggi» → «Messaggi, 3 non letti»), sulle WebView Android
 * quel nome esce come `content-desc`, e i flow Maestro toccano le voci PER TESTO. Su questo
 * dettaglio il flow del genitore ha già sbagliato due volte
 * (`.claude/maestro-flows/android-percorso-genitore.yaml`).
 *
 * La descrizione è `hidden` e non `sr-only`: un elemento nascosto REFERENZIATO da
 * `aria-describedby` entra comunque nella descrizione (accname, passo 2A), e così non occupa spazio
 * nella barra e non compare nell'albero Android come nodo a sé. Con `sr-only` finirebbe invece nel
 * NOME del link — cioè esattamente il difetto che questa scelta evita.
 *
 * ─── TRAPPOLA 2 · L'ORDINE DEI FIGLI ────────────────────────────────────────────────────
 *
 * `e2e/primaria-360/journeys/89-fix-360.spec.ts` capisce quale voce è attiva leggendo il colore di
 * `tab.querySelector('span:last-child')`, cioè dell'ETICHETTA. Uno span nuovo che diventasse il
 * primo `span:last-child` in ordine di documento non farebbe diventare rosso quel test: gli
 * farebbe misurare un altro elemento, e cambiare risposta in silenzio. Quindi la `descrizione` va
 * come PRIMO figlio del `Link` e il `badge` come PRIMO figlio della pillola, prima dell'icona.
 *
 * È il motivo per cui questo modulo restituisce DUE pezzi invece di un componente solo: i due
 * elementi vivono in due genitori diversi, e nessun wrapper potrebbe metterli entrambi al posto
 * giusto.
 *
 * ─── IL CONTRASTO, MISURATO ─────────────────────────────────────────────────────────────
 *
 * Bianco su verde: #FFFFFF su #006A5F vale **6,51:1** (WCAG AA chiede 4,5). L'anello serve a
 * staccare il badge dal fondo quando la pillola è ATTIVA, cioè verde su verde.
 *
 * ⚠️ E IN ALTO CONTRASTO NON CAMBIA NIENTE — questo commento ha detto il falso per un giro di
 * revisione, e la correzione vale più della riga sbagliata. Diceva che i due token si invertono e
 * che la cifra diventa nera su bianco a 21:1. È FALSO: `@theme inline` INLINA l'hex dentro
 * l'utility, quindi ridefinire `--color-kidville-green` e `--color-kidville-white` sotto
 * `[data-contrast="high"]` non tocca `.bg-kidville-green` né `.text-kidville-white` — nel CSS
 * compilato restano `#006a5f` e `#fff`. Lo dice già `globals.css` («ridefinire `--color-kidville-*`
 * sotto `[data-contrast="high"]` non tocca `.bg-kidville-green` né nient'altro»), ed è la stessa
 * lezione del difetto «gli elementi neri non erano nel CSS». Un tema scuro, poi, non esiste: zero
 * classi `dark:` e zero `prefers-color-scheme` in `src/` (`globals.css`, «Schema di colore
 * DICHIARATO»).
 *
 * Quindi in Alto Contrasto il badge resta bianco su #006A5F, 6,51:1, che regge AA. Il numero non
 * sta più qui a fidarsi di un commento: lo MISURA `__tests__/a11y/contrasto-cascata.test.tsx` §3
 * sul badge vero, risolvendo la cascata di `globals.css` nelle due modalità. Un numero in un
 * commento invecchia in silenzio; un numero in un lock fa rumore.
 *
 * NON si usa `text-kidville-muted`: è sotto soglia su tutte le superfici chiare del tema, e il lock
 * `testo-muted-allowlist` lo vieta.
 */
const CLASSI_BADGE =
    'absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-pill ' +
    'bg-kidville-green px-1 font-barlow text-[10px] font-extrabold leading-none text-kidville-white ' +
    'ring-2 ring-kidville-white';

/** I due pezzi da incastonare nella voce della barra, più l'attributo che li lega. */
export interface PezziBadgeChatNonLetti {
    /** Da mettere su `aria-describedby` del `<Link>`. `undefined` quando non c'è nulla da dire. */
    descrittoDa: string | undefined;
    /** PRIMO figlio del `<Link>`: la frase al plurale, nascosta. `null` senza badge. */
    descrizione: ReactNode;
    /** PRIMO figlio della pillola, PRIMA dell'icona: la cifra visibile. `null` senza badge. */
    badge: ReactNode;
}

/**
 * Il badge e la sua descrizione per la voce della chat, letti SOLO dallo store: nessuna richiesta
 * di rete da qui, né dalle barre.
 *
 * Il numero lo porta la campanella dentro la risposta di `/api/notifiche`, che gira già ogni 60 s
 * su ogni pagina (`./contatore-non-letti`). Le barre sono montate su OGNI schermata: una fetch qui
 * sarebbe una richiesta per pagina aperta, ed è il difetto che due lock misurano contando le
 * chiamate — `__tests__/ui/teacher-nav-gradi-una-chiamata.test.tsx` e `parent-figli-una-chiamata`.
 *
 * `null` («non lo so») e 0 non mostrano niente. `null` è anche ciò che vede il prerender del
 * server, così l'HTML servito e il primo render del client coincidono: il mismatch di idratazione
 * su queste barre è già costato una correzione.
 *
 * @param descrizione Come si dice il numero a chi non lo vede. Sta nel chiamante perché la chiave
 *                    i18n è diversa per area («Messaggi» e «Chat» hanno namespace diversi), e
 *                    perché il lock delle chiavi orfane la cerca nel sorgente che la usa.
 */
export function useBadgeChatNonLetti(descrizione: (n: number) => string): PezziBadgeChatNonLetti {
    const nonLetti = useChatNonLetti();
    const idNonLetti = `${useId()}chat-non-letti`;
    const conBadge = typeof nonLetti === 'number' && nonLetti > 0;

    if (!conBadge) return { descrittoDa: undefined, descrizione: null, badge: null };

    return {
        descrittoDa: idNonLetti,
        descrizione: (
            <span id={idNonLetti} hidden>
                {descrizione(nonLetti)}
            </span>
        ),
        badge: (
            // `aria-hidden`: il numero è già nella descrizione — letto due volte sarebbe rumore.
            // Oltre il nove la cifra diventa «9+», e la descrizione resta l'unico posto in cui il
            // numero è detto per intero.
            <span aria-hidden="true" data-testid="badge-chat-non-letti" className={CLASSI_BADGE}>
                {nonLetti > 9 ? '9+' : nonLetti}
            </span>
        ),
    };
}
