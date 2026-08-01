'use client';

import { motion } from 'framer-motion';
import { Eye, ThumbsUp, ThumbsDown, Clock, ChevronDown, Users, Pencil, Trash2, Megaphone, ClipboardList, Share2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { condividi } from '@/lib/native/share';
import { etichettaDestinatario, type ClasseNota } from '@/lib/avvisi/destinatari';

// Tipo del traduttore next-intl: serve per passare `t` alle funzioni helper
// (timeAgo/statusBadge) definite fuori dal componente, dove gli hook non si usano.
type Traduttore = ReturnType<typeof useTranslations>;

export interface Avviso {
    id: string;
    author_id: string;
    titolo: string;
    contenuto: string;
    tipo: string; // 'presa_visione' | 'adesione'
    target_scope: string;
    target_classes: string[] | null;
    scadenza: string | null;
    attachment_url: string | null;
    created_at: string;
    author: { first_name: string; last_name: string; role: string };
    stats: { letti: number; adesioni_si: number; adesioni_no: number };
    my_response?: { letto_il: string | null; risposta: string | null; risposto_il: string | null } | null;
}

interface Props {
    avviso: Avviso;
    index: number;
    isTeacher?: boolean;
    /**
     * Le sezioni che il chiamante conosce, per tradurre `target_classes` in
     * nomi di classe. È OPZIONALE perché non tutti hanno una fonte: il genitore
     * non ha nessun elenco di sezioni, e in quel caso una voce che è un id si
     * dichiara sconosciuta invece di comparire a schermo come uuid.
     */
    classiNote?: readonly ClasseNota[];
    onReadReceipt?: (avvisoId: string) => void;
    onAdesione?: (avvisoId: string, risposta: 'si' | 'no') => void;
    onShowDetails?: (avviso: Avviso) => void;
    onEdit?: (avviso: Avviso) => void;
    onDelete?: (avvisoId: string) => void;
}

function timeAgo(iso: string, t: Traduttore): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('adesso');
    if (mins < 60) return t('minutiFa', { n: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t('oreFa', { n: hrs });
    const days = Math.floor(hrs / 24);
    return t('giorniFa', { n: days });
}

// Badge di stato in stile DR (AvvisoRow). Riceve `t` perché è definita fuori dal componente.
function statusBadge(opts: { isAdesione: boolean; isRead: boolean; myAnswer?: string | null; isTeacher?: boolean }, t: Traduttore) {
    const { isAdesione, isRead, myAnswer, isTeacher } = opts;
    if (isTeacher) {
        return isAdesione
            ? { txt: t('badgeConfermaAdesione'), cls: 'bg-kidville-yellow text-kidville-green' }
            : { txt: t('badgeComunicazione'), cls: 'bg-kidville-info-soft text-kidville-info' };
    }
    if (isAdesione) {
        if (myAnswer === 'si') return { txt: t('badgeHaiAderito'), cls: 'bg-kidville-success-soft text-kidville-success' };
        if (myAnswer === 'no') return { txt: t('badgeNonAderisci'), cls: 'bg-kidville-error-soft text-kidville-error' };
        return { txt: t('badgeRichiedeAdesione'), cls: 'bg-kidville-yellow text-kidville-green' };
    }
    return isRead
        ? { txt: t('badgeLetto'), cls: 'bg-kidville-neutral-soft text-kidville-muted' }
        : { txt: t('badgeDaLeggere'), cls: 'bg-kidville-green-soft text-kidville-green' };
}

export function AvvisoCard({ avviso, index, isTeacher, classiNote, onReadReceipt, onAdesione, onShowDetails, onEdit, onDelete }: Props) {
    const t = useTranslations('avvisi');
    const locale = useLocale();
    const [expanded, setExpanded] = useState(false);
    const isAdesione = avviso.tipo === 'adesione';
    const isRead = !!avviso.my_response?.letto_il;
    const myAnswer = avviso.my_response?.risposta;
    const isExpired = avviso.scadenza && new Date(avviso.scadenza) < new Date();
    const unread = !isRead && !isTeacher;
    const badge = statusBadge({ isAdesione, isRead, myAnswer, isTeacher }, t);

    // Target leggibile: una pill «🌐 Tutti» per gli avvisi di plesso, una pill
    // per ogni classe destinataria. Contrasto Clay Village (green su green-soft).
    //
    // `target_classes` è un campo ETEROGENEO: il modulo ci scrive i NOMI, ma in
    // produzione ci sono record che portano l'ID della sezione. Finché il plesso
    // era uno le due forme erano ugualmente leggibili (il nome era di fatto una
    // chiave); con tre sedi non lo è più, e il collaudo iOS del 2026-07-31 (F4)
    // ha fotografato questa card mentre stampava `219cab6a-…` come destinatario
    // — mentre il cockpit, sullo stesso avviso, diceva «TEST Infanzia».
    // `etichettaDestinatario` fa quella risoluzione (id → nome, sede accanto solo
    // se deducibile) e, quando la voce è un uuid che non si risolve, NON restituisce
    // testo: la parola la mette qui il catalogo. Un uuid non è un'informazione per
    // un genitore né per un docente, ed è la ragione per cui non finisce nemmeno
    // in un `title`: un attributo lo nasconde alla vista, non allo screen reader.
    const isGlobale = avviso.target_scope === 'globale';
    const classiTarget = isGlobale ? [] : (avviso.target_classes ?? []).filter(Boolean);
    const destinatari = classiTarget.map((voce) => {
        const e = etichettaDestinatario(voce, classiNote ?? []);
        return { chiave: voce, testo: e.risolta ? e.testo : t('classeSconosciuta') };
    });
    const showTargetPills = isGlobale || destinatari.length > 0;

    // Decodifica allegato (JSON o link semplice)
    let fileUrl = null;
    let linkUrl = null;
    if (avviso.attachment_url) {
        if (avviso.attachment_url.startsWith('{')) {
            try {
                const parsed = JSON.parse(avviso.attachment_url);
                fileUrl = parsed.file;
                linkUrl = parsed.link;
            } catch {
                fileUrl = avviso.attachment_url;
            }
        } else {
            fileUrl = avviso.attachment_url;
        }
    }

    const handleExpand = () => {
        setExpanded(v => !v);
        if (!isRead && onReadReceipt) {
            onReadReceipt(avviso.id);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05, duration: 0.3 }}
            className={`overflow-hidden rounded-3xl border bg-kidville-white shadow-sm transition-all ${
                unread ? 'border-kidville-yellow/60' : 'border-kidville-line'
            }`}
        >
            {/* Header */}
            <button
                onClick={handleExpand}
                className="flex w-full items-start gap-3 px-5 py-4 text-left"
            >
                {/* Icon */}
                <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl ${
                    isAdesione ? 'bg-kidville-yellow-soft text-kidville-yellow-dark' : 'bg-kidville-green-soft text-kidville-green'
                }`}>
                    {isAdesione ? <ClipboardList size={19} strokeWidth={1.8} /> : <Megaphone size={19} strokeWidth={1.8} />}
                </div>

                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-barlow text-[10px] font-bold uppercase tracking-wide ${badge.cls}`}>
                            {badge.txt}
                        </span>
                        <span className="flex-shrink-0 font-maven text-[11px] text-kidville-muted">{timeAgo(avviso.created_at, t)}</span>
                    </div>
                    <h3 className="mt-1.5 truncate font-barlow text-base font-extrabold uppercase leading-tight tracking-wide text-kidville-green">
                        {avviso.titolo}
                    </h3>
                    <p className="mt-0.5 font-maven text-[11px] text-kidville-muted">
                        {avviso.author.first_name} {avviso.author.last_name}
                    </p>
                    {showTargetPills && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                            {isGlobale ? (
                                <span className="inline-flex items-center rounded-full bg-kidville-green-soft px-2 py-0.5 font-maven text-[10px] font-semibold text-kidville-green">
                                    {t('tutti')}
                                </span>
                            ) : (
                                destinatari.map((d) => (
                                    <span
                                        key={d.chiave}
                                        className="inline-flex items-center rounded-full bg-kidville-green-soft px-2 py-0.5 font-maven text-[10px] font-semibold text-kidville-green"
                                    >
                                        {d.testo}
                                    </span>
                                ))
                            )}
                        </div>
                    )}
                </div>

                <motion.div
                    animate={{ rotate: expanded ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    className="mt-1 flex-shrink-0"
                >
                    <ChevronDown size={16} className="text-kidville-muted" strokeWidth={1.8} />
                </motion.div>
            </button>

            {/* Expanded content */}
            {expanded && (
                <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    transition={{ duration: 0.25 }}
                    className="border-t border-kidville-line"
                >
                    {/* Contenuto */}
                    <div className="px-5 py-4">
                        <p className="whitespace-pre-wrap font-maven text-sm leading-relaxed text-[#55615c]">
                            {avviso.contenuto}
                        </p>

                        {/* Scadenza */}
                        {avviso.scadenza && (
                            <div className={`mt-3 flex items-center gap-2 rounded-xl border px-3 py-2 font-maven text-xs ${
                                isExpired
                                    ? 'border-kidville-error/20 bg-kidville-error-soft text-kidville-error'
                                    : 'border-kidville-warn/20 bg-kidville-warn-soft text-kidville-warn'
                            }`}>
                                <Clock size={12} strokeWidth={1.8} />
                                {isExpired ? t('scadutoIl') : t('scadenza')}{' '}
                                {new Date(avviso.scadenza).toLocaleDateString(locale, {
                                    day: 'numeric', month: 'long', year: 'numeric'
                                })}
                            </div>
                        )}

                        {/* Allegati e Link */}
                        {(fileUrl || linkUrl) && (
                            <div className="mt-3 flex flex-wrap gap-2">
                                {fileUrl && (
                                    <a
                                        href={fileUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1.5 rounded-xl border border-kidville-line bg-kidville-cream px-3 py-2 font-maven text-xs font-semibold text-kidville-green transition-colors hover:bg-kidville-cream-dark"
                                    >
                                        {t('allegatoFile')}
                                    </a>
                                )}
                                {linkUrl && (
                                    <a
                                        href={linkUrl.startsWith('http') ? linkUrl : `https://${linkUrl}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1.5 rounded-xl border border-kidville-line bg-kidville-cream px-3 py-2 font-maven text-xs font-semibold text-kidville-info transition-colors hover:bg-kidville-cream-dark"
                                    >
                                        {t('linkEsterno')}
                                    </a>
                                )}
                            </div>
                        )}

                        {/* Condivisione (genitore): titolo + testo dell'avviso */}
                        {!isTeacher && (
                            <div className="mt-3">
                                <button
                                    type="button"
                                    onClick={() =>
                                        void condividi({ title: avviso.titolo, text: `${avviso.titolo}\n\n${avviso.contenuto}` })
                                    }
                                    aria-label={t('condividiAria')}
                                    className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-green/30 bg-kidville-white px-3 py-2 font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-green transition-colors hover:bg-kidville-cream active:scale-95"
                                >
                                    <Share2 size={14} strokeWidth={2} /> {t('condividi')}
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Azioni genitore (adesione) */}
                    {!isTeacher && isAdesione && !isExpired && !myAnswer && (
                        <div className="flex gap-2 px-5 pb-4">
                            <button
                                onClick={() => onAdesione?.(avviso.id, 'si')}
                                className="flex flex-1 items-center justify-center gap-2 rounded-pill bg-kidville-green py-2.5 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-yellow transition-all hover:bg-kidville-green-dark active:scale-[0.98]"
                            >
                                <ThumbsUp size={14} strokeWidth={2} /> {t('aderisco')}
                            </button>
                            <button
                                onClick={() => onAdesione?.(avviso.id, 'no')}
                                className="flex flex-1 items-center justify-center gap-2 rounded-pill bg-kidville-green-soft py-2.5 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green transition-all hover:bg-kidville-cream-dark active:scale-[0.98]"
                            >
                                <ThumbsDown size={14} strokeWidth={2} /> {t('nonAderisco')}
                            </button>
                        </div>
                    )}

                    {/* Stato risposta genitore */}
                    {!isTeacher && myAnswer && (
                        <div className="px-5 pb-4">
                            <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 font-maven text-xs ${
                                myAnswer === 'si'
                                    ? 'border-kidville-success/20 bg-kidville-success-soft text-kidville-success'
                                    : 'border-kidville-neutral/20 bg-kidville-neutral-soft text-kidville-muted'
                            }`}>
                                {myAnswer === 'si' ? <ThumbsUp size={12} strokeWidth={1.8} /> : <ThumbsDown size={12} strokeWidth={1.8} />}
                                {myAnswer === 'si' ? t('haiAderitoConferma') : t('haiDeclinato')}
                            </div>
                        </div>
                    )}

                    {/* Stats e Azioni per insegnante */}
                    {isTeacher && (
                        <div className="flex flex-wrap items-center gap-4 border-t border-kidville-line px-5 pb-4 pt-3">
                            <div className="flex items-center gap-1.5 font-maven text-xs text-kidville-muted">
                                <Eye size={12} strokeWidth={1.8} />
                                <span>{t('hannoLetto', { count: avviso.stats.letti })}</span>
                            </div>
                            {isAdesione && (
                                <>
                                    <div className="flex items-center gap-1.5 font-maven text-xs text-kidville-success">
                                        <ThumbsUp size={12} strokeWidth={1.8} />
                                        <span>{avviso.stats.adesioni_si}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 font-maven text-xs text-kidville-muted">
                                        <ThumbsDown size={12} strokeWidth={1.8} />
                                        <span>{avviso.stats.adesioni_no}</span>
                                    </div>
                                </>
                            )}
                            <div className="ml-auto flex items-center gap-3">
                                <button
                                    onClick={() => onShowDetails?.(avviso)}
                                    className="flex items-center gap-1 font-maven text-xs font-bold text-kidville-green hover:underline"
                                >
                                    <Users size={12} strokeWidth={1.8} /> {t('dettaglio')}
                                </button>
                                <button
                                    onClick={() => onEdit?.(avviso)}
                                    className="flex items-center gap-1 font-maven text-xs font-bold text-kidville-info hover:underline"
                                >
                                    <Pencil size={12} strokeWidth={1.8} /> {t('modifica')}
                                </button>
                                <button
                                    onClick={() => onDelete?.(avviso.id)}
                                    className="flex items-center gap-1 font-maven text-xs font-bold text-kidville-error hover:underline"
                                >
                                    <Trash2 size={12} strokeWidth={1.8} /> {t('elimina')}
                                </button>
                            </div>
                        </div>
                    )}
                </motion.div>
            )}
        </motion.div>
    );
}
