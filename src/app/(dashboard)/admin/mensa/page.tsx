'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { UtensilsCrossed, CalendarRange, ClipboardList, Settings, CalendarPlus, Ticket } from 'lucide-react';
import Link from 'next/link';
import { MenuBuilder } from '@/components/features/admin/mensa/MenuBuilder';
import { MensaReport } from '@/components/features/admin/mensa/MensaReport';
import { PrenotazioneSegreteria } from '@/components/features/admin/mensa/PrenotazioneSegreteria';
import { CockpitPage, PageHeader, Tabs } from '@/components/ui/cockpit';

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';
const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

type Tab = 'menu' | 'report' | 'prenota';

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

  const linkCls = 'inline-flex h-[40px] items-center gap-1.5 rounded-pill border border-kidville-line bg-kidville-white px-4 font-barlow text-[13px] font-extrabold uppercase tracking-[0.03em] text-kidville-green transition-colors hover:border-kidville-green';

  return (
    <CockpitPage max={1152}>
      <PageHeader
        icon={UtensilsCrossed}
        title="Mensa & Cucina"
        subtitle="Menu, report cucina, ticket giornalieri e impostazioni."
        actions={
          <>
            <Link href={`/admin/pagamenti?userId=${userId}`} className={linkCls}><Ticket size={15} /> Ricarica ticket</Link>
            <Link href={`/admin/impostazioni?userId=${userId}&sezione=mensa`} className={linkCls}><Settings size={15} /> Impostazioni mensa</Link>
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

      <div className="bg-kidville-white rounded-2xl shadow-sm p-4 md:p-6">
        {tab === 'menu' && <MenuBuilder userId={userId} scuolaId={SCUOLA_ID} />}
        {tab === 'report' && <MensaReport userId={userId} scuolaId={SCUOLA_ID} sezioni={sezioni} />}
        {tab === 'prenota' && <PrenotazioneSegreteria userId={userId} scuolaId={SCUOLA_ID} />}
      </div>
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
