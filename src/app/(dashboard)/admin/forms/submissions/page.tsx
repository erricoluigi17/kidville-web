import { Inbox } from 'lucide-react'
import { SubmissionsTable } from '@/components/features/admin/forms/submissions/SubmissionsTable'

export const metadata = {
  title: 'Compilazioni Ricevute — Kidville',
}

export default function SubmissionsPage() {
  return (
    <div className="min-h-screen px-6 py-8 lg:px-10 bg-kidville-cream">
      <div className="max-w-6xl mx-auto">
        {/* Page header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-1.5">
            <div className="p-2 rounded-xl bg-kidville-green-soft border border-kidville-green/15">
              <Inbox className="w-5 h-5 text-kidville-green" />
            </div>
            <h1 className="font-barlow text-kidville-green font-black uppercase text-xl tracking-wide">
              Compilazioni Ricevute
            </h1>
          </div>
          <p className="font-maven text-kidville-muted text-sm" style={{ paddingLeft: '3rem' }}>
            Visualizza, filtra ed esporta tutte le risposte ai moduli dinamici
          </p>
        </div>

        <SubmissionsTable />
      </div>
    </div>
  )
}
