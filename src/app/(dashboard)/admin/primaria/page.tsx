'use client';

import { Suspense, useEffect, useState } from 'react';
import { ClipboardList, CalendarDays, FolderLock, GraduationCap } from 'lucide-react';
import { RegistriClassePanel } from '@/components/features/admin/primaria/RegistriClassePanel';
import { OrarioManager } from '@/components/features/admin/primaria/OrarioManager';
import { FascicoloAuditViewer } from '@/components/features/admin/primaria/FascicoloAuditViewer';
import { CockpitPage, PageHeader, Tabs } from '@/components/ui/cockpit';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';

type Tab = 'registri' | 'orario' | 'fascicoli';

interface Section {
  id: string;
  name: string;
  school_type: string;
  scholastic_year?: string | null;
}

function PrimariaAdminInner() {
  const { userId } = useSessionIdentity();
  const [tab, setTab] = useState<Tab>('registri');
  const [sezioni, setSezioni] = useState<Section[]>([]);
  const [sezioneId, setSezioneId] = useState<string>('');

  useEffect(() => {
    fetch(`/api/admin/sections?scuola_id=${SCUOLA_ID}`)
      .then((r) => r.json())
      .then((d) => {
        const list: Section[] = Array.isArray(d) ? d.filter((s: Section) => s.school_type === 'primaria') : [];
        setSezioni(list);
        // Update funzionale: nessuna dipendenza da sezioneId, deps [] pulite.
        if (list.length) setSezioneId((cur) => cur || list[0].id);
      })
      .catch(() => {});
  }, []);

  return (
    <CockpitPage max={1100}>
      <PageHeader
        icon={GraduationCap}
        title="Scuola Primaria"
        subtitle="Area operativa: registri di classe, orario e registro accessi ai fascicoli. La configurazione (materie, docenti, obiettivi, giudizi, scrutinio) è in Impostazioni → Didattica primaria."
      />

      {/* Selettore sezione (per Orario) */}
      {(tab === 'orario') && (
        <div className="mb-4 flex items-center gap-3">
          <label className="font-maven text-sm text-kidville-ink/70">Classe/Sezione:</label>
          <select
            value={sezioneId}
            onChange={(e) => setSezioneId(e.target.value)}
            className="font-maven rounded-pill border border-kidville-line bg-kidville-white px-4 py-2 text-sm"
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

      <Tabs
        value={tab}
        onChange={(id) => setTab(id as Tab)}
        options={[
          { id: 'registri', label: 'Registri di classe', icon: ClipboardList },
          { id: 'orario', label: 'Orario', icon: CalendarDays },
          { id: 'fascicoli', label: 'Fascicoli/Accessi', icon: FolderLock },
        ]}
      />

      <div className="rounded-card bg-kidville-white p-4 md:p-6 shadow-sm">
          {userId && tab === 'registri' && <RegistriClassePanel scuolaId={SCUOLA_ID} userId={userId} />}
          {userId && tab === 'orario' && (
            <OrarioManager sectionId={sezioneId} scuolaId={SCUOLA_ID} userId={userId} />
          )}
          {userId && tab === 'fascicoli' && <FascicoloAuditViewer scuolaId={SCUOLA_ID} userId={userId} />}
        </div>
    </CockpitPage>
  );
}

export default function PrimariaAdminPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <PrimariaAdminInner />
    </Suspense>
  );
}
