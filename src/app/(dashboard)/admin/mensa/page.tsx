'use client';

import { Suspense, useState, useEffect } from 'react';
import { UtensilsCrossed, CalendarRange, ClipboardList, Settings, CalendarPlus, Ticket } from 'lucide-react';
import Link from 'next/link';
import { MenuBuilder } from '@/components/features/admin/mensa/MenuBuilder';
import { MensaReport } from '@/components/features/admin/mensa/MensaReport';
import { PrenotazioneSegreteria } from '@/components/features/admin/mensa/PrenotazioneSegreteria';
import { CockpitPage, PageHeader, Tabs } from '@/components/ui/cockpit';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { SedeRequired, useSediAttive } from '@/lib/context/sede-context';

type Tab = 'menu' | 'report' | 'prenota';

function MensaInner() {
  const { userId } = useSessionIdentity();
  const { sedeCorrente } = useSediAttive();
  // Identità di sessione (M4): con identità non risolta il parametro viene
  // omesso (href invariato), mai `userId=null`.
  const withUser = (href: string) => (userId ? `${href}${href.includes('?') ? '&' : '?'}userId=${userId}` : href);
  const [tab, setTab] = useState<Tab>('menu');
  const [sezioni, setSezioni] = useState<string[]>([]);

  useEffect(() => {
    if (!userId || !sedeCorrente) return; // serve identità + una sola sede attiva
    // Il server scopa gli alunni dal cookie; `x-sedi` ne fa la chiave di re-fetch.
    fetch(`/api/admin/students?limit=1000`, { headers: { 'x-user-id': userId, 'x-sedi': sedeCorrente } }).then(r => r.json()).then(d => {
      if (Array.isArray(d)) {
        const set = Array.from(new Set(d.map((a: { classe_sezione?: string }) => a.classe_sezione).filter(Boolean))) as string[];
        setSezioni(set.sort());
      }
    }).catch(() => {});
  }, [userId, sedeCorrente]);

  const linkCls = 'inline-flex h-[40px] items-center gap-1.5 rounded-pill border border-kidville-line bg-kidville-white px-4 font-barlow text-[13px] font-extrabold uppercase tracking-[0.03em] text-kidville-green transition-colors hover:border-kidville-green';

  return (
    <CockpitPage max={1152}>
      <PageHeader
        icon={UtensilsCrossed}
        title="Mensa & Cucina"
        subtitle="Menu, report cucina, ticket giornalieri e impostazioni."
        actions={
          <>
            <Link href={withUser('/admin/pagamenti')} className={linkCls}><Ticket size={15} /> Ricarica ticket</Link>
            <Link href={withUser('/admin/impostazioni?sezione=mensa')} className={linkCls}><Settings size={15} /> Impostazioni mensa</Link>
          </>
        }
      />

      <Tabs
        value={tab}
        onChange={(id) => setTab(id as Tab)}
        options={[
          { id: 'menu', label: 'Menu', icon: CalendarRange },
          { id: 'report', label: 'Report cucina', icon: ClipboardList },
          { id: 'prenota', label: 'Inserisci ticket', icon: CalendarPlus },
        ]}
      />

      <SedeRequired cosa="mensa e cucina">
        {(scuolaId) => (
          <div className="bg-kidville-white rounded-2xl shadow-sm p-4 md:p-6">
            {tab === 'menu' && userId && <MenuBuilder userId={userId} scuolaId={scuolaId} />}
            {tab === 'report' && userId && <MensaReport userId={userId} scuolaId={scuolaId} sezioni={sezioni} />}
            {tab === 'prenota' && userId && <PrenotazioneSegreteria userId={userId} scuolaId={scuolaId} />}
          </div>
        )}
      </SedeRequired>
    </CockpitPage>
  );
}

export default function AdminMensaPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <MensaInner />
    </Suspense>
  );
}
