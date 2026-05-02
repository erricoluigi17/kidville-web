'use client';

import { useState, useEffect } from 'react';
import { db, LocalAttendanceLog, LocalDelegate } from '@/lib/offline/db';
import { saveLocalAttendanceLog } from '@/lib/offline/syncEngine';
import { StudentAttendanceRow } from '@/components/features/teacher/StudentAttendanceRow';
import { CheckoutModal } from '@/components/features/teacher/CheckoutModal';

const MOCK_STUDENTS = [
    { id: '1', firstName: 'Mario', lastName: 'Rossi' },
    { id: '2', firstName: 'Giulia', lastName: 'Bianchi' },
];

const MOCK_DELEGATES: LocalDelegate[] = [
    { id: 'd1', alunno_id: '1', nome: 'Nonno Franco', relazione: 'Nonno', foto_url: null }
];

export default function TeacherAttendancePage() {
    const [logs, setLogs] = useState<Record<string, LocalAttendanceLog>>({});
    const [selectedCheckout, setSelectedCheckout] = useState<string | null>(null);

    useEffect(() => {
        const loadLogs = async () => {
            const today = new Date().toISOString().split('T')[0];
            const todaysLogs = await db.presenze.where('data').equals(today).toArray();
            const logMap: Record<string, LocalAttendanceLog> = {};
            todaysLogs.forEach(log => { logMap[log.alunno_id] = log; });
            setLogs(logMap);
        };
        loadLogs();
    }, []);

    const handleTogglePresence = async (studentId: string, isPresent: boolean) => {
        const today = new Date().toISOString().split('T')[0];
        const logData: Omit<LocalAttendanceLog, 'sync_status'> = {
            id: crypto.randomUUID(),
            alunno_id: studentId,
            data: today,
            orario_entrata: isPresent ? new Date().toISOString() : null,
            orario_uscita: null,
            stato: isPresent ? 'presente' : 'assente',
            panic_alert: false,
            aggiornato_il: new Date().toISOString()
        };

        setLogs(prev => ({ ...prev, [studentId]: { ...logData, sync_status: 'pending' } }));
        await saveLocalAttendanceLog(logData);
    };

    const handlePanicAlert = async () => {
        if (!selectedCheckout) return;
        
        try {
            const response = await fetch('/api/panic-alert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alunnoId: selectedCheckout })
            });

            if (response.ok) {
                alert('ALLARME INVIATO CON SUCCESSO!');
                setSelectedCheckout(null);
            } else {
                alert('Errore invio allarme. Verifica connessione.');
            }
        } catch (e) {
            alert('Errore di rete. Allarme non inviato.');
        }
    };

    const handleConfirmCheckout = async (delegateId?: string) => {
        if (!selectedCheckout) return;
        const currentLog = logs[selectedCheckout];
        if (!currentLog) return;

        const updatedLog = {
            ...currentLog,
            orario_uscita: new Date().toISOString(),
            aggiornato_il: new Date().toISOString()
        };

        setLogs(prev => ({ ...prev, [selectedCheckout]: updatedLog }));
        await saveLocalAttendanceLog(updatedLog);
        setSelectedCheckout(null);
    };

    const checkoutStudent = MOCK_STUDENTS.find(s => s.id === selectedCheckout);
    const studentDelegates = MOCK_DELEGATES.filter(d => d.alunno_id === selectedCheckout);

    return (
        <div className="max-w-3xl mx-auto p-4 sm:p-6">
            <div className="mb-6">
                <h1 className="font-barlow font-bold text-3xl text-kidville-green uppercase tracking-wide">
                    Registro Presenze
                </h1>
                <p className="font-maven text-gray-500 mt-1">Sezione Girasoli • {new Date().toLocaleDateString('it-IT')}</p>
            </div>

            <div className="flex flex-col gap-2">
                {MOCK_STUDENTS.map(student => (
                    <StudentAttendanceRow 
                        key={student.id}
                        student={student}
                        attendanceLog={logs[student.id]}
                        onTogglePresence={handleTogglePresence}
                        onCheckoutClick={setSelectedCheckout}
                    />
                ))}
            </div>

            {selectedCheckout && checkoutStudent && (
                <CheckoutModal 
                    studentName={`${checkoutStudent.firstName} ${checkoutStudent.lastName}`}
                    delegates={studentDelegates}
                    onClose={() => setSelectedCheckout(null)}
                    onConfirmCheckout={handleConfirmCheckout}
                    onPanicAlert={handlePanicAlert}
                />
            )}
        </div>
    );
}
