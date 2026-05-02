'use client';

import { useState } from 'react';

const MOCK_STUDENTS = [
    { id: '1', name: 'Rossi Mario' },
    { id: '2', name: 'Bianchi Giulia' },
    { id: '3', name: 'Verdi Luca' },
];

export default function NotesTab() {
    const [selectedStudents, setSelectedStudents] = useState<string[]>([]);

    const toggleStudent = (id: string) => {
        if (selectedStudents.includes(id)) {
            setSelectedStudents(selectedStudents.filter(s => s !== id));
        } else {
            setSelectedStudents([...selectedStudents, id]);
        }
    };

    const selectAll = () => {
        if (selectedStudents.length === MOCK_STUDENTS.length) {
            setSelectedStudents([]);
        } else {
            setSelectedStudents(MOCK_STUDENTS.map(s => s.id));
        }
    };

    return (
        <div>
            <h2 className="font-barlow font-bold text-2xl text-kidville-green mb-4">Note Disciplinari e Didattiche</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                
                {/* Selezione Alunni */}
                <div className="border border-gray-200 rounded-xl p-4">
                    <div className="flex justify-between items-center mb-3">
                        <h3 className="font-maven font-semibold text-gray-700">Seleziona Alunni</h3>
                        <button onClick={selectAll} className="text-sm text-kidville-green underline font-maven">
                            {selectedStudents.length === MOCK_STUDENTS.length ? 'Deseleziona Tutti' : 'Seleziona Tutti'}
                        </button>
                    </div>
                    <div className="flex flex-col gap-2 max-h-[250px] overflow-y-auto">
                        {MOCK_STUDENTS.map(student => (
                            <label key={student.id} className="flex items-center gap-3 p-2 hover:bg-gray-50 rounded-lg cursor-pointer">
                                <input 
                                    type="checkbox" 
                                    checked={selectedStudents.includes(student.id)}
                                    onChange={() => toggleStudent(student.id)}
                                    className="w-5 h-5 accent-kidville-green"
                                />
                                <span className="font-maven">{student.name}</span>
                            </label>
                        ))}
                    </div>
                </div>

                {/* Form Inserimento */}
                <div className="flex flex-col gap-4">
                    <div>
                        <label className="block font-maven text-gray-700 mb-1">Categoria Nota</label>
                        <select className="w-full border border-gray-200 p-3 rounded-xl font-maven focus:ring-kidville-green focus:border-kidville-green">
                            <option value="disciplinare">Nota Disciplinare</option>
                            <option value="didattica">Nota Didattica</option>
                            <option value="compiti">Compiti non svolti</option>
                        </select>
                    </div>
                    
                    <div>
                        <label className="block font-maven text-gray-700 mb-1">Testo della nota</label>
                        <textarea 
                            className="w-full border border-gray-200 p-3 rounded-xl font-maven h-28 resize-none focus:ring-kidville-green focus:border-kidville-green"
                            placeholder="Descrivi l'accaduto..."
                        ></textarea>
                    </div>

                    <label className="flex items-center gap-2">
                        <input type="checkbox" defaultChecked className="w-4 h-4 accent-kidville-green" />
                        <span className="font-maven text-sm text-gray-700">Richiedi Firma per Presa Visione</span>
                    </label>

                    <button 
                        disabled={selectedStudents.length === 0}
                        className="h-12 w-full font-barlow font-bold text-xl rounded-pill bg-kidville-error text-white hover:bg-red-700 disabled:opacity-50 transition-colors mt-auto"
                    >
                        Assegna Nota ({selectedStudents.length})
                    </button>
                </div>

            </div>
        </div>
    );
}
