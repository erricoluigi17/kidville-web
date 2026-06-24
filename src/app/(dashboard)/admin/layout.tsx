import { AdminSidebar } from '@/components/features/admin/AdminSidebar';

// AdminSidebar non usa più useSearchParams (legge userId lato client), quindi non
// sospende: niente Suspense/stream, la sidebar è inline su ogni route (anche le
// dinamiche come /admin/primaria/[sectionId]/*).
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-kidville-cream lg:flex">
      <AdminSidebar />
      <main className="flex-1 min-w-0" data-cockpit-content>{children}</main>
    </div>
  );
}
