'use client';

import { useState, useEffect } from 'react';
import { Clock, Calendar, BookOpen } from 'lucide-react';
import { db, LocalDiaryEntry, DiaryEventType } from '@/lib/offline/db';
import { EVENT_CONFIG } from '@/components/features/teacher/diary/eventConfig';

// ============================================================
// Mock data — da sostituire con Supabase nella versione finale
// ============================================================
const MOCK_STUDENT = { id: 's1', firstName: 'Sofia', lastName: 'Esposito' };
const MOCK_CLASS_ID = 'classe-girasoli-001';

// Label italiane per i dettagli degli eventi
const MEAL_QUANTITY_LABELS: Record<string, string> = {
    niente: 'Non ha mangiato',
    poco: 'Ha mangiato poco',
    meta: 'Ha mangiato la metà',
    tanto: 'Ha mangiato tanto',
    tutto: 'Ha finito tutto! ⭐',
};

const BATHROOM_TYPE_LABELS: Record<string, string> = {
    pipi: 'Pipì',
    cacca: 'Cacca',
    vasino: 'Vasino',
};

function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('it-IT', {
        weekday: 'long', day: 'numeric', month: 'long'
    });
}

function getDetailLabel(tipo: DiaryEventType, dettagli: Record<string, unknown> | null): string | null {
    if (!dettagli) return null;
    if ((tipo === 'pranzo' || tipo === 'merenda') && dettagli.quantita) {
        return MEAL_QUANTITY_LABELS[dettagli.quantita as string] ?? null;
    }
    if (tipo === 'bagno' && dettagli.tipo) {
        return BATHROOM_TYPE_LABELS[dettagli.tipo as string] ?? null;
    }
    return null;
}

// Raggruppa gli eventi per data
function groupByDate(entries: LocalDiaryEntry[]): Map<string, LocalDiaryEntry[]> {
    const map = new Map<string, LocalDiaryEntry[]>();
    entries.forEach(entry => {
        const dateKey = entry.timestamp_evento.split('T')[0];
        if (!map.has(dateKey)) map.set(dateKey, []);
        map.get(dateKey)!.push(entry);
    });
    return map;
}

// Componente singolo evento nella timeline
function TimelineEvent({ entry }: { entry: LocalDiaryEntry }) {
    const config = EVENT_CONFIG[entry.tipo_evento as DiaryEventType];
    const detailLabel = getDetailLabel(entry.tipo_evento as DiaryEventType, entry.dettagli);

    return (
        <div className="flex gap-4 group">
            {/* Punto timeline + linea verticale */}
            <div className="flex flex-col items-center">
                <div className={`
                    w-10 h-10 flex-shrink-0 rounded-full flex items-center justify-center text-xl
                    border-2 shadow-sm transition-transform group-hover:scale-110
                    ${config.color} ${config.accentColor}
                `}>
                    {config.emoji}
                </div>
                <div className="w-0.5 flex-1 bg-gray-100 mt-2 mb-0 min-h-[16px]" />
            </div>

            {/* Card evento */}
            <div className="flex-1 pb-5">
                <div className="bg-white rounded-xl p-3 shadow-sm border border-gray-100 hover:shadow-md transition-shadow">
                    <div className="flex items-center justify-between mb-1">
                        <span className="font-barlow font-bold text-sm text-kidville-green uppercase tracking-wide">
                            {config.label}
                        </span>
                        <div className="flex items-center gap-1 text-gray-400">
                            <Clock size={12} />
                            <span className="font-maven text-xs">{formatTime(entry.timestamp_evento)}</span>
                        </div>
                    </div>

                    {detailLabel && (
                        <p className="font-maven text-sm text-gray-600">{detailLabel}</p>
                    )}

                    {entry.note && (
                        <p className="font-maven text-sm text-gray-500 mt-1 italic">
                            "{entry.note}"
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function ParentDiaryPage() {
    const [entries, setEntries] = useState<LocalDiaryEntry[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const loadEntries = async () => {
            setLoading(true);
            try {
                // Carica dal DB locale (offline) prima
                const fourteenDaysAgo = new Date();
                fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
                const cutoff = fourteenDaysAgo.toISOString();

                const localEntries = await db.diario
                    .where('alunno_id')
                    .equals(MOCK_STUDENT.id)
                    .filter(e => e.timestamp_evento >= cutoff)
                    .toArray();

                // Ordina dal più recente al più vecchio
                localEntries.sort((a, b) => b.timestamp_evento.localeCompare(a.timestamp_evento));
                setEntries(localEntries);
            } catch (err) {
                console.error('Errore caricamento diario:', err);
            } finally {
                setLoading(false);
            }
        };
        loadEntries();
    }, []);

    const grouped = groupByDate(entries);
    const dateKeys = Array.from(grouped.keys()).sort((a, b) => b.localeCompare(a));

    return (
        <div className="max-w-lg mx-auto p-4 sm:p-6">

            {/* Header */}
            <div className="mb-6">
                <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide">
                    Il Diario di {MOCK_STUDENT.firstName}
                </h1>
                <p className="font-maven text-gray-500 mt-1">
                    Attività degli ultimi 14 giorni
                </p>
            </div>

            {/* Loading */}
            {loading && (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                    <div className="w-8 h-8 border-3 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin mb-3" />
                    <p className="font-maven text-sm">Caricamento...</p>
                </div>
            )}

            {/* Stato vuoto */}
            {!loading && entries.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                    <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4">
                        <BookOpen size={36} className="text-kidville-green/40" />
                    </div>
                    <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-2">
                        Nessun Evento
                    </h2>
                    <p className="font-maven text-gray-500 max-w-xs">
                        Non ci sono ancora eventi registrati per {MOCK_STUDENT.firstName} negli ultimi 14 giorni.
                    </p>
                </div>
            )}

            {/* Timeline per data */}
            {!loading && dateKeys.map((dateKey, dateIdx) => {
                const dayEntries = grouped.get(dateKey)!;
                // Ordina dal più vecchio al più recente all'interno del giorno
                const sortedDay = [...dayEntries].sort((a, b) =>
                    a.timestamp_evento.localeCompare(b.timestamp_evento)
                );

                return (
                    <div key={dateKey} className={dateIdx > 0 ? 'mt-8' : ''}>
                        {/* Intestazione data */}
                        <div className="flex items-center gap-2 mb-4">
                            <div className="flex items-center gap-1.5 bg-kidville-green text-kidville-yellow px-3 py-1 rounded-full">
                                <Calendar size={13} />
                                <span className="font-barlow font-bold text-sm uppercase tracking-wide capitalize">
                                    {formatDate(sortedDay[0].timestamp_evento)}
                                </span>
                            </div>
                            <div className="flex-1 h-px bg-gray-200" />
                            <span className="font-maven text-xs text-gray-400">
                                {sortedDay.length} {sortedDay.length === 1 ? 'evento' : 'eventi'}
                            </span>
                        </div>

                        {/* Eventi del giorno */}
                        <div>
                            {sortedDay.map((entry) => (
                                <TimelineEvent key={entry.id} entry={entry} />
                            ))}
                        </div>
                    </div>
                );
            })}

            {/* Note legali */}
            {!loading && entries.length > 0 && (
                <div className="mt-8 p-3 bg-gray-50 rounded-xl text-center">
                    <p className="font-maven text-xs text-gray-400">
                        📋 I dati del diario sono accessibili per i 14 giorni precedenti.
                        Per consultare lo storico completo contatta la segreteria.
                    </p>
                </div>
            )}
        </div>
    );
}
