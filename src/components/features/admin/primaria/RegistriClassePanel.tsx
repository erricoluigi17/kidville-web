'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { ClipboardList, CheckSquare, Star, AlertTriangle, CalendarDays, BarChart3, GraduationCap, FolderLock } from 'lucide-react';

interface Section { id: string; name: string; school_type: string; scholastic_year?: string | null }

// Voci = stesse funzioni del docente. Admin/segreteria accedono in modifica a
// qualsiasi classe dalle rotte /admin/primaria/[sectionId]/* (ClasseShell),
// così restano dentro il cockpit (sidebar+header) invece del layout mobile docente.
// `seg` è il valore di rotta (immutato); label/desc sono chiavi i18n risolte a render.
const FUNZIONI = [
  { seg: 'registro', labelKey: 'registriRegistroLabel', icon: ClipboardList, descKey: 'registriRegistroDesc' },
  { seg: 'appello', labelKey: 'registriAppelloLabel', icon: CheckSquare, descKey: 'registriAppelloDesc' },
  { seg: 'valutazioni', labelKey: 'registriValutazioniLabel', icon: Star, descKey: 'registriValutazioniDesc' },
  { seg: 'note', labelKey: 'registriNoteLabel', icon: AlertTriangle, descKey: 'registriNoteDesc' },
  { seg: 'orario', labelKey: 'registriOrarioLabel', icon: CalendarDays, descKey: 'registriOrarioDesc' },
  { seg: 'prospetto', labelKey: 'registriProspettoLabel', icon: BarChart3, descKey: 'registriProspettoDesc' },
  { seg: 'scrutinio', labelKey: 'registriScrutinioLabel', icon: GraduationCap, descKey: 'registriScrutinioDesc' },
  { seg: 'fascicolo', labelKey: 'registriFascicoloLabel', icon: FolderLock, descKey: 'registriFascicoloDesc' },
] as const;

// Vista admin/segreteria di tutti i registri di classe: ciò che fa il docente,
// per qualsiasi sezione, in modifica.
export function RegistriClassePanel({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const t = useTranslations('adminPrimaria');
  const [sezioni, setSezioni] = useState<Section[]>([]);
  const [sezioneId, setSezioneId] = useState('');

  useEffect(() => {
    fetch(`/api/admin/sections?scuola_id=${scuolaId}`)
      .then((r) => r.json())
      .then((d) => {
        const list: Section[] = Array.isArray(d) ? d.filter((s: Section) => s.school_type === 'primaria') : [];
        setSezioni(list);
        if (list.length) setSezioneId((p) => p || list[0].id);
      })
      .catch(() => {});
  }, [scuolaId]);

  return (
    <div>
      <h3 className="font-barlow text-base font-bold text-kidville-ink mb-1">{t('registriTitolo')}</h3>
      <p className="font-maven text-xs text-kidville-muted mb-4">
        {t('registriSottotitolo')}
      </p>

      <div className="mb-5 flex items-center gap-3">
        <label className="font-maven text-sm text-kidville-ink">{t('comuneClasseSezione')}</label>
        <select
          value={sezioneId}
          onChange={(e) => setSezioneId(e.target.value)}
          className="font-maven rounded-pill border border-kidville-line bg-white px-4 py-2 text-sm"
        >
          {sezioni.length === 0 && <option value="">{t('comuneNessunaSezione')}</option>}
          {sezioni.map((s) => (
            <option key={s.id} value={s.id}>{s.name} {s.scholastic_year ? `(${s.scholastic_year})` : ''}</option>
          ))}
        </select>
      </div>

      {sezioneId && (
        <div className="grid gap-3 sm:grid-cols-2">
          {FUNZIONI.map(({ seg, labelKey, icon: Icon, descKey }) => (
            <Link
              key={seg}
              href={`/admin/primaria/${sezioneId}/${seg}?userId=${userId}`}
              className="flex items-start gap-3 rounded-card border border-kidville-line bg-white p-3 transition hover:border-kidville-green/40 hover:bg-kidville-green/5"
            >
              <span className="mt-0.5 text-kidville-green"><Icon size={18} /></span>
              <span>
                <span className="font-maven block text-sm font-semibold text-kidville-ink">{t(labelKey)}</span>
                <span className="font-maven block text-xs text-kidville-muted">{t(descKey)}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
