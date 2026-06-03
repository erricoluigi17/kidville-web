'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Settings } from 'lucide-react';
import { SettingsPanel } from '@/components/features/admin/settings/SettingsPanel';

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';
const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

function Inner() {
    const params = useSearchParams();
    const userId = params.get('userId') || DEV_ADMIN;
    return (
        <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
            <div className="max-w-4xl mx-auto">
                <header className="mb-6">
                    <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
                        <Settings size={24} /> Impostazioni
                    </h1>
                    <p className="font-maven text-sm text-gray-500">Categorie, rette, morosità, ticket mensa e fatturazione.</p>
                </header>
                <SettingsPanel userId={userId} scuolaId={SCUOLA_ID} />
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
