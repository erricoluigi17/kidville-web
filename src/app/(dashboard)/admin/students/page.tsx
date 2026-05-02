'use client';

import { useState, useEffect } from 'react';
import { Search, Filter, UserPlus, Users, LayoutGrid, List, FileDown, MoreHorizontal, CheckCircle2 } from 'lucide-react';
import { StudentTable } from '@/components/features/admin/StudentTable';
import { StudentDetailPanel } from '@/components/features/admin/StudentDetailPanel';
import { BulkAssignBar } from '@/components/features/admin/BulkAssignBar';

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';

interface Student {
  id: string;
  nome: string;
  cognome: string;
  data_nascita: string;
  classe_sezione: string | null;
  stato: string;
  note_mediche: string | null;
  codice_fiscale: string | null;
  bes?: boolean;
  note_bes?: string | null;
}

const AVAILABLE_CLASSES = ['Girasoli', 'Margherite', 'Tulipani', 'Coccinelle', 'Leoni', 'Delfini'];

export default function AdminStudentsPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [filteredStudents, setFilteredStudents] = useState<Student[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterClass, setFilterClass] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [targetClass, setTargetClass] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');

  useEffect(() => {
    fetchStudents();
  }, []);

  useEffect(() => {
    let result = [...students];
    
    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      result = result.filter(s => 
        s.nome.toLowerCase().includes(search) || 
        s.cognome.toLowerCase().includes(search) ||
        (s.codice_fiscale && s.codice_fiscale.toLowerCase().includes(search))
      );
    }
    
    if (filterClass !== 'all') {
      result = result.filter(s => s.classe_sezione === filterClass);
    }
    
    if (filterStatus !== 'all') {
      result = result.filter(s => s.stato === filterStatus);
    }
    
    setFilteredStudents(result);
  }, [searchTerm, filterClass, filterStatus, students]);

  const fetchStudents = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/admin/students?scuola_id=${SCUOLA_ID}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setStudents(data);
      }
    } catch (err) {
      console.error('Errore caricamento alunni:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const handleToggleSelectAll = () => {
    if (selectedIds.size === filteredStudents.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredStudents.map(s => s.id)));
    }
  };

  const handleSaveStudent = async (data: Partial<Student> & { id: string }) => {
    try {
      const res = await fetch('/api/admin/students', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Errore salvataggio');
      
      showToastMsg('✅ Alunno aggiornato con successo');
      fetchStudents();
      setSelectedStudent(null);
    } catch (err) {
      console.error('Errore:', err);
      showToastMsg('❌ Errore nel salvataggio');
    }
  };

  const handleDeleteStudent = async (id: string) => {
    try {
      const res = await fetch('/api/admin/students', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error('Errore eliminazione');
      
      showToastMsg('✅ Alunno eliminato definitivamente (GDPR)');
      fetchStudents();
      setSelectedStudent(null);
    } catch (err) {
      console.error('Errore:', err);
      showToastMsg('❌ Errore nell\'eliminazione');
    }
  };

  const handleBulkAssign = async () => {
    if (!targetClass || selectedIds.size === 0) return;
    setIsAssigning(true);
    try {
      const res = await fetch('/api/admin/students', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: Array.from(selectedIds),
          classe_sezione: targetClass
        }),
      });
      if (!res.ok) throw new Error('Errore bulk assign');
      
      showToastMsg(`✅ ${selectedIds.size} alunni assegnati a ${targetClass}`);
      fetchStudents();
      setSelectedIds(new Set());
      setTargetClass('');
    } catch (err) {
      console.error('Errore bulk assign:', err);
      showToastMsg('❌ Errore nell\'assegnazione massiva');
    } finally {
      setIsAssigning(false);
    }
  };

  const showToastMsg = (msg: string) => {
    setToastMessage(msg);
    setShowToast(true);
    setTimeout(() => setShowToast(false), 3000);
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
        <p className="font-maven text-gray-500">Caricamento anagrafica...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col p-6 max-w-6xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
            <Users size={28} /> Anagrafica Alunni
          </h1>
          <p className="font-maven text-gray-500 mt-1">
            Gestione studenti, classi e dati medico-didattici
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl font-maven text-sm font-semibold text-gray-600 hover:border-kidville-green hover:text-kidville-green transition-colors">
            <FileDown size={16} /> Esporta
          </button>
          <button className="flex items-center gap-2 px-4 py-2 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase tracking-wide text-sm hover:opacity-90 transition-all shadow-md">
            <UserPlus size={18} /> Nuovo Alunno
          </button>
        </div>
      </div>

      {/* Toolbar / Filtri */}
      <div className="bg-white rounded-2xl p-4 shadow-sm mb-6 flex flex-col md:flex-row gap-4 items-center">
        {/* Search */}
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input
            type="text"
            placeholder="Cerca per nome, cognome o codice fiscale..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border-2 border-gray-100 rounded-xl font-maven text-sm focus:outline-none focus:border-kidville-green transition-colors"
          />
        </div>
        
        {/* Filtro Classe */}
        <div className="flex items-center gap-2 w-full md:w-auto">
          <Filter size={16} className="text-gray-400" />
          <select
            value={filterClass}
            onChange={e => setFilterClass(e.target.value)}
            className="flex-1 md:w-40 border-2 border-gray-100 rounded-xl px-3 py-2 font-maven text-sm text-gray-600 focus:outline-none focus:border-kidville-green bg-white"
          >
            <option value="all">Tutte le classi</option>
            {AVAILABLE_CLASSES.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
            <option value="">Non assegnata</option>
          </select>
        </div>

        {/* Filtro Stato */}
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className="w-full md:w-40 border-2 border-gray-100 rounded-xl px-3 py-2 font-maven text-sm text-gray-600 focus:outline-none focus:border-kidville-green bg-white"
        >
          <option value="all">Tutti gli stati</option>
          <option value="iscritto">Iscritto</option>
          <option value="ritirato">Ritirato</option>
          <option value="sospeso">Sospeso</option>
        </select>
      </div>

      {/* Statistiche rapide */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white p-4 rounded-2xl shadow-sm border-l-4 border-kidville-green">
          <p className="font-maven text-xs text-gray-400 uppercase font-bold tracking-wider">Totale Alunni</p>
          <p className="font-barlow font-black text-2xl text-kidville-green">{students.length}</p>
        </div>
        <div className="bg-white p-4 rounded-2xl shadow-sm border-l-4 border-emerald-500">
          <p className="font-maven text-xs text-gray-400 uppercase font-bold tracking-wider">Iscritti</p>
          <p className="font-barlow font-black text-2xl text-emerald-600">{students.filter(s => s.stato === 'iscritto').length}</p>
        </div>
        <div className="bg-white p-4 rounded-2xl shadow-sm border-l-4 border-amber-500">
          <p className="font-maven text-xs text-gray-400 uppercase font-bold tracking-wider">Con BES</p>
          <p className="font-barlow font-black text-2xl text-amber-600">{students.filter(s => s.bes).length}</p>
        </div>
        <div className="bg-white p-4 rounded-2xl shadow-sm border-l-4 border-red-500">
          <p className="font-maven text-xs text-gray-400 uppercase font-bold tracking-wider">Con Allergie</p>
          <p className="font-barlow font-black text-2xl text-red-600">{students.filter(s => s.note_mediche).length}</p>
        </div>
      </div>

      {/* Tabella */}
      <StudentTable
        students={filteredStudents}
        selectedIds={selectedIds}
        onToggleSelect={handleToggleSelect}
        onToggleSelectAll={handleToggleSelectAll}
        onStudentClick={setSelectedStudent}
      />

      {/* Floating Bulk Bar */}
      <BulkAssignBar
        selectedCount={selectedIds.size}
        availableClasses={AVAILABLE_CLASSES}
        targetClass={targetClass}
        onTargetClassChange={setTargetClass}
        onAssign={handleBulkAssign}
        onClear={() => setSelectedIds(new Set())}
        isAssigning={isAssigning}
      />

      {/* Detail Panel */}
      <StudentDetailPanel
        student={selectedStudent}
        onClose={() => setSelectedStudent(null)}
        onSave={handleSaveStudent}
        onDelete={handleDeleteStudent}
      />

      {/* Toast */}
      {showToast && (
        <div className="fixed bottom-6 right-6 z-[60] bg-gray-900 text-white font-maven font-semibold px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3 animate-[slideInRight_0.3s_ease-out]">
          {toastMessage}
        </div>
      )}

      <style jsx global>{`
        @keyframes slideUp {
          from { transform: translate(-50%, 100%); opacity: 0; }
          to { transform: translate(-50%, 0); opacity: 1; }
        }
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
