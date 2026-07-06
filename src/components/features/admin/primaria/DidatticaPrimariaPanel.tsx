'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BookOpen, Users, GraduationCap, SlidersHorizontal, Target, Plus } from 'lucide-react';
import { MaterieManager } from '@/components/features/admin/primaria/MaterieManager';
import { DocentiMaterieManager } from '@/components/features/admin/primaria/DocentiMaterieManager';
import { ObiettiviManager } from '@/components/features/admin/primaria/ObiettiviManager';
import { ClassificazioneDocenti } from '@/components/features/admin/primaria/ClassificazioneDocenti';
import { ImpostazioniManager } from '@/components/features/admin/primaria/ImpostazioniManager';

type Tab = 'materie' | 'docenti' | 'obiettivi' | 'classificazione' | 'vincoli';

interface Section { id: string; name: string; school_type: string; scholastic_year?: string | null }

// Sezione "Didattica primaria" dell'hub impostazioni: raccoglie la configurazione
// didattica della scuola primaria (materie, docenti&materie, giudizi, scrutinio,
// classificazione docenti, abilitazione funzioni). Riusa i manager esistenti.
export function DidatticaPrimariaPanel({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const [tab, setTab] = useState<Tab>('materie');
  const [sezioni, setSezioni] = useState<Section[]>([]);
  const [sezioneId, setSezioneId] = useState<string>('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`/api/admin/sections?scuola_id=${scuolaId}`)
      .then((r) => r.json())
      .then((d) => {
        const list: Section[] = Array.isArray(d) ? d.filter((s: Section) => s.school_type === 'primaria') : [];
        setSezioni(list);
        if (list.length) setSezioneId((prev) => prev || list[0].id);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [scuolaId]);

  // Nessuna sezione primaria = la causa reale del "mancano le materie": senza una
  // classe primaria non c'è catalogo materie (le materie sono per-sezione).
  const noSezioniPrimaria = loaded && sezioni.length === 0;
  const linkSezioni = `/admin/students?tab=sections${userId ? `&userId=${userId}` : ''}`;

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'materie', label: 'Materie', icon: <BookOpen size={15} /> },
    { id: 'docenti', label: 'Docenti & Materie', icon: <Users size={15} /> },
    { id: 'obiettivi', label: 'Obiettivi', icon: <Target size={15} /> },
    { id: 'classificazione', label: 'Classificazione docenti', icon: <GraduationCap size={15} /> },
    { id: 'vincoli', label: 'Vincoli & notifiche', icon: <SlidersHorizontal size={15} /> },
  ];

  const sezioneCorrente = sezioni.find((s) => s.id === sezioneId);

  return (
    <div>
      {(tab === 'materie' || tab === 'docenti') && !noSezioniPrimaria && (
        <div className="mb-4 flex items-center gap-3">
          <label className="font-maven text-sm text-kidville-ink">Classe/Sezione:</label>
          <select
            value={sezioneId}
            onChange={(e) => setSezioneId(e.target.value)}
            className="font-maven rounded-pill border border-kidville-line bg-white px-4 py-2 text-sm"
          >
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
              tab === t.id ? 'bg-kidville-green text-kidville-yellow' : 'bg-white text-kidville-ink hover:bg-kidville-green/10'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      <div className="rounded-card bg-white p-4 md:p-6 shadow-sm">
        {(tab === 'materie' || tab === 'docenti') && noSezioniPrimaria ? (
          <div className="py-10 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-kidville-info-soft">
              <BookOpen size={22} className="text-kidville-info" />
            </div>
            <h4 className="font-barlow font-black text-lg text-kidville-ink">Nessuna classe di primaria</h4>
            <p className="font-maven text-sm text-kidville-muted mt-1 max-w-md mx-auto">
              Le materie si gestiscono per classe: crea prima una sezione di tipo <b>Primaria</b> in
              Anagrafica → Sezioni, poi torna qui per applicare il preset delle materie o aggiungerle a mano.
            </p>
            <Link
              href={linkSezioni}
              className="font-maven mt-4 inline-flex items-center gap-2 rounded-pill bg-kidville-green px-5 py-2.5 text-sm text-kidville-yellow"
            >
              <Plus size={16} /> Crea una sezione primaria
            </Link>
          </div>
        ) : (
          <>
            {tab === 'materie' && <MaterieManager sectionId={sezioneId} sezione={sezioneCorrente} userId={userId} scuolaId={scuolaId} />}
            {tab === 'docenti' && <DocentiMaterieManager sectionId={sezioneId} scuolaId={scuolaId} userId={userId} sezioni={sezioni} sezioneName={sezioneCorrente?.name} onSectionChange={setSezioneId} />}
            {tab === 'obiettivi' && <ObiettiviManager scuolaId={scuolaId} userId={userId} />}
            {tab === 'classificazione' && <ClassificazioneDocenti scuolaId={scuolaId} userId={userId} />}
            {tab === 'vincoli' && <ImpostazioniManager scuolaId={scuolaId} userId={userId} />}
          </>
        )}
      </div>
    </div>
  );
}
