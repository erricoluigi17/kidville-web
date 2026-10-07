'use client';

import { useId } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ETICHETTA, SceltaMultiplaContabilita } from './SceltaMultiplaContabilita';
import { etichettaMese, mesiAnnoScolastico, mesiValidi } from '@/lib/pagamenti/selezione-voci';
import { cx } from '@/lib/ui/cx';

/**
 * ─── FILTRI DI SELEZIONE DELLA CONTABILITÀ — categorie, mesi, anno ──────────
 *
 * Tre controlli CONTROLLATI dal genitore che guidano KPI e tabella:
 *  · `FiltroCategorieContabilita` — scelta multipla (vuoto = tutte);
 *  · `FiltroMesiContabilita`      — scelta multipla sui 12 mesi dell'anno
 *                                   scolastico, set→ago (vuoto = tutto l'anno);
 *  · `FiltroAnnoContabilita`      — il `<select>` dell'anno scolastico.
 *
 * Categorie e mesi stanno sul generico `SceltaMultiplaContabilita` (stesso DOM
 * e stessa accessibilità di `FiltroClassiContabilita`); qui restano solo i
 * testi e il calcolo del riepilogo.
 *
 * ⚠️ L'etichetta del comando categorie è «Categorie», MAI «Categoria»: un test
 * esistente cerca `findByLabelText('Categoria')` per un'altra select, e un
 * nome uguale lo renderebbe ambiguo.
 */

// Il `<select>` dell'anno sta in riga con i comandi a scelta multipla (`SceltaMultiplaContabilita`):
// ne ha la stessa geometria (42px, 44px sul telefono) e lo stesso fuoco visibile — niente
// `outline-none`, il ring di focus è quello del comando accanto. Per questo non usa
// `FILTER_SELECT` di `ui.ts`, pensato per i select della barra filtri (padding verticale, `outline-none`).
const SELECT_ANNO =
  'h-[42px] rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 font-maven text-sm text-kidville-ink transition-colors cursor-pointer hover:border-kidville-green/50 focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15 max-sm:h-[44px]';

export interface OpzioneCategoria {
  id: string;
  /** Testo già etichettato dal genitore (con la sede per le categorie di sede). */
  testo: string;
}

export interface FiltroCategorieContabilitaProps {
  opzioni: OpzioneCategoria[];
  /** Gli id scelti. Vuoto = tutte le categorie. */
  scelte: string[];
  onChange: (next: string[]) => void;
  className?: string;
}

export function FiltroCategorieContabilita({ opzioni, scelte, onChange, className }: FiltroCategorieContabilitaProps) {
  const t = useTranslations('adminContabilita');
  if (opzioni.length === 0) return null;

  // Solo le scelte che corrispondono a un'opzione (deduplicate) contano.
  const presenti = new Set(opzioni.map((o) => o.id));
  const valide = [...new Set(scelte)].filter((id) => presenti.has(id));
  const attive = new Set(valide);

  let riepilogo: string;
  if (valide.length === 0) riepilogo = t('filtroCategorieTutte');
  else if (valide.length === 1) riepilogo = opzioni.find((o) => o.id === valide[0])!.testo;
  else riepilogo = t('filtroCategorieSelezionate', { n: valide.length });

  return (
    <SceltaMultiplaContabilita
      etichetta={t('filtroCategorieEtichetta')}
      riepilogo={riepilogo}
      testoTutte={t('filtroCategorieTutte')}
      tutteAttiva={valide.length === 0}
      etichettaPannello={t('filtroCategoriePannello')}
      legendaPredefinita={t('filtroCategorieLegenda')}
      gruppi={[{ chiave: 'categorie', titolo: null, voci: opzioni.map((o) => ({ id: o.id, testo: o.testo })) }]}
      attive={attive}
      onCommuta={(id) => onChange(attive.has(id) ? valide.filter((v) => v !== id) : [...valide, id])}
      onTutte={() => onChange([])}
      className={className}
    />
  );
}

export interface FiltroMesiContabilitaProps {
  /** Anno scolastico (l'anno di settembre). */
  anno: number;
  /** Numeri di mese scelti (1–12). Vuoto = tutto l'anno. */
  mesi: number[];
  onChange: (next: number[]) => void;
  className?: string;
}

export function FiltroMesiContabilita({ anno, mesi, onChange, className }: FiltroMesiContabilitaProps) {
  const t = useTranslations('adminContabilita');
  const locale = useLocale();
  const periodi = mesiAnnoScolastico(anno);
  const voci = periodi.map((p) => ({ id: String(p.mese), testo: etichettaMese(p.periodo, locale, 'corta') }));

  const valide = mesiValidi(mesi);
  const attive = new Set(valide.map(String));

  let riepilogo: string;
  if (valide.length === 0) riepilogo = t('filtroMesiTutto');
  else if (valide.length === 1) riepilogo = voci.find((v) => v.id === String(valide[0]))!.testo;
  else riepilogo = t('filtroMesiSelezionati', { n: valide.length });

  return (
    <SceltaMultiplaContabilita
      etichetta={t('filtroMesiEtichetta')}
      riepilogo={riepilogo}
      testoTutte={t('filtroMesiTutto')}
      tutteAttiva={valide.length === 0}
      etichettaPannello={t('filtroMesiPannello')}
      legendaPredefinita={t('filtroMesiLegenda')}
      gruppi={[{ chiave: 'mesi', titolo: null, voci }]}
      attive={attive}
      onCommuta={(id) => {
        const m = Number(id);
        onChange(valide.includes(m) ? valide.filter((v) => v !== m) : [...valide, m]);
      }}
      onTutte={() => onChange([])}
      className={className}
    />
  );
}

export interface FiltroAnnoContabilitaProps {
  anno: number;
  anni: number[];
  onChange: (anno: number) => void;
  className?: string;
}

export function FiltroAnnoContabilita({ anno, anni, onChange, className }: FiltroAnnoContabilitaProps) {
  const t = useTranslations('adminContabilita');
  const id = useId();
  return (
    <div className={cx('min-w-0', className)}>
      <label htmlFor={id} className={ETICHETTA}>
        {t('filtroAnnoScolastico')}
      </label>
      <select id={id} value={anno} onChange={(e) => onChange(Number(e.target.value))} className={SELECT_ANNO}>
        {anni.map((y) => (
          <option key={y} value={y}>
            {t('dashAsPrefix')} {y}/{y + 1}
          </option>
        ))}
      </select>
    </div>
  );
}
