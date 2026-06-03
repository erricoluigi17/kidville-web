'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Euro, CalendarClock, Ticket, Settings } from 'lucide-react';
import Link from 'next/link';
import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';
import { GeneratoreRette } from '@/components/features/admin/pagamenti/GeneratoreRette';
import { TicketMensaPanel } from '@/components/features/admin/pagamenti/TicketMensaPanel';

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';
const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

type Tab = 'scadenziario' | 'rette' | 'ticket';

function PagamentiInner() {
    const params = useSearchParams();
    const userId = params.get('userId') || DEV_ADMIN;
    const [tab, setTab] = useState<Tab>('scadenziario');

    const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
        { id: 'scadenziario', label: 'Scadenziario', icon: <Euro size={15} /> },
        { id: 'rette', label: 'Genera rette', icon: <CalendarClock size={15} /> },
        { id: 'ticket', label: 'Ticket mensa', icon: <Ticket size={15} /> },
    ];

    return (
        <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
            <div className="max-w-6xl mx-auto">
                <header className="mb-6 flex items-start justify-between">
                    <div>
                        <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
                            <Euro size={24} /> Pagamenti
                        </h1>
                        <p className="font-maven text-sm text-gray-500">Scadenziario, incassi, rette e ticket mensa.</p>
                    </div>
                    <Link href={`/admin/impostazioni?userId=${userId}`}
                        className="px-3 py-2 rounded-full border-2 border-gray-200 text-gray-500 font-maven text-sm font-bold flex items-center gap-1 hover:border-kidville-green hover:text-kidville-green">
                        <Settings size={15} /> Impostazioni
                    </Link>
                </header>

                <div className="flex gap-2 mb-4">
                    {tabs.map(t => (
                        <button key={t.id} onClick={() => setTab(t.id)}
                            className={`px-4 py-2 rounded-full font-maven font-bold text-sm flex items-center gap-1 ${tab === t.id ? 'bg-kidville-green text-white' : 'bg-white text-gray-500 border border-gray-200'}`}>
                            {t.icon} {t.label}
                        </button>
                    ))}
                </div>

                <div className="bg-white rounded-2xl shadow-sm p-4 md:p-6">
                    {tab === 'scadenziario' && <PaymentsDashboard userId={userId} scuolaId={SCUOLA_ID} />}
                    {tab === 'rette' && <GeneratoreRette userId={userId} scuolaId={SCUOLA_ID} />}
                    {tab === 'ticket' && <TicketMensaPanel userId={userId} scuolaId={SCUOLA_ID} />}
                </div>
            </div>
        </div>
    );
}

export default function AdminPagamentiPage() {
    return (
        <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
            <PagamentiInner />
        </Suspense>
    );
}
