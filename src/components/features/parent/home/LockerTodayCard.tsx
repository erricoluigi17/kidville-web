'use client'

import { useEffect, useState } from 'react'
import { Package, Bell } from 'lucide-react'
import { Card } from '@/components/ui/Card'

interface StockItem {
  materiale: string
  stock: number
}

interface Props {
  studentId: string
}

// Soglie allineate alla pagina /parent/locker (getSemaforoUI).
const SOGLIA_GIALLA = 5
const SOGLIA_ROSSA = 2

/**
 * Teaser "Armadietto · Scorte" del design (DR LockerCard): scorte attuali con
 * barra di livello e segnalazione bassa. Dato esistente (sola lettura):
 * GET /api/locker/inventory?alunno_id=&mode=stock → [{materiale, stock}].
 *
 * Il pulsante "Avvisa" del mockup non ha un endpoint dedicato (DR usava un toast):
 * è reso come placeholder con avviso "funzione in arrivo".
 */
export function LockerTodayCard({ studentId }: Props) {
  const [items, setItems] = useState<StockItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [toast, setToast] = useState('')

  useEffect(() => {
    if (!studentId) return
    let active = true
    fetch(`/api/locker/inventory?alunno_id=${studentId}&mode=stock`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active && Array.isArray(d)) setItems(d)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [studentId])

  const notifyComingSoon = (nome: string) => {
    setToast(`Funzione in arrivo: avviseremo la scuola per ${nome.toLowerCase()}.`)
    setTimeout(() => setToast(''), 2600)
  }

  if (!loaded) {
    return (
      <Card className="p-4">
        <div className="h-5 w-2/3 animate-pulse rounded-full bg-kidville-line" />
        <div className="mt-3 h-2 w-full animate-pulse rounded-full bg-kidville-line" />
      </Card>
    )
  }

  if (items.length === 0) {
    return (
      <Card className="flex items-center gap-3 p-4">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[11px] bg-kidville-green-soft text-kidville-green">
          <Package size={18} />
        </span>
        <p className="font-maven text-[13px] text-kidville-muted">Nessun materiale registrato al momento.</p>
      </Card>
    )
  }

  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3">
        {items.map((it) => {
          const basso = it.stock <= SOGLIA_ROSSA
          const medio = !basso && it.stock <= SOGLIA_GIALLA
          const pct = Math.min(100, Math.round((it.stock / Math.max(SOGLIA_GIALLA * 2, it.stock)) * 100))
          const barColor = basso ? 'bg-kidville-error' : medio ? 'bg-kidville-warn' : 'bg-kidville-success'
          return (
            <div key={it.materiale} className="flex items-center gap-3">
              <span
                className={
                  'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[11px] ' +
                  (basso ? 'bg-kidville-error-soft text-kidville-error' : 'bg-kidville-green-soft text-kidville-green')
                }
              >
                <Package size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-barlow text-sm font-extrabold uppercase text-kidville-green">
                    {it.materiale}
                  </span>
                  <span
                    className={
                      'font-maven text-xs font-bold ' + (basso ? 'text-kidville-error' : 'text-kidville-muted')
                    }
                  >
                    {it.stock} pz
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-kidville-line">
                  <div className={'h-full rounded-full ' + barColor} style={{ width: `${pct}%` }} />
                </div>
              </div>
              {basso && (
                <button
                  type="button"
                  onClick={() => notifyComingSoon(it.materiale)}
                  className="flex flex-shrink-0 items-center gap-1 rounded-pill bg-kidville-cream-dark px-3 py-1.5 font-barlow text-[11.5px] font-extrabold uppercase tracking-wide text-kidville-green active:scale-95"
                >
                  <Bell size={13} /> Avvisa
                </button>
              )}
            </div>
          )
        })}
      </div>

      {toast && (
        <div className="fixed bottom-[110px] left-1/2 z-[60] -translate-x-1/2 rounded-2xl bg-kidville-green px-5 py-3 font-maven text-sm font-semibold text-white shadow-xl">
          {toast}
        </div>
      )}
    </Card>
  )
}
