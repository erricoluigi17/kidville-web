'use client';

/**
 * TopBar MOBILE del cockpit Direzione/Segreteria (<lg) — barra VERDE del brand.
 *
 * Sostituisce, sotto i 1024px, la vecchia topbar bianca (badge K + hamburger →
 * drawer) con la stessa barra verde persistente dell'AppBar genitore/docente:
 * wordmark Kidville bianco (link alla home admin) + campanella notifiche.
 * NIENTE hamburger, NIENTE badge K: la navigazione mobile è la bottom-nav
 * (`AdminBottomNav` + `AdminMenuSheet`, integrati dal layout).
 *
 * Il wordmark usa la STESSA metrica dell'AppBar (`logo-light.png`, height 19,
 * width auto). `kv-admin-topbar` porta le regole Alto Contrasto (aggiornate per
 * la barra verde in globals.css), `kv-appbar-admin` il padding-top di safe-area
 * nativa (`.cap-native`). L'identità (userId) viaggia via ?userId= come nelle
 * altre superfici del cockpit (`useAdminIdentity`), niente lettura duplicata.
 *
 * DAL 2026-07-31 PORTA ANCHE LA SEDE. Con tre plessi in produzione, «in quale
 * sede sto guardando questi dati» è la prima cosa da sapere e non era scritta da
 * nessuna parte sotto i 1024px: il selettore esisteva solo nella topbar
 * desktop, `hidden … lg:flex`. Qui c'è la variante `compatto` (una riga, niente
 * contatore alunni: nessuna chiamata in più) — e con una sede sola non si monta,
 * perché non c'è niente da scegliere. La scelta estesa, con le tre righe e la
 * spunta, resta nel bottom-sheet «Menu».
 */

import Link from 'next/link';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useAdminIdentity } from '@/lib/context/admin-identity';
import { SedeSelector } from '@/components/ui/cockpit';
import { AdminNotificationsPanel } from './AdminNotificationsPanel';

export function AdminTopBarMobile() {
  const t = useTranslations('adminNav');
  const { userId, withUser } = useAdminIdentity();

  return (
    <header className="kv-admin-topbar kv-appbar-admin sticky top-0 z-[105] flex items-center gap-2.5 bg-kidville-green px-4 pb-3 pt-2 lg:hidden">
      <Link href={withUser('/admin')} aria-label={t('homeAria')} className="mr-auto">
        <Image
          src="/logo-light.png"
          alt="Kidville"
          width={620}
          height={209}
          priority
          style={{ height: 19, width: 'auto', display: 'block' }}
        />
      </Link>
      <SedeSelector userId={userId} compatto />
      <AdminNotificationsPanel userId={userId} attivoSu="(max-width: 1023.98px)" />
    </header>
  );
}
