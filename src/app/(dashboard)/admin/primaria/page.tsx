'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ClipboardList, CalendarDays, FolderLock, DoorOpen, GraduationCap } from 'lucide-react';
import { RegistriClassePanel } from '@/components/features/admin/primaria/RegistriClassePanel';
import { OrarioManager } from '@/components/features/admin/primaria/OrarioManager';
import { FascicoloAuditViewer } from '@/components/features/admin/primaria/FascicoloAuditViewer';
import { CockpitPage, PageHeader, Tabs } from '@/components/ui/cockpit';

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';
const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

type Tab = 'registri' | 'orario' | 'fascicoli' | 'classi';

interface Section {
  id: string;
  name: string;
  school_type: string;
  scholastic_year?: string | null;
}

interface ClasseOp { id: string; name: string; numAlunni?: number }

function PrimariaAdminInner() {
  const params = useSearchParams();
  const userId = params.get('userId') || DEV_ADMIN;
  const [tab, setTab] = useState<Tab>('registri');
  const [sezioni, setSezioni] = useState<Section[]>([]);
  const [sezioneId, setSezioneId] = useState<string>('');
  const [classiOp, setClassiOp] = useState<ClasseOp[]>([]);

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

  // Classi operative scoped per ruolo/plesso (stesso endpoint del flusso docente).
  useEffect(() => {
    fetch(`/api/primaria/classi?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setClassiOp(d.data ?? []); })
      .catch(() => {});
  }, [userId]);

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
          { id: 'classi', label: 'Entra in classe', icon: DoorOpen },
        ]}
      />

      <div className="rounded-card bg-kidville-white p-4 md:p-6 shadow-sm">
          {tab === 'registri' && <RegistriClassePanel scuolaId={SCUOLA_ID} userId={userId} />}
          {tab === 'orario' && (
            <OrarioManager sectionId={sezioneId} scuolaId={SCUOLA_ID} userId={userId} />
          )}
          {tab === 'fascicoli' && <FascicoloAuditViewer scuolaId={SCUOLA_ID} userId={userId} />}
          {tab === 'classi' && (
            <div>
              <p className="font-maven mb-4 text-sm text-kidville-muted">
                Entra nella classe per operare (registro, appello, valutazioni, note, scrutinio, fascicolo) come fa il docente. La cornice resta sempre presente; le scritture vengono attribuite al docente titolare.
              </p>
              {classiOp.length === 0 ? (
                <p className="font-maven text-sm text-kidville-muted">Nessuna classe disponibile nel tuo plesso.</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {classiOp.map((c) => (
                    <Link
                      key={c.id}
                      href={`/admin/primaria/${c.id}/registro?userId=${userId}`}
                      className="flex items-center justify-between rounded-card border border-kidville-line p-4 transition hover:border-kidville-green/40 hover:bg-kidville-green/5"
                    >
                      <span>
                        <span className="font-maven block text-sm font-semibold text-kidville-ink">{c.name}</span>
                        {typeof c.numAlunni === 'number' && (
                          <span className="font-maven block text-xs text-kidville-muted">{c.numAlunni} alunni</span>
                        )}
                      </span>
                      <DoorOpen size={18} className="text-kidville-green" />
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
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
