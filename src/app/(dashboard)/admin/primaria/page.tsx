'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Target, CalendarDays, FolderLock } from 'lucide-react';
import { ObiettiviManager } from '@/components/features/admin/primaria/ObiettiviManager';
import { OrarioManager } from '@/components/features/admin/primaria/OrarioManager';
import { FascicoloAuditViewer } from '@/components/features/admin/primaria/FascicoloAuditViewer';

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';
const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

type Tab = 'obiettivi' | 'orario' | 'fascicoli';

interface Section {
  id: string;
  name: string;
  school_type: string;
  scholastic_year?: string | null;
}

function PrimariaAdminInner() {
  const params = useSearchParams();
  const userId = params.get('userId') || DEV_ADMIN;
  const [tab, setTab] = useState<Tab>('obiettivi');
  const [sezioni, setSezioni] = useState<Section[]>([]);
  const [sezioneId, setSezioneId] = useState<string>('');

  useEffect(() => {
    fetch(`/api/admin/sections?scuola_id=${SCUOLA_ID}`)
      .then((r) => r.json())
      .then((d) => {
        const list: Section[] = Array.isArray(d) ? d.filter((s: Section) => s.school_type === 'primaria') : [];
        setSezioni(list);
        if (list.length && !sezioneId) setSezioneId(list[0].id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'obiettivi', label: 'Obiettivi', icon: <Target size={15} /> },
    { id: 'orario', label: 'Orario', icon: <CalendarDays size={15} /> },
    { id: 'fascicoli', label: 'Fascicoli/Accessi', icon: <FolderLock size={15} /> },
  ];

  return (
    <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <header className="mb-6">
          <h1 className="font-barlow text-3xl font-bold text-kidville-green uppercase tracking-wide">
            Scuola Primaria
          </h1>
          <p className="font-maven text-gray-500 text-sm">
            Area operativa: obiettivi di apprendimento, orario e registro accessi ai fascicoli. La configurazione (materie, docenti, giudizi, scrutinio) è in Impostazioni → Didattica primaria.
          </p>
        </header>

        {/* Selettore sezione (per Orario) */}
        {(tab === 'orario') && (
          <div className="mb-4 flex items-center gap-3">
            <label className="font-maven text-sm text-gray-600">Classe/Sezione:</label>
            <select
              value={sezioneId}
              onChange={(e) => setSezioneId(e.target.value)}
              className="font-maven rounded-pill border border-gray-200 bg-white px-4 py-2 text-sm"
            >
              {sezioni.length === 0 && <option value="">Nessuna sezione primaria</option>}
              {sezioni.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.scholastic_year ? `(${s.scholastic_year})` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <nav className="mb-6 flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`font-maven inline-flex items-center gap-2 rounded-pill px-4 py-2 text-sm transition ${
                tab === t.id
                  ? 'bg-kidville-green text-kidville-yellow'
                  : 'bg-white text-gray-600 hover:bg-kidville-green/10'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>

        <div className="rounded-card bg-white p-4 md:p-6 shadow-sm">
          {tab === 'obiettivi' && <ObiettiviManager scuolaId={SCUOLA_ID} userId={userId} />}
          {tab === 'orario' && (
            <OrarioManager sectionId={sezioneId} scuolaId={SCUOLA_ID} userId={userId} />
          )}
          {tab === 'fascicoli' && <FascicoloAuditViewer scuolaId={SCUOLA_ID} userId={userId} />}
        </div>
      </div>
    </div>
  );
}

export default function PrimariaAdminPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-500">Caricamento…</div>}>
      <PrimariaAdminInner />
    </Suspense>
  );
}
