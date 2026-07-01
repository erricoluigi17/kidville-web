'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Euro, CalendarClock, Ticket, Settings, Layers, UtensilsCrossed } from 'lucide-react';
import Link from 'next/link';
import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';
import { GeneratoreRette } from '@/components/features/admin/pagamenti/GeneratoreRette';
import { GeneratoreCategoria } from '@/components/features/admin/pagamenti/GeneratoreCategoria';
import { TicketMensaPanel } from '@/components/features/admin/pagamenti/TicketMensaPanel';
import { CockpitPage, PageHeader, Tabs } from '@/components/ui/cockpit';

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';
const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

type Tab = 'scadenziario' | 'rette' | 'categoria' | 'ticket';

function PagamentiInner() {
    const params = useSearchParams();
    const userId = params.get('userId') || DEV_ADMIN;
    const [tab, setTab] = useState<Tab>('scadenziario');

    const linkCls = 'inline-flex h-[40px] items-center gap-1.5 rounded-pill border border-kidville-line bg-kidville-white px-4 font-barlow text-[13px] font-extrabold uppercase tracking-[0.03em] text-kidville-green transition-colors hover:border-kidville-green';

    return (
        <CockpitPage max={1152}>
            <PageHeader
                icon={Euro}
                title="Pagamenti"
                subtitle="Scadenziario, incassi, rette e ticket mensa."
                actions={
                    <>
                        <Link href={`/admin/mensa?userId=${userId}`} className={linkCls}><UtensilsCrossed size={15} /> Mensa &amp; Cucina</Link>
                        <Link href={`/admin/impostazioni?userId=${userId}`} className={linkCls}><Settings size={15} /> Impostazioni</Link>
                    </>
                }
            />

            <Tabs
                value={tab}
                onChange={(id) => setTab(id as Tab)}
                options={[
                    { id: 'scadenziario', label: 'Scadenziario', icon: Euro },
                    { id: 'rette', label: 'Genera rette', icon: CalendarClock },
                    { id: 'categoria', label: 'Genera pagamenti', icon: Layers },
                    { id: 'ticket', label: 'Ticket mensa', icon: Ticket },
                ]}
            />

            <div className="bg-kidville-white rounded-2xl shadow-sm p-4 md:p-6">
                {tab === 'scadenziario' && <PaymentsDashboard userId={userId} scuolaId={SCUOLA_ID} />}
                {tab === 'rette' && <GeneratoreRette userId={userId} scuolaId={SCUOLA_ID} />}
                {tab === 'categoria' && <GeneratoreCategoria userId={userId} scuolaId={SCUOLA_ID} />}
                {tab === 'ticket' && <TicketMensaPanel userId={userId} scuolaId={SCUOLA_ID} />}
            </div>
        </CockpitPage>
    );
}

export default function AdminPagamentiPage() {
    return (
        <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
            <PagamentiInner />
        </Suspense>
    );
}
