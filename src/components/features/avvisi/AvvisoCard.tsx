'use client';

import { motion } from 'framer-motion';
import { Eye, ThumbsUp, ThumbsDown, Clock, ChevronDown, Users, Pencil, Trash2, Megaphone, ClipboardList, Share2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { condividi } from '@/lib/native/share';
import { formatData } from '@/lib/i18n/date';
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
        ? { txt: t('badgeLetto'), cls: 'bg-kidville-neutral-soft text-kidville-sub' }
        : { txt: t('badgeDaLeggere'), cls: 'bg-kidville-green-soft text-kidville-green' };
}

export function AvvisoCard({ avviso, index, isTeacher, classiNote, onReadReceipt, onAdesione, onShowDetails, onEdit, onDelete }: Props) {
    const t = useTranslations('avvisi');
    const locale = useLocale();
    const [expanded, setExpanded] = useState(false);
    // L'id del pannello che il bottone della testata governa. Da `useId()` e non
    // da `avviso.id`: la stessa comunicazione può comparire due volte nella
    // stessa pagina (bacheca + anteprima in home) e due id uguali romperebbero
    // il riferimento proprio per chi lo usa.
    const idCard = useId();
    const idPannello = `avviso-corpo-${idCard}`;
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
            {/* Testata — disclosure secondo ARIA APG: intestazione → bottone
                (`aria-expanded` + `aria-controls`) → pannello con lo stesso id.
                Prima era un unico `<button>` che avvolgeva TUTTA la testata:
                due difetti in una riga sola.
                 · Nessuno dei due stati era annunciato: si premeva Invio, il
                   corpo dell'avviso compariva, e lo screen reader continuava a
                   dire «pulsante». Su /teacher/avvisi gli elementi con
                   `aria-expanded` erano uno solo in tutta la pagina, ed era il
                   menu della bottom-nav.
                 · `<h2>`, `<p>` e `<div>` stavano DENTRO il bottone, che per
                   content model ammette solo phrasing content: HTML non valido,
                   e diversi screen reader appiattiscono il contenuto del bottone
                   in un'unica etichetta — vanificando proprio la correzione
                   h3 → h2 fatta per chi naviga per intestazioni.
                L'area di tocco NON si restringe al titolo: il bottone si estende
                sulla testata con uno pseudo-elemento (`after:inset-0` sopra
                questo contenitore `relative`), così sul telefono la card si apre
                toccandola ovunque come prima. */}
            <div
                data-kv-testata-avviso
                className="relative flex w-full items-start gap-3 px-5 py-4 text-left"
            >
                {/* Icon */}
                {/* L'icona è il segno che distingue «adesione» da «comunicazione»:
                    va letta, quindi vale la soglia 3:1 di WCAG 1.4.11. Il token
                    caldo che la reggeva (`yellow-dark`) sta a 1,75:1 sul proprio
                    fondo — meno di un'ombra. `warn-strong` tiene il caldo a 4,97:1. */}
                <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl ${
                    isAdesione ? 'bg-kidville-yellow-soft text-kidville-warn-strong' : 'bg-kidville-green-soft text-kidville-green'
                }`}>
                    {isAdesione ? <ClipboardList size={19} strokeWidth={1.8} /> : <Megaphone size={19} strokeWidth={1.8} />}
                </div>

                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-barlow text-[10px] font-bold uppercase tracking-wide ${badge.cls}`}>
                            {badge.txt}
                        </span>
                        <span className="flex-shrink-0 font-maven text-[11px] text-kidville-sub">{timeAgo(avviso.created_at, t)}</span>
                    </div>
                    {/* `h2`, non `h3`: la card sta SEMPRE sotto l'`h1` della testata di
                        pagina (`PageHeaderCard`) e non c'è nessuna sezione in mezzo. Con
                        l'`h3` la bacheca del docente saltava da h1 a h3 dieci volte di
                        fila, e chi naviga per intestazioni non aveva modo di sapere se si
                        era perso un livello. */}
                    <h2 className="mt-1.5 font-barlow text-base font-extrabold uppercase leading-tight tracking-wide text-kidville-green">
                        <button
                            type="button"
                            onClick={handleExpand}
                            aria-expanded={expanded}
                            aria-controls={idPannello}
                            className="block w-full text-left after:absolute after:inset-0 after:content-['']"
                        >
                            {/* Il troncamento sta su questo `span`, non sul bottone.
                                `truncate` porta con sé `overflow: hidden`, e un
                                elemento che ritaglia i propri discendenti è l'ultimo
                                posto dove mettere lo pseudo-elemento che allarga
                                l'area di tocco: il comportamento dipenderebbe da
                                una regola di clipping sottile invece che dalla
                                struttura. Uno `span` resta phrasing content, quindi
                                il bottone continua a essere HTML valido. */}
                            <span className="block truncate">{avviso.titolo}</span>
                        </button>
                    </h2>
                    <p className="mt-0.5 font-maven text-[11px] text-kidville-sub">
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
                    <ChevronDown size={16} className="text-kidville-sub" strokeWidth={1.8} />
                </motion.div>
            </div>

            {/* Expanded content — è il pannello puntato da `aria-controls`. */}
            {expanded && (
                <motion.div
                    id={idPannello}
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    transition={{ duration: 0.25 }}
                    className="border-t border-kidville-line"
                >
                    {/* Contenuto */}
                    <div className="px-5 py-4">
                        {/* `text-kidville-sub`, non l'hex letterale che c'era prima:
                            è lo STESSO colore (#55615C), ma scritto a mano restava
                            fuori dalle rimappature per-superficie e dall'inventario
                            dei token. */}
                        <p className="whitespace-pre-wrap font-maven text-sm leading-relaxed text-kidville-sub">
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
                                {/* `formatData`, non `toLocaleDateString(locale, …)`.
                                    Quella chiamata aveva due difetti nello stesso
                                    argomento: il locale GREZZO di next-intl («en»,
                                    che Intl risolve su en-US: «8/10» letto al
                                    contrario) e NESSUN fuso, quindi il fuso
                                    dell'ambiente — UTC sul processo Vercel,
                                    Europe/Rome nel browser di una famiglia. Fra le
                                    00:00 e le 02:00 italiane la stessa scadenza
                                    rendeva due GIORNI diversi: è la famiglia di
                                    difetti che a gennaio ha fatto sparire un incasso
                                    da un KPI. */}
                                {formatData(avviso.scadenza, locale, 'lunga')}
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
                                    : 'border-kidville-neutral/20 bg-kidville-neutral-soft text-kidville-sub'
                            }`}>
                                {myAnswer === 'si' ? <ThumbsUp size={12} strokeWidth={1.8} /> : <ThumbsDown size={12} strokeWidth={1.8} />}
                                {myAnswer === 'si' ? t('haiAderitoConferma') : t('haiDeclinato')}
                            </div>
                        </div>
                    )}

                    {/* Stats e Azioni per insegnante */}
                    {isTeacher && (
                        <div className="flex flex-wrap items-center gap-4 border-t border-kidville-line px-5 pb-4 pt-3">
                            <div className="flex items-center gap-1.5 font-maven text-xs text-kidville-sub">
                                <Eye size={12} strokeWidth={1.8} />
                                <span>{t('hannoLetto', { count: avviso.stats.letti })}</span>
                            </div>
                            {isAdesione && (
                                <>
                                    <div className="flex items-center gap-1.5 font-maven text-xs text-kidville-success">
                                        <ThumbsUp size={12} strokeWidth={1.8} />
                                        <span>{avviso.stats.adesioni_si}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 font-maven text-xs text-kidville-sub">
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
