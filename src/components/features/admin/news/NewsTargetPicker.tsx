'use client';

// ─── Selettore dei destinatari di un post News ────────────────────────────────
// Sede (questa sede / «Tutte le sedi» SOLO admin) + ambito (globale / per grado /
// per classi). Rispecchia il modello del server: `scuola_id null` = tutte le sedi
// (riservato ad admin), `target_scope` + `target_gradi`/`target_classes`. Solo UI:
// il gate vero (educator, scuola_id null) è nelle route.

import { Globe, Layers, School, Building2, MapPin } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cx } from '@/lib/ui/cx';
import type { NewsScope, NewsGrado } from '@/lib/news/tipi';

// `labelKey` = chiave i18n (namespace adminComunicazioni), risolta nel componente.
const GRADI: { id: NewsGrado; labelKey: string }[] = [
  { id: 'nido', labelKey: 'gradoNido' },
  { id: 'infanzia', labelKey: 'gradoInfanzia' },
  { id: 'primaria', labelKey: 'gradoPrimaria' },
];

const SCOPES: { id: NewsScope; labelKey: string; icon: typeof Globe }[] = [
  { id: 'globale', labelKey: 'scopeGlobale', icon: Globe },
  { id: 'grado', labelKey: 'scopeGrado', icon: Layers },
  { id: 'classi', labelKey: 'scopeClassi', icon: School },
];

interface Props {
  scope: NewsScope;
  onScope: (s: NewsScope) => void;
  gradi: NewsGrado[];
  onGradi: (g: NewsGrado[]) => void;
  classi: string[];
  onClassi: (c: string[]) => void;
  availableClasses: string[];
  /** «Tutte le sedi» compare SOLO se true (admin). */
  canAllSedi?: boolean;
  tuttiSedi: boolean;
  onTuttiSedi: (v: boolean) => void;
}

const pill = (on: boolean) =>
  cx(
    'inline-flex items-center gap-1.5 rounded-pill px-3.5 py-2 font-maven text-[13px] font-bold transition-colors',
    'outline-none focus-visible:ring-2 focus-visible:ring-kidville-green focus-visible:ring-offset-1',
    on
      ? 'bg-kidville-green text-kidville-white'
      : 'border-[1.5px] border-kidville-line bg-kidville-white text-kidville-green hover:border-kidville-green',
  );

export function NewsTargetPicker({
  scope, onScope, gradi, onGradi, classi, onClassi, availableClasses,
  canAllSedi = false, tuttiSedi, onTuttiSedi,
}: Props) {
  const t = useTranslations('adminComunicazioni');
  const toggleGrado = (g: NewsGrado) => onGradi(gradi.includes(g) ? gradi.filter((x) => x !== g) : [...gradi, g]);
  const toggleClasse = (c: string) => onClassi(classi.includes(c) ? classi.filter((x) => x !== c) : [...classi, c]);

  return (
    <div className="space-y-3">
      {canAllSedi && (
        <div>
          <p className="mb-1.5 font-maven text-xs font-bold uppercase tracking-wide text-kidville-sub">{t('targetSede')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => onTuttiSedi(false)} aria-pressed={!tuttiSedi} className={pill(!tuttiSedi)}>
              <MapPin size={14} /> {t('targetQuestaSede')}
            </button>
            <button type="button" onClick={() => onTuttiSedi(true)} aria-pressed={tuttiSedi} className={pill(tuttiSedi)}>
              <Building2 size={14} /> {t('targetTutteSedi')}
            </button>
          </div>
        </div>
      )}

      <div>
        <p className="mb-1.5 font-maven text-xs font-bold uppercase tracking-wide text-kidville-sub">{t('targetAmbito')}</p>
        <div className="flex flex-wrap gap-2">
          {SCOPES.map((s) => {
            const Icon = s.icon;
            const on = scope === s.id;
            return (
              <button key={s.id} type="button" onClick={() => onScope(s.id)} aria-pressed={on} className={pill(on)}>
                <Icon size={14} /> {t(s.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {scope === 'grado' && (
        <div>
          <p className="mb-1.5 font-maven text-xs font-bold uppercase tracking-wide text-kidville-sub">{t('targetGradi')}</p>
          <div className="flex flex-wrap gap-2">
            {GRADI.map((g) => (
              <button key={g.id} type="button" onClick={() => toggleGrado(g.id)} aria-pressed={gradi.includes(g.id)} className={pill(gradi.includes(g.id))}>
                {t(g.labelKey)}
              </button>
            ))}
          </div>
        </div>
      )}

      {scope === 'classi' && (
        <div>
          <p className="mb-1.5 font-maven text-xs font-bold uppercase tracking-wide text-kidville-sub">{t('targetClassi')}</p>
          {availableClasses.length === 0 ? (
            <p className="font-maven text-xs text-kidville-sub">{t('targetNessunaClasse')}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {availableClasses.map((c) => (
                <button key={c} type="button" onClick={() => toggleClasse(c)} aria-pressed={classi.includes(c)} className={pill(classi.includes(c))}>
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
