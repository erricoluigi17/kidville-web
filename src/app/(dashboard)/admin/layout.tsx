import { AdminSidebar } from '@/components/features/admin/AdminSidebar';
import { AdminTopBar } from '@/components/features/admin/AdminTopBar';
import { AdminTopBarMobile } from '@/components/features/admin/AdminTopBarMobile';
import { AdminBottomNav } from '@/components/features/admin/AdminBottomNav';
import { SedeProvider } from '@/lib/context/sede-context';
import { AdminIdentityProvider } from '@/lib/context/admin-identity';
import { requireArea } from '@/lib/auth/area-guard';

// Shell cockpit Direzione/Segreteria.
// DESKTOP (≥lg): TopBar verde full-width (`AdminTopBar`, hidden lg:flex) in alto,
//   poi la riga [sidebar | contenuto]; `AdminSidebar` è solo-desktop.
// MOBILE (<lg): topbar verde del brand (`AdminTopBarMobile`, wordmark + campanella,
//   NIENTE hamburger) in cima e bottom-nav a pillola (`AdminBottomNav`: Home ·
//   Avvisi · Contabilità · Mensa + «Menu» → bottom-sheet) in fondo. Il vecchio
//   drawer laterale è stato rimosso (Step 1).
// L'attributo di shell sul wrapper porta le regole safe-area native (`.cap-native`
// in globals.css: altezza AppBar e padding-top della barra verde). Il `pb-28
// lg:pb-0` del <main> libera lo spazio della bottom-nav flottante su mobile.
// Nessun componente qui usa useSearchParams (userId è letto client-side): niente
// Suspense → inline su ogni route, anche le dinamiche /admin/primaria/[sectionId]/*.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Guardia d'area (M4B.4): staff di gestione e cuoca (report /admin/mensa/cucina).
  await requireArea('admin');
  return (
    <AdminIdentityProvider>
      <SedeProvider>
        <div className="min-h-screen bg-kidville-cream" data-kv-shell>
          <AdminTopBarMobile />
          <AdminTopBar />
          <div className="lg:flex">
            <AdminSidebar />
            <main className="flex-1 min-w-0 pb-28 lg:pb-0" data-cockpit-content>{children}</main>
          </div>
          <AdminBottomNav />
        </div>
      </SedeProvider>
    </AdminIdentityProvider>
  );
}
