'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, Camera, ChevronDown, GraduationCap } from 'lucide-react';
import { getEventConfig } from '@/components/features/teacher/diary/eventConfig';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { useChildSchoolType } from '@/lib/auth/use-child-school-type';
import { UMORE_CONFIG, umoreFromDettagli, umoreNarrative } from '@/lib/diary/umore';
import { MediaGrid, MediaItem } from '@/components/features/gallery/MediaGrid';

// ─── Tipi ─────────────────────────────────────────────────────────────────────

interface DiaryEntry {
    id: string;
    tipo_evento: string;
    timestamp_evento: string;
    dettagli: Record<string, unknown> | null;
    note: string | null;
    activity_description?: string | null;
}

// ─── Ordine canonico della giornata ───────────────────────────────────────────

const EVENT_ORDER: Record<string, number> = {
    entrata:  0,
    merenda:  1,
    attivita: 2,
    pranzo:   3,
    nanna:        4,
    nanna_inizio: 4,
    nanna_fine:   4.5,
    bagno:        5,
};

// ─── Narrativa in prima persona ───────────────────────────────────────────────

const MEAL_ICONS: Record<string, string> = {
    primo: '🍝', secondo: '🍖', contorno: '🥗', frutta: '🍎', merenda: '🍪',
};

const MEAL_NAMES: Record<string, string> = {
    primo: 'la pasta', secondo: 'il secondo', contorno: 'il contorno',
    frutta: 'la frutta', merenda: 'la merenda',
};

const QUANTITY_NARRATIVE: Record<string, string> = {
    niente: 'non ne ho voluto assaggiare',
    poco:   'ne ho mangiato solo un pochino',
    meta:   'ne ho mangiato metà',
    quasi:  'ne ho mangiato quasi tutto',
    tutto:  'ho finito tutto! 🌟',
};

function buildFirstPersonNarrative(tipo: string, dettagli: Record<string, unknown> | null): { lines: string[], emoji: string } {
    if (tipo === 'entrata') {
        const orarioRaw = (dettagli?.orario as string) ?? '';
        // orarioRaw può essere un ISO (timestamp dell'appello) o già 'HH:MM':
        // formatto l'ISO in ora leggibile, lascio invariato ciò che ISO non è.
        const d = orarioRaw ? new Date(orarioRaw) : null;
        const orario = d && !isNaN(d.getTime())
            ? d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
            : orarioRaw;
        return {
            emoji: '👋',
            lines: orario
                ? [`Sono arrivato/a a scuola alle ${orario}!`]
                : ['Sono arrivato/a a scuola stamattina!'],
        };
    }

    if (tipo === 'attivita') {
        const ACTIVITY_EMOJIS: Record<string, string> = {
            pittura: '🎨', musica: '🎵', lettura: '📚', motoria: '🏃',
            gioco: '🧩', natura: '🌿', cucina: '🍪', teatro: '🎭', altro: '✨',
        };
        const ACTIVITY_LABELS: Record<string, string> = {
            pittura: 'Pittura', musica: 'Musica', lettura: 'Lettura', motoria: 'Attività motoria',
            gioco: 'Gioco libero', natura: 'Natura', cucina: 'Cucina', teatro: 'Teatro', altro: 'Attività speciale',
        };
        const PART_PHRASES: Record<string, string> = {
            non_fatta:  "ma oggi non l'ho fatta",
            difficolta: "ma ho avuto qualche difficoltà",
            aiuto:      "con l'aiuto della maestra",
            autonomia:  "e l'ho svolta in autonomia! ⭐",
        };

        const rawActivities = dettagli?.activities as Array<{
            tipo: string; descrizione: string; partecipazione?: string | null;
        }> | undefined;

        if (rawActivities && rawActivities.length > 0) {
            const lines = rawActivities.map(a => {
                const emoji = ACTIVITY_EMOJIS[a.tipo] ?? '✨';
                const label = ACTIVITY_LABELS[a.tipo] ?? a.tipo;
                const partPhrase = a.partecipazione ? PART_PHRASES[a.partecipazione] ?? '' : '';
                const descPart = a.descrizione ? `: ${a.descrizione}` : '';
                return `${emoji} Ho fatto ${label}${descPart}${partPhrase ? ' ' + partPhrase : ''}`;
            });
            const firstEmoji = ACTIVITY_EMOJIS[rawActivities[0].tipo] ?? '🎨';
            return { emoji: rawActivities.length > 1 ? '🎭' : firstEmoji, lines };
        }

        // Fallback testo generico
        return { emoji: '🎨', lines: ['Oggi ho fatto delle belle attività con i miei amici!'] };
    }

    if (tipo === 'pranzo' || tipo === 'merenda') {
        const corsi = dettagli?.corsi as Record<string, string | null> | undefined;
        const lines: string[] = [];

        if (corsi) {
            Object.entries(corsi).forEach(([k, v]) => {
                if (!v) return;
                const name = MEAL_NAMES[k] ?? k;
                const icon = MEAL_ICONS[k] ?? '🍽️';
                const narrative = QUANTITY_NARRATIVE[v] ?? `ne ho mangiato ${v}`;
                if (v === 'niente') {
                    lines.push(`${icon} ${name.charAt(0).toUpperCase() + name.slice(1)}: ${narrative}`);
                } else {
                    lines.push(`${icon} ${name.charAt(0).toUpperCase() + name.slice(1)}: ${narrative}`);
                }
            });
        }

        if (lines.length === 0) {
            return { emoji: tipo === 'merenda' ? '🍎' : '🍽️', lines: ['Ho mangiato con i miei amici!'] };
        }

        return { emoji: tipo === 'merenda' ? '🍎' : '🍽️', lines };
    }

    if (tipo === 'nanna' || tipo === 'nanna_inizio') {
        const ini = dettagli?.orario_inizio as string | undefined;
        const fin = dettagli?.orario_fine   as string | undefined;
        const lines: string[] = [];
        if (ini && fin) lines.push(`Ho dormito dalle ${ini} alle ${fin} 😴`);
        else if (ini)   lines.push(`Mi sono addormentato/a alle ${ini} 😴`);
        else            lines.push('Ho fatto un bel sonnellino! 😴');
        return { emoji: '😴', lines };
    }

    if (tipo === 'nanna_fine') {
        const fin = dettagli?.orario_fine as string | undefined;
        return {
            emoji: '☀️',
            lines: fin ? [`Mi sono svegliato/a alle ${fin} ☀️`] : ['Mi sono svegliato/a dal sonnellino! ☀️'],
        };
    }

    if (tipo === 'bagno') {
        const pipi   = Number(dettagli?.pipi   ?? 0);
        const cacca  = Number(dettagli?.cacca  ?? 0);
        const vasino = Number(dettagli?.vasino ?? 0);
        const lines: string[] = [];
        if (pipi   > 0) lines.push(`💧 Ho fatto pipì ${pipi === 1 ? 'una volta' : `${pipi} volte`}`);
        if (cacca  > 0) lines.push(`💩 Ho fatto cacca ${cacca === 1 ? 'una volta' : `${cacca} volte`}`);
        if (vasino > 0) lines.push(`🪣 Ho usato il vasino ${vasino === 1 ? 'una volta' : `${vasino} volte`}`);
        if (lines.length === 0) lines.push('Sono stato/a al bagno oggi!');
        return { emoji: '🚿', lines };
    }

    return { emoji: '📝', lines: ['Evento registrato dalla maestra.'] };
}

// ─── Utilities data ────────────────────────────────────────────────────────────

function toDateKey(d: Date): string {
    return d.toISOString().split('T')[0];
}

function formatDayLabel(dateKey: string): string {
    const d = new Date(dateKey + 'T12:00:00');
    const today = toDateKey(new Date());
    const yesterday = toDateKey(new Date(Date.now() - 86400000));
    if (dateKey === today)     return 'Oggi';
    if (dateKey === yesterday) return 'Ieri';
    return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function deduplicateAndSort(entries: DiaryEntry[]): DiaryEntry[] {
    const latest = new Map<string, DiaryEntry>();
    entries.forEach(e => {
        const prev = latest.get(e.tipo_evento);
        if (!prev || e.timestamp_evento > prev.timestamp_evento) latest.set(e.tipo_evento, e);
    });
    return Array.from(latest.values()).sort((a, b) =>
        (EVENT_ORDER[a.tipo_evento] ?? 99) - (EVENT_ORDER[b.tipo_evento] ?? 99)
    );
}

// ─── Componenti ───────────────────────────────────────────────────────────────

function EventCard({ entry, index }: { entry: DiaryEntry; index: number }) {
    const config = getEventConfig(entry.tipo_evento);
    const { lines, emoji } = buildFirstPersonNarrative(
        entry.tipo_evento,
        entry.dettagli,
    );
    const borderColor = config.accentColor.split(' ').find(c => c.startsWith('border-')) ?? 'border-kidville-line';

    return (
        <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.07, duration: 0.3, ease: 'easeOut' }}
            className={`bg-white rounded-3xl border-l-4 ${borderColor} border border-kidville-line shadow-sm px-5 py-4`}
        >
            {/* Header card */}
            <div className="flex items-center gap-3 mb-3">
                <div className={`w-10 h-10 rounded-2xl flex items-center justify-center text-xl flex-shrink-0 ${config.color}`}>
                    {config.emoji}
                </div>
                <div className="flex-1">
                    <p className={`font-barlow font-black text-sm uppercase tracking-wide ${config.accentColor.split(' ').find(c => c.startsWith('text-')) ?? 'text-kidville-green'}`}>
                        {config.label}
                    </p>
                    <p className="font-maven text-[11px] text-kidville-muted">
                        {formatTime(entry.timestamp_evento)}
                    </p>
                </div>
                <span className="text-2xl">{emoji}</span>
            </div>

            {/* Narrazione prima persona */}
            <div className="space-y-1.5 pl-1">
                {lines.map((line, i) => (
                    <p key={i} className="font-maven text-sm text-kidville-ink leading-relaxed">
                        {line}
                    </p>
                ))}
                {entry.note && (
                    <p className="font-maven text-sm text-kidville-muted italic mt-2 pt-2 border-t border-kidville-line/60">
                        💬 &ldquo;{entry.note}&rdquo;
                    </p>
                )}
            </div>
        </motion.div>
    );
}

function PhotosSection({ photos }: { photos: MediaItem[] }) {
    const [open, setOpen] = useState(false);
    if (photos.length === 0) return null;
    return (
        <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.3 }}
            className="bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden"
        >
            <button
                onClick={() => setOpen(v => !v)}
                className="w-full flex items-center justify-between px-5 py-4"
            >
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-pink-50 border border-pink-100 flex items-center justify-center">
                        <Camera size={18} className="text-pink-500" strokeWidth={1.5} />
                    </div>
                    <div>
                        <p className="font-barlow font-black text-sm uppercase tracking-wide text-pink-600">
                            Le foto di oggi
                        </p>
                        <p className="font-maven text-[11px] text-kidville-muted">
                            {photos.length} {photos.length === 1 ? 'foto' : 'foto'} scattate dalla maestra
                        </p>
                    </div>
                </div>
                <motion.div animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }}>
                    <ChevronDown size={16} className="text-kidville-muted" strokeWidth={1.5} />
                </motion.div>
            </button>
            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25 }}
                        className="overflow-hidden"
                    >
                        <div className="px-4 pb-4 pt-0 border-t border-kidville-line/60 bg-black/5 rounded-b-3xl">
                            <MediaGrid items={photos} showActions />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
}

// ─── Pagina principale ────────────────────────────────────────────────────────

// Identità dalla sessione (URL → localStorage → /api/me), senza fallback demo (M4).
function ParentDiaryContent() {
    const { parentId, studentId: alunnoId, ready } = useParentIdentity();
    // Guardia grado: il diario giornaliero esiste solo per nido/infanzia.
    const { schoolType, ready: schoolTypeReady } = useChildSchoolType();

    const [dateKey, setDateKey] = useState<string>(toDateKey(new Date()));
    const [entries, setEntries] = useState<DiaryEntry[]>([]);
    const [photos, setPhotos] = useState<MediaItem[]>([]);
    // Il giorno di cui abbiamo completato il caricamento: lo spinner è derivato
    // (loading = giorno richiesto ≠ giorno caricato), niente setState sincroni.
    const [loadedKey, setLoadedKey] = useState<string | null>(null);
    const loading = loadedKey !== dateKey;
    const [direction, setDirection] = useState<1 | -1>(1);
    const [studentName, setStudentName] = useState<string | null>(null);
    const [classe, setClasse] = useState<string | null>(null);
    // "Entrata" letta dal modulo Presenze (read-only, DL-040).
    const [checkIn, setCheckIn] = useState<string | null>(null);

    const goDay = (delta: number) => {
        setDirection(delta as 1 | -1);
        setDateKey(prev => {
            const d = new Date(prev + 'T12:00:00');
            d.setDate(d.getDate() + delta);
            // Non andare oltre oggi
            if (d > new Date()) return prev;
            return toDateKey(d);
        });
    };

    const load = useCallback(async (dk: string) => {
        if (!ready || !alunnoId) return; // identità non risolta: lo spinner resta
        try {
            // Carica eventi diario (errore di rete ⇒ stato vuoto, come prima)
            const res = await fetch(`/api/diary/entries?alunno_id=${alunnoId}&from=${dk}&to=${dk}`).catch(() => null);
            if (res?.ok) {
                const data: DiaryEntry[] = await res.json();
                setEntries(deduplicateAndSort(data));
            } else {
                setEntries([]);
            }

            // "Entrata" dal modulo Presenze (orario di check-in del giorno)
            const ciRes = await fetch(`/api/diary/checkin?alunno_id=${alunnoId}&date=${dk}`).catch(() => null);
            const ci = ciRes?.ok ? await ciRes.json().catch(() => null) : null;
            setCheckIn(ci?.orario_entrata ?? null);

            // Carica foto reali associate a questo alunno per il giorno selezionato
            let photosUrl = `/api/gallery?studentId=${alunnoId}&date=${dk}`;
            if (parentId) photosUrl += `&parentId=${parentId}`;
            const photosRes = await fetch(photosUrl).catch(() => null);
            if (photosRes?.ok) {
                const photosData = await photosRes.json();
                setPhotos(photosData.media ?? []);
            } else {
                setPhotos([]);
            }
        } finally {
            setLoadedKey(dk);
        }
    }, [ready, alunnoId, parentId]);

    useEffect(() => { load(dateKey); }, [dateKey, load]);

    // Carica il nome reale del bambino
    useEffect(() => {
        if (!alunnoId) return;
        fetch(`/api/diary/students?id=${alunnoId}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (d?.nome) setStudentName(`${d.nome} ${d.cognome ?? ''}`.trim());
                if (d?.classe_sezione) setClasse(d.classe_sezione);
            })
            .catch(() => {});
    }, [alunnoId]);

    const initials = studentName
        ? studentName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
        : '?';

    const isToday = dateKey === toDateKey(new Date());

    // Umore del giorno (M5.4): entries è già deduplicato all'ultimo evento per
    // tipo, quindi qui c'è al più l'umore più recente del giorno. L'evento vive
    // nel banner giallo, non nella timeline.
    const umore = umoreFromDettagli(entries.find(e => e.tipo_evento === 'umore')?.dettagli);
    const umoreCfg = umore ? UMORE_CONFIG[umore] : null;
    const timelineEntries = entries.filter(e => e.tipo_evento !== 'umore');

    const slideVariants = {
        enter: (dir: number) => ({ x: dir > 0 ? -40 : 40, opacity: 0 }),
        center: { x: 0, opacity: 1 },
        exit:  (dir: number) => ({ x: dir > 0 ? 40 : -40, opacity: 0 }),
    };

    if (schoolTypeReady && schoolType === 'primaria') {
        return (
            <div className="min-h-screen bg-kidville-cream/40 p-6">
                <div className="max-w-md mx-auto rounded-card bg-white p-8 text-center shadow-sm">
                    <GraduationCap className="mx-auto mb-3 text-kidville-green" size={40} />
                    <h2 className="font-barlow text-xl font-bold text-kidville-ink">Sezione non disponibile</h2>
                    <p className="font-maven text-sm text-kidville-muted mt-1 mb-4">Il diario giornaliero riguarda solo nido e infanzia.</p>
                    <Link href="/parent/primaria" className="font-maven inline-block rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow">Vai alla sezione Primaria</Link>
                </div>
            </div>
        );
    }

    return (
        <div className="px-4 pt-5 pb-24">

            {/* Header verde (DR): titolo + chip nome bambino */}
            <PageHeaderCard
                eyebrow="La giornata"
                title="Il mio diario"
                subtitle="La giornata a scuola, raccontata da me 🌈"
                className="mb-6"
                action={
                    <div className="flex items-center gap-2 rounded-pill bg-white/15 py-1 pl-1 pr-3">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-kidville-yellow font-barlow text-xs font-extrabold text-kidville-green">
                            {initials}
                        </span>
                        <span className="min-w-0">
                            <span className="block truncate font-barlow text-xs font-extrabold uppercase leading-none text-white">
                                {studentName ?? '...'}
                            </span>
                            {classe && (
                                <span className="block truncate font-maven text-[10px] text-white/70">
                                    {classe}
                                </span>
                            )}
                        </span>
                    </div>
                }
            />

            {/* Navigazione giorno */}
            <div className="flex items-center justify-between mb-5 bg-white rounded-2xl border border-kidville-line shadow-sm px-4 py-3">
                <button
                    onClick={() => goDay(-1)}
                    className="w-9 h-9 rounded-xl bg-kidville-neutral-soft hover:bg-kidville-cream-dark flex items-center justify-center text-kidville-muted transition-colors"
                >
                    <ChevronLeft size={18} strokeWidth={1.5} />
                </button>

                <div className="text-center">
                    <p className="font-barlow font-black text-base text-kidville-green uppercase tracking-wide">
                        {formatDayLabel(dateKey)}
                    </p>
                    <p className="font-maven text-xs text-kidville-muted">
                        {new Date(dateKey + 'T12:00:00').toLocaleDateString('it-IT', {
                            day: 'numeric', month: 'long', year: 'numeric',
                        })}
                    </p>
                </div>

                <button
                    onClick={() => goDay(1)}
                    disabled={isToday}
                    className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${
                        isToday
                            ? 'bg-kidville-neutral-soft text-kidville-line cursor-not-allowed'
                            : 'bg-kidville-neutral-soft hover:bg-kidville-cream-dark text-kidville-muted'
                    }`}
                >
                    <ChevronRight size={18} strokeWidth={1.5} />
                </button>
            </div>

            {/* Contenuto del giorno con slide animation */}
            <AnimatePresence mode="wait" custom={direction}>
                <motion.div
                    key={dateKey}
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.25, ease: 'easeInOut' }}
                >
                    {/* Loading */}
                    {loading && (
                        <div className="flex flex-col items-center justify-center py-20 gap-3">
                            <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                            <p className="font-maven text-sm text-kidville-muted">Un attimo...</p>
                        </div>
                    )}

                    {/* Stato vuoto (nessuna voce e nessuna entrata registrata) */}
                    {!loading && entries.length === 0 && !checkIn && (
                        <div className="flex flex-col items-center justify-center py-20 text-center">
                            <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">
                                📖
                            </div>
                            <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-2">
                                Nessuna voce
                            </h2>
                            <p className="font-maven text-kidville-muted max-w-xs text-sm">
                                La maestra non ha ancora compilato il diario per questo giorno.
                            </p>
                        </div>
                    )}

                    {/* Timeline eventi (con "Entrata" in cima, letta dalle Presenze) */}
                    {!loading && (checkIn || entries.length > 0) && (
                        <div className="space-y-3">
                            {/* Banner umore (DR mood banner, M5.4): legge l'evento 'umore' più
                                recente del giorno (dettagli.umore); senza evento resta il testo
                                di attesa. */}
                            <div className="flex items-center gap-3 rounded-[20px] bg-kidville-yellow px-4 py-3.5">
                                <span className="text-[26px] leading-none">{umoreCfg?.emoji ?? '🙂'}</span>
                                <div className="min-w-0">
                                    <p className="font-barlow text-[15px] font-black uppercase leading-none tracking-wide text-kidville-green">
                                        Umore della giornata{umoreCfg ? `: ${umoreCfg.label}` : ''}
                                    </p>
                                    <p className="mt-1 font-maven text-[12px] text-kidville-green/75">
                                        {umore
                                            ? umoreNarrative(umore)
                                            : `Presto la maestra potrà segnalare come è andata${studentName ? ` per ${studentName.split(' ')[0]}` : ''}.`}
                                    </p>
                                </div>
                            </div>
                            {checkIn && (
                                <motion.div
                                    initial={{ opacity: 0, y: 14 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.3, ease: 'easeOut' }}
                                    className="bg-white rounded-3xl border-l-4 border-kidville-success/30 border border-kidville-line shadow-sm px-5 py-4"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-2xl flex items-center justify-center text-xl flex-shrink-0 bg-kidville-success-soft">
                                            🚪
                                        </div>
                                        <div className="flex-1">
                                            <p className="font-barlow font-black text-sm uppercase tracking-wide text-kidville-success">Entrata</p>
                                            <p className="font-maven text-[11px] text-kidville-muted">{checkIn}</p>
                                        </div>
                                        <span className="text-2xl">👋</span>
                                    </div>
                                    <p className="font-maven text-sm text-kidville-ink leading-relaxed pl-1 mt-2">
                                        Sono arrivato/a a scuola alle {checkIn}!
                                    </p>
                                </motion.div>
                            )}
                            {timelineEntries.map((entry, i) => (
                                <EventCard key={entry.id} entry={entry} index={i + (checkIn ? 1 : 0)} />
                            ))}
                            {/* Foto reali della giornata */}
                            <PhotosSection photos={photos} />
                        </div>
                    )}
                </motion.div>
            </AnimatePresence>

            {/* Footer */}
            <div className="mt-8 p-4 bg-white rounded-2xl border border-kidville-line text-center">
                <p className="font-maven text-xs text-kidville-muted">
                    📋 Le informazioni sono visibili per i 14 giorni precedenti.<br />
                    Per lo storico completo contatta la segreteria.
                </p>
            </div>
        </div>
    );
}

export default function ParentDiaryPage() {
    return (
        <Suspense fallback={
            <div className="px-4 pt-5 pb-24 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <ParentDiaryContent />
        </Suspense>
    );
}
