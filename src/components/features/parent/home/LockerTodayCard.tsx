'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Package, Bell } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { logClient, nomeErrore } from '@/lib/logging/client'

interface StockItem {
  materiale: string
  stock: number
}

/** Le due soglie di un materiale, come le dichiara `/api/locker/materials`. */
interface Soglia {
  allerta: number
  emergenza: number
}

interface Props {
  studentId: string
  /**
   * La sezione del bambino: è la chiave con cui si chiedono le SOGLIE al server.
   * Arriva dalla home, che quel dato ce l'ha già (`/api/diary/students?id=`) — così
   * la card non fa una seconda chiamata per sapere una cosa che il padre sa.
   * Assente ⇒ nessuna soglia ⇒ nessun semaforo, che è la verità.
   */
  classeSezione?: string
}

/**
 * Le soglie per materiale, dalla configurazione della sezione.
 *
 * ⚠️ Qui c'erano `SOGLIA_GIALLA = 5` e `SOGLIA_ROSSA = 2`, «allineate alla pagina
 * /parent/locker» — che le aveva cablate a sua volta, e sbagliate: il listino vero
 * (`src/lib/armadietto/materiali-default.ts`) dice Crema 3/1 e Cambio 2/1. Due
 * copie della stessa regola non restano allineate: restano sbagliate insieme.
 *
 * Il `try/catch` vive in una funzione di MODULO perché dentro il componente farebbe
 * scattare `react-hooks/set-state-in-effect`. Non rigetta mai: chi chiama riceve
 * `null` e semplicemente non mostra il semaforo.
 */
async function caricaSoglie(classeSezione: string): Promise<Record<string, Soglia> | null> {
  try {
    const res = await fetch(`/api/locker/materials?classe_sezione=${encodeURIComponent(classeSezione)}`)
    if (!res.ok) {
      logClient({
        livello: 'warn', evento: 'fetch',
        messaggio: `armadietto-soglie-home-non-lette: ${res.status}`,
        route: '/parent', stato: res.status,
      })
      return null
    }
    const dati: unknown = await res.json()
    if (!Array.isArray(dati)) return null
    const mappa: Record<string, Soglia> = {}
    for (const riga of dati) {
      if (riga === null || typeof riga !== 'object') continue
      const m = riga as Record<string, unknown>
      if (typeof m.nome !== 'string' || m.nome === '') continue
      // Una riga senza soglie numeriche si SCARTA: non si inventa un numero.
      if (typeof m.livello_allerta !== 'number' || typeof m.livello_emergenza !== 'number') continue
      mappa[m.nome] = { allerta: m.livello_allerta, emergenza: m.livello_emergenza }
    }
    return mappa
  } catch (err) {
    logClient({
      livello: 'error', evento: 'fetch',
      messaggio: `armadietto-soglie-home-fallite: ${nomeErrore(err)}`,
      route: '/parent',
    })
    return null
  }
}

/**
 * Teaser "Armadietto · Scorte" del design (DR LockerCard): scorte attuali con
 * barra di livello e segnalazione bassa. Dato esistente (sola lettura):
 * GET /api/locker/inventory?alunno_id=&mode=stock → [{materiale, stock}].
 *
 * Il pulsante "Avvisa" (M5.3) invia POST /api/locker/notify: notifica lo staff
 * della scuola e i docenti della sezione (tipo `locker_scorte`).
 */
export function LockerTodayCard({ studentId, classeSezione }: Props) {
  const t = useTranslations('home')
  const [items, setItems] = useState<StockItem[]>([])
  const [soglie, setSoglie] = useState<Record<string, Soglia>>({})
  const [loaded, setLoaded] = useState(false)
  const [toast, setToast] = useState('')
  const [sending, setSending] = useState(false)

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

  // Le soglie, in un effetto suo: dipendono dalla SEZIONE, non dal bambino, e
  // senza sezione non si chiedono affatto (la route, senza `classe_sezione`, non
  // filtra per plesso e risponderebbe con la configurazione di tutte le sedi).
  useEffect(() => {
    if (!classeSezione) return
    let active = true
    void caricaSoglie(classeSezione).then((s) => {
      if (active && s !== null) setSoglie(s)
    })
    return () => {
      active = false
    }
  }, [classeSezione])

  const notifyScuola = async (nome: string) => {
    if (sending) return
    setSending(true)
    try {
      const res = await fetch('/api/locker/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alunno_id: studentId, materiale: nome }),
      }).catch(() => null)
      setToast(res?.ok
        ? t('lockerAvvisoInviato', { materiale: nome.toLowerCase() })
        : t('lockerInvioFallito'))
    } finally {
      setSending(false)
      setTimeout(() => setToast(''), 2600)
    }
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
        <p className="font-maven text-[13px] text-kidville-muted">{t('lockerVuoto')}</p>
      </Card>
    )
  }

  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3">
        {items.map((it) => {
          // Materiale senza configurazione ⇒ niente semaforo e niente barra: un
          // colore inventato dice al genitore «stai tranquillo» o «corri» senza
          // saperlo. Il numero, quello, si mostra sempre.
          const s = soglie[it.materiale]
          const basso = s ? it.stock <= s.emergenza : false
          const medio = s ? !basso && it.stock <= s.allerta : false
          const pct = s ? Math.min(100, Math.round((it.stock / Math.max(s.allerta * 2, it.stock)) * 100)) : 0
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
                    {it.stock} {t('lockerPz')}
                  </span>
                </div>
                {s && (
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-kidville-line">
                    <div className={'h-full rounded-full ' + barColor} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              {basso && (
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => notifyScuola(it.materiale)}
                  className="flex flex-shrink-0 items-center gap-1 rounded-pill bg-kidville-cream-dark px-3 py-1.5 font-barlow text-[11.5px] font-extrabold uppercase tracking-wide text-kidville-green active:scale-95 disabled:opacity-60"
                >
                  <Bell size={13} /> {t('lockerAvvisa')}
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
