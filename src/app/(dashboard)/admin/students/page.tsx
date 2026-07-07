'use client';

import { Suspense, useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, Filter, UserPlus, Users, FileDown, CheckCircle2, GraduationCap, Briefcase, AlertTriangle } from 'lucide-react';
import { StudentTable } from '@/components/features/admin/StudentTable';
import { BulkAssignBar } from '@/components/features/admin/BulkAssignBar';
import { SectionsView } from '@/components/features/admin/SectionsView';
import { CockpitPage, PageHeader, Tabs, StatCard } from '@/components/ui/cockpit';
import { btnClass } from '@/components/ui/Btn';
import { useSediAttive } from '@/lib/context/sede-context';

interface Student {
  id: string;
  nome?: string;
  cognome?: string;
  first_name?: string;
  last_name?: string;
  data_nascita?: string;
  classe_sezione?: string | null;
  stato?: string;
  note_mediche?: string | null;
  codice_fiscale?: string | null;
  fiscal_code?: string | null;
  bes?: boolean;
  note_bes?: string | null;
  emails?: string[];
  phone_numbers?: string[];
}



function AdminStudentsInner() {
  // Tab iniziale dal query param (?tab=sections: back-link dal dettaglio sezione).
  const search = useSearchParams();
  const router = useRouter();
  const userId = search.get('userId');
  const { reFetchKey } = useSediAttive();
  const [students, setStudents] = useState<Student[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterClass, setFilterClass] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [viewType, setViewType] = useState<'child' | 'adult' | 'sections' | 'staff'>(() => {
    const t = search.get('tab');
    return t === 'adult' || t === 'sections' || t === 'staff' ? t : 'child';
  });
  
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [targetClass, setTargetClass] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [availableSections, setAvailableSections] = useState<{id: string, name: string, school_type: string}[]>([]);
  // P5.4 (DL-050): gruppi mensa per la bulk assign
  const [mensaGroups, setMensaGroups] = useState<{ id: string; nome: string }[]>([]);
  const [targetMensa, setTargetMensa] = useState('');

  // Carica sezioni disponibili. `x-sedi` = chiave di re-fetch al cambio sedi
  // attive (il server scopa dal cookie); così reFetchKey è referenziato (deps).
  useEffect(() => {
    const hdr = { 'x-sedi': reFetchKey };
    fetch('/api/admin/sections', { headers: hdr }).then(r => r.json()).then(d => { if (Array.isArray(d)) setAvailableSections(d); }).catch(() => {});
    fetch('/api/admin/gruppi-mensa', { headers: hdr }).then(r => r.json()).then(d => { if (d?.success) setMensaGroups(d.data ?? []); }).catch(() => {});
  }, [reFetchKey]);

  const fetchStudents = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/students?limit=1000`, { headers: { 'x-sedi': reFetchKey } });
      const data = await res.json();
      if (Array.isArray(data)) {
        setStudents(data);
      }
    } finally {
      setIsLoading(false);
    }
  }, [reFetchKey]);

  const fetchParents = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/parents`, { headers: { 'x-sedi': reFetchKey } });
      const data = await res.json();
      if (Array.isArray(data)) {
        setStudents(data);
      }
    } finally {
      setIsLoading(false);
    }
  }, [reFetchKey]);

  const fetchStaff = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/parents`, { headers: { 'x-sedi': reFetchKey } });
      const data = await res.json();
      if (Array.isArray(data)) {
        // Filtra solo educatori e coordinatori (memorizzati in citizenship come workaround)
        setStudents(data.filter((d: { citizenship?: string }) => ['educator', 'coordinator', 'admin'].includes(d.citizenship ?? '')));
      }
    } finally {
      setIsLoading(false);
    }
  }, [reFetchKey]);

  // NB: lo spinner viene attivato dal cambio tab (onChange dei Tabs), non qui:
  // setState sincrono negli effect è vietato (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (viewType === 'child') {
      fetchStudents();
    } else if (viewType === 'adult') {
      fetchParents();
    } else if (viewType === 'staff') {
      fetchStaff();
    }
    // sections tab handles its own loading
  }, [viewType, fetchStudents, fetchParents, fetchStaff]);

  // Lista filtrata derivata (niente state+effect: stessa resa, zero cascading render)
  const filteredStudents = useMemo(() => {
    let result = [...students];

    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      result = result.filter(s =>
        (s.nome && s.nome.toLowerCase().includes(search)) ||
        (s.cognome && s.cognome.toLowerCase().includes(search)) ||
        (s.first_name && s.first_name.toLowerCase().includes(search)) ||
        (s.last_name && s.last_name.toLowerCase().includes(search)) ||
        (s.codice_fiscale && s.codice_fiscale.toLowerCase().includes(search)) ||
        (s.fiscal_code && s.fiscal_code.toLowerCase().includes(search))
      );
    }

    if (viewType === 'child') {
      if (filterClass !== 'all') {
        result = result.filter(s => s.classe_sezione === filterClass);
      }

      if (filterStatus !== 'all') {
        result = result.filter(s => s.stato === filterStatus);
      }
    }

    return result;
  }, [searchTerm, filterClass, filterStatus, students, viewType]);

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

  // Apertura scheda anagrafica a TUTTA AREA (route dedicata /admin/students/[id],
  // non più il drawer laterale). `kind` instrada su scheda alunno o genitore/staff.
  const openDetail = useCallback((s: Student) => {
    const kind = viewType === 'adult' ? 'adult' : viewType === 'staff' ? 'staff' : 'child';
    const qs = new URLSearchParams({ kind });
    if (userId) qs.set('userId', userId);
    router.push(`/admin/students/${s.id}?${qs.toString()}`);
  }, [viewType, userId, router]);

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

  const handleBulkAssignMensa = async () => {
    if (!targetMensa || selectedIds.size === 0) return;
    setIsAssigning(true);
    try {
      const res = await fetch('/api/admin/students', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds), gruppo_mensa_id: targetMensa }),
      });
      if (!res.ok) throw new Error('Errore bulk mensa');
      const grp = mensaGroups.find(g => g.id === targetMensa);
      showToastMsg(`✅ ${selectedIds.size} alunni assegnati al gruppo mensa ${grp?.nome ?? ''}`);
      fetchStudents();
      setSelectedIds(new Set());
      setTargetMensa('');
    } catch (err) {
      console.error('Errore bulk mensa:', err);
      showToastMsg('❌ Errore nell\'assegnazione gruppo mensa');
    } finally {
      setIsAssigning(false);
    }
  };

  // Esporta l'elenco corrente (già filtrato) in CSV — lato client, nessuna nuova
  // API (non esiste un endpoint di export per l'anagrafica). Decisione utente.
  const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const handleExport = () => {
    const rows = filteredStudents;
    if (rows.length === 0) { showToastMsg('Nessun dato da esportare'); return; }
    const isChild = viewType === 'child';
    const headers = isChild
      ? ['Cognome', 'Nome', 'Codice Fiscale', 'Classe', 'Stato']
      : ['Cognome', 'Nome', 'Codice Fiscale', 'Email', 'Telefono'];
    const lines = rows.map((s) => {
      const cognome = s.cognome ?? s.last_name ?? '';
      const nome = s.nome ?? s.first_name ?? '';
      const cf = s.codice_fiscale ?? s.fiscal_code ?? '';
      const cols = isChild
        ? [cognome, nome, cf, s.classe_sezione ?? '', s.stato ?? '']
        : [cognome, nome, cf, s.emails?.[0] ?? '', s.phone_numbers?.[0] ?? ''];
      return cols.map((c) => csvCell(String(c))).join(',');
    });
    const csv = [headers.join(','), ...lines].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `anagrafica-${viewType}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToastMsg(`✅ Esportati ${rows.length} record in CSV`);
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
        <p className="font-maven text-kidville-muted">Caricamento anagrafica...</p>
      </div>
    );
  }

  return (
    <CockpitPage max={1152} className="flex flex-col">
      <PageHeader
        icon={Users}
        title="Anagrafica Generale"
        subtitle="Gestione studenti, genitori e personale"
        actions={
          <>
            <button
              onClick={handleExport}
              className="inline-flex h-[46px] items-center gap-2 rounded-pill border border-kidville-line bg-kidville-white px-5 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green transition-colors hover:border-kidville-green"
            >
              <FileDown size={16} /> Esporta
            </button>
            <button onClick={() => (window.location.href = '/admin/students/new')} className={btnClass('primary', 'md')}>
              <UserPlus size={18} /> Nuovo {viewType === 'child' ? 'Alunno' : 'Genitore'}
            </button>
          </>
        }
      />

      {/* Tipo Vista (Tabs) */}
      <Tabs
        value={viewType}
        onChange={(id) => {
          if (id !== 'sections') setIsLoading(true);
          setViewType(id as 'child' | 'adult' | 'sections' | 'staff');
        }}
        options={[
          { id: 'child', label: 'Alunni', icon: Users },
          { id: 'adult', label: 'Genitori', icon: Users },
          { id: 'sections', label: 'Sezioni', icon: GraduationCap },
          { id: 'staff', label: 'Staff', icon: Briefcase },
        ]}
      />

      {/* Toolbar / Filtri — nascosta per la tab Sezioni */}
      {viewType !== 'sections' && (
      <div className="bg-white bg-kidville-white rounded-2xl p-4 shadow-sm mb-6 flex flex-col md:flex-row gap-4 items-center">
        {/* Search */}
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-kidville-muted" size={18} />
          <input
            type="text"
            placeholder="Cerca per nome, cognome o codice fiscale..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border-2 border-kidville-line rounded-xl font-maven text-sm focus:outline-none focus:border-kidville-green transition-colors"
          />
        </div>
        
        {/* Filtro Classe */}
        {viewType === 'child' && (
          <>
            <div className="flex items-center gap-2 w-full md:w-auto">
              <Filter size={16} className="text-kidville-muted" />
              <select
                value={filterClass}
                onChange={e => setFilterClass(e.target.value)}
                className="flex-1 md:w-40 border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-ink/70 focus:outline-none focus:border-kidville-green bg-white"
              >
                <option value="all">Tutte le classi</option>
                {availableSections.map(s => (
                  <option key={s.id} value={s.name}>{s.name}</option>
                ))}
                <option value="">Non assegnata</option>
              </select>
            </div>

            {/* Filtro Stato */}
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="w-full md:w-40 border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-ink/70 focus:outline-none focus:border-kidville-green bg-white"
            >
              <option value="all">Tutti gli stati</option>
              <option value="iscritto">Iscritto</option>
              <option value="ritirato">Ritirato</option>
              <option value="sospeso">Sospeso</option>
            </select>
          </>
        )}
      </div>
      )}

      {/* Content area — switch by viewType */}
      {viewType === 'sections' ? (
        <SectionsView />
      ) : (
        <>
          {/* Statistiche rapide — solo per alunni */}
          {viewType === 'child' && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <StatCard icon={Users} label="Totale Alunni" value={students.length} tone="green" />
              <StatCard icon={CheckCircle2} label="Iscritti" value={students.filter((s) => s.stato === 'iscritto').length} tone="success" />
              <StatCard icon={GraduationCap} label="Con BES" value={students.filter((s) => s.bes).length} tone="warn" />
              <StatCard icon={AlertTriangle} label="Con Allergie" value={students.filter((s) => s.note_mediche).length} tone="error" />
            </div>
          )}

          {/* Tabella */}
          <StudentTable
            students={filteredStudents}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
            onStudentClick={openDetail}
            currentTypeFilter={viewType === 'staff' ? 'adult' : viewType}
          />

          {/* Floating Bulk Bar */}
          <BulkAssignBar
            selectedCount={selectedIds.size}
            availableClasses={availableSections.map(s => s.name)}
            targetClass={targetClass}
            onTargetClassChange={setTargetClass}
            onAssign={handleBulkAssign}
            onClear={() => setSelectedIds(new Set())}
            isAssigning={isAssigning}
            mensaGroups={mensaGroups}
            targetMensa={targetMensa}
            onTargetMensaChange={setTargetMensa}
            onAssignMensa={handleBulkAssignMensa}
          />

        </>
      )}

      {/* Toast */}
      {showToast && (
        <div className="fixed bottom-6 right-6 z-[60] bg-kidville-green text-kidville-white font-maven font-semibold px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3 animate-[slideInRight_0.3s_ease-out]">
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
    </CockpitPage>
  );
}

export default function AdminStudentsPage() {
  return (
    <Suspense fallback={
      <div className="flex-1 flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
        <p className="font-maven text-kidville-muted">Caricamento anagrafica...</p>
      </div>
    }>
      <AdminStudentsInner />
    </Suspense>
  );
}
