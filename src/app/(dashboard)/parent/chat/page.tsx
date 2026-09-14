'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useTranslations } from 'next-intl';
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
function ParentChatContent() {
    const t = useTranslations('parentChat');
    const { userId: parentId, ready } = useSessionIdentity();

    const [showMobile, setShowMobile] = useState<'list' | 'chat'>('list');
    const [showNewChat, setShowNewChat] = useState(false);
    const [contacts, setContacts] = useState<Contact[]>([]);
    /**
     * L'invio non è riuscito, e perché. `null` = nessun problema.
     * Non è un doppione dello stato «termini» o «sospensione»: quelli sono
     * blocchi NOTI che disabilitano il composer, questo è il rifiuto di un
     * messaggio già scritto — e fino al 2026-09-07 non lo diceva nessuno.
     */
    const [erroreInvio, setErroreInvio] = useState<'rifiutato' | 'rete' | 'sospeso' | null>(null);

    /**
     * Perché la rubrica è vuota, quando lo è. La rotta lo dice (campo `motivo`),
     * e serve a non mostrare «li hai già contattati tutti» a chi non ha nessun
     * contatto possibile — che dopo la stretta del 2026-09-07 sarebbe una bugia.
     */
    const [motivoVuoto, setMotivoVuoto] = useState<string | null>(null);

    const [loadingContacts, setLoadingContacts] = useState(false);
    const [childrenNames, setChildrenNames] = useState<string[]>([]);
    const [chatCfg, setChatCfg] = useState<{
        in_orario: boolean;
        orario_docenti_da: string;
        orario_docenti_a: string;
        risposta_fuori_orario_msg: string;
    } | null>(null);
    // Gate Termini (C5): il POST messaggio ha risposto 403 termini_non_accettati.
    // Mostra il CTA verso /parent/onboarding invece di un errore generico.
    const [termsBlocked, setTermsBlocked] = useState(false);

    // I nomi dei figli nel sottotitolo, da ogni lista di thread arrivata.
    const onThreadsCaricati = useCallback((data: ChatThread[]) => {
        const names = [...new Set(data.map(t => t.student.nome))];
        if (names.length > 0) setChildrenNames(names);
    }, []);

    /**
     * Thread, messaggi, polling, realtime, invio e segna-letti: tutto ciò che parla con la rete
     * vive in `useConversazioneChat`, condiviso con la pagina del docente. Qui resta la UI.
     */
    const chat = useConversazioneChat({ userId: parentId, ready, rotta: '/parent/chat', onThreadsCaricati });
    const threads = chat.threads;
    const selectedThread = chat.threadAperto;
    const messages = chat.messaggi;

    // Aggiorna in-place la sospensione di un thread (dopo sospendi/riapri).
    const applySospensione = (threadId: string, sospensione: SospensioneInfo | null) => {
        chat.aggiornaThread(threadId, { sospensione });
    };

    // Config chat (orari docenti, messaggio fuori orario) dalle impostazioni scuola.
    useEffect(() => {
        fetch('/api/chat/config')
            .then(r => r.json())
            .then(d => { if (d.success) setChatCfg(d.data); })
            .catch(() => {});
    }, []);

    // NB: lo spinner contatti (loadingContacts) viene attivato dall'handler di
    // apertura modale, non qui: nessun setState sincrono nei loader da effect.
    const loadContacts = useCallback(async () => {
        if (!parentId) return;
        try {
            const res = await fetch(`/api/chat/contacts?userId=${parentId}`).catch(() => null);
            if (res?.ok) {
                const data = await res.json();
                setContacts(data.contacts ?? []);
                setMotivoVuoto(data.motivo ?? null);
                const names: string[] = [...new Set<string>((data.contacts ?? []).map((c: Contact) => c.student_name.split(' ')[0]))];
                if (names.length > 0) setChildrenNames(names);
            }
        } finally {
            setLoadingContacts(false);
        }
    }, [parentId]);

    useEffect(() => { loadContacts(); }, [loadContacts]);

    const handleSelectThread = (thread: ChatThread) => {
        chat.apri(thread);
        setShowMobile('chat');
    };

    const handleNewChat = async (contact: Contact) => {
        if (!parentId) return;
        try {
            const res = await fetch('/api/chat/threads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    teacher_id: contact.user_id,
                    parent_id: parentId,
                    student_id: contact.student_id,
                }),
            });
            if (res.ok) {
                setShowNewChat(false);
                const newThread = await res.json();
                await chat.ricaricaThreads();
                const allThreads = await chat.ricaricaThreads();
                const found = allThreads?.find(t => t.id === newThread.id);
                if (found) handleSelectThread(found);
            }
        } catch (err) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `chat-creazione-conversazione-fallita: ${nomeErrore(err)}`, route: '/parent/chat' });
        }
    };

    const handleSendMessage = async (content: string, attachmentUrl?: string, attachmentType?: string) => {
        if (!selectedThread || !parentId) return;
        const esito = await chat.invia(content, attachmentUrl, attachmentType);
        if (esito.esito === 'nessun-thread') return;
        if (esito.esito === 'ok') {
            setTermsBlocked(false);
            setErroreInvio(null);
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
            setErroreInvio('rete');
            return false;
        }
        if (esito.stato === 403) {
            // Guardie UGC (C5): il server rifiuta la scrittura. Il client mostra il
            // CTA giusto invece di un errore muto.
            if (esito.motivo === 'termini_non_accettati') {
                setTermsBlocked(true);
            } else if (esito.motivo === 'conversazione_sospesa') {
                // Sospensione rilevata server-side: ricarica i thread così il banner
                // "Conversazione sospesa" compare e il composer si disabilita.
                await chat.ricaricaThreads();
            } else if (esito.motivo === 'account_sospeso') {
                setErroreInvio('sospeso');
            } else {
                setErroreInvio('rifiutato');
            }
            return false;
        }
        setErroreInvio('rifiutato');
        return false;
    };

    // Skeleton finché l'identità non è risolta e i thread non sono caricati.
    // `statoThreads` esce da 'caricamento' appena la prima lista risponde, quindi
    // niente skeleton infinito; con identità risolta-a-null l'hook reindirizza.
    if (!ready || chat.statoThreads === 'caricamento' || !parentId) {
        return <ChatListSkeleton />;
    }

    // Stato sospensione DERIVATO dai thread (non da selectedThread, che resta
    // stabile): così un refresh dei thread — polling o dopo un 403 in invio —
    // fa comparire da sé il banner e disabilita il composer.
    const activeThread = selectedThread ? (threads.find(t => t.id === selectedThread.id) ?? selectedThread) : null;
    const susp = activeThread?.sospensione ?? null;
    const suspendedToMe = !!susp && susp.sospesaVerso === parentId;
    const controparteId = activeThread ? (activeThread.teacher_id === parentId ? activeThread.parent_id : activeThread.teacher_id) : '';
    const lastIncomingMessageId = messages.length
        ? ([...messages].reverse().find(m => m.sender_id !== parentId)?.id ?? null)
        : null;

    const menuTriggerLight = 'flex h-9 w-9 items-center justify-center rounded-full text-kidville-muted transition-colors hover:bg-kidville-neutral-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-kidville-green';
    const menuTriggerOnGreen = 'flex h-9 w-9 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-kidville-yellow';

    const conversationMenu = (triggerClassName: string) => activeThread ? (
        <ChatConversationMenu
            t={t}
            currentUserId={parentId}
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
            currentUserId={parentId}
            threadId={activeThread.id}
            sospensione={susp}
            onReopened={() => applySospensione(activeThread.id, null)}
        />
    ) : null;

    const terminiCta = termsBlocked ? (
        <div className="border-t border-kidville-yellow/40 bg-kidville-yellow-soft px-4 py-3">
            <p className="font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-yellow-dark">{t('ugcTermsBlockedTitle')}</p>
            {/* Niente `/80` sull'inchiostro: l'alfa portava il corpo del banner a
                1,56:1 sul giallo tenue — sotto il titolo, che già stava a 1,75:1.
                La rete di sicurezza in globals.css lo riporterebbe comunque a
                tinta piena, quindi la classe direbbe una cosa e la pagina ne
                renderebbe un'altra. La gerarchia resta dove è leggibile: 12px
                normale contro 14px extrabold. */}
            <p className="mb-2 font-maven text-xs text-kidville-yellow-dark">{t('ugcTermsBlockedBody')}</p>
            <a
                href="/parent/onboarding"
                className="inline-flex items-center rounded-full bg-kidville-green px-4 py-2 font-barlow text-xs font-bold uppercase tracking-wide text-white transition-colors hover:bg-kidville-green-dark"
            >
                {t('ugcTermsBlockedCta')}
            </a>
        </div>
    ) : null;

    return (
        <div className="px-4 pt-5 pb-24">
            <PageHeaderCard
                eyebrow={t('eyebrow')}
                title={t('title')}
                className="mb-4"
                badge={
                    <AnimatePresence>
                        {chat.nonLetti > 0 && (
                            <motion.span
                                initial={{ scale: 0, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0, opacity: 0 }}
                                transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                                className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-kidville-yellow text-kidville-green font-barlow font-bold text-xs shadow-sm"
                            >
                                {chat.nonLetti > 99 ? '99+' : chat.nonLetti}
                            </motion.span>
                        )}
                    </AnimatePresence>
                }
                subtitle={childrenNames.length > 0
                    ? t('subtitleWithNames', { names: childrenNames.join(` ${t('and')} `) })
                    : t('subtitle')}
                action={
                    <Btn
                        variant="secondary"
                        size="sm"
                        onClick={() => { setShowNewChat(true); setLoadingContacts(true); loadContacts(); }}
                    >
                        <Plus size={16} strokeWidth={1.5} /> {t('newChat')}
                    </Btn>
                }
            />

            {chatCfg && !chatCfg.in_orario && (
                <div className="mb-4 rounded-2xl bg-kidville-yellow-soft border border-kidville-yellow/40 px-4 py-3 font-maven text-sm text-kidville-yellow-dark">
                    {chatCfg.risposta_fuori_orario_msg || t('outOfHoursFallback', { da: chatCfg.orario_docenti_da, a: chatCfg.orario_docenti_a })}
                </div>
            )}

            {/* Desktop. mb-24 = clearance sotto il pannello: l'altezza fissa
                calc(100vh-200px) non tiene conto del banner fuori-orario, che
                spingeva il composer SOTTO la bottom nav fissa (irraggiungibile
                anche scrollando). Col margine lo scroll libera il composer;
                senza banner la resa iniziale è identica (spazio sotto la fold). */}
            <div className="hidden md:flex gap-4 h-[calc(100vh-200px-var(--kv-appbar-h,0px))] min-h-[500px] mb-24">
                <div className="w-80 flex-shrink-0 bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden flex flex-col">
                    <div className="px-4 py-3 border-b border-kidville-line">
                        <p className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">{t('teachers')}</p>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        <ChatThreadList threads={threads} selectedId={selectedThread?.id ?? null}
                            currentUserId={parentId} onSelect={handleSelectThread} />
                    </div>
                </div>

                <div className="flex-1 bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden flex flex-col">
                    {selectedThread ? (
                        <>
                            <div className="flex items-center gap-3 px-5 py-3.5 border-b border-kidville-line">
                                <div className="w-10 h-10 rounded-full bg-kidville-green flex items-center justify-center font-barlow font-bold text-sm text-kidville-yellow">
                                    {selectedThread.other_user.first_name[0]}{selectedThread.other_user.last_name[0]}
                                </div>
                                <div>
                                    <p className="font-maven font-semibold text-sm text-kidville-green">
                                        {selectedThread.other_user.first_name} {selectedThread.other_user.last_name}
                                    </p>
                                    <p className="font-maven text-[11px] text-kidville-muted">
                                        {t('teacherRole')} • {selectedThread.student.classe_sezione}
                                    </p>
                                </div>
                                <div className="ml-auto">{conversationMenu(menuTriggerLight)}</div>
                            </div>
                            {suspensionBanner}
                            <ChatMessageArea
                                messages={messages}
                                currentUserId={parentId}
                                otherUserName={selectedThread.other_user.first_name}
                                loading={chat.caricamentoMessaggi}
                                firstUnreadId={chat.primoNonLettoId}
                                onMarkRead={chat.segnaLetti}
                            />
                            {terminiCta}
                            {erroreInvio && (
                                <p role="alert" className="mx-4 mb-2 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
                                    {erroreInvio === 'rete' ? t('invioNonRiuscitoRete') : erroreInvio === 'sospeso' ? t('invioNonRiuscitoSospeso') : t('invioNonRiuscito')}
                                </p>
                            )}
                            <ChatInput onSend={handleSendMessage} placeholder={t('inputPlaceholderTeacher')} disabled={suspendedToMe} />
                        </>
                    ) : (
                        <div className="flex-1 flex items-center justify-center">
                            <div className="text-center">
                                <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mx-auto mb-4">
                                    <MessageSquare size={32} className="text-kidville-green" strokeWidth={1.5} />
                                </div>
                                <p className="font-barlow font-bold text-lg text-kidville-green uppercase mb-1">{t('selectTeacher')}</p>
                                <p className="font-maven text-sm text-kidville-muted">{t('selectTeacherHint', { action: t('newChat') })}</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Mobile */}
            <div className="md:hidden">
                {showMobile === 'list' ? (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        className="bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden">
                        <ChatThreadList threads={threads} selectedId={null}
                            currentUserId={parentId} onSelect={handleSelectThread} />
                    </motion.div>
                ) : selectedThread && (
                    // Conversazione a schermo intero su mobile: si adatta a qualsiasi
                    // dispositivo (100dvh reale), il campo resta sempre visibile in fondo
                    // sopra la safe-area; si esce con il tasto indietro in alto.
                    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                        className="fixed inset-0 z-[60] bg-kidville-cream flex flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]">
                        {/* Header conversazione del design: barra verde, back white/15, avatar giallo */}
                        <div className="flex items-center gap-2.5 bg-kidville-green px-3 py-2.5 pt-[max(10px,env(safe-area-inset-top))]">
                            <button onClick={() => setShowMobile('list')} aria-label={t('backToList')}
                                className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-transform active:scale-95">
                                <ArrowLeft size={18} strokeWidth={2.2} />
                            </button>
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kidville-yellow font-barlow text-sm font-extrabold text-kidville-green">
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
                            currentUserId={parentId}
                            otherUserName={selectedThread.other_user.first_name}
                            loading={chat.caricamentoMessaggi}
                            firstUnreadId={chat.primoNonLettoId}
                            onMarkRead={chat.segnaLetti}
                        />
                        {terminiCta}
                        {erroreInvio && (
                                <p role="alert" className="mx-4 mb-2 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
                                    {erroreInvio === 'rete' ? t('invioNonRiuscitoRete') : erroreInvio === 'sospeso' ? t('invioNonRiuscitoSospeso') : t('invioNonRiuscito')}
                                </p>
                            )}
                            <ChatInput onSend={handleSendMessage} placeholder={t('inputPlaceholder')} disabled={suspendedToMe} />
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
                                    <h2 className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide">{t('newChat')}</h2>
                                </div>
                                <button onClick={() => setShowNewChat(false)} aria-label={t('chiudiNuovaChat')}
                                    className="w-8 h-8 rounded-xl bg-kidville-neutral-soft hover:bg-kidville-cream-dark flex items-center justify-center text-kidville-muted">
                                    <X size={14} strokeWidth={1.5} />
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto p-4">
                                {loadingContacts ? (
                                    <div className="flex flex-col items-center py-8 gap-3">
                                        <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                                        <p className="font-maven text-sm text-kidville-muted">{t('loadingContacts')}</p>
                                    </div>
                                ) : contacts.length === 0 ? (
                                    <div className="flex flex-col items-center py-8 text-center">
                                        {/* ⚠️ QUATTRO VUOTI DIVERSI, QUATTRO FRASI DIVERSE.
                                            Qui c'era solo «Hai già una conversazione con tutte le
                                            maestre disponibili! 🎉». Dal 2026-09-07 la rubrica mostra
                                            le sole insegnanti della sezione dei propri figli, e quella
                                            frase toccherebbe anche chi non ha NESSUN contatto
                                            possibile: 23 famiglie, di cui 20 di una sola sezione — la
                                            `Sezione delle Meraviglie (NIDO)` di Cesa, che ha 20
                                            iscritti e zero insegnanti assegnate. Dire loro «li hai già
                                            contattati tutti», con un'emoji, sarebbe una bugia — e le
                                            manderebbe a cercare una conversazione che non esiste
                                            invece che in segreteria. */}
                                        <p className="font-maven text-sm text-kidville-muted">
                                            {motivoVuoto === 'figli-senza-sezione'
                                                ? t('childWithoutSection')
                                                : motivoVuoto === 'sezione-senza-docenti' || motivoVuoto === 'nessuna-sezione-assegnata'
                                                    ? t('noTeachersYet')
                                                    : motivoVuoto === 'nessun-figlio'
                                                        ? t('noChildren')
                                                        : t('allContactsUsed')}
                                        </p>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <p className="font-maven text-xs text-kidville-muted mb-3">
                                            {t('selectTeacherToStart')}
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
                                                    <div className="w-10 h-10 rounded-full bg-kidville-green flex items-center justify-center font-barlow font-bold text-sm text-kidville-yellow">
                                                        {initials}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="font-maven font-semibold text-sm text-kidville-green truncate">
                                                            {contact.user_name}
                                                        </p>
                                                        <p className="font-maven text-xs text-kidville-muted truncate">
                                                            {t('teacherOf', { name: contact.student_name })} • {contact.sezione}
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

export default function ParentChatPage() {
    return (
        <Suspense fallback={
            <div className="px-4 pt-5 pb-24 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <ParentChatContent />
        </Suspense>
    );
}
