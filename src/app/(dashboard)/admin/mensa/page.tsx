'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { UtensilsCrossed, CalendarRange, ClipboardList, Settings, CalendarPlus, Ticket } from 'lucide-react';
import Link from 'next/link';
import { MenuBuilder } from '@/components/features/admin/mensa/MenuBuilder';
import { MensaReport } from '@/components/features/admin/mensa/MensaReport';
import { MensaSettings } from '@/components/features/admin/mensa/MensaSettings';
import { PrenotazioneSegreteria } from '@/components/features/admin/mensa/PrenotazioneSegreteria';

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';
const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

type Tab = 'menu' | 'report' | 'prenota' | 'impostazioni';

function MensaInner() {
  const params = useSearchParams();
  const userId = params.get('userId') || DEV_ADMIN;
  const [tab, setTab] = useState<Tab>('menu');
  const [sezioni, setSezioni] = useState<string[]>([]);

  useEffect(() => {
    fetch(`/api/admin/students?scuola_id=${SCUOLA_ID}`).then(r => r.json()).then(d => {
      if (Array.isArray(d)) {
        const set = Array.from(new Set(d.map((a: { classe_sezione?: string }) => a.classe_sezione).filter(Boolean))) as string[];
        setSezioni(set.sort());
      }
    }).catch(() => {});
  }, []);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'menu', label: 'Menu', icon: <CalendarRange size={15} /> },
    { id: 'report', label: 'Report cucina', icon: <ClipboardList size={15} /> },
    { id: 'prenota', label: 'Inserisci ticket', icon: <CalendarPlus size={15} /> },
    { id: 'impostazioni', label: 'Impostazioni', icon: <Settings size={15} /> },
  ];

  return (
    <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
              <UtensilsCrossed size={24} /> Mensa & Cucina
            </h1>
            <p className="font-maven text-sm text-gray-500">Menu, report cucina, ticket giornalieri e impostazioni.</p>
          </div>
          <Link href={`/admin/pagamenti?userId=${userId}`}
            className="px-3 py-2 rounded-full border-2 border-gray-200 text-gray-500 font-maven text-sm font-bold flex items-center gap-1 hover:border-kidville-green hover:text-kidville-green">
            <Ticket size={15} /> Ricarica ticket
          </Link>
        </header>

        <div className="flex gap-2 mb-4 flex-wrap">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-4 py-2 rounded-full font-maven font-bold text-sm flex items-center gap-1 ${tab === t.id ? 'bg-kidville-green text-white' : 'bg-white text-gray-500 border border-gray-200'}`}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-4 md:p-6">
          {tab === 'menu' && <MenuBuilder userId={userId} scuolaId={SCUOLA_ID} />}
          {tab === 'report' && <MensaReport userId={userId} scuolaId={SCUOLA_ID} sezioni={sezioni} />}
          {tab === 'prenota' && <PrenotazioneSegreteria userId={userId} scuolaId={SCUOLA_ID} />}
          {tab === 'impostazioni' && <MensaSettings userId={userId} scuolaId={SCUOLA_ID} />}
        </div>
      </div>
    </div>
  );
}

export default function AdminMensaPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
      <MensaInner />
    </Suspense>
  );
}
