'use client';

import { useState, useEffect } from 'react';
import { Package, AlertTriangle, RefreshCw, Users, ChevronDown, ChevronRight } from 'lucide-react';
import { InventoryCard } from '@/components/features/teacher/locker/InventoryCard';
import { LoadStockModal } from '@/components/features/teacher/locker/LoadStockModal';

const SEZIONE = 'Girasoli';

interface InventoryItem {
    alunno_id: string;
    materiale: string;
    quantita: number;
    unita: string;
    livello_allerta: number | string;
    livello_emergenza: number | string;
}

interface StudentWithInventory {
    id: string;
    nome: string;
    cognome: string;
    inventario: InventoryItem[];
}

export default function TeacherLockerPage() {
    const [students, setStudents] = useState<StudentWithInventory[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [expandedStudent, setExpandedStudent] = useState<string | null>(null);
    const [showLoadModal, setShowLoadModal] = useState(false);
    const [preselectedStudent, setPreselectedStudent] = useState<string>('');
    const [preselectedMateriale, setPreselectedMateriale] = useState<string>('');

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        setIsLoading(true);
        try {
            const res = await fetch(`/api/locker/inventory?classe_sezione=${SEZIONE}`);
            const data = await res.json();
            if (Array.isArray(data)) {
                setStudents(data);
                if (data.length > 0) setExpandedStudent(data[0].id);
            }
        } catch (err) {
            console.error(err);
        } finally {
            setIsLoading(false);
        }
    };

    const handleLoadStock = async (data: { alunno_id: string; materiale: string; quantita: number }) => {
        try {
            const res = await fetch('/api/locker/inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Errore salvataggio');
            }
            alert('✅ Carico registrato con successo!');
            fetchData();
        } catch (err: any) {
            console.error(err);
            alert('❌ Errore: ' + err.message);
        }
    };

    if (isLoading) return <div className="p-10 text-center font-maven">Caricamento...</div>;

    return (
        <div className="max-w-2xl mx-auto p-4 sm:p-6">
            <div className="flex items-center justify-between mb-6">
                <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase flex items-center gap-2">
                    <Package size={28} /> Armadietto
                </h1>
                <button onClick={fetchData} className="p-2 border rounded-xl text-gray-400"><RefreshCw size={18} /></button>
            </div>

            <button
                onClick={() => { setPreselectedStudent(''); setPreselectedMateriale(''); setShowLoadModal(true); }}
                className="w-full mb-6 py-3 bg-kidville-green text-kidville-yellow rounded-2xl font-barlow font-black uppercase shadow-lg"
            >
                Registra Nuovo Carico
            </button>

            <div className="space-y-3">
                {students.map(student => {
                    const isExpanded = expandedStudent === student.id;
                    const alerts = student.inventario.filter(i => i.quantita <= (parseInt(i.livello_allerta as string) || 5)).length;

                    return (
                        <div key={student.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                            <button
                                onClick={() => setExpandedStudent(isExpanded ? null : student.id)}
                                className="w-full flex items-center gap-3 p-4 hover:bg-gray-50"
                            >
                                <div className="w-10 h-10 rounded-full bg-kidville-cream text-kidville-green flex items-center justify-center font-black">
                                    {student.nome[0]}{student.cognome[0]}
                                </div>
                                <div className="flex-1 text-left">
                                    <p className="font-maven font-bold text-kidville-green">{student.nome} {student.cognome}</p>
                                    <p className="text-xs text-gray-400">{student.inventario.length} materiali</p>
                                </div>
                                {alerts > 0 && <span className="bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">{alerts} ALERT</span>}
                                {isExpanded ? <ChevronDown size={18} className="text-gray-300" /> : <ChevronRight size={18} className="text-gray-300" />}
                            </button>

                            {isExpanded && (
                                <div className="p-4 bg-gray-50/50 border-t border-gray-100 space-y-2">
                                    {student.inventario.length > 0 ? (
                                        student.inventario.map((item, idx) => (
                                            <InventoryCard
                                                key={idx}
                                                item={item}
                                                onLoad={() => {
                                                    setPreselectedStudent(student.id);
                                                    setPreselectedMateriale(item.materiale);
                                                    setShowLoadModal(true);
                                                }}
                                            />
                                        ))
                                    ) : (
                                        <p className="text-center py-4 text-gray-400 text-sm">Nessun dato</p>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            <LoadStockModal
                isOpen={showLoadModal}
                onClose={() => setShowLoadModal(false)}
                students={students.map(s => ({ id: s.id, nome: s.nome, cognome: s.cognome }))}
                preselectedStudent={preselectedStudent}
                preselectedMateriale={preselectedMateriale}
                onConfirm={handleLoadStock}
            />
        </div>
    );
}
