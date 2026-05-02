'use client';

import { useState } from 'react';
import LessonsTab from '@/components/features/teacher/register/LessonsTab';
import GradesTab from '@/components/features/teacher/register/GradesTab';
import NotesTab from '@/components/features/teacher/register/NotesTab';

type Tab = 'lezioni' | 'voti' | 'note';

export default function TeacherRegisterPage() {
    const [activeTab, setActiveTab] = useState<Tab>('lezioni');

    return (
        <div className="max-w-4xl mx-auto p-4 sm:p-6">
            <div className="mb-6">
                <h1 className="font-barlow font-bold text-3xl text-kidville-green uppercase tracking-wide">
                    Registro di Classe
                </h1>
                <p className="font-maven text-gray-500 mt-1">Classe 3A • Primaria</p>
            </div>

            <div className="flex space-x-2 bg-kidville-white p-2 rounded-full shadow-sm mb-6 w-full max-w-md">
                <button
                    onClick={() => setActiveTab('lezioni')}
                    className={`flex-1 py-2 font-maven font-semibold rounded-pill transition-all ${
                        activeTab === 'lezioni' ? 'bg-kidville-green text-kidville-yellow' : 'text-gray-500 hover:bg-kidville-cream'
                    }`}
                >
                    Lezioni
                </button>
                <button
                    onClick={() => setActiveTab('voti')}
                    className={`flex-1 py-2 font-maven font-semibold rounded-pill transition-all ${
                        activeTab === 'voti' ? 'bg-kidville-green text-kidville-yellow' : 'text-gray-500 hover:bg-kidville-cream'
                    }`}
                >
                    Valutazioni
                </button>
                <button
                    onClick={() => setActiveTab('note')}
                    className={`flex-1 py-2 font-maven font-semibold rounded-pill transition-all ${
                        activeTab === 'note' ? 'bg-kidville-green text-kidville-yellow' : 'text-gray-500 hover:bg-kidville-cream'
                    }`}
                >
                    Note
                </button>
            </div>

            <div className="bg-kidville-white rounded-card shadow-sm p-4 sm:p-6 min-h-[400px]">
                {activeTab === 'lezioni' && <LessonsTab />}
                {activeTab === 'voti' && <GradesTab />}
                {activeTab === 'note' && <NotesTab />}
            </div>
        </div>
    );
}
