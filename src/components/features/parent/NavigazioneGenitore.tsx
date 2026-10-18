'use client';

import BottomNav, { useVociGenitore } from '@/components/features/parent/BottomNav';
import { BarraLaterale } from '@/components/features/shell/BarraLaterale';
import { useFormatoGuscio } from '@/lib/ui/use-formato-guscio';

/**
 * La navigazione dell'area genitore: barra in basso sul telefono, binario o sidebar sul tablet.
 *
 * UNA sola delle due è montata (vedi `useFormatoGuscio`). Le voci si leggono DENTRO il ramo
 * montato, così `useVociGenitore` non ha mai due istanze vive, cioè mai due richieste dei figli
 * o dei messaggi non letti.
 */
export function NavigazioneGenitore() {
  const formato = useFormatoGuscio();
  return formato === 'telefono' ? <BottomNav /> : <BarraLateraleGenitore formato={formato} />;
}

function BarraLateraleGenitore({ formato }: { formato: 'binario' | 'sidebar' }) {
  const { t, pathname, mainTabs, visibleGroups, isActive, isMenuSectionActive, anyMainTabActive, nonLetti } =
    useVociGenitore();
  return (
    <BarraLaterale
      formato={formato}
      ariaNav={t('ariaNavigazionePrincipale')}
      tab={mainTabs}
      gruppi={visibleGroups}
      pathname={pathname}
      isActive={isActive}
      menuAcceso={isMenuSectionActive && !anyMainTabActive}
      hrefDi={(href) => href}
      idBadge="chat"
      nonLetti={nonLetti}
      testi={{
        ariaMenu: t('ariaMenu'),
        eyebrow: t('menuEyebrow'),
        titolo: t('menuTitolo'),
        chiudi: t('ariaChiudi'),
        inArrivo: t('badgeInArrivo'),
      }}
    />
  );
}
