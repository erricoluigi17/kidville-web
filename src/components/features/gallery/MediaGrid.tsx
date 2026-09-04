'use client';

import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { logClient } from '@/lib/logging/client';
import { Download, Share2, Play, ChevronLeft, ChevronRight, ImageOff } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { SegnalaContenuto } from '@/components/features/segnalazioni/SegnalaContenuto';

// Il traduttore va passato a timeAgo(), che è module-level (fuori dal componente).
type Traduttore = ReturnType<typeof useTranslations>;

export interface Student {
    id: string;
    nome: string;
    cognome: string;
    consenso_privacy?: boolean;
}

export interface MediaItem {
    id: string;
    /**
     * Indirizzo FIRMATO a tempo, generato dalla GET della galleria (il bucket è
     * privato). È `null` quando la firma non è riuscita: in quel caso la foto
     * non si può mostrare, e si mostra un segnaposto invece di un'immagine
     * rotta — il perché sta nel log lato server, a livello `error`.
     */
    file_url: string | null;
    file_type: string;
    caption: string | null;
    tag_students: string[];
    is_broadcast: boolean;
    created_at: string;
    uploader_name: string;
}

interface Props {
    items: MediaItem[];
    showActions?: boolean; // Download/Share per genitore
    onDelete?: (id: string) => void; // Solo admin/staff
    students?: Student[]; // Tutti gli studenti della classe per il tagging
    onUpdateTags?: (id: string, newTags: string[]) => Promise<void>; // Salvataggio dei tag
}

function timeAgo(iso: string, t: Traduttore): string {
    const diff = Date.now() - new Date(iso).getTime();
    const hrs = Math.floor(diff / 3600000);
    if (hrs < 1) return t('galleryOra');
    if (hrs < 24) return t('galleryOreFa', { n: hrs });
    const days = Math.floor(hrs / 24);
    return t('galleryGiorniFa', { n: days });
}

export function MediaGrid({ items, showActions, onDelete, students, onUpdateTags }: Props) {
    const t = useTranslations('shared');
    const [lightbox, setLightbox] = useState<MediaItem | null>(null);
    const [editMode, setEditMode] = useState(false);
    const [tempTagged, setTempTagged] = useState<string[]>([]);
    const [savingTags, setSavingTags] = useState(false);

    const handleCloseLightbox = () => {
        setLightbox(null);
        setEditMode(false);
        setTempTagged([]);
    };

    const currentIndex = lightbox ? items.findIndex(item => item.id === lightbox.id) : -1;
    // Indirizzo firmato del media aperto nel visore, in una const: `null` quando la
    // firma non è riuscita (bucket privato → link a tempo generato dalla GET).
    const urlVisore = lightbox?.file_url ?? null;

    const handlePrev = useCallback((e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (currentIndex > 0) {
            const prevItem = items[currentIndex - 1];
            setLightbox(prevItem);
            setEditMode(false);
            setTempTagged(prevItem.tag_students ?? []);
        }
    }, [currentIndex, items]);

    const handleNext = useCallback((e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (currentIndex < items.length - 1) {
            const nextItem = items[currentIndex + 1];
            setLightbox(nextItem);
            setEditMode(false);
            setTempTagged(nextItem.tag_students ?? []);
        }
    }, [currentIndex, items]);

    useEffect(() => {
        if (!lightbox) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') {
                handlePrev();
            } else if (e.key === 'ArrowRight') {
                handleNext();
            } else if (e.key === 'Escape') {
                handleCloseLightbox();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
        // handlePrev/handleNext sono memoizzate su [currentIndex, items] (già dipendenze):
        // l'effect gira esattamente quando girava prima.
    }, [lightbox, currentIndex, items, handlePrev, handleNext]);

    if (items.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">📷</div>
                <p className="font-barlow font-bold text-lg text-kidville-green uppercase mb-1">{t('galleryVuotoTitolo')}</p>
                <p className="font-maven text-sm text-kidville-sub">{t('galleryVuotoCorpo')}</p>
            </div>
        );
    }

    return (
        <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {items.map((item, idx) => {
                    // `url` in una const locale: il restringimento di tipo su
                    // `item.file_url` non sopravvivrebbe dentro gli handler.
                    const url = item.file_url;
                    return (
                    <motion.div
                        key={item.id}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: idx * 0.04, duration: 0.25 }}
                        className="relative group aspect-square rounded-2xl overflow-hidden bg-kidville-neutral-soft cursor-pointer shadow-sm border border-white/40"
                        onClick={() => {
                            setLightbox(item);
                            setEditMode(false);
                            setTempTagged(item.tag_students ?? []);
                        }}
                    >
                        {item.file_type === 'video' ? (
                            <div className="w-full h-full bg-kidville-ink flex items-center justify-center">
                                <Play size={32} className="text-white/80" strokeWidth={1.5} />
                            </div>
                        ) : item.file_url ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={item.file_url} alt={item.caption ?? t('galleryAltFoto')} className="w-full h-full object-cover" />
                        ) : (
                            /* Link non firmato: un `<img src="">` mostrerebbe l'icona di
                               immagine rotta e ripartirebbe con una richiesta sulla pagina
                               stessa. Meglio dirlo. */
                            <div className="w-full h-full bg-kidville-cream flex flex-col items-center justify-center gap-1 px-2 text-center">
                                <ImageOff size={22} className="text-kidville-green/40" strokeWidth={1.5} />
                                <span className="font-maven text-[10px] leading-tight text-kidville-green/60">
                                    {t('galleryAnteprimaNonDisponibile')}
                                </span>
                            </div>
                        )}

                        {/* Overlay on hover */}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                            <div className="absolute bottom-0 left-0 right-0 p-3">
                                <p className="font-maven text-xs text-white/90 truncate">{item.caption ?? ''}</p>
                                <p className="font-maven text-[10px] text-white/60">{item.uploader_name} • {timeAgo(item.created_at, t)}</p>
                            </div>
                        </div>

                        {/* Broadcast badge */}
                        {item.is_broadcast && (
                            <div className="absolute top-2 left-2 px-2 py-0.5 bg-kidville-yellow text-kidville-green font-barlow font-bold text-[9px] rounded-full uppercase">
                                {t('galleryBadgeGenerale')}
                            </div>
                        )}

                        {/* Pulsanti Download e Condividi diretti sulla card.
                            Senza indirizzo firmato non possono fare nulla: si tolgono,
                            invece di offrire un bottone che scarica un errore. */}
                        {showActions && url && (
                            <div className="absolute top-2 right-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 md:group-hover:opacity-100 transition-opacity duration-200 z-10 pointer-events-auto" style={{ opacity: 1 /* rendili sempre visibili per facilità su mobile */ }}>
                                <button
                                    onClick={async (e) => {
                                        e.stopPropagation();
                                        try {
                                            const response = await fetch(url);
                                            const blob = await response.blob();
                                            const blobUrl = window.URL.createObjectURL(blob);
                                            const a = document.createElement('a');
                                            a.href = blobUrl;
                                            a.download = item.caption || 'scaricato-da-kidville';
                                            document.body.appendChild(a);
                                            a.click();
                                            document.body.removeChild(a);
                                            window.URL.revokeObjectURL(blobUrl);
                                        } catch {
                                            window.open(url, '_blank');
                                        }
                                    }}
                                    className="w-7 h-7 rounded-lg bg-white/90 hover:bg-white text-kidville-green flex items-center justify-center shadow-md active:scale-95 transition-all cursor-pointer border border-kidville-line"
                                    title={t('mediaScarica')}
                                >
                                    <Download size={12} strokeWidth={2.5} />
                                </button>
                                <button
                                    onClick={async (e) => {
                                        e.stopPropagation();
                                        if (navigator.share) {
                                            try {
                                                await navigator.share({
                                                    url,
                                                    title: item.caption ?? t('galleryFotoDaKidville')
                                                });
                                            } catch {
                                                // Annullamento del foglio di condivisione: UX attesa,
                                                // non un guasto (stesso principio di @/lib/native/share).
                                                // L'oggetto errore conteneva l'URL FIRMATO della foto.
                                            }
                                        } else {
                                            try {
                                                await navigator.clipboard.writeText(url);
                                                alert(t('mediaLinkCopiato'));
                                            } catch {
                                                // Copia negata dal browser: l'utente lo vede subito.
                                            }
                                        }
                                    }}
                                    className="w-7 h-7 rounded-lg bg-white/90 hover:bg-white text-kidville-green flex items-center justify-center shadow-md active:scale-95 transition-all cursor-pointer border border-kidville-line"
                                    title={t('mediaCondividi')}
                                >
                                    <Share2 size={12} strokeWidth={2.5} />
                                </button>
                            </div>
                        )}
                    </motion.div>
                    );
                })}
            </div>

            {/* Lightbox */}
            {lightbox && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="fixed inset-0 bg-white/70 backdrop-blur-xl z-50 flex flex-col items-center justify-center p-4 overflow-hidden"
                    onClick={handleCloseLightbox}
                >
                    {/* Navigation Arrows */}
                    {currentIndex > 0 && (
                        <button
                            onClick={handlePrev}
                            className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-white/80 hover:bg-white text-kidville-green flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-all z-10 cursor-pointer border border-kidville-line"
                            title={t('mediaPrecedente')}
                        >
                            <ChevronLeft className="w-5 h-5 sm:w-6 sm:h-6" strokeWidth={2.5} />
                        </button>
                    )}
                    {currentIndex < items.length - 1 && (
                        <button
                            onClick={handleNext}
                            className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-white/80 hover:bg-white text-kidville-green flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-all z-10 cursor-pointer border border-kidville-line"
                            title={t('mediaSuccessiva')}
                        >
                            <ChevronRight className="w-5 h-5 sm:w-6 sm:h-6" strokeWidth={2.5} />
                        </button>
                    )}

                    <div className="relative max-w-2xl w-full my-auto z-10" onClick={e => e.stopPropagation()}>
                        <div className="relative bg-white rounded-2xl overflow-hidden shadow-xl p-3 border border-kidville-green/10">
                            {!urlVisore ? (
                                /* Firma non riuscita: si dice, non si mostra un riquadro rotto. */
                                <div className="w-full min-h-[35vh] rounded-xl bg-kidville-cream flex flex-col items-center justify-center gap-2 px-6 text-center">
                                    <ImageOff size={32} className="text-kidville-green/40" strokeWidth={1.5} />
                                    <span className="font-maven text-sm text-kidville-green/70">
                                        {t('galleryAnteprimaNonDisponibile')}
                                    </span>
                                </div>
                            ) : lightbox.file_type === 'video' ? (
                                <video src={urlVisore} controls className="w-full max-h-[55vh] rounded-xl bg-black" />
                            ) : (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img src={urlVisore} alt={lightbox.caption ?? t('galleryAltFoto')}
                                    className="w-full max-h-[55vh] object-contain rounded-xl mx-auto" />
                            )}
                        </div>

                        {/* Caption */}
                        {lightbox.caption && (
                            <p className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide text-center mt-4 mb-2">{lightbox.caption}</p>
                        )}

                        {/* Tagged Students Info (Teacher Side) */}
                        {students && students.length > 0 && (
                            <div className="mt-3 bg-kidville-cream/40 border border-kidville-green/10 rounded-2xl p-4 text-kidville-green">
                                <div className="flex items-center justify-between mb-2 pb-2 border-b border-kidville-green/10">
                                    <h3 className="font-barlow font-bold text-xs uppercase tracking-wide text-kidville-green/70">
                                        {t('galleryTaggatiTitolo')}
                                    </h3>
                                    {onUpdateTags && !editMode && (
                                        <button
                                            onClick={() => {
                                                setEditMode(true);
                                                setTempTagged(lightbox.tag_students ?? []);
                                            }}
                                            className="px-3 py-1 bg-kidville-green/10 hover:bg-kidville-green/20 text-kidville-green rounded-lg text-xs font-semibold tracking-wide transition-colors"
                                        >
                                            ✏️ {t('galleryModificaTag')}
                                        </button>
                                    )}
                                </div>

                                {editMode ? (
                                    <div className="space-y-3">
                                        <div className="grid grid-cols-2 gap-2 max-h-32 overflow-y-auto pr-1">
                                            {students.map((student) => {
                                                const isTagged = tempTagged.includes(student.id);
                                                return (
                                                    <label
                                                        key={student.id}
                                                        className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs cursor-pointer select-none transition-all ${
                                                            isTagged
                                                                ? 'bg-kidville-success-soft border-kidville-success text-kidville-success font-semibold shadow-sm'
                                                                : 'bg-white border-kidville-line text-kidville-sub hover:bg-kidville-cream'
                                                        }`}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={isTagged}
                                                            onChange={() => {
                                                                setTempTagged((prev) =>
                                                                    prev.includes(student.id)
                                                                        ? prev.filter((id) => id !== student.id)
                                                                        : [...prev, student.id]
                                                                );
                                                            }}
                                                            className="hidden"
                                                        />
                                                        <span>
                                                            {student.nome} {student.cognome}
                                                        </span>
                                                    </label>
                                                );
                                            })}
                                        </div>
                                        <div className="flex items-center justify-end gap-2 pt-2 border-t border-kidville-green/10">
                                            <button
                                                onClick={() => setEditMode(false)}
                                                className="px-3 py-1 bg-kidville-neutral-soft hover:bg-kidville-cream-dark rounded-lg text-xs font-semibold text-kidville-sub transition-colors"
                                            >
                                                {t('galleryAnnulla')}
                                            </button>
                                            <button
                                                onClick={async () => {
                                                    setSavingTags(true);
                                                    try {
                                                        await onUpdateTags?.(lightbox.id, tempTagged);
                                                        setLightbox({ ...lightbox, tag_students: tempTagged });
                                                        setEditMode(false);
                                                    } catch {
                                                        logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-salva-tag-fallito', route: '/gallery' });
                                                    } finally {
                                                        setSavingTags(false);
                                                    }
                                                }}
                                                disabled={savingTags}
                                                className="px-3 py-1 bg-kidville-success hover:opacity-90 disabled:opacity-55 rounded-lg text-xs font-semibold text-white transition-colors"
                                            >
                                                {savingTags ? t('gallerySalvataggio') : t('gallerySalva')}
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex flex-wrap gap-1.5">
                                        {(lightbox.tag_students ?? []).length === 0 ? (
                                            <span className="text-xs text-kidville-sub italic">{t('galleryNessunTaggato')}</span>
                                        ) : (
                                            (lightbox.tag_students ?? []).map((id) => {
                                                const student = students.find((s) => s.id === id);
                                                if (!student) return null;
                                                return (
                                                    <span
                                                        key={id}
                                                        className="px-2.5 py-1 bg-kidville-green/10 border border-kidville-green/20 rounded-full text-xs font-semibold"
                                                    >
                                                        {student.nome} {student.cognome}
                                                    </span>
                                                );
                                            })
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Actions */}
                        {showActions && (
                            <div className="flex items-center justify-center gap-3 mt-4">
                                {urlVisore && <button
                                    onClick={async () => {
                                        try {
                                            const response = await fetch(urlVisore);
                                            const blob = await response.blob();
                                            const blobUrl = window.URL.createObjectURL(blob);
                                            const a = document.createElement('a');
                                            a.href = blobUrl;
                                            a.download = lightbox.caption || 'scaricato-da-kidville';
                                            document.body.appendChild(a);
                                            a.click();
                                            document.body.removeChild(a);
                                            window.URL.revokeObjectURL(blobUrl);
                                        } catch {
                                            logClient({ livello: 'warn', evento: 'fetch', messaggio: 'gallery-download-diretto-fallito', route: '/gallery' });
                                            window.open(urlVisore, '_blank');
                                        }
                                    }}
                                    className="flex items-center gap-2 px-5 py-2.5 bg-kidville-green hover:bg-kidville-green/90 text-white rounded-full font-barlow font-bold text-xs uppercase tracking-wide transition-colors cursor-pointer shadow-sm">
                                    <Download size={14} strokeWidth={2.5} /> {t('mediaScarica')}
                                </button>}
                                {urlVisore && <button
                                    onClick={async () => {
                                        if (navigator.share) {
                                            try {
                                                await navigator.share({
                                                    url: urlVisore,
                                                    title: lightbox.caption ?? t('galleryFotoDaKidville')
                                                });
                                            } catch {
                                                // Annullamento della condivisione: UX attesa.
                                            }
                                        } else {
                                            try {
                                                await navigator.clipboard.writeText(urlVisore);
                                                alert(t('mediaLinkCopiatoLungo'));
                                            } catch {
                                                // Copia negata dal browser: l'utente lo vede subito.
                                            }
                                        }
                                    }}
                                    className="flex items-center gap-2 px-5 py-2.5 bg-kidville-yellow hover:bg-kidville-yellow/90 text-kidville-green rounded-full font-barlow font-bold text-xs uppercase tracking-wide transition-colors cursor-pointer shadow-sm">
                                    <Share2 size={14} strokeWidth={2.5} /> {t('mediaCondividi')}
                                </button>}
                                {/* Segnalazione contenuto (C5 §2): sempre etichettata, lato genitore. */}
                                <SegnalaContenuto
                                    tipoOggetto="media_galleria"
                                    oggettoId={lightbox.id}
                                    label={t('mediaSegnala')}
                                    variant="pill"
                                />
                            </div>
                        )}

                        {/* Delete (admin) */}
                        {onDelete && (
                            <button onClick={() => { onDelete(lightbox.id); handleCloseLightbox(); }}
                                className="mt-4 mx-auto flex items-center gap-1 px-4 py-2 bg-kidville-error hover:opacity-90 text-white rounded-full font-maven text-xs font-semibold transition-colors cursor-pointer">
                                🗑️ {t('galleryEliminaMedia')}
                            </button>
                        )}
                    </div>

                    {/* Close button */}
                    <button onClick={handleCloseLightbox}
                        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-kidville-green/10 text-kidville-green flex items-center justify-center hover:bg-kidville-green/20 transition-colors shadow-sm font-bold">
                        ✕
                    </button>
                </motion.div>
            )}
        </>
    );
}
