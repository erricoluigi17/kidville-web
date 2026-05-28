import { Trophy } from 'lucide-react'
import { RankingTable } from '@/components/features/admin/forms/rankings/RankingTable'

export const metadata = {
  title: 'Graduatorie — Kidville',
  description: 'Classifiche automatiche dei moduli completati con punteggio e regolazioni manuali',
}

export default function RankingsPage() {
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
              style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.2)' }}
            >
              <Trophy className="w-5 h-5 text-amber-400" />
            </div>
            <h1 className="text-white font-bold text-xl tracking-tight">
              Graduatorie
            </h1>
          </div>
          <p className="text-slate-600 text-sm" style={{ paddingLeft: '3rem' }}>
            Classifiche automatiche con punteggi calcolati dal database — clicca su una riga per regolare
          </p>
        </div>

        <RankingTable />
      </div>
    </div>
  )
}
