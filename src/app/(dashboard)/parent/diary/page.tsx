'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { intlDateTime } from '@/i18n/config';
import { useDateFormat } from '@/lib/i18n/date';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, Camera, ChevronDown, GraduationCap } from 'lucide-react';
import { configDiVoce, useEventLabel } from '@/components/features/teacher/diary/eventConfig';
import { eRoutinePersonalizzata, routineCompilata, oraRoutine } from '@/lib/diary/routine';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { OfflineBadge } from '@/components/ui/OfflineBadge';
import { fetchConCache } from '@/lib/offline/read-cache';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { useChildSchoolType } from '@/lib/auth/use-child-school-type';
import { UMORE_CONFIG, useUmoreLabel, umoreFromDettagli, umoreNarrative } from '@/lib/diary/umore';
import { voceDaMostrare } from '@/lib/diary/registrazione';
import { orarioAttivita, oraDiLatoAttivita } from '@/lib/diary/attivita';
import { MediaGrid, MediaItem } from '@/components/features/gallery/MediaGrid';
import { SegnalaContenuto } from '@/components/features/segnalazioni/SegnalaContenuto';
import { oraDiRoma } from '@/lib/presenze/orario';
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile';
import { ascoltaNotificaAperta } from '@/lib/notifiche/pagina-aperta-da-notifica';
import { segnalaDiarioNonLetto } from '@/lib/diary/lettura-genitore';

/**
 * Dopo un ritorno nell'app andato a vuoto (rete non ancora pronta, o solo la copia salvata) si
 * riprova una volta dopo questo tempo. Misurato il 2026-09-28: in 14 giorni la lettura del diario
 * è fallita a stato 0 967 volte, per ~220 utenti.
 */
const RITENTA_DOPO_MS = 4_000;

// Tipo del traduttore next-intl: serve per passare `t` alle funzioni helper
// (narrativa, etichetta del giorno) definite fuori dal componente, dove gli
// hook non si possono chiamare.
type Traduci = ReturnType<typeof useTranslations>;

// ─── Tipi ─────────────────────────────────────────────────────────────────────

interface DiaryEntry {
    id: string;
    tipo_evento: string;
    timestamp_evento: string;
    dettagli: Record<string, unknown> | null;
    // Nota di SEZIONE: la stessa per tutti i genitori (broadcast).
    note: string | null;
    // Nota per SINGOLO bambino (E1): riservata a questo genitore.
    notaBambino?: string | null;
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

// Orario leggibile per l'entrata: un ISO (timestamp dell'appello) diventa 'HH:MM'
// in ora locale; ciò che ISO non è (es. già 'HH:MM') passa invariato.
/**
 * L'ora d'ingresso mostrata al genitore nel diario.
 *
 * Il fuso lo dichiarava già (`intlDateTime`), quindi sull'ISO diceva il vero — ma
 * era la SESTA copia della stessa lettura, e sulle altre due forme in colonna
 * (`08:45` e l'ISO naïve della primaria) cadeva sul ramo `: raw`, cioè restituiva
 * la stringa grezza sperando che somigliasse a un'ora. Ora passa dal motore, che
 * le conosce tutte e tre. Il `locale` non serve più: l'ora di una scuola italiana
 * si scrive `HH:MM` in tutte e due le lingue dell'app.
 */
function formatOrarioEntrata(raw: string | null | undefined): string | null {
    return oraDiRoma(raw);
}

/**
 * Gli stati dell'appello in cui il bambino È arrivato a scuola (contratto A1 di
 * `GET /api/diary/checkin`): la card «Entrata» compare anche senza orario.
 */
const STATI_ARRIVATO: ReadonlySet<unknown> = new Set(['presente', 'ritardo', 'uscita_anticipata']);

/**
 * D3 (2026-09-26): l'orario PROPRIO di un'attività, come lo legge il genitore —
 * «dalle 10:00 alle 11:00», «dalle 10:00» (solo inizio), «fino alle 11:00» (solo
 * fine), stringa vuota se non c'è. La normalizzazione è quella del contratto D1
 * (`orarioAttivita`): un valore vuoto o fuori formato non viene «aggiustato», sparisce.
 */
function fraseOrarioAttivita(voce: unknown, t: Traduci): string {
    const { inizio, fine } = orarioAttivita(voce);
    if (inizio && fine) return t('attivitaOrarioDalleAlle', { inizio, fine });
    if (inizio) return t('attivitaOrarioDalle', { inizio });
    if (fine) return t('attivitaOrarioFinoAlle', { fine });
    return '';
}

// `locale` non serve più: l'unica cosa che lo usava era la formattazione dell'ora
// d'ingresso, che ora passa dal motore condiviso e rende `HH:MM` in entrambe le lingue.
function buildFirstPersonNarrative(tipo: string, dettagli: Record<string, unknown> | null, t: Traduci): { lines: string[], emoji: string } {
    if (tipo === 'entrata') {
        const orario = formatOrarioEntrata((dettagli?.orario as string) ?? '') ?? '';
        return {
            emoji: '👋',
            lines: orario
                ? [t('narrativaEntrataAlle', { orario })]
                : [t('narrativaEntrataMattina')],
        };
    }

    if (tipo === 'attivita') {
        const ACTIVITY_EMOJIS: Record<string, string> = {
            pittura: '🎨', musica: '🎵', lettura: '📚', motoria: '🏃',
            gioco: '🧩', natura: '🌿', cucina: '🍪', teatro: '🎭', altro: '✨',
        };

        const rawActivities = dettagli?.activities as Array<{
            tipo: string; descrizione: string; partecipazione?: string | null;
            ora_inizio?: string | null; ora_fine?: string | null;
        }> | undefined;

        if (rawActivities && rawActivities.length > 0) {
            const lines = rawActivities.map(a => {
                const emoji = ACTIVITY_EMOJIS[a.tipo] ?? '✨';
                // Etichetta e frase di partecipazione da i18n, con fallback ai dati
                // grezzi (attività ignota → il tipo così com'è; partecipazione
                // ignota → nessuna frase), come prima delle chiavi.
                const label = t.has(`attivita_${a.tipo}`) ? t(`attivita_${a.tipo}`) : a.tipo;
                const partPhrase = a.partecipazione && t.has(`partecipazione_${a.partecipazione}`)
                    ? t(`partecipazione_${a.partecipazione}`)
                    : '';
                const descPart = a.descrizione ? `: ${a.descrizione}` : '';
                const orario = fraseOrarioAttivita(a, t);
                return `${emoji} ${t('attivitaHoFatto', { label })}${orario ? ' ' + orario : ''}${descPart}${partPhrase ? ' ' + partPhrase : ''}`;
            });
            const firstEmoji = ACTIVITY_EMOJIS[rawActivities[0].tipo] ?? '🎨';
            return { emoji: rawActivities.length > 1 ? '🎭' : firstEmoji, lines };
        }

        // Fallback testo generico
        return { emoji: '🎨', lines: [t('attivitaGenerica')] };
    }

    if (tipo === 'pranzo' || tipo === 'merenda') {
        const corsi = dettagli?.corsi as Record<string, string | null> | undefined;
        const lines: string[] = [];

        if (corsi) {
            Object.entries(corsi).forEach(([k, v]) => {
                if (!v) return;
                // Nome portata e narrativa della quantità da i18n, con fallback ai
                // dati grezzi (portata/quantità ignota) come prima delle chiavi.
                const name = t.has(`pasto_${k}`) ? t(`pasto_${k}`) : k;
                const icon = MEAL_ICONS[k] ?? '🍽️';
                const narrative = t.has(`quantita_${v}`) ? t(`quantita_${v}`) : t('quantitaGenerica', { quantita: v });
                lines.push(`${icon} ${name.charAt(0).toUpperCase() + name.slice(1)}: ${narrative}`);
            });
        }

        if (lines.length === 0) {
            return { emoji: tipo === 'merenda' ? '🍎' : '🍽️', lines: [t('pastoGenerico')] };
        }

        return { emoji: tipo === 'merenda' ? '🍎' : '🍽️', lines };
    }

    if (tipo === 'nanna' || tipo === 'nanna_inizio') {
        const ini = dettagli?.orario_inizio as string | undefined;
        const fin = dettagli?.orario_fine   as string | undefined;
        const lines: string[] = [];
        // ⚠️ `nannaGenerica` («Ho fatto un bel sonnellino!») è la RETE, non la strada.
        // È la frase che per mesi ha raccontato un sonnellino mai avvenuto, perché il
        // diario salvava una riga di nanna anche con l'ora vuota. Da quando la
        // timeline filtra le nanne non compilate (`timelineEntries`), questo ramo è
        // irraggiungibile: resta perché una voce con l'ora persa per altra via non
        // deve comparire muta, non perché serva ancora.
        if (ini && fin) lines.push(t('nannaDurata', { inizio: ini, fine: fin }));
        else if (ini)   lines.push(t('nannaInizio', { inizio: ini }));
        else            lines.push(t('nannaGenerica'));
        return { emoji: '😴', lines };
    }

    if (tipo === 'nanna_fine') {
        const fin = dettagli?.orario_fine as string | undefined;
        return {
            emoji: '☀️',
            lines: fin ? [t('nannaFine', { fine: fin })] : [t('nannaFineGenerica')],
        };
    }

    if (tipo === 'bagno') {
        const pipi   = Number(dettagli?.pipi   ?? 0);
        const cacca  = Number(dettagli?.cacca  ?? 0);
        const vasino = Number(dettagli?.vasino ?? 0);
        const lines: string[] = [];
        if (pipi   > 0) lines.push(t('bagnoPipi',   { count: pipi }));
        if (cacca  > 0) lines.push(t('bagnoCacca',  { count: cacca }));
        if (vasino > 0) lines.push(t('bagnoVasino', { count: vasino }));
        if (lines.length === 0) lines.push(t('bagnoGenerico'));
        return { emoji: '🚿', lines };
    }

    // Le routine aggiunte dalla scuola (2026-09-28): il NOME sta nel titolo della card, qui va il
    // valore. Nome e icona vengono dalla fotografia salvata nella voce, non dalla configurazione
    // di oggi: la voce resta leggibile anche a routine rinominata, spenta o cancellata.
    if (eRoutinePersonalizzata(tipo)) {
        const emoji = typeof dettagli?.emoji === 'string' && dettagli.emoji.trim() ? dettagli.emoji.trim() : '📝';
        const frase = fraseRoutine(dettagli, t);
        return { emoji, lines: frase ? [frase] : [] };
    }

    return { emoji: '📝', lines: [t('eventoGenerico')] };
}

/**
 * Il valore di una routine della scuola, detto al genitore, o `null` se la maestra non l'ha segnato.
 * Le opzioni e il testo sono dati: non si traducono.
 *
 * ⚠️ `null` e non una frase (seconda revisione, 2026-09-28). Una voce può esistere SENZA valore,
 * tenuta in piedi da una nota — di sezione, che va a tutti, o del bambino. Prima la spunta diceva
 * «Fatto ✓» senza guardare il valore: la maestra spuntava la crema a 3 bambini su 20, scriveva
 * «domani portate la crema», e 17 genitori leggevano «Fatto ✓». Con una routine «Farmaco» sarebbe
 * stato pericoloso. Gli altri tipi cadevano su «Evento registrato dalla maestra.»: ora la card
 * mostra la nota e basta.
 */
function fraseRoutine(dettagli: Record<string, unknown> | null, t: Traduci): string | null {
    if (!routineCompilata(dettagli)) return null;
    const valore = dettagli?.valore;
    switch (dettagli?.risposta) {
        case 'spunta':
            return t('routineFatto');
        case 'orario':
            return t('routineAlle', { ora: valore as string });
        case 'scelta':
            return (valore as unknown[]).filter((v) => typeof v === 'string' && v.trim()).join(', ');
        case 'testo':
            return (valore as string).trim();
        default:
            return null;
    }
}

// ─── Utilities data ────────────────────────────────────────────────────────────

function toDateKey(d: Date): string {
    return d.toISOString().split('T')[0];
}

function formatDayLabel(dateKey: string, t: Traduci, locale: string): string {
    const d = new Date(dateKey + 'T12:00:00');
    const today = toDateKey(new Date());
    const yesterday = toDateKey(new Date(Date.now() - 86400000));
    if (dateKey === today)     return t('giornoOggi');
    if (dateKey === yesterday) return t('giornoIeri');
    return intlDateTime(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

function formatTime(iso: string, locale: string): string {
    return intlDateTime(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/**
 * Una voce per tipo (l'ultima SALVATA) e l'ordine canonico della giornata.
 *
 * D3 (2026-09-26), l'ora di lato dell'attività ora può essere l'inizio della prima
 * attività invece del salvataggio. Qui volutamente non cambia niente:
 * - l'ordine della timeline non è mai stato cronologico ma per TIPO (`EVENT_ORDER`:
 *   entrata, merenda, attività, pranzo, nanna, bagno), quindi non dipende dall'ora
 *   mostrata né prima né adesso: riordinare per ora sarebbe un cambio di
 *   comportamento che il titolare non ha chiesto;
 * - la deduplica DEVE restare sull'ora del salvataggio: la correzione di una
 *   maestra (salvata dopo, magari con l'attività spostata prima) deve vincere sulla
 *   registrazione vecchia. Usare l'ora mostrata farebbe perdere la correzione.
 */
function deduplicateAndSort(entries: DiaryEntry[]): DiaryEntry[] {
    const latest = new Map<string, DiaryEntry>();
    entries.forEach(e => {
        const prev = latest.get(e.tipo_evento);
        if (!prev || e.timestamp_evento > prev.timestamp_evento) latest.set(e.tipo_evento, e);
    });
    // A parità d'ordine (le routine della scuola, che in `EVENT_ORDER` non ci sono) si va dalla
    // più presto alla più tardi: prima restavano nell'ordine della GET, cioè dalla più recente.
    return Array.from(latest.values()).sort((a, b) =>
        (EVENT_ORDER[a.tipo_evento] ?? 99) - (EVENT_ORDER[b.tipo_evento] ?? 99)
        || (a.timestamp_evento < b.timestamp_evento ? -1 : a.timestamp_evento > b.timestamp_evento ? 1 : 0)
    );
}

// ─── Componenti ───────────────────────────────────────────────────────────────

export function EventCard({ entry, index }: { entry: DiaryEntry; index: number }) {
    const t = useTranslations('diario');
    const f = useDateFormat();
    const eventLabel = useEventLabel();
    // Per una routine della scuola nome e icona vengono dalla fotografia nella voce (`dettagli`).
    const config = configDiVoce(entry.tipo_evento, entry.dettagli);
    const { lines, emoji } = buildFirstPersonNarrative(
        entry.tipo_evento,
        entry.dettagli,
        t,
    );
    const borderColor = config.accentColor.split(' ').find(c => c.startsWith('border-')) ?? 'border-kidville-line';
    // D3 (2026-09-26): a lato della voce «attività» va l'ora di inizio della PRIMA
    // attività (contratto D1, `oraDiLatoAttivita`); se non c'è, l'ora del
    // salvataggio come per tutte le altre voci.
    // Per una routine della scuola a orario, l'ora di lato è quella SEGNATA (2026-09-28): prima era
    // quella del primo salvataggio — «Latte 15:47» per un biberon delle 10:30.
    const oraDiLato = (entry.tipo_evento === 'attivita' ? oraDiLatoAttivita(entry.dettagli, entry.timestamp_evento) : null)
        ?? (eRoutinePersonalizzata(entry.tipo_evento) ? oraRoutine(entry.dettagli) : null)
        ?? formatTime(entry.timestamp_evento, f.locale);

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
                <div className="flex-1 min-w-0">
                    <p className={`font-barlow font-black text-sm uppercase tracking-wide break-words ${config.accentColor.split(' ').find(c => c.startsWith('text-')) ?? 'text-kidville-green'}`}>
                        {eventLabel(entry.tipo_evento, entry.dettagli)}
                    </p>
                    <p className="font-maven text-[11px] text-kidville-muted">
                        {oraDiLato}
                    </p>
                </div>
                <span className="text-2xl">{emoji}</span>
            </div>

            {/* Narrazione prima persona */}
            <div className="space-y-1.5 pl-1">
                {lines.map((line, i) => (
                    <p key={i} className="font-maven text-sm text-kidville-ink leading-relaxed break-words">
                        {line}
                    </p>
                ))}
                {entry.note && (
                    <p className={`font-maven text-sm text-kidville-muted italic break-words ${lines.length > 0 ? 'mt-2 pt-2 border-t border-kidville-line/60' : ''}`}>
                        💬 &ldquo;{entry.note}&rdquo;
                    </p>
                )}
                {/* Nota per il singolo bambino (E1): riservata a questo genitore, distinta
                    dalla nota di sezione qui sopra. */}
                {entry.notaBambino && (
                    <div className="mt-2 rounded-xl bg-kidville-cream px-3 py-2">
                        <p className="font-barlow font-bold uppercase text-[10px] tracking-wide text-kidville-green">
                            {t('notaPerTe')}
                        </p>
                        <p className="font-maven text-sm text-kidville-ink leading-relaxed mt-0.5 break-words">
                            💬 &ldquo;{entry.notaBambino}&rdquo;
                        </p>
                    </div>
                )}
            </div>

            {/* Segnalazione voce di diario (C5 §2): etichetta testuale sempre visibile. */}
            <div className="mt-3 flex justify-end border-t border-kidville-line/50 pt-2">
                <SegnalaContenuto
                    tipoOggetto="voce_diario"
                    oggettoId={entry.id}
                    label={t('segnalaVoce')}
                    ariaLabel={t('segnalaVoceAria')}
                    variant="inline"
                />
            </div>
        </motion.div>
    );
}

function PhotosSection({ photos }: { photos: MediaItem[] }) {
    const t = useTranslations('diario');
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
                    <div className="w-10 h-10 rounded-2xl bg-kidville-yellow-soft border border-kidville-line flex items-center justify-center">
                        <Camera size={18} className="text-kidville-yellow-strong" strokeWidth={1.5} />
                    </div>
                    <div>
                        <p className="font-barlow font-black text-sm uppercase tracking-wide text-kidville-yellow-strong">
                            {t('fotoTitolo')}
                        </p>
                        <p className="font-maven text-[11px] text-kidville-muted">
                            {t('fotoScattate', { count: photos.length })}
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
                        <div className="px-4 pb-4 pt-0 border-t border-kidville-line/60 bg-kidville-cream-dark rounded-b-3xl">
                            {/* Due colonne dichiarate: qui la griglia vive dentro una scheda del
                                diario, ancora più stretta della galleria. */}
                            <MediaGrid items={photos} showActions colonne={2} />
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
    const t = useTranslations('diario');
    const f = useDateFormat();
    const umoreLabel = useUmoreLabel();
    const { parentId, studentId: alunnoId, ready } = useParentIdentity();
    // Guardia grado: il diario giornaliero esiste solo per nido/infanzia.
    const { schoolType, ready: schoolTypeReady } = useChildSchoolType();

    const [dateKey, setDateKey] = useState<string>(toDateKey(new Date()));
    const [entries, setEntries] = useState<DiaryEntry[]>([]);
    // true quando il diario del giorno viene dalla cache offline (rete assente).
    const [offline, setOffline] = useState(false);
    const [photos, setPhotos] = useState<MediaItem[]>([]);
    // Il giorno di cui abbiamo completato il caricamento: lo spinner è derivato
    // (loading = giorno richiesto ≠ giorno caricato), niente setState sincroni.
    const [loadedKey, setLoadedKey] = useState<string | null>(null);
    const loading = loadedKey !== dateKey;
    const [direction, setDirection] = useState<1 | -1>(1);
    const [studentName, setStudentName] = useState<string | null>(null);
    const [classe, setClasse] = useState<string | null>(null);
    // "Entrata" letta dal modulo Presenze (read-only, DL-040).
    // A1 (2026-09-26): l'ARRIVO e l'ORARIO sono due cose distinte. `arrivato` accende la
    // card «Entrata» (presente, ritardo, uscita anticipata); `checkIn` è l'ora, che la
    // route manda SOLO sul ritardo — ai presenti il genitore non vede l'ora del tocco.
    const [checkIn, setCheckIn] = useState<string | null>(null);
    const [arrivato, setArrivato] = useState(false);
    // Le voci del giorno NON si sono lette (rete giù o errore, e nessuna copia salvata). È un
    // avviso a sé: fino al 2026-09-28 diventava «La maestra non ha ancora compilato il diario».
    const [erroreLettura, setErroreLettura] = useState(false);

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

    // ─── Il caricamento del giorno ────────────────────────────────────────────
    //
    // Dal 2026-09-28 la pagina si ricarica anche al ritorno nell'app, al tocco su una notifica
    // e con «Riprova». Tre regole tengono lo schermo vero:
    //  · scrive solo l'ULTIMO caricamento partito (`ultimoCaricamento`): una ricarica lenta di
    //    «oggi» arrivata dopo il tocco su «ieri» non finisce sotto l'etichetta di ieri;
    //  · una ricarica mentre lo STESSO giorno sta già arrivando non ne fa partire un'altra:
    //    aspetta quella (`inVolo`). Prima la scavalcava e, se falliva, lasciava a schermo il
    //    giorno di prima sotto l'etichetta nuova (rilievo del critico, riprodotto);
    //  · una ricarica che fallisce lascia com'è ciò che è a schermo. È sicuro per la regola di
    //    sopra: ogni cambio di giorno o di bambino fa partire un caricamento normale, quindi
    //    una ricarica che NON trova niente in volo ha a schermo proprio il suo giorno.
    // Letture prima, scritture tutte insieme alla fine: lo schermo cambia una volta sola.
    const ultimoCaricamento = useRef(0);
    const inVolo = useRef<{ chiave: string; numero: number; esito: Promise<boolean> } | null>(null);

    /**
     * Carica il giorno `dk`. Risponde `true` se le voci sono arrivate fresche dalla rete, `false`
     * se non si sono lette o è arrivata solo la copia salvata: è il segnale con cui il ritorno
     * nell'app decide se riprovare.
     */
    const load = useCallback((dk: string, { ricarica = false }: { ricarica?: boolean } = {}): Promise<boolean> => {
        if (!ready || !alunnoId) return Promise.resolve(true); // identità non risolta: lo spinner resta
        const chiave = `${alunnoId}:${dk}`;
        if (ricarica && inVolo.current?.chiave === chiave) return inVolo.current.esito;
        const numero = ++ultimoCaricamento.current;
        const superato = () => numero !== ultimoCaricamento.current;

        const esito = (async (): Promise<boolean> => {
            try {
                // Voci del diario, con la copia offline: se la rete non risponde, `fetchConCache`
                // serve l'ultima copia salvata (`offline: true`); se non c'è nemmeno quella lancia.
                let voci: DiaryEntry[] | null = null;
                let daCopia = false;
                try {
                    const r = await fetchConCache<DiaryEntry[]>(
                        `diario:${alunnoId}:${dk}:${dk}`,
                        `/api/diary/entries?alunno_id=${alunnoId}&from=${dk}&to=${dk}`,
                    );
                    voci = r.data;
                    daCopia = r.offline;
                } catch {
                    // Rete giù e nessuna copia: `voci` resta null, e qui sotto diventa l'avviso
                    // d'errore (o lo schermo tenuto com'è) più la riga di `segnalaDiarioNonLetto`.
                    // Il guasto di rete in sé lo registra già la fetch strumentata.
                }
                if (superato()) return true;

                // "Entrata" dal modulo Presenze (orario di check-in del giorno)
                const ciRes = await fetch(`/api/diary/checkin?alunno_id=${alunnoId}&date=${dk}`).catch(() => null);
                const ci = ciRes?.ok ? await ciRes.json().catch(() => null) : null;
                if (superato()) return true;

                // Carica foto reali associate a questo alunno per il giorno selezionato
                // (GET gated: identità anche via header, oltre alla sessione)
                let photosUrl = `/api/gallery?studentId=${alunnoId}&date=${dk}`;
                if (parentId) photosUrl += `&parentId=${parentId}`;
                const photosRes = await fetch(photosUrl, parentId ? { headers: { 'x-user-id': parentId } } : undefined).catch(() => null);
                const photosData = photosRes?.ok ? await photosRes.json().catch(() => null) : null;
                if (superato()) return true;

                if (voci === null) segnalaDiarioNonLetto('pagina', ricarica ? 'ricarica' : 'apertura');
                if (voci !== null || !ricarica) {
                    setEntries(voci ? deduplicateAndSort(voci) : []);
                    setOffline(daCopia);
                    setErroreLettura(voci === null);
                }
                if (ci !== null || !ricarica) {
                    const orarioRisposta = formatOrarioEntrata(ci?.orario_entrata);
                    // D3: l'ora d'ingresso si mostra SOLO sul ritardo (è l'ora del docente).
                    // La route la manda già solo lì, ma la pagina non si regge sul server.
                    // Si distingue il campo MANCANTE dal campo NULLO:
                    //  - proprietà `stato` assente = risposta di un server precedente al
                    //    2026-09-26, che mandava solo l'orario: l'orario vale come arrivo e
                    //    si mostra, come prima;
                    //  - `stato` presente (anche `null`, appello non fatto) = server nuovo:
                    //    l'arrivo lo decide lo stato e l'ora si mostra solo sul ritardo. Un
                    //    orario rimasto su un presente, un assente o uno stato nullo (route
                    //    regredita, riga passata da presente ad assente) non si vede.
                    const serverPrecedente = !(ci && typeof ci === 'object' && 'stato' in ci);
                    const statoRisposta: unknown = serverPrecedente ? undefined : ci.stato;
                    const arrivatoRisposta = serverPrecedente
                        ? Boolean(orarioRisposta)
                        : STATI_ARRIVATO.has(statoRisposta);
                    const mostraOrario = serverPrecedente || statoRisposta === 'ritardo';
                    setCheckIn(mostraOrario ? orarioRisposta : null);
                    setArrivato(arrivatoRisposta);
                }
                if (photosData !== null || !ricarica) setPhotos(photosData?.media ?? []);
                return voci !== null && !daCopia;
            } finally {
                if (!superato()) setLoadedKey(dk);
                if (inVolo.current?.numero === numero) inVolo.current = null;
            }
        })();
        inVolo.current = { chiave, numero, esito };
        return esito;
    }, [ready, alunnoId, parentId]);

    useEffect(() => { void load(dateKey); }, [dateKey, load]);

    // Il giorno che era «oggi» all'ultimo sguardo. Con l'app rimasta aperta la notte, al ritorno
    // la pagina che mostrava oggi passa al nuovo oggi, invece di rileggere ieri.
    const oggiVisto = useRef(dateKey);

    // Al ritorno nell'app si ricarica il giorno mostrato. `null` = nessun orologio: le voci
    // cambiano poche volte al giorno, e il momento in cui quelle vecchie mentono è la
    // riapertura (2026-09-28: chi apriva il diario al mattino e tornava nel pomeriggio
    // leggeva ancora «La maestra non ha ancora compilato», con le voci già scritte). Se non
    // arriva niente di fresco si riprova una volta, dopo `RITENTA_DOPO_MS`.
    usePollingVisibile(() => {
        const oggi = toDateKey(new Date());
        if (oggi !== oggiVisto.current) {
            const mostravaOggi = dateKey === oggiVisto.current;
            oggiVisto.current = oggi;
            if (mostravaOggi) {
                setDirection(1);
                setDateKey(oggi);
                return true;
            }
        }
        return load(dateKey, { ricarica: true });
    }, null, { ritentaDopoMs: RITENTA_DOPO_MS });

    // Il tocco su una notifica che porta al diario, con il diario già aperto (2026-09-28): la
    // navigazione non rimonta la pagina, quindi è l'avviso a riportarla a oggi e a rileggere.
    // Se la notifica è di un altro figlio, a cambiarlo ci pensa la navigazione (`?id=`).
    useEffect(() => ascoltaNotificaAperta('/parent/diary', () => {
        const oggi = toDateKey(new Date());
        oggiVisto.current = oggi;
        if (dateKey !== oggi) {
            setDirection(1);
            setDateKey(oggi);
        } else {
            void load(oggi, { ricarica: true });
        }
    }), [dateKey, load]);

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
    const voceUmore = entries.find(e => e.tipo_evento === 'umore');
    const umore = umoreFromDettagli(voceUmore?.dettagli);
    const umoreCfg = umore ? UMORE_CONFIG[umore] : null;
    // Le note scritte nel riquadro dell'umore (2026-09-28): la timeline esclude l'umore, e il
    // riquadro non le mostrava — la nota non arrivava mai al genitore.
    const notaUmore = voceUmore?.note?.trim() || null;
    const notaUmoreBambino = voceUmore?.notaBambino?.trim() || null;
    const riquadroUmore = Boolean(umoreCfg) || Boolean(notaUmore || notaUmoreBambino);
    // Fuori dalla timeline: l'umore (vive nel banner, non fra le voci) e le nanne
    // NON COMPILATE.
    //
    // Queste ultime sono il difetto che il titolare ha segnalato, visto dal lato di
    // chi lo subiva: il diario salvava una riga di nanna per OGNI bambino presente,
    // anche con l'ora vuota, e qui sotto il ramo generico della narrativa la
    // raccontava come «Ho fatto un bel sonnellino! 😴». Il genitore di un bambino
    // che non aveva dormito leggeva una frase falsa, ogni pomeriggio.
    //
    // Il filtro sta DOPO `deduplicateAndSort` di proposito: quella funzione tiene
    // l'ULTIMA voce per tipo, quindi filtrare prima farebbe riemergere una voce
    // vecchia al posto di quella corrente — mostrerebbe un sonnellino di ieri invece
    // di niente. Filtrare dopo mostra il vero: la voce non c'è.
    //
    // Vale anche per le righe già in archivio: nessuna migrazione, nessuna
    // cancellazione retroattiva sul diario di un bambino.
    // `umore` resta escluso a parte: non è una voce di timeline, ha una fascia sua.
    // Tutto il resto passa da `voceDaMostrare`, che dal 2026-09-08 copre anche il
    // bagno e i pasti: 323 righe di bagno su 514 erano completamente vuote e
    // raccontavano «🚿 Sono stato/a al bagno oggi!» a chi in bagno non c'era andato.
    const timelineEntries = entries.filter(e =>
        e.tipo_evento !== 'umore' && voceDaMostrare(e.tipo_evento, e.dettagli, { conNota: Boolean(e.notaBambino || e.note) }),
    );
    // NIENTE DA MOSTRARE — lo si decide su ciò che si mostrerebbe davvero, non sulle voci arrivate
    // (2026-09-28). Voci tutte filtrate (nanne vuote, righe mute) e nessun ingresso lasciavano la
    // pagina con intestazione e piè di pagina e basta: nemmeno «Nessuna voce».
    const nienteDaMostrare = timelineEntries.length === 0 && !riquadroUmore && !arrivato && photos.length === 0;

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
                    <h2 className="font-barlow text-xl font-bold text-kidville-ink">{t('primariaTitolo')}</h2>
                    <p className="font-maven text-sm text-kidville-muted mt-1 mb-4">{t('primariaTesto')}</p>
                    <Link href="/parent/primaria" className="font-maven inline-block rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow">{t('primariaLink')}</Link>
                </div>
            </div>
        );
    }

    return (
        <div className="px-4 pt-5 pb-24">

            {/* Header verde (DR): titolo + chip nome bambino */}
            <PageHeaderCard
                eyebrow={t('headerEyebrow')}
                title={t('headerTitle')}
                subtitle={t('headerSubtitle')}
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

            {/* Indicatore offline: il diario del giorno viene dalla cache */}
            {offline && !loading && (
                <div className="mb-4 flex justify-center">
                    <OfflineBadge />
                </div>
            )}

            {/* Navigazione giorno */}
            <div className="flex items-center justify-between mb-5 bg-white rounded-2xl border border-kidville-line shadow-sm px-4 py-3">
                <button
                    onClick={() => goDay(-1)}
                    aria-label={t('giornoPrecedente')}
                    className="w-9 h-9 rounded-xl bg-kidville-neutral-soft hover:bg-kidville-cream-dark flex items-center justify-center text-kidville-muted transition-colors"
                >
                    <ChevronLeft size={18} strokeWidth={1.5} />
                </button>

                <div className="text-center">
                    <p className="font-barlow font-black text-base text-kidville-green uppercase tracking-wide">
                        {formatDayLabel(dateKey, t, f.locale)}
                    </p>
                    <p className="font-maven text-xs text-kidville-muted">
                        {intlDateTime(f.locale, {
                            day: 'numeric', month: 'long', year: 'numeric',
                        }).format(new Date(dateKey + 'T12:00:00'))}
                    </p>
                </div>

                <button
                    onClick={() => goDay(1)}
                    aria-label={t('giornoSuccessivo')}
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
                            <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>
                        </div>
                    )}

                    {/* Il diario NON si è letto: lo si dice, con «Riprova». Fino al 2026-09-28
                        qui finiva nello stato vuoto, cioè «La maestra non ha ancora compilato». */}
                    {!loading && erroreLettura && (
                        <div className="flex flex-col items-center justify-center py-20 text-center">
                            <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">
                                📖
                            </div>
                            <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-2">
                                {t('erroreTitolo')}
                            </h2>
                            <p className="font-maven text-kidville-sub max-w-xs text-sm">
                                {t('erroreTesto')}
                            </p>
                            <button
                                type="button"
                                onClick={() => { void load(dateKey, { ricarica: true }); }}
                                className="mt-4 font-maven rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow"
                            >
                                {t('riprova')}
                            </button>
                        </div>
                    )}

                    {/* Stato vuoto (niente da mostrare: vedi `nienteDaMostrare`) */}
                    {!loading && !erroreLettura && nienteDaMostrare && (
                        <div className="flex flex-col items-center justify-center py-20 text-center">
                            <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">
                                📖
                            </div>
                            <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-2">
                                {t('vuotoTitolo')}
                            </h2>
                            <p className="font-maven text-kidville-muted max-w-xs text-sm">
                                {t('vuotoTesto')}
                            </p>
                        </div>
                    )}

                    {/* Timeline eventi (con "Entrata" in cima, letta dalle Presenze) */}
                    {!loading && !erroreLettura && !nienteDaMostrare && (
                        <div className="space-y-3">
                            {/* Banner umore (DR mood banner, M5.4): legge l'evento 'umore' più
                                recente del giorno (dettagli.umore). SOLO se c'è (2026-09-28): senza
                                voce diceva «Presto la maestra potrà segnalare come è andata», ma
                                nelle tre sedi vere l'umore è SPENTO — una promessa che la sede non
                                manteneva, a ogni genitore, ogni giorno. */}
                            {riquadroUmore && (
                                <div className="flex items-start gap-3 rounded-[20px] bg-kidville-yellow px-4 py-3.5">
                                    <span className="text-[26px] leading-none">{umoreCfg?.emoji ?? '🌈'}</span>
                                    <div className="min-w-0">
                                        <p className="font-barlow text-[15px] font-black uppercase leading-none tracking-wide text-kidville-green">
                                            {umore ? `${t('umoreTitolo')}: ${umoreLabel(umore)}` : t('umoreTitolo')}
                                        </p>
                                        {umore && (
                                            <p className="mt-1 font-maven text-[12px] text-kidville-green/75">
                                                {umoreNarrative(umore)}
                                            </p>
                                        )}
                                        {notaUmore && (
                                            <p className="mt-1.5 font-maven text-[13px] italic text-kidville-green break-words">
                                                💬 &ldquo;{notaUmore}&rdquo;
                                            </p>
                                        )}
                                        {notaUmoreBambino && (
                                            <p className="mt-1.5 font-maven text-[13px] text-kidville-green break-words">
                                                <span className="font-barlow font-bold uppercase text-[10px] tracking-wide">{t('notaPerTe')}</span>{' '}
                                                💬 &ldquo;{notaUmoreBambino}&rdquo;
                                            </p>
                                        )}
                                    </div>
                                </div>
                            )}
                            {arrivato && (
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
                                            <p className="font-barlow font-black text-sm uppercase tracking-wide text-kidville-success">{t('entrataLabel')}</p>
                                            {checkIn && (
                                                <p className="font-maven text-[11px] text-kidville-muted">{checkIn}</p>
                                            )}
                                        </div>
                                        <span className="text-2xl">👋</span>
                                    </div>
                                    <p className="font-maven text-sm text-kidville-ink leading-relaxed pl-1 mt-2">
                                        {checkIn
                                            ? t('narrativaEntrataAlle', { orario: checkIn })
                                            : t('narrativaEntrataSenzaOrario')}
                                    </p>
                                </motion.div>
                            )}
                            {timelineEntries.map((entry, i) => (
                                <EventCard key={entry.id} entry={entry} index={i + (arrivato ? 1 : 0)} />
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
                    {t('footerVisibilita')}<br />
                    {t('footerStorico')}
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
