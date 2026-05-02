'use client';

import { useState } from 'react';

const MOCK_STUDENTS = [
    { id: '1', name: 'Rossi Mario', votes: [8, 'Avanzato'] },
    { id: '2', name: 'Bianchi Giulia', votes: [7] },
    { id: '3', name: 'Verdi Luca', votes: [] },
];

export default function GradesTab() {
    const [selectedStudent, setSelectedStudent] = useState<string | null>(null);

    return (
        <div>
            <div className="flex justify-between items-center mb-4">
                <h2 className="font-barlow font-bold text-2xl text-kidville-green">Valutazioni - Italiano</h2>
                <button className="h-10 px-4 font-maven font-medium rounded-pill bg-kidville-yellow text-kidville-green hover:opacity-90">
                    Aggiungi Voto +
                </button>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="border-b-2 border-gray-100">
                            <th className="py-3 px-2 font-barlow text-kidville-green text-lg">Alunno</th>
                            <th className="py-3 px-2 font-barlow text-kidville-green text-lg">Media</th>
                            <th className="py-3 px-2 font-barlow text-kidville-green text-lg">Voti Recenti</th>
                        </tr>
                    </thead>
                    <tbody>
                        {MOCK_STUDENTS.map(student => (
                            <tr key={student.id} className="border-b border-gray-50 hover:bg-kidville-cream/30 transition-colors">
                                <td className="py-3 px-2 font-maven font-semibold text-gray-800">{student.name}</td>
                                <td className="py-3 px-2 font-maven text-gray-600">
                                    {student.votes.length > 0 ? '7.5' : '-'}
                                </td>
                                <td className="py-3 px-2 flex gap-2">
                                    {student.votes.map((v, i) => (
                                        <span key={i} className="inline-flex items-center justify-center min-w-[32px] h-8 px-2 bg-kidville-green text-white rounded-md font-maven text-sm">
                                            {v}
                                        </span>
                                    ))}
                                    {student.votes.length === 0 && <span className="text-gray-400 text-sm italic">Nessun voto</span>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <p className="text-xs text-gray-500 mt-6 bg-yellow-50 p-3 rounded-xl border border-yellow-100">
                <strong>Nota:</strong> I voti inseriti diventano visibili ai genitori dopo 10 minuti (Buffer Notifica), permettendo eventuali correzioni.
            </p>
        </div>
    );
}
