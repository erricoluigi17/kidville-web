'use client';

import { LocalAttendanceLog } from '@/lib/offline/db';
import { User, Clock, CheckCircle } from 'lucide-react';

interface Student {
    id: string;
    firstName: string;
    lastName: string;
}

interface Props {
    student: Student;
    attendanceLog?: LocalAttendanceLog;
    onTogglePresence: (studentId: string, isPresent: boolean) => void;
    onCheckoutClick: (studentId: string) => void;
}

export function StudentAttendanceRow({ student, attendanceLog, onTogglePresence, onCheckoutClick }: Props) {
    const isPresent = attendanceLog?.stato === 'presente';
    const checkInTime = attendanceLog?.orario_entrata 
        ? new Date(attendanceLog.orario_entrata).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
        : null;

    return (
        <div className="bg-kidville-white p-4 rounded-card shadow-sm mb-3 flex items-center justify-between border-l-4 border-l-transparent transition-colors hover:bg-gray-50"
             style={{ borderLeftColor: isPresent ? 'var(--color-kidville-success)' : 'transparent' }}>
            
            <div className="flex items-center gap-3">
                <div className="bg-kidville-cream w-10 h-10 rounded-full flex items-center justify-center text-kidville-green">
                    <User size={20} />
                </div>
                <div>
                    <h3 className="font-barlow font-semibold text-lg text-kidville-green uppercase tracking-wide">
                        {student.firstName} {student.lastName}
                    </h3>
                    {isPresent && checkInTime && (
                        <div className="flex items-center text-sm text-gray-500 font-maven mt-0.5">
                            <Clock size={14} className="mr-1" />
                            Ingresso: {checkInTime}
                        </div>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-2">
                <button 
                    onClick={() => onTogglePresence(student.id, !isPresent)}
                    className={`h-10 px-4 font-maven font-medium rounded-pill transition-all flex items-center gap-2
                        ${isPresent 
                            ? 'bg-kidville-success text-white' 
                            : 'bg-kidville-cream text-kidville-green hover:bg-kidville-green hover:text-kidville-yellow'}`}
                >
                    {isPresent ? (
                        <>
                            <CheckCircle size={18} /> Presente
                        </>
                    ) : (
                        'Segna Presente'
                    )}
                </button>

                {isPresent && !attendanceLog?.orario_uscita && (
                    <button 
                        onClick={() => onCheckoutClick(student.id)}
                        className="h-10 px-4 font-maven font-medium rounded-pill bg-kidville-yellow text-kidville-green hover:opacity-90 transition-opacity"
                    >
                        Uscita
                    </button>
                )}
            </div>
        </div>
    );
}
