'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Plus, Minus, Moon, Sun, Trash2 } from 'lucide-react';
import { DiaryEventType } from '@/lib/offline/db';
import { EventTypeButton } from '@/components/features/teacher/diary/EventTypeButton';
import { EVENT_CONFIG, BATHROOM_TYPES, useEventLabel } from '@/components/features/teacher/diary/eventConfig';
import { MealDetailInline } from '@/components/features/teacher/diary/MealDetailInline';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { ActivityDetailInline, ActivityItem } from '@/components/features/teacher/diary/ActivityDetailInline';
import { UMORE_VALUES, UMORE_CONFIG, useUmoreLabel, umoreFromDettagli, umoreAttivo } from '@/lib/diary/umore';
import { eEventoNanna, nannaCompilata } from '@/lib/diary/nanna';
import { fetchDiarioConfig } from '@/lib/diary/config-cache';
import { parametroClasse } from '@/lib/sezioni/parametro-classe';
import { etichetteAllergie, isNegazione, useAllergeneLabel } from '@/lib/mensa/allergeni';

// =============================================================================
// Compilazione del diario 0-6 per una sezione: stato + handler (useDiaryDay) e
// UI di compilazione (DiaryEventEditor), condivisi tra la pagina mobile del
// docente (/teacher/diary) e il cockpit segreteria (/admin/diary).
// =============================================================================

/**
 * Un bambino nella schermata del diario, con le DUE cose che l'insegnante deve
 * poter leggere mentre segna il pranzo, tenute separate perché sono separate in
 * archivio e vogliono dire cose diverse:
 *  · `allergie` — `alunni.allergeni` + `alunni.allergies`, composti dal motore;
 *  · `notaMedica` — `alunni.note_mediche`, la casella che il modulo d'iscrizione
 *    etichetta «Note Mediche (BES, DSA, patologie)»: epilessia, terapia
 *    salvavita, intolleranze non alimentari.
 *
 * ⚠️ IL SECONDO CAMPO NON È UN DI PIÙ, È IL RIPRISTINO DI UNA PERDITA. Prima del
 * 2026-09-07 la nota veniva spezzata sulle virgole e mostrata SOTTO la parola
 * «Allergie»: sbagliato. La prima correzione l'ha tolta e basta, e così l'alert
 * del pranzo ha perso 29 bambini su 657 (misurato in produzione il 2026-09-07:
 * 44 note mediche, 29 delle quali su bambini con `allergies` vuota o negata).
 * Togliere un'etichetta sbagliata non è la stessa cosa che togliere il dato.
 */
export interface DiaryStudent { id: string; firstName: string; lastName: string; allergie: string[]; notaMedica: string | null; }

/**
 * La nota medica che vale la pena leggere a pranzo: vuota e «Nessuna» non lo
 * sono. La regola della negazione è quella del motore (`isNegazione`, a
 * vocabolario intero) e non una `/nessuna/` scritta qui: a sottostringa,
 * «Epilessia, nessuna terapia in corso» sparirebbe.
 */
function notaDaMostrare(nota?: string | null): string | null {
  const t = (nota ?? '').trim();
  return t !== '' && !isNegazione(t) ? t : null;
}

// Entrata rimossa — gestita dal modulo Presenze
// Nanna e Sveglia sono DUE pulsanti distinti (PRD §3.1.1): Nanna = orario inizio, Sveglia = orario fine.
// 'umore' (M5.4) si aggiunge in coda solo se attivo in diario_config.routine_attive.
const ALL_EVENT_TYPES: DiaryEventType[] = ['attivita', 'merenda', 'pranzo', 'nanna_inizio', 'nanna_fine', 'bagno'];

function now() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function todayISO() {
    return new Date().toISOString().split('T')[0];
}

// Nome leggibile di un tipo bagno (pipì/cacca/vasino) dai valori di BATHROOM_TYPES.
// Mostrato solo quando le celle sono impilate (mobile), per orientare senza la sola emoji.
function bathroomLabel(value: string): string {
    return BATHROOM_TYPES.find(b => b.value === value)?.label ?? value;
}

function buildInitialState(type: DiaryEventType, students: DiaryStudent[]) {
    const state: Record<string, Record<string, unknown>> = {};
    students.forEach(s => {
        if (type === 'attivita') state[s.id] = { partecipazione: null };
        else if (type === 'pranzo') {
            const corsi: Record<string, string | null> = {};
            ['primo', 'secondo', 'contorno', 'frutta'].forEach(c => { corsi[c] = null; });
            state[s.id] = { corsi };
        } else if (type === 'merenda') {
            state[s.id] = { corsi: { merenda: null } };
        } else if (type === 'nanna_inizio') {
            state[s.id] = { orario_inizio: '' };
        } else if (type === 'nanna_fine') {
            state[s.id] = { orario_fine: '' };
        } else if (type === 'bagno') {
            state[s.id] = { pipi: 0, cacca: 0, vasino: 0 };
        } else if (type === 'umore') {
            state[s.id] = { umore: null };
        } else {
            state[s.id] = {};
        }
    });
    return state;
}

// ─── Animazioni accordion ─────────────────────────────────────────────────────

const sectionVariants = {
    hidden: { opacity: 0, y: 12 },
    visible: {
        opacity: 1,
        y: 0,
        transition: {
            duration: 0.3,
            ease: [0.25, 0.46, 0.45, 0.94] as const,
        },
    },
    exit: {
        opacity: 0,
        y: -8,
        transition: {
            duration: 0.2,
            ease: [0.25, 0.46, 0.45, 0.94] as const,
        },
    },
};

const itemVariants = {
    hidden: { opacity: 0, y: 8 },
    visible: (i: number) => ({
        opacity: 1,
        y: 0,
        transition: { delay: i * 0.04, duration: 0.25, ease: 'easeOut' as const },
    }),
};

// ─── Hook: stato e handler della giornata ─────────────────────────────────────

export function useDiaryDay(
    userId: string | null,
    sezione: string | null,
    opts?: {
        onSaved?: () => void;
        /**
         * L'UUID della sezione: l'identità vera. Facoltativo perché
         * `/admin/diary` sceglie la classe da un elenco di soli nomi, e perché
         * la risposta vecchia di `educator-sections` l'id non ce l'ha — le route
         * accettano entrambe le strade e le fanno finire sullo stesso filtro.
         */
        sectionId?: string;
    },
) {
    const t = useTranslations('teacherDiario');
    const etichettaAllergene = useAllergeneLabel();
    const [students, setStudents] = useState<DiaryStudent[]>([]);
    const [selectedEvent, setSelectedEvent] = useState<DiaryEventType | null>(null);
    const [studentStates, setStudentStates] = useState<Record<string, Record<string, unknown>>>({});
    const [isSaving, setIsSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [savedStudentIds, setSavedStudentIds] = useState<Set<string>>(new Set());
    const [showSavedToast, setShowSavedToast] = useState(false);
    const [activities, setActivities] = useState<ActivityItem[]>([]);
    const [notaLibera, setNotaLibera] = useState('');
    // Nota per SINGOLO bambino (E1): mappa alunno_id → testo. Distinta da notaLibera
    // (nota di sezione, uguale per tutti): finisce in eventi_diario.nota_bambino ed è
    // visibile SOLO al genitore di quel bambino.
    const [noteBambino, setNoteBambino] = useState<Record<string, string>>({});
    // Filtro presenze (incongruenza #7): default = solo presenti; toggle per mostrare tutti.
    const [showAll, setShowAll] = useState(false);
    // 'umore' visibile solo se attivo in diario_config.routine_attive (M5.4).
    const [umoreEnabled, setUmoreEnabled] = useState(false);

    // Config dalla cache di modulo: è la STESSA GET che il chrome della pagina
    // /teacher/diary fa per sapere se mostrare le sezioni primaria. Farne una
    // propria significava due richieste identiche (quattro con StrictMode).
    useEffect(() => {
        if (!userId) return;
        let active = true;
        void fetchDiarioConfig(userId).then(d => {
            if (active && d) setUmoreEnabled(umoreAttivo(d.routine_attive));
        });
        return () => { active = false; };
    }, [userId]);

    const eventTypes: DiaryEventType[] = umoreEnabled ? [...ALL_EVENT_TYPES, 'umore'] : ALL_EVENT_TYPES;

    // L'uuid quando c'è, il nome quando no. Prima si mandava sempre il nome, e
    // le route filtravano `alunni.classe_sezione` per uguaglianza esatta: uno
    // spazio di differenza dal nome della sezione e il diario si apriva senza
    // nessun bambino, con 200 e senza un log.
    const paramClasse = parametroClasse({ id: opts?.sectionId, name: sezione ?? '' });

    const fetchStudents = async () => {
        if (!sezione || !userId) return;
        try {
            const res = await fetch(`/api/diary/students?${paramClasse}&onlyPresent=${showAll ? 'false' : 'true'}&userId=${userId}`);
            const data = await res.json();
            if (Array.isArray(data)) {
                // ── LE ALLERGIE VENGONO DALLE ALLERGIE ─────────────────────────
                // Qui si spezzava `note_mediche` sulle virgole e la si chiamava
                // «allergie»: è la casella «Note Mediche (BES, DSA, patologie)» del
                // modulo d'iscrizione, e finiva dritta nell'alert del PRANZO.
                //
                // Si compone come `colonnaAllergie` in `prestampati/banco.ts`:
                // etichette degli allergeni SPUNTATI più il testo libero così com'è.
                // Il testo non si infersce e non si riassume — «fragole» o «nichel»
                // non sono fra i 14 UE e sparirebbero dal piatto di un bambino. Esce
                // solo la negazione, che è il modo in cui qualcuno ha scritto «niente».
                //
                // ⚠️ E LA NOTA MEDICA NON SI BUTTA: CAMBIA GRUPPO. Toglierla e basta
                // ha fatto sparire dall'alert del pranzo 29 bambini su 657 (misurato
                // il 2026-09-07), fra cui chi ha scritto in quella casella una terapia
                // salvavita. Viaggia in `notaMedica`, con etichetta e colore suoi in
                // `MealDetailInline`: due gruppi, come nella card della home docente.
                //
                // ⚠️ E NEMMENO LE CHIAVI SI FILTRANO. Qui c'era `normalizzaAllergeni`,
                // che tiene le 14 UE e scarta il resto in SILENZIO: se in archivio
                // c'è `['nichel']`, il prestampato di banco la stampa e questo alert
                // la faceva sparire. La composizione ora è una sola per tutte le
                // superfici operative — `etichetteAllergie` nel motore — e prende
                // l'etichettatore tradotto perché questo è un componente client.
                const mapped: DiaryStudent[] = data.map((a: { id: string; nome: string; cognome: string; allergeni?: string[] | null; allergies?: string | null; note_mediche?: string | null }) => ({
                    id: a.id,
                    firstName: a.nome,
                    lastName: a.cognome,
                    allergie: etichetteAllergie({ allergeni: a.allergeni, allergies: a.allergies }, etichettaAllergene),
                    notaMedica: notaDaMostrare(a.note_mediche),
                }));
                setStudents(mapped);
            }
        } finally {
            setIsLoading(false);
        }
    };

    // Carica studenti: di default solo i presenti; rifa il fetch al toggle o al cambio sezione.
    useEffect(() => {
        fetchStudents();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showAll, sezione, userId]);

    // Ripristina lo stato UI dai dati già salvati su Supabase per un certo tipo evento
    const restoreFromSupabase = async (eventType: DiaryEventType, studentList?: DiaryStudent[]) => {
        const list = studentList ?? students;
        if (list.length === 0 || !sezione) { setSavedStudentIds(new Set()); return; }
        try {
            const today = todayISO();
            const res = await fetch(`/api/diary/entries?${paramClasse}&date=${today}&userId=${userId}`);
            const entries = await res.json();
            if (!Array.isArray(entries)) { setSavedStudentIds(new Set()); return; }

            const filtered = entries.filter((e: { tipo_evento: string }) => e.tipo_evento === eventType);
            if (filtered.length === 0) { setSavedStudentIds(new Set()); return; }

            // Per ogni studente, prendi l'ultimo salvataggio
            const latestPerStudent: Record<string, { dettagli: Record<string, unknown>; activity_description?: string }> = {};
            filtered.forEach((e: { alunno_id: string; orario_inizio: string; dettagli: Record<string, unknown>; activity_description?: string }) => {
                if (!latestPerStudent[e.alunno_id] || e.orario_inizio > (latestPerStudent[e.alunno_id] as unknown as { orario_inizio: string }).orario_inizio) {
                    latestPerStudent[e.alunno_id] = e;
                }
            });

            const newState = buildInitialState(eventType, list);
            const savedIds = new Set<string>();
            const restoredNotes: Record<string, string> = {};
            Object.entries(latestPerStudent).forEach(([studentId, entry]) => {
                // Nota per-bambino (E1): la ripopolo SEMPRE (prima dell'early-return
                // umore), così riaprire lo stesso evento e risalvare non la azzera in
                // silenzio. Assente sul DB E2E non migrato → resta stringa vuota.
                const nb = (entry as { nota_bambino?: string | null }).nota_bambino;
                if (typeof nb === 'string' && nb.length > 0) restoredNotes[studentId] = nb;
                if (entry.dettagli && typeof entry.dettagli === 'object') {
                    // Eventi umore senza valore (legacy {umore:null}) non contano
                    // come compilati: niente ✅ né ripristino stato.
                    if (eventType === 'umore' && !umoreFromDettagli(entry.dettagli)) return;
                    // Stessa regola per la nanna, e qui rende inerti anche le righe
                    // vuote GIÀ in archivio: senza questa riga, riaprendo la schermata
                    // l'intera sezione risulterebbe «nanna registrata» con l'ora vuota,
                    // e la ✅ è ciò che dice alla maestra «questo bambino è a posto».
                    if (eEventoNanna(eventType) && !nannaCompilata(eventType, entry.dettagli)) return;
                    newState[studentId] = entry.dettagli;
                    savedIds.add(studentId);
                }
            });
            setNoteBambino(restoredNotes);

            // Ricostruisce activities[] con partecipazione per-studente dal primo entry trovato
            if (eventType === 'attivita') {
                const firstEntry = Object.values(latestPerStudent)[0] as { dettagli: Record<string, unknown> } | undefined;
                const rawActs = firstEntry?.dettagli?.activities as Array<{
                    tipo: string; descrizione: string; partecipazione?: string;
                    studentPartecipazione?: Record<string, string | null>;
                }> | undefined;

                if (rawActs && rawActs.length > 0) {
                    // Ricostruisce studentPartecipazione da tutti gli entry
                    const reconstructed: ActivityItem[] = rawActs.map((a, aIdx) => {
                        const sp: Record<string, string | null> = {};
                        Object.entries(latestPerStudent).forEach(([sid, entry]) => {
                            const eDet = (entry as { dettagli: Record<string, unknown> }).dettagli;
                            const acts = eDet?.activities as Array<{ tipo: string; partecipazione?: string }> | undefined;
                            sp[sid] = acts?.[aIdx]?.partecipazione ?? null;
                        });
                        return {
                            tipo: a.tipo,
                            descrizione: a.descrizione ?? '',
                            studentPartecipazione: sp,
                        };
                    });
                    setActivities(reconstructed);
                }
            }
            setStudentStates(newState);
            setSavedStudentIds(savedIds);
        } catch (err) {
            // Il diario è il posto con i dati più delicati dell'app (pasti, bagno, sonno,
            // partecipazione di ogni bambino): dell'errore esce la classe e basta.
            logClient({ livello: 'error', evento: 'fetch', messaggio: `diario-ripristino-dati-fallito: ${nomeErrore(err)}` });
            setSavedStudentIds(new Set());
        }
    };

    const handleEventSelect = async (type: DiaryEventType) => {
        if (selectedEvent === type) {
            setSelectedEvent(null);
            return;
        }
        // Prima imposta il tipo e lo stato pulito
        setSelectedEvent(type);
        setSavedStudentIds(new Set());
        setNotaLibera('');
        setNoteBambino({});
        // Inizializza con una attività vuota, con partecipazione null per ogni studente
        const initPart: Record<string, string | null> = {};
        students.forEach(s => { initPart[s.id] = null; });
        setActivities([{ tipo: 'pittura', descrizione: '', studentPartecipazione: initPart }]);
        // Poi carica da Supabase (await per evitare race condition)
        const initialState = buildInitialState(type, students);
        setStudentStates(initialState);
        await restoreFromSupabase(type);
    };

    const updateStudent = (id: string, updates: Record<string, unknown>) => {
        setStudentStates(prev => ({ ...prev, [id]: { ...prev[id], ...updates } }));
        setSavedStudentIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    };

    // Nota riservata al singolo bambino (E1): aggiorna SOLO la riga indicata e toglie
    // la ✅ a quel bambino (la modifica è da risalvare).
    const updateNotaBambino = (id: string, value: string) => {
        setNoteBambino(prev => ({ ...prev, [id]: value }));
        setSavedStudentIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    };

    const updateMealCourse = (studentId: string, corsoId: string, value: string | null) => {
        const prev = (studentStates[studentId]?.corsi as Record<string, string | null>) ?? {};
        updateStudent(studentId, { corsi: { ...prev, [corsoId]: value } });
    };

    const counter = (id: string, field: 'pipi' | 'cacca' | 'vasino', delta: number) => {
        const cur = (studentStates[id]?.[field] as number) ?? 0;
        updateStudent(id, { [field]: Math.max(0, cur + delta) });
    };

    // Bulk "Nanna per tutti": imposta l'orario di inizio nanna = ora per ogni bambino in elenco.
    const bulkNannaOra = () => {
        const t = now();
        setStudentStates(prev => {
            const next = { ...prev };
            students.forEach(s => { next[s.id] = { ...next[s.id], orario_inizio: t }; });
            return next;
        });
        setSavedStudentIds(new Set());
    };

    /**
     * ELIMINA una registrazione di nanna segnata per errore.
     *
     * Perché serve un gesto suo, e non «svuota il campo e risalva»: dopo il filtro
     * selettivo, un campo vuoto ESCLUDE quel bambino dal payload, quindi il
     * salvataggio lascerebbe la riga in archivio esattamente com'era — un no-op che
     * SEMBRA aver funzionato, perché il campo è vuoto a schermo e la ✅ è sparita.
     * Sarebbe il difetto che stiamo chiudendo, riaperto dal suo stesso rimedio.
     *
     * Niente aggiornamento ottimistico: la ✅ si toglie SOLO a cancellazione avvenuta.
     * Una spunta che sparisce mentre la riga resta è la bugia opposta a quella di prima.
     */
    const eliminaRegistrazione = async (studentId: string) => {
        if (!selectedEvent || !userId || !eEventoNanna(selectedEvent)) return;
        const campo = selectedEvent === 'nanna_fine' ? 'orario_fine' : 'orario_inizio';
        try {
            const qs = new URLSearchParams({
                alunno_id: studentId,
                tipo_evento: selectedEvent,
                date: todayISO(),
                userId,
            });
            const res = await fetch(`/api/diary/entries?${qs.toString()}`, {
                method: 'DELETE',
                headers: { 'x-user-id': userId },
            });
            if (!res.ok) throw new Error(String(res.status));
            setSavedStudentIds(prev => { const n = new Set(prev); n.delete(studentId); return n; });
            setStudentStates(prev => ({ ...prev, [studentId]: { ...prev[studentId], [campo]: '' } }));
        } catch (err) {
            // Del guasto esce il codice e basta: il diario è il posto con i dati più
            // delicati dell'app, e il nome del bambino non entra in nessun log.
            logClient({ livello: 'error', evento: 'fetch', messaggio: `diario-eliminazione-fallita: ${nomeErrore(err)}` });
            alert(t('alertErroreEliminazione'));
        }
    };

    // Cambio sezione dal consumer: la selezione e le spunte riferivano la sezione precedente.
    const resetSelection = () => {
        setSelectedEvent(null);
        setSavedStudentIds(new Set());
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            if (!selectedEvent || !userId) return;
            const nowIso = new Date().toISOString();
            // CHI FINISCE IN ARCHIVIO. Tre casi, non due — e il secondo è nato da un
            // difetto vero, segnalato dal titolare.
            //
            // · umore: opzionale per bambino. Salvare {umore:null} marcherebbe ✅ tutti
            //   e sopprimerebbe lo stato vuoto lato genitore.
            //
            // · nanna/sveglia: si salva SOLO chi ha l'orario. Prima cadevano nel ramo
            //   `else`, quindi una riga per ogni bambino presente anche con l'ora vuota,
            //   e il genitore di chi NON aveva dormito leggeva «Ho fatto un bel
            //   sonnellino! 😴». Non era un dato mancante: era una frase falsa nel
            //   diario di suo figlio. La regola «'' non è un'ora» sta in
            //   `@/lib/diary/nanna`, un posto solo per tutti e tre i lettori.
            //
            // · tutto il resto (pranzo, merenda, bagno, attività): si salva TUTTI, ed è
            //   corretto. Lì lo stato vuoto È un dato — «segnato: non ha mangiato niente»
            //   è diverso da «non l'ho segnato».
            const targetStudents = selectedEvent === 'umore'
                ? students.filter(s => umoreFromDettagli(studentStates[s.id]) !== null)
                : eEventoNanna(selectedEvent)
                    ? students.filter(s => nannaCompilata(selectedEvent, studentStates[s.id]))
                    : students;
            if (targetStudents.length === 0) return;
            const payload = targetStudents.map(student => {
                // dettagli specifico per tipo evento:
                // - attività   → elenco attività con partecipazione per-studente
                // - nanna/sveglia/bagno/pranzo/merenda → stato per-studente (orari, contatori, portate)
                let dettagli: Record<string, unknown>;
                if (selectedEvent === 'attivita') {
                    dettagli = {
                        activities: activities.map(a => ({
                            tipo: a.tipo,
                            descrizione: a.descrizione,
                            partecipazione: a.studentPartecipazione[student.id] ?? null,
                        })),
                    };
                } else {
                    dettagli = studentStates[student.id] ?? {};
                }
                return {
                    alunno_id: student.id,
                    maestra_id: userId,
                    tipo_evento: selectedEvent,
                    orario_inizio: nowIso,
                    dettagli,
                    // Nota di sezione: identica per tutti (broadcast).
                    nota_libera: notaLibera.trim() || null,
                    // Nota per-bambino: solo di questo bambino, altrimenti null (E1).
                    nota_bambino: noteBambino[student.id]?.trim() || null,
                };
            });

            const res = await fetch(`/api/diary/entries?userId=${userId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify(payload),
            });

            // 200 = tutto ok, 207 = parzialmente salvato (es. colonna mancante ma righe inserite)
            if (!res.ok && res.status !== 207) {
                const err = await res.json();
                throw new Error(err.error || 'Errore salvataggio');
            }

            const result = await res.json();
            // Conta quanti sono stati effettivamente salvati
            const savedItems = Array.isArray(result) ? result : (result.saved ?? []);
            const savedIds = new Set<string>(
                savedItems
                    .map((r: { alunno_id?: string }) => r.alunno_id)
                    .filter(Boolean)
            );
            // Se nessuno ha un alunno_id nel result, segna come salvati i soli inviati (upsert silent)
            setSavedStudentIds(savedIds.size > 0 ? savedIds : new Set(targetStudents.map(s => s.id)));
            setShowSavedToast(true);
            setTimeout(() => setShowSavedToast(false), 2500);
            opts?.onSaved?.();
        } catch (err) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `diario-salvataggio-fallito: ${nomeErrore(err)}` });
            alert(t('alertErroreSalvataggio'));
        } finally {
            setIsSaving(false);
        }
    };

    return {
        students,
        isLoading,
        showAll,
        toggleShowAll: () => setShowAll(v => !v),
        eventTypes,
        selectedEvent,
        setSelectedEvent,
        studentStates,
        savedStudentIds,
        activities,
        setActivities,
        notaLibera,
        setNotaLibera,
        notaBambino: noteBambino,
        updateNotaBambino,
        isSaving,
        showSavedToast,
        handleEventSelect,
        updateStudent,
        updateMealCourse,
        counter,
        bulkNannaOra,
        handleSave,
        eliminaRegistrazione,
        resetSelection,
    };
}

export type DiaryDay = ReturnType<typeof useDiaryDay>;

// ─── UI di compilazione (griglia eventi + accordion + toast) ─────────────────

export function DiaryEventEditor({ day, sezione }: { day: DiaryDay; sezione: string | null }) {
    const t = useTranslations('teacherDiario');
    const eventLabel = useEventLabel();
    const umoreLabel = useUmoreLabel();
    const {
        students, eventTypes, selectedEvent, setSelectedEvent, studentStates, savedStudentIds,
        activities, setActivities, notaLibera, setNotaLibera, notaBambino, updateNotaBambino,
        isSaving, showSavedToast,
        handleEventSelect, updateStudent, updateMealCourse, counter, bulkNannaOra, handleSave,
        eliminaRegistrazione,
    } = day;

    const cfg = selectedEvent ? EVENT_CONFIG[selectedEvent] : null;

    // QUANTI FINIRANNO IN ARCHIVIO. Per la nanna il salvataggio è selettivo, quindi
    // «Salva Nanna per tutti» sarebbe una frase falsa sul pulsante che la esegue —
    // e a zero bambini compilati sarebbe anche un pulsante che non fa niente senza
    // dirlo (l'handler esce subito). Il conteggio rende visibile la regola, e il
    // pulsante disabilitato rende visibile il no-op.
    const nannaSelettiva = selectedEvent !== null && eEventoNanna(selectedEvent);
    const daSalvare = nannaSelettiva
        ? students.filter(s => nannaCompilata(selectedEvent!, studentStates[s.id])).length
        : students.length;

    // Tessera selezionata: la scorro in vista quando cambia (mobile a 6-7
    // tessere può iniziare con quella scelta fuori dallo schermo). Niente
    // behavior esplicito: decide scroll-smooth via CSS, così la guardia
    // reduced-motion di globals.css (scroll-behavior: auto !important) vince.
    // La chiamata opzionale sul metodo copre jsdom, che non lo implementa.
    const selectedTileRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        selectedTileRef.current?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    }, [selectedEvent]);

    return (
        <>
            {/* ── Riga eventi scorrevole (6-7 routine) ── */}
            <div className="mt-4 w-full rounded-3xl border border-kidville-line bg-white p-4 shadow-sm">
                <p className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">{t('cosaRegistrare')}</p>
                <div className="-mx-4 px-4 pt-1 pb-1.5 flex gap-2 overflow-x-auto snap-x scroll-smooth scroll-pl-4 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                    {eventTypes.map(type => {
                        const selected = selectedEvent === type;
                        return (
                            <div
                                key={type}
                                ref={selected ? selectedTileRef : null}
                                className={`w-[92px] flex-shrink-0 snap-start rounded-2xl transition-all duration-200 ${
                                    selected ? 'shadow-md' : ''
                                }`}
                            >
                                <EventTypeButton type={type} disabled={false} selected={selected} onClick={handleEventSelect} />
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* ── Sezione dettaglio inline (Accordion) ── */}
            <AnimatePresence mode="wait">
                {selectedEvent && cfg && (
                    <motion.div
                        key={`section-${selectedEvent}`}
                        variants={sectionVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        className="w-full mt-4"
                    >
                        {/* Header sezione (DR) */}
                        <div className="w-full overflow-hidden rounded-3xl border border-kidville-line bg-white shadow-lg">
                            {/* Title bar */}
                            <div className="flex items-center justify-between px-5 py-4 border-b border-kidville-line">
                                <div className="flex items-center gap-3">
                                    <div className={`w-10 h-10 rounded-2xl flex items-center justify-center text-xl ${cfg.color} border ${cfg.accentColor.split(' ').find(c => c.startsWith('border-')) ?? ''}`}>
                                        {cfg.emoji}
                                    </div>
                                    <div>
                                        <h2 className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide">{eventLabel(selectedEvent ?? '')}</h2>
                                        <p className="font-maven text-[11px] text-kidville-muted">{t('numBambini', { count: students.length })} • {todayISO()}</p>
                                    </div>
                                </div>
                                <button
                                    onClick={() => setSelectedEvent(null)}
                                    aria-label={t('chiudiEvento')}
                                    className="w-8 h-8 rounded-xl bg-kidville-cream-dark hover:bg-kidville-cream flex items-center justify-center text-kidville-green transition-colors"
                                >
                                    <X size={14} strokeWidth={1.5} />
                                </button>
                            </div>

                            {/* Contenuto sezione */}
                            <div className="p-4 space-y-2">
                                {/* ── ATTIVITÀ ── */}
                                {selectedEvent === 'attivita' && (
                                    <ActivityDetailInline
                                        students={students}
                                        activities={activities}
                                        onActivitiesChange={setActivities}
                                        savedStudentIds={savedStudentIds}
                                    />
                                )}

                                {/* ── PRANZO / MERENDA ── */}
                                {(selectedEvent === 'pranzo' || selectedEvent === 'merenda') && (
                                    <MealDetailInline
                                        students={students}
                                        studentStates={studentStates}
                                        onMealSelect={updateMealCourse}
                                        date={todayISO()}
                                        classId={sezione ?? ''}
                                        savedStudentIds={savedStudentIds}
                                        isMerenda={selectedEvent === 'merenda'}
                                    />
                                )}

                                {/* ── Bulk "Nanna per tutti": un tap imposta l'orario inizio = ora per tutti ── */}
                                {selectedEvent === 'nanna_inizio' && students.length > 0 && (
                                    <button
                                        onClick={bulkNannaOra}
                                        className="w-full mb-1 py-2.5 rounded-2xl bg-kidville-info-soft border border-kidville-info/30 text-kidville-info font-maven font-semibold text-sm flex items-center justify-center gap-2 hover:bg-kidville-info-soft transition-colors"
                                    >
                                        <Moon size={14} strokeWidth={1.5} /> {t('tuttiANannaOra', { ora: now() })}
                                    </button>
                                )}
                                {/* Il pulsante si chiama «Tutti a nanna ora»: da quando si salva
                                    solo chi ha l'orario, quel nome da solo prometterebbe una cosa
                                    che non fa più. Questa riga dice cosa fa davvero. */}
                                {selectedEvent === 'nanna_inizio' && students.length > 0 && (
                                    <p className="font-maven text-[11px] text-kidville-sub text-center mb-1 px-2">
                                        {t('nannaAiutoCompilazione')}
                                    </p>
                                )}

                                {/* ── NANNA (inizio) / SVEGLIA (fine) — due eventi distinti (PRD §3.1.1) ── */}
                                {(selectedEvent === 'nanna_inizio' || selectedEvent === 'nanna_fine') && students.map((student, idx) => {
                                    const state = studentStates[student.id] ?? {};
                                    const isSaved = savedStudentIds.has(student.id);
                                    const isInizio = selectedEvent === 'nanna_inizio';
                                    return (
                                        <motion.div
                                            key={student.id}
                                            custom={idx}
                                            variants={itemVariants}
                                            initial="hidden"
                                            animate="visible"
                                            className="rounded-2xl border border-kidville-line bg-white shadow-sm px-4 py-3"
                                        >
                                            <div className="flex items-center gap-3 mb-3">
                                                <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center font-barlow font-bold text-xs bg-kidville-cream text-kidville-green">
                                                    {student.firstName[0]}{student.lastName[0]}
                                                </div>
                                                <span className="font-maven font-medium text-sm text-kidville-green flex-1">
                                                    {student.firstName} {student.lastName}
                                                    {isSaved && <span className="ml-1.5 text-kidville-success">✅</span>}
                                                </span>
                                                {/* ELIMINA — compare solo su una registrazione che ESISTE
                                                    in archivio (la ✅). Svuotare il campo non basterebbe:
                                                    da quando si salva solo chi ha l'orario, un campo vuoto
                                                    ESCLUDE il bambino dal salvataggio, quindi la riga
                                                    resterebbe dov'è. Sarebbe un no-op che sembra riuscito. */}
                                                {isSaved && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            const nome = `${student.firstName} ${student.lastName}`;
                                                            // La nota per-bambino sta sulla STESSA riga e sparisce
                                                            // con lei: chi conferma deve saperlo.
                                                            const haNota = Boolean(notaBambino[student.id]?.trim());
                                                            const domanda = haNota
                                                                ? t('nannaConfermaEliminaConNota', { nome })
                                                                : t('nannaConfermaElimina', { nome });
                                                            if (!confirm(domanda)) return;
                                                            void eliminaRegistrazione(student.id);
                                                        }}
                                                        aria-label={t('nannaEliminaAria', { nome: `${student.firstName} ${student.lastName}` })}
                                                        className="flex-shrink-0 min-h-[44px] px-2 rounded-xl text-kidville-error-strong font-maven text-xs font-semibold flex items-center gap-1 hover:bg-kidville-error-soft transition-colors"
                                                    >
                                                        <Trash2 size={14} strokeWidth={1.5} /> {t('nannaEliminaRegistrazione')}
                                                    </button>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-1.5 mb-1.5">
                                                {isInizio
                                                    ? <Moon size={12} className="text-kidville-info" strokeWidth={1.5} />
                                                    : <Sun size={12} className="text-kidville-yellow-dark" strokeWidth={1.5} />}
                                                <p className="font-maven text-xs text-kidville-muted">
                                                    {isInizio ? t('siAddormenta') : t('siSveglia')}
                                                </p>
                                            </div>
                                            <input
                                                type="time"
                                                value={(isInizio ? (state.orario_inizio as string) : (state.orario_fine as string)) ?? ''}
                                                onChange={e => updateStudent(student.id, isInizio ? { orario_inizio: e.target.value } : { orario_fine: e.target.value })}
                                                className={`w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 transition-all ${isInizio ? 'focus:ring-kidville-info/40 focus:border-kidville-info/60' : 'focus:ring-kidville-yellow-dark/40 focus:border-kidville-yellow-dark/60'}`}
                                            />
                                        </motion.div>
                                    );
                                })}

                                {/* ── BAGNO ── */}
                                {selectedEvent === 'bagno' && students.map((student, idx) => {
                                    const state = studentStates[student.id] ?? {};
                                    const pipi = (state.pipi as number) ?? 0;
                                    const cacca = (state.cacca as number) ?? 0;
                                    const vasino = (state.vasino as number) ?? 0;
                                    const isSaved = savedStudentIds.has(student.id);
                                    return (
                                        <motion.div
                                            key={student.id}
                                            custom={idx}
                                            variants={itemVariants}
                                            initial="hidden"
                                            animate="visible"
                                            className="rounded-2xl border border-kidville-line bg-white shadow-sm px-4 py-3"
                                        >
                                            {/* Avatar + Nome */}
                                            <div className="flex items-center gap-3 mb-3">
                                                <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center font-barlow font-bold text-xs bg-kidville-cream text-kidville-green">
                                                    {student.firstName[0]}{student.lastName[0]}
                                                </div>
                                                <span className="font-maven font-medium text-sm text-kidville-green flex-1">
                                                    {student.firstName} {student.lastName}
                                                    {isSaved && <span className="ml-1.5 text-kidville-success">✅</span>}
                                                </span>
                                            </div>
                                            {/* Contatori in griglia: impilati su mobile, in riga da sm+ */}
                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                                {/* Pipì */}
                                                <div className="flex items-center justify-between gap-2 min-w-0 bg-kidville-info-soft/80 backdrop-blur-sm rounded-xl px-3 py-2 border border-kidville-info/20">
                                                    <div className="flex items-center gap-1.5 min-w-0">
                                                        <span className="text-lg leading-none">💧</span>
                                                        <span className="sm:hidden font-maven font-semibold text-xs text-kidville-info truncate">{bathroomLabel('pipi')}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 flex-shrink-0">
                                                        <button
                                                            onClick={() => counter(student.id, 'pipi', -1)}
                                                            aria-label={t('bagnoPipiMeno')}
                                                            className="w-7 h-7 rounded-full bg-white border border-kidville-info/30 text-kidville-info flex items-center justify-center hover:bg-kidville-info-soft transition-colors"
                                                        >
                                                            <Minus size={10} strokeWidth={1.5} />
                                                        </button>
                                                        <span className="font-barlow font-black text-xl text-kidville-info w-6 text-center">{pipi}</span>
                                                        <button
                                                            onClick={() => counter(student.id, 'pipi', 1)}
                                                            aria-label={t('bagnoPipiPiu')}
                                                            className="w-7 h-7 rounded-full bg-kidville-info text-white flex items-center justify-center hover:opacity-90 transition-colors"
                                                        >
                                                            <Plus size={10} strokeWidth={1.5} />
                                                        </button>
                                                    </div>
                                                </div>
                                                {/* Cacca */}
                                                <div className="flex items-center justify-between gap-2 min-w-0 bg-kidville-warn-soft/80 backdrop-blur-sm rounded-xl px-3 py-2 border border-kidville-warn/20">
                                                    <div className="flex items-center gap-1.5 min-w-0">
                                                        <span className="text-lg leading-none">💩</span>
                                                        <span className="sm:hidden font-maven font-semibold text-xs text-kidville-warn truncate">{bathroomLabel('cacca')}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 flex-shrink-0">
                                                        <button
                                                            onClick={() => counter(student.id, 'cacca', -1)}
                                                            aria-label={t('bagnoCaccaMeno')}
                                                            className="w-7 h-7 rounded-full bg-white border border-kidville-warn/30 text-kidville-warn flex items-center justify-center hover:bg-kidville-warn-soft transition-colors"
                                                        >
                                                            <Minus size={10} strokeWidth={1.5} />
                                                        </button>
                                                        <span className="font-barlow font-black text-xl text-kidville-warn w-6 text-center">{cacca}</span>
                                                        <button
                                                            onClick={() => counter(student.id, 'cacca', 1)}
                                                            aria-label={t('bagnoCaccaPiu')}
                                                            className="w-7 h-7 rounded-full bg-kidville-warn text-white flex items-center justify-center hover:opacity-90 transition-colors"
                                                        >
                                                            <Plus size={10} strokeWidth={1.5} />
                                                        </button>
                                                    </div>
                                                </div>
                                                {/* Vasino (potty training) */}
                                                <div className="flex items-center justify-between gap-2 min-w-0 bg-kidville-success-soft/80 backdrop-blur-sm rounded-xl px-3 py-2 border border-kidville-success/20">
                                                    <div className="flex items-center gap-1.5 min-w-0">
                                                        <span className="text-lg leading-none">🚽</span>
                                                        <span className="sm:hidden font-maven font-semibold text-xs text-kidville-success truncate">{bathroomLabel('vasino')}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 flex-shrink-0">
                                                        <button
                                                            onClick={() => counter(student.id, 'vasino', -1)}
                                                            aria-label={t('bagnoVasinoMeno')}
                                                            className="w-7 h-7 rounded-full bg-white border border-kidville-success/30 text-kidville-success flex items-center justify-center hover:bg-kidville-success-soft transition-colors"
                                                        >
                                                            <Minus size={10} strokeWidth={1.5} />
                                                        </button>
                                                        <span className="font-barlow font-black text-xl text-kidville-success w-6 text-center">{vasino}</span>
                                                        <button
                                                            onClick={() => counter(student.id, 'vasino', 1)}
                                                            aria-label={t('bagnoVasinoPiu')}
                                                            className="w-7 h-7 rounded-full bg-kidville-success text-white flex items-center justify-center hover:opacity-90 transition-colors"
                                                        >
                                                            <Plus size={10} strokeWidth={1.5} />
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </motion.div>
                                    );
                                })}

                                {/* ── UMORE (M5.4): picker 5 valori per alunno → dettagli.umore ── */}
                                {selectedEvent === 'umore' && students.map((student, idx) => {
                                    const sel = umoreFromDettagli(studentStates[student.id]);
                                    const isSaved = savedStudentIds.has(student.id);
                                    return (
                                        <motion.div
                                            key={student.id}
                                            custom={idx}
                                            variants={itemVariants}
                                            initial="hidden"
                                            animate="visible"
                                            className="rounded-2xl border border-kidville-line bg-white shadow-sm px-4 py-3"
                                        >
                                            <div className="flex items-center gap-3 mb-3">
                                                <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center font-barlow font-bold text-xs bg-kidville-cream text-kidville-green">
                                                    {student.firstName[0]}{student.lastName[0]}
                                                </div>
                                                <span className="font-maven font-medium text-sm text-kidville-green flex-1">
                                                    {student.firstName} {student.lastName}
                                                    {isSaved && <span className="ml-1.5 text-kidville-success">✅</span>}
                                                </span>
                                            </div>
                                            <div className="grid grid-cols-5 gap-1.5">
                                                {UMORE_VALUES.map(v => {
                                                    const c = UMORE_CONFIG[v];
                                                    const active = sel === v;
                                                    return (
                                                        <button
                                                            key={v}
                                                            onClick={() => updateStudent(student.id, { umore: active ? null : v })}
                                                            className={`flex flex-col items-center gap-1 rounded-xl border px-1 py-2 transition-all ${
                                                                active
                                                                    ? 'border-kidville-yellow-dark/60 bg-kidville-yellow-soft scale-105 shadow-sm'
                                                                    : 'border-kidville-line bg-white hover:bg-kidville-cream'
                                                            }`}
                                                            aria-pressed={active}
                                                            aria-label={`${student.firstName}: ${umoreLabel(v)}`}
                                                        >
                                                            <span className="text-xl leading-none">{c.emoji}</span>
                                                            <span className={`font-maven text-[10px] ${active ? 'font-bold text-kidville-yellow-dark' : 'text-kidville-muted'}`}>
                                                                {umoreLabel(v)}
                                                            </span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </motion.div>
                                    );
                                })}
                            </div>

                            {/* ── Nota di SEZIONE (uguale per tutti i genitori) ── */}
                            <div className="px-4 pt-1 pb-2">
                                <p className="font-barlow font-bold text-kidville-green uppercase text-[11px] tracking-wide mb-1.5">
                                    {t('notaSezione')}
                                </p>
                                <textarea
                                    value={notaLibera}
                                    onChange={e => setNotaLibera(e.target.value)}
                                    rows={2}
                                    aria-label={t('notaSezioneAria')}
                                    placeholder={t('notaSezionePlaceholder')}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/30 resize-none"
                                />
                            </div>

                            {/* ── Nota per SINGOLO bambino (E1): la legge solo quel genitore ── */}
                            {students.length > 0 && (
                                <div className="px-4 pt-1 pb-2">
                                    <p className="font-barlow font-bold text-kidville-green uppercase text-[11px] tracking-wide mb-1.5">
                                        {t('notaPrivataTitolo')}
                                    </p>
                                    <div className="space-y-2">
                                        {students.map(student => (
                                            <div key={student.id} className="flex items-center gap-2">
                                                <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center font-barlow font-bold text-[10px] bg-kidville-cream text-kidville-green">
                                                    {student.firstName[0]}{student.lastName[0]}
                                                </div>
                                                <input
                                                    type="text"
                                                    value={notaBambino[student.id] ?? ''}
                                                    onChange={e => updateNotaBambino(student.id, e.target.value)}
                                                    placeholder={t('notaPrivataPlaceholder', { nome: student.firstName })}
                                                    aria-label={t('notaPrivataAria', { nome: `${student.firstName} ${student.lastName}` })}
                                                    className="flex-1 min-w-0 border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/30"
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* ── Footer salva ── */}
                            <div className="px-4 py-3 border-t border-kidville-line">
                                <button
                                    onClick={handleSave}
                                    disabled={isSaving || daSalvare === 0}
                                    className="w-full py-3.5 rounded-2xl bg-kidville-green text-kidville-yellow font-barlow font-black text-lg uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-kidville-green/20"
                                >
                                    {isSaving
                                        ? <><div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" /> {t('salvataggio')}</>
                                        : nannaSelettiva
                                            ? <><span>{cfg.emoji}</span> {daSalvare === 0 ? t('nannaNessunOrario') : t('salvaConOrario', { count: daSalvare })}</>
                                            : <><span>{cfg.emoji}</span> {t('salvaPerTutti', { evento: eventLabel(selectedEvent ?? '') })}</>
                                    }
                                </button>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ── Stato vuoto (nessuna sezione selezionata) ── */}
            {!selectedEvent && students.length > 0 && (
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1, duration: 0.3 }}
                    className="mt-6 text-center py-12"
                >
                    <p className="font-maven text-kidville-muted text-sm">
                        {t('selezionaEvento')}
                    </p>
                </motion.div>
            )}

            {/* Toast di conferma salvataggio */}
            <AnimatePresence>
                {showSavedToast && (
                    <motion.div
                        initial={{ opacity: 0, y: -20, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -10, scale: 0.95 }}
                        className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] bg-kidville-green text-white font-maven font-semibold px-6 py-3 rounded-2xl shadow-xl flex items-center gap-2"
                    >
                        {t('salvatoConSuccesso')}
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
}
