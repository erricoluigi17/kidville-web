'use client'

import { CalendarDays, Check } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { cx } from '@/lib/ui/cx'
import { MESI_IT } from '@/lib/news/tipi'

/** 'YYYY-MM' → 'Mese Anno' in italiano; formato non valido → passthrough. */
export function formattaMeseArchivio(mese: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(mese)
  if (!m) return mese
  const idx = Number(m[2]) - 1
  const nome = MESI_IT[idx]
  return nome ? `${nome} ${m[1]}` : mese
}

interface Props {
  open: boolean
  onClose: () => void
  mesi: { mese: string; conteggio: number }[]
  current: string | null
  onSelect: (mese: string | null) => void
}

export function NewsArchivioDrawer({ open, onClose, mesi, current, onSelect }: Props) {
  const scegli = (mese: string | null) => {
    onSelect(mese)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Archivio delle news per mese"
      className="w-full max-w-[400px] rounded-3xl bg-kidville-cream p-4"
    >
      <div className="mb-3 flex items-center gap-2 px-1">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-kidville-green-soft text-kidville-green">
          <CalendarDays size={19} strokeWidth={1.9} />
        </span>
        <div>
          <p className="font-barlow text-[10px] font-bold uppercase tracking-[0.14em] text-kidville-sub">Archivio</p>
          <h3 className="font-barlow text-lg font-black uppercase leading-none tracking-wide text-kidville-green">Scegli un mese</h3>
        </div>
      </div>

      <div className="max-h-[60vh] overflow-y-auto">
        <div className="overflow-hidden rounded-card bg-kidville-white">
          <button
            type="button"
            onClick={() => scegli(null)}
            className={cx(
              'flex w-full items-center justify-between gap-3 border-b border-kidville-line px-3 py-3 text-left active:bg-kidville-cream',
            )}
          >
            <span className="font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green">Tutti i mesi</span>
            {current === null && <Check size={16} strokeWidth={2.4} className="text-kidville-green" />}
          </button>

          {mesi.length === 0 && (
            <p className="px-3 py-4 font-maven text-[13px] text-kidville-muted">Ancora nessun mese in archivio.</p>
          )}

          {mesi.map((m, i) => {
            const attivo = current === m.mese
            return (
              <button
                key={m.mese}
                type="button"
                onClick={() => scegli(m.mese)}
                className={cx(
                  'flex w-full items-center justify-between gap-3 px-3 py-3 text-left active:bg-kidville-cream',
                  i < mesi.length - 1 && 'border-b border-kidville-line',
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green">
                    {formattaMeseArchivio(m.mese)}
                  </span>
                  <span className="rounded-pill bg-kidville-neutral-soft px-2 py-0.5 font-maven text-[11px] font-semibold text-kidville-sub">
                    {m.conteggio}
                  </span>
                </span>
                {attivo && <Check size={16} strokeWidth={2.4} className="text-kidville-green" />}
              </button>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
