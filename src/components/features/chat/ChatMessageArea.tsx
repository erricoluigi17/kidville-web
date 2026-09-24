'use client';

import { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formattaIstante } from '@/i18n/config';
import { scartoGiorniCivili } from '@/lib/i18n/quando-relativo';
import { motion } from 'framer-motion';
import { Check, CheckCheck, Languages, Loader2 } from 'lucide-react';
import { sembraItaliano } from '@/lib/translate/lingua';
import { allegatoMostrabile, vicinoAlFondo, type ChatMessage } from '@/lib/chat/stato-conversazione';

/**
 * Il tipo del messaggio e la regola dell'allegato vivono nel modulo puro
 * `@/lib/chat/stato-conversazione` dal 2026-09-14: li usa anche l'unione dei messaggi, che non
 * può dipendere da un componente React. Si riesportano da qui perché i chiamanti e i test che li
 * importano da questo file restino validi senza toccarli.
 */
export { allegatoMostrabile };
export type { ChatMessage };

interface Props {
    messages: ChatMessage[];
    currentUserId: string;
    otherUserName: string;
    loading?: boolean;
    /** ID del primo messaggio non letto (dall'interlocutore). Usato per il separatore e lo scroll. */
    firstUnreadId?: string | null;
    /** Callback quando messaggi non letti entrano nel viewport (debounced 500ms) */
    onMarkRead?: (ids: string[]) => void;
    /**
     * Il server ha messaggi più vecchi di quelli in lista: in cima compare «Carica messaggi
     * precedenti». Dal 2026-09-14 la GET porta gli ULTIMI 50, lo storico si chiede a mano.
     */
    haPrecedenti?: boolean;
    /** La pagina precedente è in volo: il pulsante è occupato (e un secondo tocco non ne chiede un'altra). */
    caricandoPrecedenti?: boolean;
    /** L'ultimo tentativo non è riuscito: l'avviso resta finché non si riprova a mano. */
    errorePrecedenti?: boolean;
    onCaricaPrecedenti?: () => void;
}

/**
 * L'ora di una bolla di chat («14:05»).
 *
 * `intlDateTime` e non `toLocaleTimeString(locale, …)`: quest'ultima prendeva il
 * locale GREZZO di next-intl e nessun fuso. Due difetti in una riga sola:
 *  · `'en'` nudo lo risolve `Intl` su **en-US** → «2:05 PM» dentro un'interfaccia
 *    britannica dove tutto il resto è a 24 ore;
 *  · senza `timeZone` il fuso è quello DELL'AMBIENTE — su Vercel UTC, nel
 *    telefono di una famiglia Europe/Rome: d'estate due ore di scarto, e
 *    l'ultimo messaggio della sera finiva nel giorno prima.
 *
 * Il gemello a riga 72 era già stato corretto; questo no, nello stesso file.
 * Esportata perché è pura ed è il punto in cui il difetto si misura: il lock di
 * forma `__tests__/architecture/date-senza-fuso.test.ts` vieta la scrittura,
 * `__tests__/components/chat-ora-messaggio.test.ts` prova il risultato.
 */
export function formatMessageTime(iso: string, locale: string): string {
    return formattaIstante(new Date(iso), locale, { hour: '2-digit', minute: '2-digit' });
}

/** Etichette localizzate per i separatori relativi (da `common.oggi`/`common.ieri`). */
export interface EtichetteGiorno {
    oggi: string;
    ieri: string;
}

export function formatMessageDate(iso: string, locale: string, labels: EtichetteGiorno, adesso: Date = new Date()): string {
    // «Oggi»/«Ieri» sulle DATE CIVILI di Roma, come la chiave del gruppo (`groupByDate`): mai col
    // fuso del dispositivo, mai con «ieri = adesso − 24 ore» (il 29/03 dura 23 ore).
    // Le etichette arrivano localizzate (parità it/en); il resto della data (giorno + mese) è
    // localizzato da `formattaIstante`, che su un istante illeggibile restituisce ''.
    const scarto = scartoGiorniCivili(iso, adesso);
    if (scarto === 0) return labels.oggi;
    if (scarto === -1) return labels.ieri;
    return formattaIstante(iso, locale, { day: 'numeric', month: 'long' });
}

/**
 * I messaggi di un giorno sotto il suo separatore.
 *
 * ⚠️ IL GRUPPO È LA DATA DI CALENDARIO, NON L'ETICHETTA (2026-09-14). Prima un gruppo finiva quando
 * cambiava l'etichetta, e l'etichetta era anche la chiave React. Con «Carica messaggi precedenti» lo
 * storico copre anche due anni, e «5 novembre» è l'etichetta di due giorni diversi: due gruppi con
 * la stessa chiave (React può farne sparire o duplicare uno), oppure — se consecutivi — un anno
 * intero sotto un separatore solo. La data si prende nel fuso della scuola, lo stesso delle
 * etichette: a Roma la mezzanotte non è quella di Greenwich.
 */
function groupByDate(messages: ChatMessage[], locale: string, labels: EtichetteGiorno): { chiave: string; date: string; messages: ChatMessage[] }[] {
    const groups: { chiave: string; date: string; messages: ChatMessage[] }[] = [];
    // Un solo «adesso» per tutto l'elenco: due separatori dello stesso render non possono
    // leggere due orologi diversi a cavallo della mezzanotte.
    const adesso = new Date();

    messages.forEach(msg => {
        const chiave = formattaIstante(msg.created_at, 'it', { year: 'numeric', month: '2-digit', day: '2-digit' });
        const ultimo = groups[groups.length - 1];
        if (ultimo && ultimo.chiave === chiave) {
            ultimo.messages.push(msg);
            return;
        }
        groups.push({ chiave, date: formatMessageDate(msg.created_at, locale, labels, adesso), messages: [msg] });
    });

    return groups;
}

/** Separatore "Nuovi Messaggi" — pillola del design (non-letto = giallo, mai rosso). */
function UnreadSeparator() {
    const t = useTranslations('parentChat');
    return (
        <motion.div
            initial={{ opacity: 0, scaleX: 0.8 }}
            animate={{ opacity: 1, scaleX: 1 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="my-5 flex justify-center"
        >
            <span className="whitespace-nowrap rounded-pill border border-kidville-yellow bg-kidville-yellow-soft px-3 py-1 font-barlow text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-kidville-yellow-dark">
                {t('newMessages')}
            </span>
        </motion.div>
    );
}

/**
 * La lingua in cui l'utente STA LEGGENDO, in una funzione sola.
 *
 * Prima la si deduceva da `navigator.language`, cioè dalla lingua del SISTEMA
 * OPERATIVO — e in due punti diversi dello stesso componente, con la stessa
 * espressione ricopiata. Conseguenza misurata: una famiglia che ha messo
 * Kidville in inglese ma tiene il telefono in italiano non vedeva «Traduci» su
 * un messaggio italiano. È esattamente il caso d'uso per cui `src/lib/translate/`
 * esiste, e la lingua giusta era già in mano al componente (`useLocale()`, che
 * legge il cookie `KV_LOCALE`): si guardava l'altra.
 *
 * La scelta fatta dentro l'app è il segnale d'intento più forte che un utente
 * possa dare — più del locale di sistema, che spesso è quello con cui il
 * telefono è uscito dal negozio. Il sistema resta come RIPIEGO, per il caso in
 * cui il locale dell'app non sia disponibile.
 */
export function linguaDiLettura(localeApp?: string | null, localeSistema?: string | null): string {
    const scelta = (localeApp || '').trim() || (localeSistema || '').trim() || 'it';
    return scelta.split('-')[0].toLowerCase() || 'it';
}

/**
 * Quando ha senso proporre «Traduci»: se la lingua di lettura non è l'italiano
 * (lettore straniero) oppure se il messaggio non sembra italiano (mittente
 * straniero). Su un testo vuoto non c'è niente da tradurre.
 */
export function offriTraduzione(
    localeApp: string | null | undefined,
    localeSistema: string | null | undefined,
    testo: string | null | undefined,
): boolean {
    if (!testo || !testo.trim()) return false;
    return linguaDiLettura(localeApp, localeSistema) !== 'it' || !sembraItaliano(testo);
}

/** Bolla messaggio + traduzione automatica (DL-042) per i messaggi in ingresso. */
function MessageBubble({ msg, isMine, currentUserId }: { msg: ChatMessage; isMine: boolean; currentUserId: string }) {
    const locale = useLocale();
    const t = useTranslations('parentChat');
    const [translated, setTranslated] = useState<string | null>(null);
    const [translating, setTranslating] = useState(false);
    const [unavailable, setUnavailable] = useState(false);

    // «Traduci» compare SOLO se una delle due lingue non è l'italiano:
    // il messaggio in arrivo non sembra italiano (mittente straniero) oppure
    // chi legge non sta leggendo in italiano (lettore straniero).
    const linguaSistema = typeof navigator !== 'undefined' ? navigator.language : null;
    const mostraTraduci = offriTraduzione(locale, linguaSistema, msg.content);

    const handleTranslate = async () => {
        if (translated) { setTranslated(null); return; } // toggle: nascondi
        setTranslating(true);
        try {
            // Stessa regola del bottone, stessa funzione: tradurre VERSO una lingua
            // diversa da quella che ha fatto comparire il bottone sarebbe assurdo,
            // e con due espressioni ricopiate era solo questione di tempo.
            const targetLang = linguaDiLettura(locale, typeof navigator !== 'undefined' ? navigator.language : null);
            const res = await fetch('/api/chat/translate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': currentUserId },
                body: JSON.stringify({ text: msg.content, targetLang }),
            });
            if (res.status === 503) { setUnavailable(true); return; }
            if (res.ok) { const j = await res.json(); setTranslated(j.translated ?? null); }
        } catch { /* best-effort */ } finally {
            setTranslating(false);
        }
    };

    return (
        <div
            className={`max-w-[min(270px,80%)] px-3 py-2 ${
                isMine
                    ? 'rounded-[18px] rounded-br-[6px] bg-kidville-green text-white'
                    : 'rounded-[18px] rounded-bl-[6px] border border-kidville-line bg-kidville-white text-kidville-ink'
            }`}
            style={{
                boxShadow: isMine
                    ? '0 8px 20px -14px rgba(0,84,75,.7)'
                    : '0 1px 2px rgba(0,84,75,.05), 0 8px 22px -20px rgba(0,84,75,.3)',
            }}
        >
            {/* Attachment preview */}
            {msg.attachment_type === 'image' && allegatoMostrabile(msg.attachment_url) && (
                <div className="mb-2 rounded-xl overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={msg.attachment_url!} alt={t('attachmentAlt')} className="w-full h-auto max-h-48 object-cover" />
                </div>
            )}
            {msg.attachment_url && msg.attachment_type === 'document' && (
                allegatoMostrabile(msg.attachment_url) ? (
                    <a
                        href={msg.attachment_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`mb-2 px-3 py-2 rounded-xl text-xs font-maven flex items-center gap-2 underline-offset-2 hover:underline ${isMine ? 'bg-white/20' : 'bg-kidville-neutral-soft'}`}
                    >
                        📎 {t('documentAttachment')}
                    </a>
                ) : (
                    // URL con schema non-http (es. javascript:) salvato via API:
                    // niente link, solo il chip inerte com'era prima.
                    <div className={`mb-2 px-3 py-2 rounded-xl text-xs font-maven flex items-center gap-2 ${isMine ? 'bg-white/20' : 'bg-kidville-neutral-soft'}`}>
                        📎 {t('documentAttachment')}
                    </div>
                )
            )}

            {/* Text (design: Maven 13.5px, interlinea 1.42)
                `break-words`: il bubble è largo `min(270px,80%)` e con
                `overflow-wrap` predefinito una parola senza spazi non va a capo.
                Misurato a 320px: un URL da 107 caratteri produce scrollWidth 357
                contro clientWidth 217 e deborda oltre il bordo. Cinese, thai,
                arabo ed emoji (comprese le sequenze ZWJ) andavano già a capo da
                soli: è la parola lunga il caso scoperto, e un link incollato in
                chat è la cosa più comune che ci sia.
                `dir="auto"`: senza, l'arabo eredita la direzione LTR del
                documento e la punteggiatura di fine frase finisce a sinistra. Con
                `auto` il browser deduce la direzione dal primo carattere forte
                del messaggio — che è esattamente il dato che serve, ed è per
                messaggio, non per pagina. */}
            <p
                dir="auto"
                className={`font-maven text-[13.5px] leading-[1.42] break-words ${isMine ? 'text-white' : 'text-kidville-ink'}`}
            >
                {msg.content}
            </p>

            {/* Traduzione (solo messaggi in ingresso, e solo se serve davvero) */}
            {!isMine && msg.content?.trim() && !unavailable && mostraTraduci && (
                <>
                    {translated && (
                        <p className="font-maven text-sm leading-relaxed text-kidville-green mt-1.5 pt-1.5 border-t border-kidville-line italic">
                            🌐 {translated}
                        </p>
                    )}
                    {/* Chip "Traduci" del design (pill green-soft, Barlow 800) */}
                    <button
                        onClick={handleTranslate}
                        disabled={translating}
                        className="mt-1.5 inline-flex items-center gap-1 rounded-pill bg-kidville-green-soft px-2 py-0.5 font-barlow text-[10px] font-extrabold uppercase tracking-wide text-kidville-green transition-colors disabled:opacity-50"
                    >
                        {translating
                            ? <Loader2 size={11} className="animate-spin" />
                            : <Languages size={11} strokeWidth={2} />}
                        {translated ? t('showOriginal') : t('translate')}
                    </button>
                </>
            )}

            {/* Time + read status */}
            <div className={`flex items-center gap-1 mt-1 ${isMine ? 'justify-end' : 'justify-start'}`}>
                <span className={`font-maven text-[10px] ${isMine ? 'text-white/60' : 'text-kidville-muted'}`}>
                    {formatMessageTime(msg.created_at, locale)}
                </span>
                {isMine && (
                    // Tre stati: letto (doppia spunta gialla) › consegnato (doppia spunta grigia)
                    // › inviato (singola spunta grigia). `delivered_at` può mancare (payload E2E
                    // senza colonna): in tal caso si ricade su "inviato", che è la verità visibile.
                    <span
                        role="img"
                        aria-label={msg.read_at ? t('statusRead') : msg.delivered_at ? t('statusDelivered') : t('statusSent')}
                        className="transition-all duration-300"
                    >
                        {msg.read_at
                            ? <CheckCheck size={12} className="text-kidville-yellow" strokeWidth={1.5} />
                            : msg.delivered_at
                                ? <CheckCheck size={12} className="text-white/40" strokeWidth={1.5} />
                                : <Check size={12} className="text-white/40" strokeWidth={1.5} />}
                    </span>
                )}
            </div>
        </div>
    );
}

/**
 * La bolla di un messaggio dentro UN contenitore, per id. Gli id vengono dal database (uuid): uno
 * che non ha quella forma non entra in un selettore, dove un apice lo trasformerebbe in un altro.
 */
function messaggioNelContenitore(contenitore: HTMLElement, id: string): HTMLElement | null {
    if (!/^[\w-]+$/.test(id)) return null;
    return contenitore.querySelector<HTMLElement>(`[data-msg-id="${id}"]`);
}

export function ChatMessageArea({
    messages,
    currentUserId,
    otherUserName,
    loading,
    firstUnreadId,
    onMarkRead,
    haPrecedenti,
    caricandoPrecedenti,
    errorePrecedenti,
    onCaricaPrecedenti,
}: Props) {
    const locale = useLocale();
    const tCommon = useTranslations('common');
    const t = useTranslations('parentChat');
    const bottomRef = useRef<HTMLDivElement>(null);
    /**
     * Il contenitore che scorre. Le pagine montano questo componente DUE volte (desktop e mobile
     * a schermo intero), e nel DOM ci sono entrambe le istanze: tutto ciò che cerca bolle deve
     * cercarle QUI DENTRO, non in `document`.
     */
    const contenitoreRef = useRef<HTMLDivElement>(null);
    const separatorRef = useRef<HTMLDivElement>(null);
    const observerRef = useRef<IntersectionObserver | null>(null);
    const pendingMarkRead = useRef<Set<string>>(new Set());
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onMarkReadRef = useRef(onMarkRead);

    useEffect(() => {
        onMarkReadRef.current = onMarkRead;
    }, [onMarkRead]);

    // Flush degli ID da marcare come letti (debounced 500ms)
    const flushMarkRead = useCallback(() => {
        if (pendingMarkRead.current.size === 0) return;
        const ids = Array.from(pendingMarkRead.current);
        pendingMarkRead.current.clear();
        onMarkReadRef.current?.(ids);
    }, []);

    const scheduleFlush = useCallback(() => {
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(flushMarkRead, 500);
    }, [flushMarkRead]);

    // Scroll: se ci sono non letti → al separatore, altrimenti al fondo
    useEffect(() => {
        if (messages.length === 0) return;
        if (firstUnreadId && separatorRef.current) {
            separatorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    // Solo quando la conversazione COMPARE: cambio di thread, o fine del caricamento. Fino al
    // 2026-09-14 la chiave era il solo thread, e un messaggio del realtime arrivato mentre c'era lo
    // spinner la accendeva allora — senza niente a schermo da scorrere — e mai più: la conversazione
    // restava aperta in cima. L'effetto sulla lunghezza lo copriva per caso, ed è stato tolto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [!loading && messages.length > 0 ? messages[0]?.thread_id : null]);

    /* ─── IN TESTA O IN CODA: lo scorrimento che non salta (2026-09-14) ───────────────────────────
     *
     * Qui c'era un effetto su `messages.length`: se la lista cresceva, in fondo. Andava bene finché
     * la lista cresceva solo in coda. Con «Carica messaggi precedenti» cresce anche in TESTA, e quel
     * effetto rispediva all'ultimo messaggio chi aveva appena chiesto i primi. Sapere QUANTI sono non
     * basta: bisogna sapere DOVE sono arrivati, e lo dicono il primo e l'ultimo id.
     *
     *  · IN TESTA (cambia il primo, l'ultimo resta): il messaggio che era in cima resta dov'era a
     *    schermo. `scrollTop += spostamento dell'àncora`. WebKit (la WebView dell'app iOS) non ha lo
     *    scroll anchoring dei browser Chromium; dove c'è ed è già intervenuto lo spostamento misurato
     *    vale zero, quindi la correzione non si somma alla sua;
     *  · IN CODA (cambia l'ultimo): in fondo SOLO se il messaggio è mio, o se chi legge era già in
     *    fondo (`vicinoAlFondo`, regola del modulo puro: chi decide altro su «in fondo» usa quella).
     *
     * La «foto di prima» (`vistaRef`) si prende dopo OGNI commit e a ogni scroll: il commit che
     * aggiunge i messaggi ha già il DOM nuovo, quindi la posizione di prima va letta prima. I due
     * `useLayoutEffect` stanno in quest'ordine (React li esegue in ordine di dichiarazione) e prima
     * delle `return` anticipate; girano prima che il browser dipinga, quindi il salto non si vede.
     */
    const threadId = messages[0]?.thread_id ?? null;
    const primoId = messages[0]?.id ?? null;
    const ultimo = messages.length > 0 ? messages[messages.length - 1] : null;
    const ultimoId = ultimo?.id ?? null;
    const ultimoMio = !!ultimo && ultimo.sender_id === currentUserId;
    const vistaRef = useRef<{
        threadId: string | null;
        primoId: string | null;
        ultimoId: string | null;
        /** Distanza a schermo del primo messaggio dal bordo alto del contenitore. */
        ancoraTop: number | null;
        inFondo: boolean;
    }>({ threadId: null, primoId: null, ultimoId: null, ancoraTop: null, inFondo: true });

    const misura = useCallback(() => {
        const vista = vistaRef.current;
        const contenitore = contenitoreRef.current;
        if (!contenitore) {
            // Niente lista a schermo (spinner, conversazione vuota): la prossima si apre in fondo.
            vista.ancoraTop = null;
            vista.inFondo = true;
            return;
        }
        vista.inFondo = vicinoAlFondo(contenitore);
        const ancora = vista.primoId ? messaggioNelContenitore(contenitore, vista.primoId) : null;
        vista.ancoraTop = ancora ? ancora.getBoundingClientRect().top - contenitore.getBoundingClientRect().top : null;
    }, []);

    useLayoutEffect(() => {
        const prima = vistaRef.current;
        const contenitore = contenitoreRef.current;
        const stessoThread = prima.threadId !== null && prima.threadId === threadId;
        if (stessoThread && contenitore) {
            if (primoId !== prima.primoId && ultimoId === prima.ultimoId) {
                const ancora = prima.primoId && prima.ancoraTop !== null ? messaggioNelContenitore(contenitore, prima.primoId) : null;
                if (ancora && prima.ancoraTop !== null) {
                    const ora = ancora.getBoundingClientRect().top - contenitore.getBoundingClientRect().top;
                    contenitore.scrollTop += ora - prima.ancoraTop;
                }
            } else if (ultimoId !== prima.ultimoId && (ultimoMio || prima.inFondo)) {
                bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
            }
        }
        vistaRef.current = { ...prima, threadId, primoId, ultimoId };
    }, [threadId, primoId, ultimoId, ultimoMio]);

    useLayoutEffect(() => {
        misura();
    });

    // IntersectionObserver per marcare come letti i messaggi non letti
    //
    // ⚠️ SI OSSERVA SOLO DENTRO IL PROPRIO CONTENITORE (2026-09-14). Le pagine montano questo
    // componente due volte (desktop e mobile), e con `document.querySelectorAll` ciascuna istanza
    // osservava anche le bolle dell'altra: ogni lotto di letti partiva due volte. E l'effetto dipende
    // anche da `loading`: i messaggi arrivati mentre c'era lo spinner (niente contenitore montato)
    // non venivano più osservati quando lo spinner spariva, perché l'array dei messaggi era lo stesso.
    //
    // ⚠️ CIÒ CHE È COPERTO NON È VISTO (2026-09-14). `BiometricGate` lascia la pagina montata sotto
    // un `inert`, e una modale rende inerte lo sfondo: una bolla lì sotto interseca il viewport ma
    // nessuno la sta leggendo. Con l'apertura della conversazione dal tocco su una notifica, a
    // freddo, si segnavano letti messaggi coperti dal blocco — e il mittente vedeva la spunta. Una
    // bolla coperta non si segna e NON si smette di osservare; quando un `inert` sparisce si riosserva,
    // perché l'IntersectionObserver da solo non riscatta se l'intersezione non è cambiata.
    useEffect(() => {
        if (!onMarkRead) return;

        // Disconnetti observer precedente
        observerRef.current?.disconnect();
        const contenitore = contenitoreRef.current;
        if (!contenitore) return;

        const osserva = () => {
            observerRef.current?.disconnect();
            observerRef.current = new IntersectionObserver(
                (entries) => {
                    let hasNew = false;
                    entries.forEach((entry) => {
                        if (!entry.isIntersecting) return;
                        if ((entry.target as Element).closest('[inert]')) return; // coperto: non visto
                        const id = (entry.target as HTMLElement).dataset.messageId;
                        if (id) {
                            pendingMarkRead.current.add(id);
                            hasNew = true;
                            // Smetti di osservare una volta visto
                            observerRef.current?.unobserve(entry.target);
                        }
                    });
                    if (hasNew) scheduleFlush();
                },
                { threshold: 0.5 }
            );

            // Osserva i messaggi non letti dell'interlocutore di QUESTO contenitore
            const unreadEls = contenitore.querySelectorAll('[data-unread="true"]');
            unreadEls.forEach(el => observerRef.current?.observe(el));
        };
        osserva();

        // Uno sblocco (o una modale che si chiude) toglie un `inert`: si riosserva.
        const coperture = typeof MutationObserver === 'undefined'
            ? null
            : new MutationObserver(() => osserva());
        coperture?.observe(document.body, { attributes: true, attributeFilter: ['inert'], subtree: true });

        return () => {
            coperture?.disconnect();
            observerRef.current?.disconnect();
            if (debounceTimer.current) clearTimeout(debounceTimer.current);
        };
    // Ri-osserva quando cambiano i messaggi o finisce il caricamento
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages, loading, scheduleFlush]);

    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center bg-kidville-cream/50">
                <div className="flex flex-col items-center gap-3">
                    <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                    <p className="font-maven text-sm text-kidville-muted">{t('loadingMessages')}</p>
                </div>
            </div>
        );
    }

    if (messages.length === 0) {
        return (
            <div className="flex-1 flex items-center justify-center px-4 bg-kidville-cream/50">
                <div className="text-center">
                    <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
                        💬
                    </div>
                    <p className="font-barlow font-bold text-lg text-kidville-green uppercase mb-1">
                        {t('startConversation')}
                    </p>
                    <p className="font-maven text-sm text-kidville-muted max-w-xs">
                        {t('writeMessageTo', { name: otherUserName })}
                    </p>
                </div>
            </div>
        );
    }

    const groups = groupByDate(messages, locale, { oggi: tCommon('oggi'), ieri: tCommon('ieri') });

    return (
        <div
            ref={contenitoreRef}
            data-testid="chat-messaggi"
            onScroll={misura}
            className="flex-1 overflow-y-auto bg-kidville-cream/50 px-4 py-4 space-y-4"
        >
            {/* In cima, DENTRO il contenitore che scorre: si raggiunge scorrendo verso l'alto, dove
                finiscono i messaggi. La riga ha un'altezza fissa: il passaggio a «Caricamento…» non
                sposta la conversazione sotto. Niente opacità sul disabilitato: il testo verde sul
                bianco resta leggibile anche mentre carica. */}
            {haPrecedenti && onCaricaPrecedenti && (
                <div className="flex flex-col items-center gap-1.5">
                    <div className="flex h-11 items-center justify-center">
                        <button
                            type="button"
                            onClick={onCaricaPrecedenti}
                            disabled={caricandoPrecedenti}
                            aria-busy={caricandoPrecedenti ? true : undefined}
                            className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-line bg-white px-3 py-1.5 font-barlow text-[11px] font-extrabold uppercase tracking-[0.08em] text-kidville-green transition-colors hover:bg-kidville-green-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-kidville-green disabled:cursor-wait"
                        >
                            {caricandoPrecedenti ? (
                                <>
                                    <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                                    {t('loadingMessages')}
                                </>
                            ) : (
                                t('caricaPrecedenti')
                            )}
                        </button>
                    </div>
                    {errorePrecedenti && (
                        <p role="alert" className="text-center font-maven text-xs text-kidville-error-strong">
                            {t('caricaPrecedentiErrore')}
                        </p>
                    )}
                </div>
            )}
            {groups.map((group) => (
                <div key={group.chiave}>
                    {/* Separatore giorno — pillola del design */}
                    <div className="my-4 flex justify-center">
                        <span className="rounded-pill border border-kidville-line bg-white/70 px-3 py-1 font-barlow text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-kidville-muted">
                            {group.date}
                        </span>
                    </div>

                    {/* Messages */}
                    <div className="space-y-1.5">
                        {group.messages.map((msg, idx) => {
                            const isMine = msg.sender_id === currentUserId;
                            const isUnread = !isMine && msg.read_at === null;

                            // Separatore prima del primo messaggio non letto:
                            // gli id sono unici, il confronto è già esaustivo.
                            const showSeparator = firstUnreadId !== null && msg.id === firstUnreadId;

                            return (
                                <div key={msg.id}>
                                    {showSeparator && (
                                        <div ref={separatorRef}>
                                            <UnreadSeparator />
                                        </div>
                                    )}
                                    <motion.div
                                        initial={{ opacity: 0, y: 8, scale: 0.97 }}
                                        animate={{ opacity: 1, y: 0, scale: 1 }}
                                        transition={{ delay: idx * 0.02, duration: 0.2 }}
                                        className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}
                                        // L'àncora dello scorrimento: TUTTI i messaggi. Distinto da
                                        // `data-message-id`, che segna solo i non letti da osservare.
                                        data-msg-id={msg.id}
                                        // Attributi per IntersectionObserver
                                        data-message-id={isUnread ? msg.id : undefined}
                                        data-unread={isUnread ? 'true' : undefined}
                                    >
                                        <MessageBubble msg={msg} isMine={isMine} currentUserId={currentUserId} />
                                    </motion.div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
            <div ref={bottomRef} />
        </div>
    );
}
