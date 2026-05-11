'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, AlertCircle, Download } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import type { MonthlyAttendanceRecord } from '@/app/api/attendance/monthly/route';

type AttendanceStatus = 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata' | 'nessun_dato';

interface StudentMonthData {
    student_id: string;
    student_nome: string;
    student_cognome: string;
    section_name: string | null;
    byDate: Record<string, MonthlyAttendanceRecord>;
}

interface StudentSummary { presenze: number; assenze: number; ritardi: number; uscite: number; }

// Palette Kidville
const KV = {
    green: '#006A5F',
    yellow: '#FDC400',
    cream: '#FEF1E4',
    success: '#43A047',
    error: '#E53935',
};

const STATUS_CONFIG: Record<AttendanceStatus, { short: string; bg: string; text: string; dot: string }> = {
    presente:          { short: '✓', bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500' },
    assente:           { short: '✗', bg: 'bg-red-100',     text: 'text-red-600',     dot: 'bg-red-400' },
    ritardo:           { short: 'R', bg: 'bg-amber-100',   text: 'text-amber-700',   dot: 'bg-amber-400' },
    uscita_anticipata: { short: 'U', bg: 'bg-blue-100',    text: 'text-blue-700',    dot: 'bg-blue-400' },
    nessun_dato:       { short: '·', bg: '',               text: 'text-gray-300',    dot: 'bg-gray-200' },
};

const GIORNI = ['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
const MESI = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];

function getDays(year: number, month: number) {
    const days: Date[] = [];
    const total = new Date(year, month, 0).getDate();
    for (let d = 1; d <= total; d++) days.push(new Date(year, month - 1, d));
    return days;
}

function toISO(d: Date) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

interface RawStudent { id: string; nome: string; cognome: string; classe_sezione?: string | null; }

/** Costruisce la griglia studenti partendo SEMPRE dalla lista completa della sezione,
 *  sovrappone i record presenze dove esistono. Mesi senza dati → righe vuote. */
function mergeStudentsAndPresences(
    allStudents: RawStudent[],
    records: MonthlyAttendanceRecord[]
): StudentMonthData[] {
    const presenceMap = new Map<string, Record<string, MonthlyAttendanceRecord>>();
    for (const r of records) {
        if (!presenceMap.has(r.student_id)) presenceMap.set(r.student_id, {});
        presenceMap.get(r.student_id)![r.date] = r;
    }
    return allStudents
        .map(s => ({
            student_id: s.id,
            student_nome: s.nome,
            student_cognome: s.cognome,
            section_name: s.classe_sezione ?? null,
            byDate: presenceMap.get(s.id) ?? {},
        }))
        .sort((a, b) => `${a.student_cognome} ${a.student_nome}`.localeCompare(`${b.student_cognome} ${b.student_nome}`));
}

function calcSummary(s: StudentMonthData): StudentSummary {
    let presenze = 0, assenze = 0, ritardi = 0, uscite = 0;
    for (const r of Object.values(s.byDate)) {
        if (r.stato === 'presente') presenze++;
        else if (r.stato === 'assente') assenze++;
        else if (r.stato === 'ritardo') ritardi++;
        else if (r.stato === 'uscita_anticipata') uscite++;
    }
    return { presenze, assenze, ritardi, uscite };
}

// ─── Cella ───────────────────────────────────────────────────────────────────

function Cell({ record, isWeekend }: { record?: MonthlyAttendanceRecord; isWeekend: boolean }) {
    const s: AttendanceStatus = record?.stato ?? 'nessun_dato';
    const cfg = STATUS_CONFIG[s];
    return (
        <td className={`p-0 border-b border-gray-100 ${isWeekend ? 'bg-gray-50/60' : ''}`} style={{ width: 38 }}>
            <div className="flex items-center justify-center" style={{ height: 40 }}>
                <span className={`text-[11px] font-black w-6 h-6 rounded-full flex items-center justify-center ${s !== 'nessun_dato' ? `${cfg.bg} ${cfg.text}` : cfg.text}`}>
                    {cfg.short}
                </span>
            </div>
        </td>
    );
}

// ─── Export PDF ───────────────────────────────────────────────────────────────

async function exportPDF(students: StudentMonthData[], days: Date[], month: number, year: number, sezione: string) {
    const { default: jsPDF } = await import('jspdf');
    // @ts-ignore autotable types
    const { default: autoTable } = await import('jspdf-autotable');

    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    // A4 landscape: 297 × 210 mm. Margini 8mm → area utile 281mm.
    const PAGE_W = 281;
    const NAME_COL  = 42;   // nome studente
    const SUMM_COLS = 7;    // P, A, R (3 colonne × 7mm)
    const SUMM_N    = 3;
    const dayColW   = Math.max(5.5, Math.floor((PAGE_W - NAME_COL - SUMM_N * SUMM_COLS) / days.length));

    // ── Banner intestazione ──────────────────────────────────────────
    doc.setFillColor(0, 106, 95);
    doc.rect(0, 0, 297, 20, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(15);
    doc.setFont('helvetica', 'bold');
    doc.text(`REGISTRO PRESENZE — ${MESI[month - 1].toUpperCase()} ${year}`, 10, 13);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Sezione: ${sezione}   |   Esportato il ${new Date().toLocaleDateString('it-IT')}`, 289, 13, { align: 'right' });

    // ── Intestazioni colonne giorni ───────────────────────────────────
    const dayHeaders = days.map(d => {
        const dow = d.getDay();
        const isWe = dow === 0 || dow === 6;
        return {
            content: `${GIORNI[dow][0]}\n${d.getDate()}`,
            styles: {
                halign: 'center' as const,
                fontSize: 7,
                cellWidth: dayColW,
                fillColor: isWe ? [230, 230, 230] as [number,number,number] : [0, 106, 95] as [number,number,number],
                textColor: isWe ? [100, 100, 100] as [number,number,number] : [255, 255, 255] as [number,number,number],
            }
        };
    });

    const head = [[
        { content: 'Studente', styles: { halign: 'left' as const, fontSize: 8, cellWidth: NAME_COL } },
        ...dayHeaders,
        { content: 'P', styles: { halign: 'center' as const, fontSize: 8, cellWidth: SUMM_COLS, fillColor: [46,125,50]  as [number,number,number], textColor: [255,255,255] as [number,number,number] } },
        { content: 'A', styles: { halign: 'center' as const, fontSize: 8, cellWidth: SUMM_COLS, fillColor: [183,28,28]  as [number,number,number], textColor: [255,255,255] as [number,number,number] } },
        { content: 'R', styles: { halign: 'center' as const, fontSize: 8, cellWidth: SUMM_COLS, fillColor: [230,119,0]  as [number,number,number], textColor: [255,255,255] as [number,number,number] } },
    ]];

    // Simboli ASCII (più leggibili nei PDF vs unicode)
    const SIMBOLO: Record<string, string> = { presente: 'P', assente: 'A', ritardo: 'R', uscita_anticipata: 'U' };
    const COLORE_STATO: Record<string, [number,number,number]> = {
        presente:          [200, 230, 201],
        assente:           [255, 205, 210],
        ritardo:           [255, 236, 179],
        uscita_anticipata: [187, 222, 251],
    };

    const body = students.map(student => {
        const s = calcSummary(student);
        const dayCells = days.map(d => {
            const record = student.byDate[toISO(d)];
            const isWe = d.getDay() === 0 || d.getDay() === 6;
            return {
                content: record ? SIMBOLO[record.stato] ?? '' : '',
                styles: {
                    halign: 'center' as const,
                    fontSize: 8,
                    fontStyle: 'bold' as const,
                    fillColor: record
                        ? COLORE_STATO[record.stato]
                        : isWe ? [240, 240, 240] as [number,number,number] : undefined,
                    textColor: record?.stato === 'presente' ? [27,94,32] as [number,number,number]
                        : record?.stato === 'assente'  ? [183,28,28] as [number,number,number]
                        : record?.stato === 'ritardo'  ? [230,119,0] as [number,number,number]
                        : [80,80,80] as [number,number,number],
                }
            };
        });
        return [
            { content: `${student.student_cognome} ${student.student_nome}`, styles: { fontSize: 9, fontStyle: 'bold' as const } },
            ...dayCells,
            { content: String(s.presenze), styles: { halign: 'center' as const, fontSize: 10, fontStyle: 'bold' as const, textColor: [46,125,50]  as [number,number,number] } },
            { content: String(s.assenze),  styles: { halign: 'center' as const, fontSize: 10, fontStyle: 'bold' as const, textColor: [183,28,28] as [number,number,number] } },
            { content: String(s.ritardi),  styles: { halign: 'center' as const, fontSize: 10, fontStyle: 'bold' as const, textColor: [230,119,0]  as [number,number,number] } },
        ];
    });

    autoTable(doc, {
        startY: 24,
        head,
        body,
        theme: 'grid',
        styles: {
            cellPadding: { top: 1.5, bottom: 1.5, left: 1, right: 1 },
            lineColor: [200, 200, 200],
            lineWidth: 0.2,
            minCellHeight: 7,
            overflow: 'hidden',
        },
        headStyles: {
            fillColor: [0, 106, 95],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
            fontSize: 8,
            minCellHeight: 10,
        },
        alternateRowStyles: { fillColor: [252, 250, 248] },
        columnStyles: { 0: { cellWidth: NAME_COL } },
        margin: { left: 8, right: 8, bottom: 12 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        didDrawPage: (data: any) => {
            doc.setFontSize(7);
            doc.setTextColor(160, 160, 160);
            doc.text(
                `Pagina ${data.pageNumber} di ${data.pageCount}  —  Kidville Electronic Register`,
                148, 207, { align: 'center' }
            );
        },
    });

    doc.save(`presenze_${sezione}_${MESI[month-1].toLowerCase()}_${year}.pdf`);
}

// ─── Componente Principale ───────────────────────────────────────────────────

export function MonthlyAttendanceTable({ sezione = 'Girasoli' }: { sezione?: string }) {
    const now = new Date();
    const [year, setYear] = useState(now.getFullYear());
    const [month, setMonth] = useState(now.getMonth() + 1);
    const [students, setStudents] = useState<StudentMonthData[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isExporting, setIsExporting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const days = getDays(year, month);
    const todayISO = toISO(now);

    const fetchData = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            // Carica SEMPRE tutti gli studenti della sezione + presenze del mese in parallelo.
            // Così i mesi senza presenze mostrano comunque la lista completa con celle vuote.
            const [studRes, presRes] = await Promise.all([
                fetch(`/api/diary/students?sezione=${sezione}`, { cache: 'no-store' }),
                fetch(`/api/attendance/monthly?year=${year}&month=${month}&sezione=${sezione}`, { cache: 'no-store' }),
            ]);
            if (!studRes.ok) throw new Error('Errore caricamento studenti');
            const allStudents: RawStudent[] = await studRes.json();
            const records: MonthlyAttendanceRecord[] = presRes.ok ? await presRes.json() : [];
            setStudents(mergeStudentsAndPresences(allStudents, records));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Errore caricamento');
        } finally {
            setIsLoading(false);
        }
    }, [year, month, sezione]);

    useEffect(() => { fetchData(); }, [fetchData]);

    const prevMonth = () => month === 1 ? (setYear(y => y - 1), setMonth(12)) : setMonth(m => m - 1);
    const nextMonth = () => month === 12 ? (setYear(y => y + 1), setMonth(1)) : setMonth(m => m + 1);

    const handleExport = async () => {
        setIsExporting(true);
        try { await exportPDF(students, days, month, year, sezione); }
        finally { setIsExporting(false); }
    };

    const todayPresenti = students.filter(s => s.byDate[todayISO]?.stato === 'presente').length;
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
    const tableMinWidth = 200 + days.length * 38 + 120;

    return (
        <div className="flex flex-col gap-4 w-full">

            {/* ── Header ── */}
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-2">
                    <button onClick={prevMonth} className="w-9 h-9 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center text-gray-500 hover:text-kidville-green transition-all shadow-sm">
                        <ChevronLeft size={16} />
                    </button>
                    <div className="px-2">
                        <h2 className="font-barlow font-black text-2xl uppercase tracking-wide" style={{ color: KV.green }}>
                            {MESI[month - 1]}
                        </h2>
                        <p className="font-maven text-xs text-gray-400">{year}</p>
                    </div>
                    <button onClick={nextMonth} className="w-9 h-9 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center text-gray-500 hover:text-kidville-green transition-all shadow-sm">
                        <ChevronRight size={16} />
                    </button>
                </div>

                <div className="flex items-center gap-2">
                    {isCurrentMonth && !isLoading && students.length > 0 && (
                        <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-1.5">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                            <span className="font-maven text-xs text-emerald-700 font-medium">{todayPresenti}/{students.length} oggi</span>
                        </div>
                    )}
                    <button onClick={fetchData} disabled={isLoading} className="w-9 h-9 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center text-gray-400 hover:text-kidville-green transition-all shadow-sm disabled:opacity-40">
                        <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
                    </button>
                    <button
                        onClick={handleExport}
                        disabled={isExporting || students.length === 0}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl text-white font-maven font-semibold text-sm shadow-sm hover:opacity-90 transition-all disabled:opacity-40"
                        style={{ background: KV.green }}
                    >
                        <Download size={15} />
                        {isExporting ? 'Generazione…' : 'Esporta PDF'}
                    </button>
                </div>
            </div>

            {/* ── Errore ── */}
            <AnimatePresence>
                {error && (
                    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                        className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
                        <AlertCircle size={16} className="text-red-500 flex-shrink-0" />
                        <p className="font-maven text-sm text-red-600">{error}</p>
                        <button onClick={fetchData} className="ml-auto font-maven text-xs text-red-500 hover:text-red-700 underline">Riprova</button>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ── Tabella ── */}
            <div className="w-full rounded-2xl overflow-hidden border border-gray-200 shadow-sm bg-white">
                <div className="overflow-x-auto" style={{ maxHeight: 'calc(100vh - 320px)' }}>
                    <table className="border-collapse w-full" style={{ minWidth: tableMinWidth }}>
                        <thead>
                            <tr>
                                {/* Sticky corner */}
                                <th style={{ position: 'sticky', top: 0, left: 0, zIndex: 30, width: 200, background: KV.green }}
                                    className="text-left px-4 py-3 font-barlow font-bold text-xs text-white uppercase tracking-widest border-b border-r border-white/20">
                                    Studente
                                </th>
                                {days.map(day => {
                                    const dow = day.getDay();
                                    const isWeekend = dow === 0 || dow === 6;
                                    const isToday = toISO(day) === todayISO;
                                    return (
                                        <th key={toISO(day)} style={{ position: 'sticky', top: 0, zIndex: 20, width: 38, background: isToday ? KV.green : isWeekend ? '#F5F5F5' : 'white' }}
                                            className="border-b border-gray-200 text-center font-barlow font-bold">
                                            <div className={`flex flex-col items-center py-2 gap-0.5 ${isToday ? 'text-white' : isWeekend ? 'text-gray-400' : 'text-gray-500'}`}>
                                                <span className="text-[8px] uppercase tracking-wider font-maven">{GIORNI[dow]}</span>
                                                <span className={`text-xs font-black ${isToday ? 'bg-white/20 w-5 h-5 rounded-full flex items-center justify-center' : ''}`}>{day.getDate()}</span>
                                            </div>
                                        </th>
                                    );
                                })}
                                {/* Summary header — sticky right */}
                                <th style={{ position: 'sticky', top: 0, right: 0, zIndex: 25, width: 120, background: KV.green }}
                                    className="border-b border-l border-white/20 text-center">
                                    <div className="flex justify-around py-3 px-2">
                                        {['P','A','R','U'].map(l => <span key={l} className="text-white/80 text-[10px] font-barlow font-black">{l}</span>)}
                                    </div>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {isLoading ? (
                                <tr><td colSpan={days.length + 2}>
                                    <div className="flex items-center justify-center py-20">
                                        <div className="w-8 h-8 border-3 rounded-full animate-spin" style={{ borderColor: `${KV.cream}`, borderTopColor: KV.green }} />
                                    </div>
                                </td></tr>
                            ) : students.length === 0 ? (
                                <tr><td colSpan={days.length + 2}>
                                    <div className="flex flex-col items-center justify-center py-20 gap-3">
                                        <span className="text-5xl opacity-20">👶</span>
                                        <p className="font-maven text-sm text-gray-400">Nessun alunno nella sezione <strong>{sezione}</strong></p>
                                    </div>
                                </td></tr>
                            ) : students.map((student, idx) => {
                                const s = calcSummary(student);
                                const rowBg = idx % 2 !== 0 ? '#FAFAF9' : 'white';
                                return (
                                    <tr key={student.student_id} className="group hover:bg-green-50/40 transition-colors">
                                        {/* Sticky left — nome */}
                                        <td style={{ position: 'sticky', left: 0, zIndex: 10, width: 200, background: rowBg }}
                                            className="border-r border-gray-100 px-4 group-hover:bg-green-50/60 transition-colors border-b border-gray-100">
                                            <div className="flex items-center gap-2.5 py-1.5">
                                                <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center font-barlow font-black text-xs text-white"
                                                    style={{ background: KV.green }}>
                                                    {student.student_nome[0]}{student.student_cognome[0]}
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="font-maven font-bold text-xs truncate" style={{ color: KV.green }}>{student.student_cognome}</p>
                                                    <p className="font-maven text-[10px] text-gray-400 truncate">{student.student_nome}</p>
                                                </div>
                                            </div>
                                        </td>
                                        {/* Celle giorni */}
                                        {days.map(day => (
                                            <Cell key={toISO(day)} record={student.byDate[toISO(day)]} isWeekend={day.getDay()===0||day.getDay()===6} />
                                        ))}
                                        {/* Summary — sticky right */}
                                        <td style={{ position: 'sticky', right: 0, zIndex: 10, width: 120, background: rowBg }}
                                            className="border-b border-l border-gray-100 group-hover:bg-green-50/60 transition-colors">
                                            <div className="flex items-center justify-around px-2 py-1.5">
                                                <div className="flex flex-col items-center">
                                                    <span className="font-barlow font-black text-sm text-emerald-600">{s.presenze}</span>
                                                    <span className="font-maven text-[8px] text-gray-300">P</span>
                                                </div>
                                                <div className="w-px h-5 bg-gray-100"/>
                                                <div className="flex flex-col items-center">
                                                    <span className="font-barlow font-black text-sm text-red-500">{s.assenze}</span>
                                                    <span className="font-maven text-[8px] text-gray-300">A</span>
                                                </div>
                                                <div className="w-px h-5 bg-gray-100"/>
                                                <div className="flex flex-col items-center">
                                                    <span className="font-barlow font-black text-sm text-amber-500">{s.ritardi}</span>
                                                    <span className="font-maven text-[8px] text-gray-300">R</span>
                                                </div>
                                                <div className="w-px h-5 bg-gray-100"/>
                                                <div className="flex flex-col items-center">
                                                    <span className="font-barlow font-black text-sm text-blue-500">{s.uscite}</span>
                                                    <span className="font-maven text-[8px] text-gray-300">U</span>
                                                </div>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* ── Legenda ── */}
            <div className="flex flex-wrap items-center justify-between gap-4 px-1">
                <div className="flex flex-wrap gap-4">
                    {(['presente','assente','ritardo','uscita_anticipata'] as AttendanceStatus[]).map(s => {
                        const cfg = STATUS_CONFIG[s];
                        const label = s === 'uscita_anticipata' ? 'Uscita Ant.' : s.charAt(0).toUpperCase() + s.slice(1);
                        return (
                            <div key={s} className="flex items-center gap-1.5">
                                <span className={`w-4 h-4 rounded-full ${cfg.dot}`} />
                                <span className="font-maven text-xs text-gray-500">{label}</span>
                            </div>
                        );
                    })}
                </div>
                {!isLoading && students.length > 0 && (
                    <div className="flex gap-5">
                        {[
                            { label: 'Presenze', key: 'presenze', color: 'text-emerald-600' },
                            { label: 'Assenze',  key: 'assenze',  color: 'text-red-500' },
                            { label: 'Ritardi',  key: 'ritardi',  color: 'text-amber-500' },
                        ].map(({ label, key, color }) => {
                            const count = students.reduce((acc, st) => acc + (calcSummary(st) as unknown as Record<string,number>)[key], 0);
                            return (
                                <div key={key} className="text-center">
                                    <p className={`font-barlow font-black text-2xl ${color}`}>{count}</p>
                                    <p className="font-maven text-[10px] text-gray-400 uppercase tracking-wide">{label}</p>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
