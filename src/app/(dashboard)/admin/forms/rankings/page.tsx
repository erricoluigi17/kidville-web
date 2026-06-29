import { Trophy } from 'lucide-react'
import { RankingTable } from '@/components/features/admin/forms/rankings/RankingTable'

export const metadata = {
  title: 'Graduatorie — Kidville',
  description: 'Classifiche automatiche dei moduli completati con punteggio e regolazioni manuali',
}

export default function RankingsPage() {
  return (
    <div className="min-h-screen px-6 py-8 lg:px-10 bg-kidville-cream">
      <div className="max-w-6xl mx-auto">
        {/* Page header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-1.5">
            <div className="p-2 rounded-xl bg-kidville-yellow-soft border border-kidville-yellow/30">
              <Trophy className="w-5 h-5 text-kidville-yellow-dark" />
            </div>
            <h1 className="font-barlow text-kidville-green font-black uppercase text-xl tracking-wide">
              Graduatorie
            </h1>
          </div>
          <p className="font-maven text-kidville-muted text-sm" style={{ paddingLeft: '3rem' }}>
            Classifiche automatiche con punteggi calcolati dal database — clicca su una riga per regolare
          </p>
        </div>

        <RankingTable />
      </div>
    </div>
  )
}
