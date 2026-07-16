'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, CheckCheck, Languages, Loader2 } from 'lucide-react';
import { sembraItaliano } from '@/lib/translate/lingua';

export interface ChatMessage {
    id: string;
    thread_id: string;
    sender_id: string;
    content: string;
    attachment_url: string | null;
    attachment_type: string | null;
    read_at: string | null;
    /** Consegnato (scaricato dal destinatario). OPZIONALE: il payload E2E non lo ha
     *  finché il DB della CI non è migrato — l'assenza degrada a "solo inviato". */
    delivered_at?: string | null;
    created_at: string;
}

interface Props {
    messages: ChatMessage[];
    currentUserId: string;
    otherUserName: string;
    loading?: boolean;
    /** ID del primo messaggio non letto (dall'interlocutore). Usato per il separatore e lo scroll. */
    firstUnreadId?: string | null;
    /** Callback quando messaggi non letti entrano nel viewport (debounced 500ms) */
    onMarkRead?: (ids: string[]) => void;
}

function formatMessageTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function formatMessageDate(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);

    if (d.toDateString() === today.toDateString()) return 'Oggi';
    if (d.toDateString() === yesterday.toDateString()) return 'Ieri';
    return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
}

function groupByDate(messages: ChatMessage[]): { date: string; messages: ChatMessage[] }[] {
    const groups: { date: string; messages: ChatMessage[] }[] = [];
    let currentDate = '';

    messages.forEach(msg => {
        const date = formatMessageDate(msg.created_at);
        if (date !== currentDate) {
            currentDate = date;
            groups.push({ date, messages: [] });
        }
        groups[groups.length - 1].messages.push(msg);
    });

    return groups;
}

/** Separatore "Nuovi Messaggi" — pillola del design (non-letto = giallo, mai rosso). */
function UnreadSeparator() {
    return (
        <motion.div
            initial={{ opacity: 0, scaleX: 0.8 }}
            animate={{ opacity: 1, scaleX: 1 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="my-5 flex justify-center"
        >
            <span className="whitespace-nowrap rounded-pill border border-kidville-yellow bg-kidville-yellow-soft px-3 py-1 font-barlow text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-kidville-yellow-dark">
                Nuovi Messaggi
            </span>
        </motion.div>
    );
}

/** Bolla messaggio + traduzione automatica (DL-042) per i messaggi in ingresso. */
function MessageBubble({ msg, isMine, currentUserId }: { msg: ChatMessage; isMine: boolean; currentUserId: string }) {
    const [translated, setTranslated] = useState<string | null>(null);
    const [translating, setTranslating] = useState(false);
    const [unavailable, setUnavailable] = useState(false);

    // «Traduci» compare SOLO se una delle due lingue non è l'italiano:
    // il messaggio in arrivo non sembra italiano (mittente straniero) oppure
    // il dispositivo di chi legge non è in italiano (lettore straniero).
    const linguaDispositivo = (typeof navigator !== 'undefined' ? navigator.language : 'it').split('-')[0] || 'it';
    const mostraTraduci = linguaDispositivo !== 'it' || !sembraItaliano(msg.content ?? '');

    const handleTranslate = async () => {
        if (translated) { setTranslated(null); return; } // toggle: nascondi
        setTranslating(true);
        try {
            const targetLang = (typeof navigator !== 'undefined' ? navigator.language : 'it').split('-')[0] || 'it';
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
            {msg.attachment_url && msg.attachment_type === 'image' && (
                <div className="mb-2 rounded-xl overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={msg.attachment_url} alt="Allegato" className="w-full h-auto max-h-48 object-cover" />
                </div>
            )}
            {msg.attachment_url && msg.attachment_type === 'document' && (
                /^https?:\/\//i.test(msg.attachment_url) ? (
                    <a
                        href={msg.attachment_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`mb-2 px-3 py-2 rounded-xl text-xs font-maven flex items-center gap-2 underline-offset-2 hover:underline ${isMine ? 'bg-white/20' : 'bg-kidville-neutral-soft'}`}
                    >
                        📎 Documento allegato
                    </a>
                ) : (
                    // URL con schema non-http (es. javascript:) salvato via API:
                    // niente link, solo il chip inerte com'era prima.
                    <div className={`mb-2 px-3 py-2 rounded-xl text-xs font-maven flex items-center gap-2 ${isMine ? 'bg-white/20' : 'bg-kidville-neutral-soft'}`}>
                        📎 Documento allegato
                    </div>
                )
            )}

            {/* Text (design: Maven 13.5px, interlinea 1.42) */}
            <p className={`font-maven text-[13.5px] leading-[1.42] ${isMine ? 'text-white' : 'text-kidville-ink'}`}>
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
                        {translated ? 'Mostra originale' : 'Traduci'}
                    </button>
                </>
            )}

            {/* Time + read status */}
            <div className={`flex items-center gap-1 mt-1 ${isMine ? 'justify-end' : 'justify-start'}`}>
                <span className={`font-maven text-[10px] ${isMine ? 'text-white/60' : 'text-kidville-muted'}`}>
                    {formatMessageTime(msg.created_at)}
                </span>
                {isMine && (
                    // Tre stati: letto (doppia spunta gialla) › consegnato (doppia spunta grigia)
                    // › inviato (singola spunta grigia). `delivered_at` può mancare (payload E2E
                    // senza colonna): in tal caso si ricade su "inviato", che è la verità visibile.
                    <span
                        role="img"
                        aria-label={msg.read_at ? 'Letto' : msg.delivered_at ? 'Consegnato' : 'Inviato'}
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

export function ChatMessageArea({
    messages,
    currentUserId,
    otherUserName,
    loading,
    firstUnreadId,
    onMarkRead,
}: Props) {
    const bottomRef = useRef<HTMLDivElement>(null);
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
    // Solo quando cambia il thread (messages.length da 0 a N)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages.length > 0 ? messages[0]?.thread_id : null]);

    // Scroll al fondo per nuovi messaggi in ingresso (non al caricamento iniziale)
    const prevLengthRef = useRef(messages.length);
    useEffect(() => {
        const prev = prevLengthRef.current;
        prevLengthRef.current = messages.length;
        // Scrolla al fondo solo se sono arrivati nuovi messaggi (non il caricamento iniziale)
        if (prev > 0 && messages.length > prev) {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages.length]);

    // IntersectionObserver per marcare come letti i messaggi non letti
    useEffect(() => {
        if (!onMarkRead) return;

        // Disconnetti observer precedente
        observerRef.current?.disconnect();

        observerRef.current = new IntersectionObserver(
            (entries) => {
                let hasNew = false;
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        const id = (entry.target as HTMLElement).dataset.messageId;
                        if (id) {
                            pendingMarkRead.current.add(id);
                            hasNew = true;
                            // Smetti di osservare una volta visto
                            observerRef.current?.unobserve(entry.target);
                        }
                    }
                });
                if (hasNew) scheduleFlush();
            },
            { threshold: 0.5 }
        );

        // Osserva tutti i messaggi non letti dell'interlocutore
        const unreadEls = document.querySelectorAll('[data-unread="true"]');
        unreadEls.forEach(el => observerRef.current?.observe(el));

        return () => {
            observerRef.current?.disconnect();
            if (debounceTimer.current) clearTimeout(debounceTimer.current);
        };
    // Ri-osserva quando cambiano i messaggi
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages, scheduleFlush]);

    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center bg-kidville-cream/50">
                <div className="flex flex-col items-center gap-3">
                    <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                    <p className="font-maven text-sm text-kidville-muted">Caricamento messaggi...</p>
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
                        Inizia la conversazione
                    </p>
                    <p className="font-maven text-sm text-kidville-muted max-w-xs">
                        Scrivi un messaggio a {otherUserName}
                    </p>
                </div>
            </div>
        );
    }

    const groups = groupByDate(messages);

    return (
        <div className="flex-1 overflow-y-auto bg-kidville-cream/50 px-4 py-4 space-y-4">
            {groups.map((group) => (
                <div key={group.date}>
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
