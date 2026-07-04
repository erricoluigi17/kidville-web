import { AdminSidebar } from '@/components/features/admin/AdminSidebar';
import { AdminTopBar } from '@/components/features/admin/AdminTopBar';
import { SedeProvider } from '@/lib/context/sede-context';
import { requireArea } from '@/lib/auth/area-guard';

// Shell cockpit DESKTOP: TopBar verde (full-width) in alto, poi la riga
// [sidebar | contenuto]. Su mobile la TopBar è nascosta (hidden lg:flex) e resta
// la topbar/drawer mobile dentro AdminSidebar.
// AdminSidebar non usa useSearchParams (legge userId lato client), quindi non
// sospende: è inline su ogni route (anche le dinamiche /admin/primaria/[sectionId]/*).
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Guardia d'area (M4B.4): staff di gestione e cuoca (report /admin/mensa/cucina).
  await requireArea('admin');
  return (
    <SedeProvider>
      <div className="min-h-screen bg-kidville-cream">
        <AdminTopBar />
        <div className="lg:flex">
          <AdminSidebar />
          <main className="flex-1 min-w-0" data-cockpit-content>{children}</main>
        </div>
      </div>
    </SedeProvider>
  );
}
