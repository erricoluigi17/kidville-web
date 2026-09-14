'use client';

import { useState, useCallback, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, MessageSquare, Plus, X, UserPlus } from 'lucide-react';
import { ChatThreadList, ChatThread, SospensioneInfo } from '@/components/features/chat/ChatThreadList';
import { ChatMessageArea } from '@/components/features/chat/ChatMessageArea';
import { ChatInput } from '@/components/features/chat/ChatInput';
import { ChatConversationMenu } from '@/components/features/chat/ChatConversationMenu';
import { ChatSuspensionBanner } from '@/components/features/chat/ChatSuspensionBanner';
import { ChatListSkeleton } from '@/components/features/chat/ChatListSkeleton';
import { useConversazioneChat } from '@/components/features/chat/useConversazioneChat';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { useTranslations } from 'next-intl';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { logClient, nomeErrore } from '@/lib/logging/client';

interface Contact {
    user_id: string;
    user_name: string;
    user_role: string;
    student_id: string;
    student_name: string;
    sezione: string;
}

// Identità dalla sessione (URL → localStorage → /api/me), senza fallback demo (M4).
function TeacherChatContent() {
    const t = useTranslations('teacherComunicazioni');
    const { userId: teacherId, ready } = useSessionIdentity();

    const [showMobile, setShowMobile] = useState<'list' | 'chat'>('list');
    const [showNewChat, setShowNewChat] = useState(false);
    const [contacts, setContacts] = useState<Contact[]>([]);
    /**
     * L'invio non è riuscito, e perché. `null` = nessun problema.
     * Non è un doppione dello stato «termini» o «sospensione»: quelli sono
     * blocchi NOTI che disabilitano il composer, questo è il rifiuto di un
     * messaggio già scritto — e fino al 2026-09-07 non lo diceva nessuno.
     *
     * Appartiene al THREAD da cui il messaggio è partito (2026-09-14, D2): prima era uno stato
     * della pagina, e un invio fallito su una conversazione mostrava l'avviso sopra un'altra.
     */
    const [erroreInvio, setErroreInvio] = useState<{ threadId: string; tipo: 'rifiutato' | 'rete' | 'sospeso' } | null>(null);

    /**
     * Perché la rubrica è vuota, quando lo è. La rotta lo dice (campo `motivo`),
     * e serve a non mostrare «li hai già contattati tutti» a chi non ha nessun
     * contatto possibile — che dopo la stretta del 2026-09-07 sarebbe una bugia.
     */
    const [motivoVuoto, setMotivoVuoto] = useState<string | null>(null);

    const [loadingContacts, setLoadingContacts] = useState(false);

    /**
     * Thread, messaggi, polling, realtime, invio e segna-letti: tutto ciò che parla con la rete
     * vive in `useConversazioneChat`, condiviso con la pagina del genitore. Qui resta la UI.
     */
    const chat = useConversazioneChat({ userId: teacherId, ready, rotta: '/teacher/chat' });
    const threads = chat.threads;
    const selectedThread = chat.threadAperto;
    const messages = chat.messaggi;

    // Aggiorna in-place la sospensione di un thread (dopo sospendi/riapri).
    const applySospensione = (threadId: string, sospensione: SospensioneInfo | null) => {
        chat.aggiornaThread(threadId, { sospensione });
    };

    // Carica contatti disponibili
    // NB: lo spinner contatti (loadingContacts) viene attivato dall'handler di
    // apertura modale, non qui: nessun setState sincrono nei loader da effect.
    const loadContacts = useCallback(async () => {
        if (!teacherId) return;
        try {
            const res = await fetch(`/api/chat/contacts?userId=${teacherId}`).catch(() => null);
            if (res?.ok) {
                const data = await res.json();
                setContacts(data.contacts ?? []);
                setMotivoVuoto(data.motivo ?? null);
            }
        } finally {
            setLoadingContacts(false);
        }
    }, [teacherId]);

    const handleSelectThread = (thread: ChatThread) => {
        chat.apri(thread);
        setShowMobile('chat');
    };

    const handleNewChat = async (contact: Contact) => {
        if (!teacherId) return;
        try {
            const res = await fetch('/api/chat/threads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    teacher_id: teacherId,
                    parent_id: contact.user_id,
                    student_id: contact.student_id,
                }),
            });
            if (res.ok) {
                setShowNewChat(false);
                await chat.ricaricaThreads();
                const newThread = await res.json();
                const allThreads = await chat.ricaricaThreads();
                const found = allThreads?.find(t => t.id === newThread.id);
                if (found) handleSelectThread(found);
            }
        } catch (err) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `chat-creazione-conversazione-fallita: ${nomeErrore(err)}`, route: '/teacher/chat' });
        }
    };

    const handleSendMessage = async (content: string, attachmentUrl?: string, attachmentType?: string) => {
        if (!selectedThread || !teacherId) return;
        const esito = await chat.invia(content, attachmentUrl, attachmentType);
        if (esito.esito === 'nessun-thread') return;
        if (esito.esito === 'ok') {
            setErroreInvio(prev => (prev?.threadId === esito.threadId ? null : prev));
            return true;
        }
        /**
         * ⚠️ DA QUI IN GIÙ, PRIMA, NON SUCCEDEVA NIENTE.
         *
         * Il campo di scrittura si svuotava comunque (lo faceva `ChatInput`
         * prima di conoscere l'esito), e a schermo non compariva nulla: il
         * messaggio era perso e chi l'aveva scritto credeva di averlo mandato.
         * Valeva per il genitore moroso (403 `account_sospeso`), per un
         * allegato rifiutato (400) e per qualunque 500.
         *
         * Adesso l'handler dice `false`, il testo resta nel campo, e l'avviso
         * nomina il motivo quando il server ne dichiara uno.
         */
        if (esito.esito === 'rete') {
            // La rete è caduta: il messaggio NON è partito. Il log l'ha già scritto il hook;
            // questo serve a chi sta scrivendo adesso.
            setErroreInvio({ threadId: esito.threadId, tipo: 'rete' });
            return false;
        }
        if (esito.stato === 403) {
            // Guardia UGC (C5): se la conversazione è stata sospesa, ricarica i thread
            // così il banner compare e il composer si disabilita. (Il gate Termini non
            // scatta mai per un docente: guardia trasparente per lo staff.)
            if (esito.motivo === 'conversazione_sospesa') {
                await chat.ricaricaThreads();
            } else if (esito.motivo === 'account_sospeso') {
                setErroreInvio({ threadId: esito.threadId, tipo: 'sospeso' });
            } else {
                setErroreInvio({ threadId: esito.threadId, tipo: 'rifiutato' });
            }
            return false;
        }
        setErroreInvio({ threadId: esito.threadId, tipo: 'rifiutato' });
        return false;
    };


    // Skeleton finché l'identità non è risolta e i thread non sono caricati.
    // `statoThreads` esce da 'caricamento' appena la prima lista risponde, quindi
    // niente skeleton infinito; con identità risolta-a-null l'hook reindirizza.
    if (!ready || chat.statoThreads === 'caricamento' || !teacherId) {
        return <ChatListSkeleton />;
    }

    // Stato sospensione DERIVATO dai thread (vedi parent/chat): un refresh dei
    // thread fa comparire il banner e disabilita il composer senza toccare
    // selectedThread.
    const activeThread = selectedThread ? (threads.find(t => t.id === selectedThread.id) ?? selectedThread) : null;
    const susp = activeThread?.sospensione ?? null;
    const suspendedToMe = !!susp && susp.sospesaVerso === teacherId;
    // L'avviso d'invio si mostra solo sulla conversazione da cui il messaggio è partito.
    const erroreQui = erroreInvio && activeThread && erroreInvio.threadId === activeThread.id ? erroreInvio.tipo : null;
    const controparteId = activeThread ? (activeThread.teacher_id === teacherId ? activeThread.parent_id : activeThread.teacher_id) : '';
    const lastIncomingMessageId = messages.length
        ? ([...messages].reverse().find(m => m.sender_id !== teacherId)?.id ?? null)
        : null;

    const menuTriggerLight = 'flex h-9 w-9 items-center justify-center rounded-full text-kidville-muted transition-colors hover:bg-kidville-neutral-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-kidville-green';
    const menuTriggerOnGreen = 'flex h-9 w-9 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-kidville-yellow';

    const conversationMenu = (triggerClassName: string) => activeThread ? (
        <ChatConversationMenu
            t={t}
            currentUserId={teacherId}
            threadId={activeThread.id}
            controparteId={controparteId}
            lastIncomingMessageId={lastIncomingMessageId}
            isSuspended={!!susp}
            onSuspended={(s) => applySospensione(activeThread.id, s)}
            triggerClassName={triggerClassName}
        />
    ) : null;

    const suspensionBanner = activeThread && susp ? (
        <ChatSuspensionBanner
            t={t}
            currentUserId={teacherId}
            threadId={activeThread.id}
            sospensione={susp}
            onReopened={() => applySospensione(activeThread.id, null)}
        />
    ) : null;

    return (
        <div className="max-w-5xl mx-auto p-4 sm:p-6">
            {/* Header verde (DR) */}
            <PageHeaderCard
                eyebrow={t('chatEyebrow')}
                title={t('chatTitolo')}
                badge={
                    <AnimatePresence>
                        {chat.nonLetti > 0 && (
                            <motion.span
                                initial={{ scale: 0, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0, opacity: 0 }}
                                transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                                className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-kidville-yellow text-kidville-green font-barlow font-bold text-xs shadow-lg shadow-sm"
                            >
                                {chat.nonLetti > 99 ? '99+' : chat.nonLetti}
                            </motion.span>
                        )}
                    </AnimatePresence>
                }
                subtitle={t('chatSottotitolo')}
                action={
                    <Btn
                        variant="secondary"
                        size="sm"
                        onClick={() => { setShowNewChat(true); setLoadingContacts(true); loadContacts(); }}
                    >
                        <Plus size={16} strokeWidth={1.5} /> {t('chatNuova')}
                    </Btn>
                }
                className="mb-4"
            />

            {/* Desktop Layout: sidebar + chat area. mb-24 = clearance sotto il
                pannello ad altezza fissa, così lo scroll porta sempre il
                composer sopra la bottom nav fissa (stesso fix del parent chat). */}
            <div className="hidden md:flex gap-4 h-[calc(100vh-200px-var(--kv-appbar-h,0px))] min-h-[500px] mb-24">
                {/* Thread list */}
                <div className="w-80 flex-shrink-0 bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden flex flex-col">
                    <div className="px-4 py-3 border-b border-kidville-line">
                        <p className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">{t('chatConversazioni')}</p>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        <ChatThreadList threads={threads} selectedId={selectedThread?.id ?? null}
                            currentUserId={teacherId} onSelect={handleSelectThread} />
                    </div>
                </div>

                {/* Chat area */}
                <div className="flex-1 bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden flex flex-col">
                    {selectedThread ? (
                        <>
                            <div className="flex items-center gap-3 px-5 py-3.5 border-b border-kidville-line">
                                <div className="w-10 h-10 rounded-full bg-kidville-warn-soft flex items-center justify-center font-barlow font-bold text-sm text-kidville-warn">
                                    {selectedThread.other_user.first_name[0]}{selectedThread.other_user.last_name[0]}
                                </div>
                                <div>
                                    <p className="font-maven font-semibold text-sm text-kidville-green">
                                        {selectedThread.other_user.first_name} {selectedThread.other_user.last_name}
                                    </p>
                                    <p className="font-maven text-[11px] text-kidville-muted">
                                        {t('chatGenitoreDi', { nome: selectedThread.student.nome, cognome: selectedThread.student.cognome })}
                                    </p>
                                </div>
                                <div className="ml-auto">{conversationMenu(menuTriggerLight)}</div>
                            </div>
                            {suspensionBanner}
                            <ChatMessageArea
                                messages={messages}
                                currentUserId={teacherId}
                                otherUserName={selectedThread.other_user.first_name}
                                loading={chat.caricamentoMessaggi}
                                firstUnreadId={chat.primoNonLettoId}
                                onMarkRead={chat.segnaLetti}
                            />
                            {erroreQui && (
                                <p role="alert" className="mx-4 mb-2 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
                                    {erroreQui === 'rete' ? t('chatInvioNonRiuscitoRete') : erroreQui === 'sospeso' ? t('chatInvioNonRiuscitoSospeso') : t('chatInvioNonRiuscito')}
                                </p>
                            )}
                            {/* `key` sul thread (D2, 2026-09-14): il campo tiene testo e allegato in uno
                                stato suo, e senza key ciò che si era scritto per una famiglia restava
                                lì, pronto a partire, aprendo la conversazione con un'altra. */}
                            <ChatInput key={selectedThread.id} onSend={handleSendMessage} disabled={suspendedToMe} />
                        </>
                    ) : (
                        <div className="flex-1 flex items-center justify-center">
                            <div className="text-center">
                                <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mx-auto mb-4">
                                    <MessageSquare size={32} className="text-kidville-green" strokeWidth={1.5} />
                                </div>
                                <p className="font-barlow font-bold text-lg text-kidville-green uppercase mb-1">
                                    {t('chatSelezionaConversazione')}
                                </p>
                                <p className="font-maven text-sm text-kidville-muted">
                                    {t('chatSelezionaConversazioneAiuto', { azione: t('chatNuova') })}
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Mobile Layout */}
            <div className="md:hidden">
                {showMobile === 'list' ? (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        className="bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden">
                        <ChatThreadList threads={threads} selectedId={null}
                            currentUserId={teacherId} onSelect={handleSelectThread} />
                    </motion.div>
                ) : selectedThread && (
                    // Conversazione a schermo intero su mobile: si adatta a qualsiasi
                    // dispositivo (100dvh reale), il campo resta sempre visibile in fondo
                    // sopra la safe-area; si esce con il tasto indietro in alto.
                    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                        className="fixed inset-0 z-[60] bg-kidville-cream flex flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]">
                        {/* Header conversazione del design: barra verde, back white/15, avatar tinta persona */}
                        <div className="flex items-center gap-2.5 bg-kidville-green px-3 py-2.5 pt-[max(10px,env(safe-area-inset-top))]">
                            <button onClick={() => setShowMobile('list')} aria-label={t('chatTornaAllaLista')}
                                className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-transform active:scale-95">
                                <ArrowLeft size={18} strokeWidth={2.2} />
                            </button>
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kidville-warn font-barlow text-sm font-extrabold text-white">
                                {selectedThread.other_user.first_name[0]}{selectedThread.other_user.last_name[0]}
                            </div>
                            <div className="min-w-0">
                                <p className="truncate font-barlow text-[17px] font-extrabold uppercase leading-tight text-white">
                                    {selectedThread.other_user.first_name} {selectedThread.other_user.last_name}
                                </p>
                                <p className="truncate font-maven text-[11.5px] text-white/75">{selectedThread.student.nome}</p>
                            </div>
                            <div className="ml-auto">{conversationMenu(menuTriggerOnGreen)}</div>
                        </div>
                        {suspensionBanner}
                        <ChatMessageArea
                            messages={messages}
                            currentUserId={teacherId}
                            otherUserName={selectedThread.other_user.first_name}
                            loading={chat.caricamentoMessaggi}
                            firstUnreadId={chat.primoNonLettoId}
                            onMarkRead={chat.segnaLetti}
                        />
                        {erroreQui && (
                                <p role="alert" className="mx-4 mb-2 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
                                    {erroreQui === 'rete' ? t('chatInvioNonRiuscitoRete') : erroreQui === 'sospeso' ? t('chatInvioNonRiuscitoSospeso') : t('chatInvioNonRiuscito')}
                                </p>
                            )}
                            <ChatInput key={selectedThread.id} onSend={handleSendMessage} disabled={suspendedToMe} />
                    </motion.div>
                )}
            </div>

            {/* Modal Nuova Chat */}
            <AnimatePresence>
                {showNewChat && (
                    <>
                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="fixed inset-0 bg-kidville-green/30 backdrop-blur-sm z-50" onClick={() => setShowNewChat(false)} />
                        <motion.div
                            initial={{ opacity: 0, y: 30, scale: 0.97 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 20, scale: 0.97 }}
                            className="fixed inset-4 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-w-md bg-white rounded-3xl shadow-2xl z-50 flex flex-col max-h-[80vh] overflow-hidden"
                        >
                            <div className="flex items-center justify-between px-6 py-4 border-b border-kidville-line">
                                <div className="flex items-center gap-2">
                                    <UserPlus size={18} className="text-kidville-green" strokeWidth={1.5} />
                                    <h2 className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide">{t('chatNuova')}</h2>
                                </div>
                                <button onClick={() => setShowNewChat(false)} aria-label={t('chatChiudiNuova')}
                                    className="w-8 h-8 rounded-xl bg-kidville-cream hover:bg-kidville-cream-dark flex items-center justify-center text-kidville-green">
                                    <X size={14} strokeWidth={1.5} />
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto p-4">
                                {loadingContacts ? (
                                    <div className="flex flex-col items-center py-8 gap-3">
                                        <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                                        <p className="font-maven text-sm text-kidville-muted">{t('chatCaricamentoContatti')}</p>
                                    </div>
                                ) : contacts.length === 0 ? (
                                    <div className="flex flex-col items-center py-8 text-center">
                                        {/* Tre vuoti diversi, tre frasi diverse. «Hai già una
                                            conversazione con tutti i genitori disponibili! 🎉» è vera
                                            solo per il primo: alle 6 insegnanti senza sezione
                                            assegnata direbbe il falso, e le lascerebbe a chiedersi
                                            perché la loro classe non c'è. Il rimedio è
                                            un'assegnazione in anagrafica, e la frase lo dice. */}
                                        <p className="font-maven text-sm text-kidville-muted">
                                            {motivoVuoto === 'nessuna-sezione-assegnata'
                                                ? t('chatNessunaSezione')
                                                : motivoVuoto === 'sezioni-senza-famiglie'
                                                    ? t('chatSezioniSenzaFamiglie')
                                                    : t('chatContattiVuoto')}
                                        </p>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <p className="font-maven text-xs text-kidville-muted mb-3">
                                            {t('chatSelezionaGenitore')}
                                        </p>
                                        {contacts.map((contact, idx) => {
                                            const initials = contact.user_name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
                                            return (
                                                <motion.button
                                                    key={`${contact.user_id}-${contact.student_id}`}
                                                    initial={{ opacity: 0, y: 6 }}
                                                    animate={{ opacity: 1, y: 0 }}
                                                    transition={{ delay: idx * 0.04 }}
                                                    onClick={() => handleNewChat(contact)}
                                                    className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl bg-kidville-cream/30 hover:bg-kidville-cream/60 transition-all text-left"
                                                >
                                                    <div className="w-10 h-10 rounded-full bg-kidville-warn-soft flex items-center justify-center font-barlow font-bold text-sm text-kidville-warn">
                                                        {initials}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="font-maven font-semibold text-sm text-kidville-green truncate">
                                                            {contact.user_name}
                                                        </p>
                                                        <p className="font-maven text-xs text-kidville-muted truncate">
                                                            {t('chatGenitoreDiContatto', { nome: contact.student_name, sezione: contact.sezione })}
                                                        </p>
                                                    </div>
                                                    <Plus size={16} className="text-kidville-green flex-shrink-0" strokeWidth={1.5} />
                                                </motion.button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>
        </div>
    );
}

export default function TeacherChatPage() {
    return (
        <Suspense fallback={
            <div className="max-w-5xl mx-auto p-4 sm:p-6 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <TeacherChatContent />
        </Suspense>
    );
}
