import { Inbox } from 'lucide-react'
import { SubmissionsTable } from '@/components/features/admin/forms/submissions/SubmissionsTable'

export const metadata = {
  title: 'Compilazioni Ricevute — Kidville',
}

export default function SubmissionsPage() {
  return (
    <div
      className="min-h-screen px-6 py-8 lg:px-10"
      style={{ background: '#0b0f1f' }}
    >
      <div className="max-w-6xl mx-auto">
        {/* Page header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-1.5">
            <div
              className="p-2 rounded-xl"
              style={{ background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.2)' }}
            >
              <Inbox className="w-5 h-5 text-indigo-400" />
            </div>
            <h1 className="text-white font-bold text-xl tracking-tight">
              Compilazioni Ricevute
            </h1>
          </div>
          <p className="text-slate-600 text-sm" style={{ paddingLeft: '3rem' }}>
            Visualizza, filtra ed esporta tutte le risposte ai moduli dinamici
          </p>
        </div>

        <SubmissionsTable />
      </div>
    </div>
  )
}
