'use client';

import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { logClient } from '@/lib/logging/client';
import { nomeFileScarico, scarica, type RisultatoScarico } from '@/lib/native/scarica';
import { condividiLink } from '@/lib/native/share';
import { Download, Share2, Play, ChevronLeft, ChevronRight, ImageOff } from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
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

/*
 * ⚠️ QUI NON SI PASSA `route`, ED È UNA DECISIONE — non una dimenticanza.
 *
 * Fino al 2026-09-06 queste righe dichiaravano `route: '/gallery'`, una pagina che NON
 * ESISTE: sotto `src/app/` ci sono `parent/gallery`, `teacher/gallery`, `admin/gallery` e la
 * route API, mai una `/gallery` alla radice. E `MediaGrid` è montata in QUATTRO punti —
 * `/parent/gallery`, `/parent/diary`, `/teacher/gallery` e, dal 2026-09-05, `/admin/gallery`
 * attraverso `GalleriaSedeGiornate`.
 *
 * `logClient` la rotta se la riempie da sé quando il campo manca: `client.ts` fa
 * `redigiPathSicuro(e.route || pagina())`, e `pagina()` è `redigiPath(location.pathname)` —
 * il percorso vero, già ridotto. Passare una costante era quindi STRETTAMENTE PEGGIO che
 * ometterla: sovrascriveva il luogo dell'incidente con un luogo inventato, e in `app_log` lo
 * scarico fallito di un'insegnante, quello di un genitore in galleria e quello dal diario
 * diventavano indistinguibili — in un lavoro il cui scopo è proprio sapere dove è successo.
 *
 * Chi in futuro volesse rimettere un `route` fisso qui dentro: serve a distinguere QUATTRO
 * superfici, e il modo giusto è lasciar parlare la pagina.
 */

/**
 * L'ESITO DELLO SCARICO FINISCE SEMPRE IN `app_log` — successo compreso.
 *
 * ─── PERCHÉ ANCHE IL SUCCESSO ────────────────────────────────────────────────
 * Senza la riga del successo, «nessun log» non distingue «va tutto bene» da «il
 * pulsante non ha mai fatto partire niente» — ed è ESATTAMENTE così che questo
 * guasto è rimasto in piedi: in trenta giorni di `app_log` c'è UNA sola riga
 * sullo scarico della galleria (2026-09-05, iOS), e nessuna che dica che una
 * volta abbia funzionato. Il silenzio sembrava salute (§5 di AGENTS.md).
 *
 * ─── PERCHÉ `warn` PER UN SUCCESSO, che sembra sbagliato ─────────────────────
 * Perché il canale non ha di meglio: `/api/logs` accetta **solo** `warn|error`
 * (difesa n. 4 della route: «un client non può riempire la tabella di `info`»),
 * quindi un `info` non è spedibile e l'unico modo di NON conservare un evento è
 * non mandarlo. Il costo è misurato, non stimato: `app_log` deduplica per
 * `(fingerprint, giorno)` — una riga al giorno per utente, con `occorrenze` che
 * conta il resto — e `controlloTassoErrore` guarda **solo** `livello = 'error'`,
 * quindi un battito a `warn` non può far dire «degradato» a un'app sana.
 *
 * ─── PERCHÉ LO STATO HTTP STA NEL MESSAGGIO E NON IN `stato` ─────────────────
 * Perché `livelloEvento()` applica a ogni `stato` fra 400 e 599 la politica di
 * `livelloFetch`, che per un 403 o un 404 risponde `null` = «non spedire». Un
 * indirizzo firmato scaduto (403) è il caso più probabile di scarico fallito:
 * dichiararlo in `stato` significherebbe scartare in silenzio proprio la riga
 * che si sta aggiungendo. Come token dentro `messaggio` invece resta, e il
 * livello resta quello dichiarato qui.
 */
function registraEsitoScarico(risultato: RisultatoScarico): void {
    const coda = risultato.motivo ? `: ${risultato.motivo}` : '';
    if (risultato.esito === 'nativo-file' || risultato.esito === 'web-blob') {
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: `gallery-scarico-riuscito:${risultato.esito}`,
        });
        return;
    }
    if (risultato.esito === 'ripiego-condivisione' || risultato.esito === 'ripiego-appunti') {
        // Degradato, non guasto: l'utente ha ottenuto il link. Vale `warn`.
        //
        // I DUE RIPIEGHI RESTANO DUE TOKEN DIVERSI in tabella
        // (`gallery-scarico-ripiego-condivisione` e `gallery-scarico-ripiego-appunti`),
        // perché non sono la stessa degradazione: col foglio l'utente vede
        // qualcosa succedere, con gli appunti no. Contarli insieme nasconderebbe
        // proprio il ramo che si è dovuto rendere parlante.
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: `gallery-scarico-${risultato.esito}${coda}`,
        });
        return;
    }
    // L'utente non ha ottenuto NIENTE: è il solo caso che merita un `error`.
    logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `gallery-scarico-non-riuscito${coda}`,
    });
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

    /**
     * UNO SCARICO ALLA VOLTA. Non è cosmesi: su iOS presentare un secondo foglio
     * di condivisione mentre il primo è aperto solleva, e su nativo la seconda
     * pressione riscriverebbe lo stesso file mentre lo si sta consegnando. Un
     * `ref` e non uno `state` perché non deve ridisegnare niente.
     */
    const scaricoInCorso = useRef(false);

    /**
     * LO SCARICO, IN UN POSTO SOLO — ed è metà della correzione.
     *
     * Prima questa logica era scritta DUE VOLTE, sulla card e nel visore, e le
     * due copie erano già divergenti: quella della card non aveva nemmeno un
     * `logClient`. Due copie che divergono non sono un difetto di domani: erano
     * il difetto di ieri.
     */
    const scaricaMedia = useCallback(async (item: MediaItem, url: string) => {
        if (scaricoInCorso.current) {
            /**
             * NON UN `return` NUDO — e non è pignoleria.
             *
             * `scarica()` non lancia mai, ma può NON RISOLVERE: la `fetch` verso
             * l'indirizzo firmato è CROSS-ORIGIN e nella WebView può accettare e
             * tacere (è la riga di produzione con `stato_http = 0` citata in
             * `scarica.ts`). In quel caso il `finally` qui sotto non gira mai, il
             * ref resta `true` per tutta la vita della pagina, e da lì in avanti
             * OGNI pressione di «Scarica» esce da questa riga.
             *
             * Senza questa riga «il pulsante è incagliato» e «nessuno l'ha mai
             * premuto» sarebbero lo stesso identico silenzio in `app_log`: è
             * l'ambiguità che il §5 di AGENTS.md vieta, ed è precisamente il modo
             * in cui lo «Scarica» rotto è sopravvissuto per mesi.
             *
             * Il TETTO DI TEMPO su `scarica()` è una decisione separata e non si
             * prende qui: `MAI_OLTRE_MS` è 30 s, e trenta secondi sono pochi per
             * il video di un genitore su rete lenta. Loggare la pressione
             * scartata invece non richiede nessuna scelta sui tempi.
             */
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: 'gallery-scarico-gia-in-corso',
            });
            return;
        }
        scaricoInCorso.current = true;
        try {
            const risultato = await scarica({
                url,
                nomeFile: nomeFileScarico(item.caption, url, item.file_type),
                titolo: item.caption ?? t('galleryFotoDaKidville'),
            });
            // Prima la riga, poi l'avviso: `alert()` blocca il thread finché
            // l'utente non chiude, e un log che parte dopo è un log che si perde
            // se lui intanto se ne va dalla pagina.
            registraEsitoScarico(risultato);
            // L'UNICO RAMO MUTO, e va detto — esattamente come fa `condividiMedia`
            // qui sotto. Ci si arriva sul web senza Web Share (Firefox su desktop)
            // quando l'indirizzo firmato è scaduto: il file non c'è, negli appunti
            // c'è il link, e sullo schermo non è cambiato niente. Senza queste due
            // righe «Scarica» tornerebbe a essere un pulsante che sembra rotto,
            // che è il difetto da cui è nato tutto questo lavoro.
            if (risultato.esito === 'ripiego-appunti') alert(t('mediaLinkCopiato'));
        } finally {
            scaricoInCorso.current = false;
        }
    }, [t]);

    /**
     * LA CONDIVISIONE, dallo stesso modulo nativo di tutto il resto dell'app
     * (`@/lib/native/share`) invece che riscritta a mano due volte. Qui il ramo
     * nativo mancava del tutto: c'era solo `navigator.share`, che nella WebView
     * esiste ma non è il foglio di sistema di Capacitor.
     *
     * `avvisoAppunti` è il messaggio da mostrare QUANDO si finisce sugli appunti,
     * che è l'unico ramo muto: senza, la copia riuscita e il pulsante rotto si
     * assomigliano troppo. Lo decide `condividiLink`, non una condizione
     * ricopiata qui.
     */
    const condividiMedia = useCallback(async (item: MediaItem, url: string, avvisoAppunti: string) => {
        const esito = await condividiLink({
            url,
            title: item.caption ?? t('galleryFotoDaKidville'),
        });
        if (esito === 'appunti') {
            alert(avvisoAppunti);
            return;
        }
        if (esito === 'non-riuscita') {
            // Nessun canale: prima di oggi questo ramo taceva del tutto, e un
            // «Condividi» che non condivide non lasciava traccia da nessuna parte.
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: 'gallery-condivisione-senza-canale',
            });
        }
    }, [t]);

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
                                <ImageOff size={22} className="text-kidville-green/70" strokeWidth={1.5} />
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
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void scaricaMedia(item, url);
                                    }}
                                    className="w-7 h-7 rounded-lg bg-white/90 hover:bg-white text-kidville-green flex items-center justify-center shadow-md active:scale-95 transition-all cursor-pointer border border-kidville-line"
                                    title={t('mediaScarica')}
                                >
                                    <Download size={12} strokeWidth={2.5} />
                                </button>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void condividiMedia(item, url, t('mediaLinkCopiato'));
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
                                    <ImageOff size={32} className="text-kidville-green/70" strokeWidth={1.5} />
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
                                {/* Gli STESSI due gesti della card, e nient'altro: la
                                    duplicazione fra questi due punti è ciò che aveva
                                    lasciato la card senza nemmeno un log. */}
                                {urlVisore && <button
                                    onClick={() => { void scaricaMedia(lightbox, urlVisore); }}
                                    className="flex items-center gap-2 px-5 py-2.5 bg-kidville-green hover:bg-kidville-green/90 text-white rounded-full font-barlow font-bold text-xs uppercase tracking-wide transition-colors cursor-pointer shadow-sm">
                                    <Download size={14} strokeWidth={2.5} /> {t('mediaScarica')}
                                </button>}
                                {urlVisore && <button
                                    onClick={() => { void condividiMedia(lightbox, urlVisore, t('mediaLinkCopiatoLungo')); }}
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
