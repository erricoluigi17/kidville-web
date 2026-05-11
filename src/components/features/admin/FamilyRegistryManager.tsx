'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, Users, Plus, Heart, ShieldCheck, Trash2, CheckCircle2, AlertCircle } from 'lucide-react';
import { ScrollableStudentForm } from './ScrollableStudentForm';
import { ScrollableAdultForm } from './ScrollableAdultForm';

export function FamilyRegistryManager() {
    const [tabs, setTabs] = useState([
        { id: 'alunno', label: 'Alunno', type: 'student', removable: false },
        { id: 'madre', label: 'Madre', type: 'adult', removable: false, defaultRole: 'mother' },
        { id: 'padre', label: 'Padre', type: 'adult', removable: false, defaultRole: 'father' },
    ]);
    const [activeTab, setActiveTab] = useState('alunno');
    const [createdStudentId, setCreatedStudentId] = useState<string | null>(null);

    const addAdultTab = () => {
        const newId = `adulto-${Date.now()}`;
        setTabs(prev => [...prev, { id: newId, label: 'Nuovo Componente', type: 'adult', removable: true, defaultRole: 'delegate' }]);
        setActiveTab(newId);
    };

    const removeTab = (tabId: string) => {
        setTabs(prev => prev.filter(t => t.id !== tabId));
        if (activeTab === tabId) setActiveTab('alunno');
    };

    const getTabIcon = (tab: typeof tabs[0]) => {
        if (tab.type === 'student') return <User size={16} />;
        if (tab.defaultRole === 'mother') return <Heart size={16} />;
        if (tab.defaultRole === 'father') return <ShieldCheck size={16} />;
        return <Users size={16} />;
    };

    return (
        <div className="w-full max-w-5xl mx-auto">
            {/* Top Tabs */}
            <div className="flex flex-wrap gap-2 mb-6 p-2 bg-black/80 backdrop-blur-md rounded-2xl border border-white/10 w-fit">
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`relative px-5 py-3 rounded-xl font-bold text-sm transition-colors flex items-center gap-2 ${activeTab === tab.id ? 'text-white' : 'text-gray-400 hover:text-white'}`}
                    >
                        {activeTab === tab.id && (
                            <motion.div 
                                layoutId="activeFamilyTabIndicator"
                                className="absolute inset-0 bg-kidville-green rounded-xl shadow-lg"
                                initial={false}
                                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                            />
                        )}
                        <span className="relative z-10 flex items-center gap-2">
                            {getTabIcon(tab)}
                            {tab.label}
                            {tab.removable && (
                                <span
                                    onClick={(e) => { e.stopPropagation(); removeTab(tab.id); }}
                                    className="ml-1 p-0.5 rounded-full hover:bg-red-500/30 text-gray-400 hover:text-red-400 transition-colors"
                                >
                                    <Trash2 size={12} />
                                </span>
                            )}
                        </span>
                    </button>
                ))}
                
                <button
                    onClick={addAdultTab}
                    className="relative px-4 py-3 rounded-xl font-bold text-sm text-gray-300 hover:text-white hover:bg-white/10 transition-colors flex items-center gap-2 border border-dashed border-gray-500"
                >
                    <Plus size={16} /> Aggiungi Componente
                </button>
            </div>

            {/* Tab Content */}
            <div className="relative min-h-[600px]">
                {/* Banner stato collegamento */}
                {activeTab !== 'alunno' && (
                    <div className={`flex items-center gap-2 px-4 py-2 rounded-xl mb-3 text-sm font-maven font-bold ${
                        createdStudentId
                            ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                            : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                    }`}>
                        {createdStudentId
                            ? <><CheckCircle2 size={15} /> Alunno salvato — il genitore verrà collegato automaticamente</>  
                            : <><AlertCircle size={15} /> ⚠️ Salva prima l&apos;alunno nella tab &quot;Alunno&quot; per attivare il collegamento automatico</>  
                        }
                    </div>
                )}
                <AnimatePresence mode="wait">
                    {tabs.map((tab) => (
                        activeTab === tab.id && (
                            <motion.div
                                key={tab.id}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -20 }}
                                transition={{ duration: 0.3 }}
                                className="absolute inset-0 bg-gray-950/90 backdrop-blur-2xl border border-white/10 p-8 rounded-3xl shadow-2xl overflow-y-auto text-white"
                            >
                                {tab.type === 'student' ? (
                                    <ScrollableStudentForm onSaveSuccess={setCreatedStudentId} />
                                ) : (
                                    <ScrollableAdultForm 
                                        tabId={tab.id} 
                                        defaultRole={tab.defaultRole}
                                        studentId={createdStudentId}
                                        updateTabLabel={(label) => setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, label } : t))} 
                                    />
                                )}
                            </motion.div>
                        )
                    ))}
                </AnimatePresence>
            </div>
        </div>
    );
}
