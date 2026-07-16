'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { LayoutGrid, User, GraduationCap, Baby, BookOpen, Building2, Plus, ChevronRight, Loader2 } from 'lucide-react';

// Griglia sezioni dell'anagrafica: le sedi/sezioni arrivano dai plessi
// consentiti (/api/admin/sections/scoped, niente scuola hardcoded) e il
// click apre il dettaglio a tutta area su /admin/students/sezioni/[id].

interface SezioneScoped {
    id: string;
    name: string;
    school_type: 'nido' | 'infanzia' | 'primaria';
}

interface ScuolaScoped {
    scuolaId: string;
    scuolaNome: string;
    sezioni: SezioneScoped[];
}

interface Student {
    id: string;
    nome: string;
    cognome: string;
    classe_sezione?: string | null;
    section_id?: string | null;
    stato?: string;
}

export const schoolTypeConfig = {
    nido: { label: 'Nido', icon: Baby, color: 'text-pink-500', bg: 'bg-pink-500/10', border: 'border-pink-500/30' },
    infanzia: { label: 'Infanzia', icon: GraduationCap, color: 'text-kidville-green', bg: 'bg-kidville-green/10', border: 'border-kidville-green/30' },
    primaria: { label: 'Primaria', icon: BookOpen, color: 'text-kidville-info', bg: 'bg-kidville-info/10', border: 'border-kidville-info/30' },
};

export function SectionsView() {
    const [scuole, setScuole] = useState<ScuolaScoped[]>([]);
    const [students, setStudents] = useState<Student[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [showNewForm, setShowNewForm] = useState(false);
    const [newSectionName, setNewSectionName] = useState('');
    const [newSectionType, setNewSectionType] = useState<'nido' | 'infanzia' | 'primaria'>('infanzia');
    const [newSectionScuola, setNewSectionScuola] = useState('');
    const [isCreating, setIsCreating] = useState(false);

    // Niente setIsLoading(true) sincrono qui (react-hooks/set-state-in-effect):
    // al mount isLoading parte già true; i refetch da handler lo impostano loro.
    const fetchData = useCallback(async () => {
        try {
            const secRes = await fetch('/api/admin/sections/scoped');
            const secData = await secRes.json().catch(() => null);
            const groups: ScuolaScoped[] = secData?.success ? (secData.data ?? []) : [];
            setScuole(groups);
            setNewSectionScuola(cur => cur || groups[0]?.scuolaId || '');

            const perScuola = await Promise.all(
                groups.map(async (g) => {
                    const r = await fetch(`/api/admin/students?scuola_id=${g.scuolaId}&limit=1000`).catch(() => null);
                    const d = r?.ok ? await r.json().catch(() => null) : null;
                    return Array.isArray(d) ? (d as Student[]) : [];
                })
            );
            setStudents(perScuola.flat());
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const handleCreateSection = async () => {
        if (!newSectionName.trim() || !newSectionScuola) return;
        setIsCreating(true);
        try {
            const res = await fetch('/api/admin/sections', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newSectionName, school_type: newSectionType, scuola_id: newSectionScuola })
            });
            if (res.ok) {
                setNewSectionName('');
                setShowNewForm(false);
                fetchData();
            }
        } catch (err) {
            console.error('Errore creazione sezione:', err);
        } finally {
            setIsCreating(false);
        }
    };

    const countStudents = (section: SezioneScoped) =>
        students.filter(s => s.section_id === section.id || s.classe_sezione === section.name).length;

    const sections = scuole.flatMap(g => g.sezioni.map(s => ({ ...s, scuolaId: g.scuolaId, scuolaNome: g.scuolaNome })));
    const multiSede = scuole.length > 1;

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="animate-spin text-kidville-green" size={32} />
            </div>
        );
    }

    return (
        <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h2 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
                        <LayoutGrid size={22} /> Sezioni Scolastiche
                    </h2>
                    <p className="font-maven text-sm text-kidville-muted mt-1">{sections.length} sezioni configurate</p>
                </div>
                <button
                    onClick={() => setShowNewForm(!showNewForm)}
                    className="flex items-center gap-2 px-4 py-2 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-extrabold uppercase tracking-[0.03em] text-sm transition-transform hover:bg-kidville-green-dark active:scale-95 shadow-md"
                >
                    <Plus size={16} /> Nuova Sezione
                </button>
            </div>

            {/* New Section Form */}
            {showNewForm && (
                <div className="bg-kidville-white rounded-card shadow-sm p-6 mb-6 border-2 border-kidville-green/20">
                    <h3 className="font-barlow font-bold text-kidville-green uppercase mb-4">Crea Nuova Sezione</h3>
                    <div className="flex flex-col md:flex-row gap-4 items-end">
                        <div className="flex-1">
                            <label className="block text-sm font-bold text-kidville-ink mb-1">Nome Sezione</label>
                            <input
                                value={newSectionName}
                                onChange={e => setNewSectionName(e.target.value)}
                                placeholder="Es. Girasoli, Leoni, 1A..."
                                className="w-full p-3 border-2 border-kidville-line rounded-input font-maven text-sm bg-kidville-white focus:outline-none focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15"
                            />
                        </div>
                        <div className="w-48">
                            <label className="block text-sm font-bold text-kidville-ink mb-1">Tipo</label>
                            <select
                                value={newSectionType}
                                onChange={e => setNewSectionType(e.target.value as 'nido' | 'infanzia' | 'primaria')}
                                className="w-full p-3 border-2 border-kidville-line rounded-input font-maven text-sm bg-kidville-white focus:outline-none focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15"
                            >
                                <option value="nido">Nido</option>
                                <option value="infanzia">Infanzia</option>
                                <option value="primaria">Primaria</option>
                            </select>
                        </div>
                        {multiSede && (
                            <div className="w-56">
                                <label className="block text-sm font-bold text-kidville-ink mb-1">Sede</label>
                                <select
                                    value={newSectionScuola}
                                    onChange={e => setNewSectionScuola(e.target.value)}
                                    className="w-full p-3 border-2 border-kidville-line rounded-input font-maven text-sm bg-kidville-white focus:outline-none focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15"
                                >
                                    {scuole.map(g => (
                                        <option key={g.scuolaId} value={g.scuolaId}>{g.scuolaNome}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                        <button
                            onClick={handleCreateSection}
                            disabled={isCreating || !newSectionName.trim()}
                            className="px-6 py-3 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-extrabold uppercase tracking-[0.03em] transition-transform hover:bg-kidville-green-dark active:scale-95 disabled:opacity-50 disabled:pointer-events-none flex items-center gap-2"
                        >
                            {isCreating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                            Crea
                        </button>
                    </div>
                </div>
            )}

            {/* Sections Grid — il click apre il dettaglio a tutta area */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                {sections.map(section => {
                    const config = schoolTypeConfig[section.school_type] || schoolTypeConfig.infanzia;
                    const Icon = config.icon;

                    return (
                        <Link
                            key={section.id}
                            href={`/admin/students/sezioni/${section.id}`}
                            className="text-left p-5 rounded-card border-2 border-kidville-line bg-kidville-white transition-all hover:shadow-lg hover:border-kidville-green/30 group"
                        >
                            <div className="flex items-start justify-between mb-3">
                                <div className={`p-2.5 rounded-xl ${config.bg}`}>
                                    <Icon size={22} className={config.color} />
                                </div>
                                <span className={`text-xs font-bold uppercase tracking-wider px-2 py-1 rounded-lg ${config.bg} ${config.color}`}>
                                    {config.label}
                                </span>
                            </div>
                            <h3 className="font-barlow font-black text-lg text-kidville-ink mb-1">{section.name}</h3>
                            <div className="flex items-center gap-4 text-sm text-kidville-muted font-maven">
                                <span className="flex items-center gap-1"><User size={14} /> {countStudents(section)} alunni</span>
                                {multiSede && (
                                    <span className="flex items-center gap-1"><Building2 size={14} /> {section.scuolaNome}</span>
                                )}
                            </div>
                            <div className="mt-3 flex items-center gap-1 text-xs font-bold text-kidville-green opacity-0 group-hover:opacity-100 transition-opacity">
                                Apri la sezione <ChevronRight size={14} />
                            </div>
                        </Link>
                    );
                })}

                {sections.length === 0 && (
                    <div className="col-span-full flex flex-col items-center py-12 text-center bg-kidville-white rounded-card border-2 border-dashed border-kidville-line">
                        <div className="mb-3 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-cream text-4xl">🗂️</div>
                        <p className="font-barlow font-bold text-lg text-kidville-green uppercase">Nessuna sezione configurata</p>
                        <p className="font-maven text-sm text-kidville-muted mt-1">Clicca &ldquo;Nuova Sezione&rdquo; per iniziare</p>
                    </div>
                )}
            </div>
        </div>
    );
}
