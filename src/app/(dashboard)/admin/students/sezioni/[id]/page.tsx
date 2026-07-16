'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Building2, GraduationCap, Loader2, Plus, Settings, User, X } from 'lucide-react';
import { CockpitPage } from '@/components/ui/cockpit';
import { schoolTypeConfig } from '@/components/features/admin/SectionsView';

// Dettaglio sezione a tutta area contenuto (sidebar e header del cockpit
// restano): alunni assegnati + impostazioni. Sostituisce il pannello inline
// che si apriva in fondo alla griglia dell'anagrafica.

type SchoolType = 'nido' | 'infanzia' | 'primaria';

interface SezioneDettaglio {
    id: string;
    name: string;
    school_type: SchoolType;
    scuolaId: string;
    scuolaNome: string;
}

interface Student {
    id: string;
    nome: string;
    cognome: string;
    classe_sezione?: string | null;
    section_id?: string | null;
    stato?: string;
}

interface Teacher {
    id: string;
    nome: string;
    cognome: string;
}

export default function SezioneDetailPage() {
    const params = useParams<{ id: string }>();
    const sectionId = params?.id;

    const [sezione, setSezione] = useState<SezioneDettaglio | null>(null);
    const [students, setStudents] = useState<Student[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSavingType, setIsSavingType] = useState(false);
    const [teachers, setTeachers] = useState<{ assigned: Teacher[]; available: Teacher[] }>({ assigned: [], available: [] });
    const [newTeacherId, setNewTeacherId] = useState('');
    const [teacherBusy, setTeacherBusy] = useState(false);
    const [teachersLoading, setTeachersLoading] = useState(true);

    const loadTeachers = useCallback(async () => {
        if (!sectionId) return;
        try {
            const res = await fetch(`/api/admin/sections/${sectionId}/teachers`).catch(() => null);
            const d = res?.ok ? await res.json().catch(() => null) : null;
            if (d?.success) setTeachers({ assigned: d.assigned ?? [], available: d.available ?? [] });
        } finally {
            setTeachersLoading(false);
        }
    }, [sectionId]);

    useEffect(() => { loadTeachers(); }, [loadTeachers]);

    const addTeacher = async () => {
        if (!newTeacherId || !sectionId) return;
        setTeacherBusy(true);
        try {
            await fetch(`/api/admin/sections/${sectionId}/teachers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ utente_id: newTeacherId }),
            });
            setNewTeacherId('');
            await loadTeachers();
        } finally {
            setTeacherBusy(false);
        }
    };

    const removeTeacher = async (utenteId: string) => {
        if (!sectionId) return;
        setTeacherBusy(true);
        try {
            await fetch(`/api/admin/sections/${sectionId}/teachers`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ utente_id: utenteId }),
            });
            await loadTeachers();
        } finally {
            setTeacherBusy(false);
        }
    };

    const load = useCallback(async () => {
        if (!sectionId) return;
        try {
            const res = await fetch('/api/admin/sections/scoped').catch(() => null);
            const d = res?.ok ? await res.json().catch(() => null) : null;
            const groups: { scuolaId: string; scuolaNome: string; sezioni: { id: string; name: string; school_type: SchoolType }[] }[] =
                d?.success ? (d.data ?? []) : [];

            let found: SezioneDettaglio | null = null;
            for (const g of groups) {
                const s = g.sezioni.find(x => x.id === sectionId);
                if (s) { found = { ...s, scuolaId: g.scuolaId, scuolaNome: g.scuolaNome }; break; }
            }
            setSezione(found);

            if (found) {
                const stuRes = await fetch(`/api/admin/students?scuola_id=${found.scuolaId}&limit=1000`).catch(() => null);
                const stuData = stuRes?.ok ? await stuRes.json().catch(() => null) : null;
                if (Array.isArray(stuData)) {
                    const f = found;
                    setStudents((stuData as Student[]).filter(s => s.section_id === f.id || s.classe_sezione === f.name));
                }
            }
        } finally {
            setIsLoading(false);
        }
    }, [sectionId]);

    useEffect(() => { load(); }, [load]);

    const changeSchoolType = async (newType: SchoolType) => {
        if (!sezione) return;
        setIsSavingType(true);
        try {
            const res = await fetch('/api/admin/sections', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: sezione.id, school_type: newType }),
            });
            if (res.ok) setSezione({ ...sezione, school_type: newType });
        } finally {
            setIsSavingType(false);
        }
    };

    const backHref = '/admin/students?tab=sections';

    if (isLoading) {
        return (
            <CockpitPage max={1152}>
                <div className="flex items-center justify-center py-24">
                    <Loader2 className="animate-spin text-kidville-green" size={32} />
                </div>
            </CockpitPage>
        );
    }

    if (!sezione) {
        return (
            <CockpitPage max={1152}>
                <Link href={backHref} className="mb-4 inline-flex items-center gap-1.5 font-maven text-sm font-semibold text-kidville-green hover:underline">
                    <ArrowLeft size={15} strokeWidth={2} /> Tutte le sezioni
                </Link>
                <div className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-cream text-4xl">🏫</div>
                    <h2 className="font-barlow text-lg font-bold uppercase text-kidville-green">Sezione non disponibile</h2>
                    <p className="font-maven mt-1 text-sm text-kidville-muted">La sezione non esiste o non appartiene ai tuoi plessi.</p>
                </div>
            </CockpitPage>
        );
    }

    const config = schoolTypeConfig[sezione.school_type] || schoolTypeConfig.infanzia;
    const Icon = config.icon;

    return (
        <CockpitPage max={1152}>
            <Link href={backHref} className="mb-4 inline-flex items-center gap-1.5 font-maven text-sm font-semibold text-kidville-green hover:underline">
                <ArrowLeft size={15} strokeWidth={2} /> Tutte le sezioni
            </Link>

            {/* Testata sezione */}
            <div className="mb-5 rounded-card bg-kidville-white p-6 shadow-sm">
                <div className="flex items-center gap-4">
                    <div className={`p-3 rounded-2xl ${config.bg}`}>
                        <Icon size={28} className={config.color} />
                    </div>
                    <div>
                        <h1 className="font-barlow text-3xl font-black uppercase leading-none text-kidville-green">Sezione {sezione.name}</h1>
                        <div className="mt-1.5 flex flex-wrap items-center gap-3">
                            <span className={`text-xs font-bold uppercase tracking-wider px-2 py-1 rounded-lg ${config.bg} ${config.color}`}>
                                {config.label}
                            </span>
                            <span className="font-maven flex items-center gap-1 text-sm text-kidville-muted">
                                <Building2 size={14} /> {sezione.scuolaNome}
                            </span>
                            <span className="font-maven flex items-center gap-1 text-sm text-kidville-muted">
                                <User size={14} /> {students.length} alunni
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
                {/* Alunni della sezione */}
                <div className="rounded-card bg-kidville-white p-6 shadow-sm">
                    <h4 className="font-barlow mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-kidville-muted">
                        <User size={16} /> Alunni in questa sezione ({students.length})
                    </h4>
                    {students.length > 0 ? (
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                            {students.map(student => (
                                <div key={student.id} className="flex items-center gap-3 rounded-xl bg-kidville-cream p-3">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-kidville-green/10">
                                        <User size={14} className="text-kidville-green" />
                                    </div>
                                    <div>
                                        <p className="font-maven text-sm font-bold text-kidville-ink">{student.cognome} {student.nome}</p>
                                        <p className="text-xs text-kidville-muted">{student.stato || 'iscritto'}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="rounded-xl bg-kidville-cream py-6 text-center">
                            <p className="font-maven text-sm text-kidville-muted">Nessun alunno assegnato a questa sezione</p>
                        </div>
                    )}
                    <p className="font-maven mt-4 text-xs text-kidville-muted">
                        Per aprire o modificare la scheda di un alunno usa il tab <Link href="/admin/students" className="font-semibold text-kidville-green hover:underline">Alunni</Link> dell&apos;anagrafica.
                    </p>
                </div>

                <div className="space-y-5">
                {/* Impostazioni sezione */}
                <div className="rounded-card bg-kidville-white p-6 shadow-sm">
                    <h4 className="font-barlow mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-kidville-muted">
                        <Settings size={16} /> Impostazioni Sezione
                    </h4>
                    <div className="space-y-4 rounded-xl bg-kidville-cream p-4">
                        <div>
                            <label className="mb-1 block text-xs font-bold uppercase text-kidville-muted">Tipo di Scuola</label>
                            <select
                                value={sezione.school_type}
                                disabled={isSavingType}
                                onChange={e => changeSchoolType(e.target.value as SchoolType)}
                                className="w-full rounded-xl border-2 border-kidville-line bg-kidville-white p-2.5 font-maven text-sm focus:border-kidville-green focus:outline-none disabled:opacity-60"
                            >
                                <option value="nido">Nido</option>
                                <option value="infanzia">Infanzia</option>
                                <option value="primaria">Primaria</option>
                            </select>
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-bold uppercase text-kidville-muted">Sede</label>
                            <div className="flex items-center gap-2 rounded-xl border-2 border-kidville-line bg-kidville-white p-2.5">
                                <Building2 size={16} className="text-kidville-muted" />
                                <span className="font-maven text-sm text-kidville-ink">{sezione.scuolaNome}</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Insegnanti di riferimento */}
                <div className="rounded-card bg-kidville-white p-6 shadow-sm">
                    <h4 className="font-barlow mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-kidville-muted">
                        <GraduationCap size={16} /> Insegnanti di riferimento
                    </h4>
                    <div className="space-y-3 rounded-xl bg-kidville-cream p-4">
                        {teachers.assigned.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                                {teachers.assigned.map(t => (
                                    <span key={t.id} className="inline-flex items-center gap-1.5 rounded-full bg-kidville-green/10 px-3 py-1.5 font-maven text-sm text-kidville-green">
                                        {t.cognome} {t.nome}
                                        <button
                                            onClick={() => removeTeacher(t.id)}
                                            disabled={teacherBusy}
                                            aria-label="Rimuovi insegnante"
                                            className="text-kidville-green/60 hover:text-kidville-error disabled:opacity-50"
                                        >
                                            <X size={14} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <p className="font-maven text-sm text-kidville-muted">Nessun insegnante di riferimento assegnato.</p>
                        )}
                        <div className="flex items-center gap-2">
                            <select
                                value={newTeacherId}
                                onChange={e => setNewTeacherId(e.target.value)}
                                disabled={teacherBusy || teachersLoading || teachers.available.length === 0}
                                className="flex-1 rounded-xl border-2 border-kidville-line bg-kidville-white p-2.5 font-maven text-sm focus:border-kidville-green focus:outline-none disabled:opacity-60"
                            >
                                <option value="">{teachersLoading ? 'Caricamento…' : teachers.available.length === 0 ? 'Nessun docente disponibile' : '— Seleziona insegnante —'}</option>
                                {teachers.available.map(t => (
                                    <option key={t.id} value={t.id}>{t.cognome} {t.nome}</option>
                                ))}
                            </select>
                            <button
                                onClick={addTeacher}
                                disabled={!newTeacherId || teacherBusy || teachersLoading}
                                className="inline-flex items-center gap-1.5 rounded-xl bg-kidville-green px-4 py-2.5 font-barlow text-sm font-bold uppercase text-kidville-yellow disabled:opacity-50"
                            >
                                <Plus size={16} /> Aggiungi
                            </button>
                        </div>
                        <p className="font-maven text-xs text-kidville-muted">
                            L&apos;insegnante aggiunto comparirà automaticamente tra le sue &quot;Classi assegnate&quot;.
                        </p>
                    </div>
                </div>
                </div>
            </div>
        </CockpitPage>
    );
}
