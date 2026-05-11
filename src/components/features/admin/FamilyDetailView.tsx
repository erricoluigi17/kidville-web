'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, Users } from 'lucide-react';

interface TabItem {
    id: string;
    label: string;
    type: 'student' | 'mother' | 'father' | 'other';
    data: any;
}

export function FamilyDetailView({ familyData }: { familyData?: any }) {
    // Simulazione dati. Nella realtà verrebbero passati come props.
    const mockTabs: TabItem[] = [
        { id: 'alunno', label: 'Alunno: Sofia Esposito', type: 'student', data: { nome: 'Sofia' } },
        { id: 'madre', label: 'Madre: Sarah Pagano', type: 'mother', data: { nome: 'Sarah' } },
        { id: 'padre', label: 'Padre: Marco Esposito', type: 'father', data: { nome: 'Marco' } }
    ];

    const tabs = familyData?.tabs || mockTabs;
    const [activeTab, setActiveTab] = useState(tabs[0].id);

    return (
        <div className="w-full max-w-5xl mx-auto">
            {/* Tab Navigation */}
            <div className="flex gap-2 mb-6 p-2 bg-black/20 backdrop-blur-md rounded-2xl border border-white/5 w-fit">
                {tabs.map((tab: TabItem) => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`relative px-6 py-3 rounded-xl font-bold text-sm transition-colors flex items-center gap-2 ${activeTab === tab.id ? 'text-white' : 'text-gray-400 hover:text-white'}`}
                    >
                        {activeTab === tab.id && (
                            <motion.div 
                                layoutId="activeTabIndicator"
                                className="absolute inset-0 bg-kidville-green rounded-xl shadow-lg"
                                initial={false}
                                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                            />
                        )}
                        <span className="relative z-10 flex items-center gap-2">
                            {tab.type === 'student' ? <User size={16} /> : <Users size={16} />}
                            {tab.label}
                        </span>
                    </button>
                ))}
            </div>

            {/* Tab Content */}
            <div className="relative min-h-[500px]">
                <AnimatePresence mode="wait">
                    {tabs.map((tab: TabItem) => (
                        activeTab === tab.id && (
                            <motion.div
                                key={tab.id}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -20 }}
                                transition={{ duration: 0.3 }}
                                className="absolute inset-0 bg-white/5 backdrop-blur-xl border border-white/10 p-8 rounded-3xl shadow-2xl"
                            >
                                <h3 className="text-2xl font-bold text-kidville-green mb-6 border-b border-white/10 pb-4">
                                    Dettagli {tab.label.split(':')[0]}
                                </h3>
                                {/* Qui andrebbe il render del componente di dettaglio specifico (DettaglioAlunno o DettaglioAdulto) */}
                                <div className="text-gray-300">
                                    <p className="mb-4">Visualizzazione dati per: <strong className="text-white">{tab.data.nome}</strong></p>
                                    <div className="grid grid-cols-2 gap-4 opacity-50">
                                        <div className="h-12 bg-white/5 rounded-xl animate-pulse"></div>
                                        <div className="h-12 bg-white/5 rounded-xl animate-pulse"></div>
                                        <div className="h-12 bg-white/5 rounded-xl animate-pulse col-span-2"></div>
                                        <div className="h-32 bg-white/5 rounded-xl animate-pulse col-span-2 mt-4"></div>
                                    </div>
                                </div>
                            </motion.div>
                        )
                    ))}
                </AnimatePresence>
            </div>
        </div>
    );
}
