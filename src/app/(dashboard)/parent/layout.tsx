import BottomNav from '@/components/features/parent/BottomNav';

export default function ParentLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-kidville-cream">
      <div className="relative max-w-[430px] mx-auto min-h-screen">
        <main>{children}</main>
        <BottomNav />
      </div>
    </div>
  );
}
