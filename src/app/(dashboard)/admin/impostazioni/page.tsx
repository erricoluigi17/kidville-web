'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Settings, CreditCard, GraduationCap } from 'lucide-react';
import { SettingsPanel } from '@/components/features/admin/settings/SettingsPanel';
import { DidatticaPrimariaPanel } from '@/components/features/admin/primaria/DidatticaPrimariaPanel';

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';
const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

type Sezione = 'pagamenti' | 'didattica';

function Inner() {
    const params = useSearchParams();
    const userId = params.get('userId') || DEV_ADMIN;
    const [sezione, setSezione] = useState<Sezione>(params.get('sezione') === 'didattica' ? 'didattica' : 'pagamenti');

    const sezioni: { id: Sezione; label: string; icon: React.ReactNode }[] = [
        { id: 'pagamenti', label: 'Pagamenti & Fatturazione', icon: <CreditCard size={15} /> },
        { id: 'didattica', label: 'Didattica primaria', icon: <GraduationCap size={15} /> },
    ];

    return (
        <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
            <div className="max-w-5xl mx-auto">
                <header className="mb-6">
                    <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
                        <Settings size={24} /> Impostazioni
                    </h1>
                    <p className="font-maven text-sm text-gray-500">Pagamenti e fatturazione · configurazione didattica della scuola primaria.</p>
                </header>

                <nav className="mb-6 flex flex-wrap gap-2">
                    {sezioni.map((s) => (
                        <button
                            key={s.id}
                            onClick={() => setSezione(s.id)}
                            className={`font-maven inline-flex items-center gap-2 rounded-pill px-4 py-2 text-sm transition ${
                                sezione === s.id ? 'bg-kidville-green text-kidville-yellow' : 'bg-white text-gray-600 hover:bg-kidville-green/10'
                            }`}
                        >
                            {s.icon}
                            {s.label}
                        </button>
                    ))}
                </nav>

                {sezione === 'pagamenti' && <SettingsPanel userId={userId} scuolaId={SCUOLA_ID} />}
                {sezione === 'didattica' && <DidatticaPrimariaPanel scuolaId={SCUOLA_ID} userId={userId} />}
            </div>
        </div>
    );
}

export default function AdminImpostazioniPage() {
    return (
        <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
            <Inner />
        </Suspense>
    );
}
