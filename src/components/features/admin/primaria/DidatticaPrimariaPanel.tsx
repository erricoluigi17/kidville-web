'use client';

import { useEffect, useState } from 'react';
import { BookOpen, Users, Star, GraduationCap, SlidersHorizontal } from 'lucide-react';
import { MaterieManager } from '@/components/features/admin/primaria/MaterieManager';
import { DocentiMaterieManager } from '@/components/features/admin/primaria/DocentiMaterieManager';
import { GiudiziManager } from '@/components/features/admin/primaria/GiudiziManager';
import { ScrutinioPeriodiManager } from '@/components/features/admin/primaria/ScrutinioPeriodiManager';
import { ClassificazioneDocenti } from '@/components/features/admin/primaria/ClassificazioneDocenti';
import { ImpostazioniManager } from '@/components/features/admin/primaria/ImpostazioniManager';

type Tab = 'materie' | 'docenti' | 'giudizi' | 'scrutinio' | 'classificazione' | 'abilitazione';

interface Section { id: string; name: string; school_type: string; scholastic_year?: string | null }

// Sezione "Didattica primaria" dell'hub impostazioni: raccoglie la configurazione
// didattica della scuola primaria (materie, docenti&materie, giudizi, scrutinio,
// classificazione docenti, abilitazione funzioni). Riusa i manager esistenti.
export function DidatticaPrimariaPanel({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const [tab, setTab] = useState<Tab>('materie');
  const [sezioni, setSezioni] = useState<Section[]>([]);
  const [sezioneId, setSezioneId] = useState<string>('');

  useEffect(() => {
    fetch(`/api/admin/sections?scuola_id=${scuolaId}`)
      .then((r) => r.json())
      .then((d) => {
        const list: Section[] = Array.isArray(d) ? d.filter((s: Section) => s.school_type === 'primaria') : [];
        setSezioni(list);
        if (list.length) setSezioneId((prev) => prev || list[0].id);
      })
      .catch(() => {});
  }, [scuolaId]);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'materie', label: 'Materie', icon: <BookOpen size={15} /> },
    { id: 'docenti', label: 'Docenti & Materie', icon: <Users size={15} /> },
    { id: 'giudizi', label: 'Giudizi', icon: <Star size={15} /> },
    { id: 'scrutinio', label: 'Scrutinio', icon: <GraduationCap size={15} /> },
    { id: 'classificazione', label: 'Classificazione docenti', icon: <GraduationCap size={15} /> },
    { id: 'abilitazione', label: 'Abilitazione funzioni', icon: <SlidersHorizontal size={15} /> },
  ];

  const sezioneCorrente = sezioni.find((s) => s.id === sezioneId);

  return (
    <div>
      {(tab === 'materie' || tab === 'docenti') && (
        <div className="mb-4 flex items-center gap-3">
          <label className="font-maven text-sm text-gray-600">Classe/Sezione:</label>
          <select
            value={sezioneId}
            onChange={(e) => setSezioneId(e.target.value)}
            className="font-maven rounded-pill border border-gray-200 bg-white px-4 py-2 text-sm"
          >
            {sezioni.length === 0 && <option value="">Nessuna sezione primaria</option>}
            {sezioni.map((s) => (
              <option key={s.id} value={s.id}>{s.name} {s.scholastic_year ? `(${s.scholastic_year})` : ''}</option>
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
              tab === t.id ? 'bg-kidville-green text-kidville-yellow' : 'bg-white text-gray-600 hover:bg-kidville-green/10'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      <div className="rounded-card bg-white p-4 md:p-6 shadow-sm">
        {tab === 'materie' && <MaterieManager sectionId={sezioneId} sezione={sezioneCorrente} userId={userId} scuolaId={scuolaId} />}
        {tab === 'docenti' && <DocentiMaterieManager sectionId={sezioneId} scuolaId={scuolaId} userId={userId} />}
        {tab === 'giudizi' && <GiudiziManager scuolaId={scuolaId} userId={userId} />}
        {tab === 'scrutinio' && <ScrutinioPeriodiManager scuolaId={scuolaId} userId={userId} />}
        {tab === 'classificazione' && <ClassificazioneDocenti scuolaId={scuolaId} userId={userId} />}
        {tab === 'abilitazione' && <ImpostazioniManager scuolaId={scuolaId} userId={userId} />}
      </div>
    </div>
  );
}
