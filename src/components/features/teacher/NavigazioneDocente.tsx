'use client';

import TeacherBottomNav, { useVociDocente } from '@/components/features/teacher/TeacherBottomNav';
import { BarraLaterale } from '@/components/features/shell/BarraLaterale';
import { useFormatoGuscio } from '@/lib/ui/use-formato-guscio';

/**
 * La navigazione dell'area docente: barra in basso sul telefono, binario o sidebar sul tablet.
 *
 * UNA sola delle due è montata (vedi `useFormatoGuscio`), e `useVociDocente` vive soltanto nel
 * ramo montato: i gradi del docente si chiedono una volta sola
 * (lock `teacher-nav-gradi-una-chiamata`).
 */
export function NavigazioneDocente() {
  const formato = useFormatoGuscio();
  return formato === 'telefono' ? <TeacherBottomNav /> : <BarraLateraleDocente formato={formato} />;
}

function BarraLateraleDocente({ formato }: { formato: 'binario' | 'sidebar' }) {
  const { t, pathname, withUser, mainTabs, visibleGroups, isActive, isMenuSectionActive, anyMainTabActive, nonLetti } =
    useVociDocente();
  return (
    <BarraLaterale
      formato={formato}
      ariaNav={t('ariaNavigazionePrincipale')}
      tab={mainTabs}
      gruppi={visibleGroups}
      pathname={pathname}
      isActive={isActive}
      menuAcceso={isMenuSectionActive && !anyMainTabActive}
      hrefDi={withUser}
      idBadge="messaggi"
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
