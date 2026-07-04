'use client';

import { useState } from 'react';
import { GraduationCap, Star, ListChecks } from 'lucide-react';
import { GiudiziManager } from '@/components/features/admin/primaria/GiudiziManager';
import { ScrutinioPeriodiManager } from '@/components/features/admin/primaria/ScrutinioPeriodiManager';
import { ScrutinioGiudiziManager } from '@/components/features/admin/primaria/ScrutinioGiudiziManager';

type Tab = 'periodi' | 'giudizi' | 'giudizi-scrutinio';

// Sezione "Pagelle & Scrutinio" dell'hub impostazioni: periodi di scrutinio,
// scala giudizi sintetici e giudizi descrittivi. Riusa i manager esistenti.
export function PagelleScrutinioPanel({ scuolaId, userId }: { scuolaId: string; userId: string }) {
    const [tab, setTab] = useState<Tab>('periodi');

    const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
        { id: 'periodi', label: 'Periodi scrutinio', icon: <GraduationCap size={15} /> },
        { id: 'giudizi', label: 'Scala giudizi', icon: <Star size={15} /> },
        { id: 'giudizi-scrutinio', label: 'Giudizi scrutinio', icon: <ListChecks size={15} /> },
    ];

    return (
        <div>
            <nav className="mb-6 flex flex-wrap gap-2">
                {tabs.map((t) => (
                    <button
                        key={t.id}
                        onClick={() => setTab(t.id)}
                        className={`font-maven inline-flex items-center gap-2 rounded-pill px-4 py-2 text-sm transition ${
                            tab === t.id ? 'bg-kidville-green text-kidville-yellow' : 'bg-white text-kidville-ink hover:bg-kidville-green/10'
                        }`}
                    >
                        {t.icon}
                        {t.label}
                    </button>
                ))}
            </nav>

            <div className="rounded-card bg-white p-4 md:p-6 shadow-sm">
                {tab === 'periodi' && <ScrutinioPeriodiManager scuolaId={scuolaId} userId={userId} />}
                {tab === 'giudizi' && <GiudiziManager scuolaId={scuolaId} userId={userId} />}
                {tab === 'giudizi-scrutinio' && <ScrutinioGiudiziManager scuolaId={scuolaId} userId={userId} />}
            </div>
        </div>
    );
}
