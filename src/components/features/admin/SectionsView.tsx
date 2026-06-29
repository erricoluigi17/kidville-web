'use client';

import React, { useState, useEffect } from 'react';
import { LayoutGrid, Users, User, GraduationCap, Baby, BookOpen, Building2, Plus, Settings, ChevronRight, Loader2, X } from 'lucide-react';

interface Section {
    id: string;
    name: string;
    school_type: 'nido' | 'infanzia' | 'primaria';
    scuola_id: string;
    created_at: string;
}

interface Student {
    id: string;
    nome: string;
    cognome: string;
    classe_sezione?: string | null;
    section_id?: string | null;
    stato?: string;
}

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';

const schoolTypeConfig = {
    nido: { label: 'Nido', icon: Baby, color: 'text-pink-500', bg: 'bg-pink-500/10', border: 'border-pink-500/30' },
    infanzia: { label: 'Infanzia', icon: GraduationCap, color: 'text-kidville-green', bg: 'bg-kidville-green/10', border: 'border-kidville-green/30' },
    primaria: { label: 'Primaria', icon: BookOpen, color: 'text-kidville-info', bg: 'bg-kidville-info-soft0/10', border: 'border-blue-500/30' },
};

interface SectionsViewProps {
    onStudentClick?: (student: Student) => void;
}

export function SectionsView({ onStudentClick }: SectionsViewProps) {
    const [sections, setSections] = useState<Section[]>([]);
    const [students, setStudents] = useState<Student[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [selectedSection, setSelectedSection] = useState<Section | null>(null);
    const [showNewForm, setShowNewForm] = useState(false);
    const [newSectionName, setNewSectionName] = useState('');
    const [newSectionType, setNewSectionType] = useState<'nido' | 'infanzia' | 'primaria'>('infanzia');
    const [isCreating, setIsCreating] = useState(false);

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        setIsLoading(true);
        try {
            const [secRes, stuRes] = await Promise.all([
                fetch(`/api/admin/sections?scuola_id=${SCUOLA_ID}`),
                fetch(`/api/admin/students?scuola_id=${SCUOLA_ID}`)
            ]);
            const secData = await secRes.json();
            const stuData = await stuRes.json();
            if (Array.isArray(secData)) setSections(secData);
            if (Array.isArray(stuData)) setStudents(stuData);
        } catch (err) {
            console.error('Errore caricamento sezioni:', err);
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreateSection = async () => {
        if (!newSectionName.trim()) return;
        setIsCreating(true);
        try {
            const res = await fetch('/api/admin/sections', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newSectionName, school_type: newSectionType, scuola_id: SCUOLA_ID })
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

    const getStudentsForSection = (section: Section) => {
        return students.filter(s => 
            s.section_id === section.id || s.classe_sezione === section.name
        );
    };

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
                    <p className="font-maven text-sm text-gray-400 mt-1">{sections.length} sezioni configurate</p>
                </div>
                <button
                    onClick={() => setShowNewForm(!showNewForm)}
                    className="flex items-center gap-2 px-4 py-2 bg-kidville-green text-white rounded-xl font-barlow font-bold uppercase text-sm hover:opacity-90 transition-all shadow-md"
                >
                    <Plus size={16} /> Nuova Sezione
                </button>
            </div>

            {/* New Section Form */}
            {showNewForm && (
                <div className="bg-white rounded-2xl shadow-sm p-6 mb-6 border-2 border-kidville-green/20">
                    <h3 className="font-barlow font-bold text-kidville-green uppercase mb-4">Crea Nuova Sezione</h3>
                    <div className="flex flex-col md:flex-row gap-4 items-end">
                        <div className="flex-1">
                            <label className="block text-sm font-bold text-gray-600 mb-1">Nome Sezione</label>
                            <input
                                value={newSectionName}
                                onChange={e => setNewSectionName(e.target.value)}
                                placeholder="Es. Girasoli, Leoni, 1A..."
                                className="w-full p-3 border-2 border-gray-100 rounded-xl font-maven text-sm focus:outline-none focus:border-kidville-green"
                            />
                        </div>
                        <div className="w-48">
                            <label className="block text-sm font-bold text-gray-600 mb-1">Tipo</label>
                            <select
                                value={newSectionType}
                                onChange={e => setNewSectionType(e.target.value as any)}
                                className="w-full p-3 border-2 border-gray-100 rounded-xl font-maven text-sm focus:outline-none focus:border-kidville-green bg-white"
                            >
                                <option value="nido">Nido</option>
                                <option value="infanzia">Infanzia</option>
                                <option value="primaria">Primaria</option>
                            </select>
                        </div>
                        <button
                            onClick={handleCreateSection}
                            disabled={isCreating || !newSectionName.trim()}
                            className="px-6 py-3 bg-kidville-green text-white rounded-xl font-bold hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                        >
                            {isCreating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                            Crea
                        </button>
                    </div>
                </div>
            )}

            {/* Sections Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                {sections.map(section => {
                    const config = schoolTypeConfig[section.school_type] || schoolTypeConfig.infanzia;
                    const Icon = config.icon;
                    const sectionStudents = getStudentsForSection(section);
                    const isSelected = selectedSection?.id === section.id;

                    return (
                        <button
                            key={section.id}
                            onClick={() => setSelectedSection(isSelected ? null : section)}
                            className={`text-left p-5 rounded-2xl border-2 transition-all hover:shadow-lg group ${
                                isSelected 
                                    ? 'border-kidville-green bg-kidville-green/5 shadow-lg' 
                                    : 'border-gray-100 bg-white hover:border-kidville-green/30'
                            }`}
                        >
                            <div className="flex items-start justify-between mb-3">
                                <div className={`p-2.5 rounded-xl ${config.bg}`}>
                                    <Icon size={22} className={config.color} />
                                </div>
                                <span className={`text-xs font-bold uppercase tracking-wider px-2 py-1 rounded-lg ${config.bg} ${config.color}`}>
                                    {config.label}
                                </span>
                            </div>
                            <h3 className="font-barlow font-black text-lg text-gray-800 mb-1">{section.name}</h3>
                            <div className="flex items-center gap-4 text-sm text-gray-500 font-maven">
                                <span className="flex items-center gap-1"><User size={14} /> {sectionStudents.length} alunni</span>
                            </div>
                            <div className="mt-3 flex items-center gap-1 text-xs font-bold text-kidville-green opacity-0 group-hover:opacity-100 transition-opacity">
                                Clicca per dettagli <ChevronRight size={14} />
                            </div>
                        </button>
                    );
                })}

                {sections.length === 0 && (
                    <div className="col-span-full text-center py-12 bg-white rounded-2xl border-2 border-dashed border-gray-200">
                        <LayoutGrid size={40} className="mx-auto text-gray-300 mb-3" />
                        <p className="font-maven text-gray-400">Nessuna sezione configurata</p>
                        <p className="font-maven text-sm text-gray-300 mt-1">Clicca "Nuova Sezione" per iniziare</p>
                    </div>
                )}
            </div>

            {/* Selected Section Detail */}
            {selectedSection && (
                <div className="bg-white rounded-2xl shadow-lg border-2 border-kidville-green/20 overflow-hidden">
                    <div className="bg-kidville-green/5 p-6 border-b border-kidville-green/10 flex items-center justify-between">
                        <div>
                            <h3 className="font-barlow font-black text-xl text-kidville-green uppercase">
                                Sezione: {selectedSection.name}
                            </h3>
                            <div className="flex items-center gap-3 mt-1">
                                <span className={`text-xs font-bold uppercase tracking-wider px-2 py-1 rounded-lg ${schoolTypeConfig[selectedSection.school_type]?.bg} ${schoolTypeConfig[selectedSection.school_type]?.color}`}>
                                    {schoolTypeConfig[selectedSection.school_type]?.label}
                                </span>
                                <span className="text-sm text-gray-500 font-maven flex items-center gap-1">
                                    <Building2 size={14} /> Kidville Roma
                                </span>
                            </div>
                        </div>
                        <button onClick={() => setSelectedSection(null)} className="p-2 hover:bg-gray-100 rounded-xl transition-colors">
                            <X size={20} className="text-gray-400" />
                        </button>
                    </div>

                    <div className="p-6">
                        {/* Alunni nella sezione */}
                        <h4 className="font-barlow font-bold text-sm uppercase tracking-wide text-gray-500 mb-3 flex items-center gap-2">
                            <User size={16} /> Alunni in questa sezione ({getStudentsForSection(selectedSection).length})
                        </h4>
                        {getStudentsForSection(selectedSection).length > 0 ? (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-6">
                                {getStudentsForSection(selectedSection).map(student => (
                                    <div 
                                        key={student.id} 
                                        className="flex items-center gap-3 p-3 bg-gray-50 hover:bg-gray-100 cursor-pointer rounded-xl transition-colors"
                                        onClick={() => onStudentClick && onStudentClick(student)}
                                    >
                                        <div className="w-8 h-8 rounded-full bg-kidville-green/10 flex items-center justify-center">
                                            <User size={14} className="text-kidville-green" />
                                        </div>
                                        <div>
                                            <p className="font-maven font-bold text-sm text-gray-800">{student.cognome} {student.nome}</p>
                                            <p className="text-xs text-gray-400">{student.stato || 'iscritto'}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-center py-6 bg-gray-50 rounded-xl mb-6">
                                <p className="font-maven text-gray-400 text-sm">Nessun alunno assegnato a questa sezione</p>
                            </div>
                        )}

                        {/* Impostazioni Sezione */}
                        <h4 className="font-barlow font-bold text-sm uppercase tracking-wide text-gray-500 mb-3 flex items-center gap-2">
                            <Settings size={16} /> Impostazioni Sezione
                        </h4>
                        <div className="grid grid-cols-2 gap-4 bg-gray-50 p-4 rounded-xl">
                            <div>
                                <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">Tipo di Scuola</label>
                                <select
                                    value={selectedSection.school_type}
                                    onChange={async (e) => {
                                        const newType = e.target.value;
                                        await fetch('/api/admin/sections', {
                                            method: 'PATCH',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ id: selectedSection.id, school_type: newType })
                                        });
                                        setSelectedSection({ ...selectedSection, school_type: newType as any });
                                        fetchData();
                                    }}
                                    className="w-full p-2.5 border-2 border-gray-200 rounded-xl font-maven text-sm bg-white focus:border-kidville-green focus:outline-none"
                                >
                                    <option value="nido">Nido</option>
                                    <option value="infanzia">Infanzia</option>
                                    <option value="primaria">Primaria</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">Sede</label>
                                <div className="flex items-center gap-2 p-2.5 border-2 border-gray-200 rounded-xl bg-white">
                                    <Building2 size={16} className="text-gray-400" />
                                    <span className="font-maven text-sm text-gray-700">Kidville Roma</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
