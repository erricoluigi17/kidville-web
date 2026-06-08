import { Suspense } from 'react';
import { AdminSidebar } from '@/components/features/admin/AdminSidebar';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-kidville-cream lg:flex">
      <Suspense fallback={<div className="hidden lg:block lg:w-64 lg:shrink-0" />}>
        <AdminSidebar />
      </Suspense>
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
