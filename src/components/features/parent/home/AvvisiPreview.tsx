'use client'

import { useEffect, useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Megaphone, ClipboardList } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { cx } from '@/lib/ui/cx'
import type { Avviso } from '@/components/features/avvisi/AvvisoCard'
import { formattaIstante } from '@/i18n/config'
import { logClient, nomeErrore } from '@/lib/logging/client'

interface Props {
  parentId: string
  studentId: string
}

const fmtDate = (iso: string, locale: string) => {
  try {
    return formattaIstante(new Date(iso), locale, { day: 'numeric', month: 'short' })
  } catch {
    return ''
  }
}

/**
 * Anteprima Avvisi del design (DR AvvisoRow, top 2). SOLA LETTURA: le azioni
 * (adesione / segna come letto) restano sulla pagina /parent/avvisi. Dato
 * esistente: GET /api/diary/students + GET /api/avvisi. Si nasconde se vuoto.
 */
export function AvvisiPreview({ parentId, studentId }: Props) {
  const t = useTranslations('home')
  // Il secondo catalogo serve per UNA frase: «In lista d'attesa». È la STESSA
  // (`avvisi.badgeInAttesa`) che la card mostra nella bacheca, e una seconda
  // formulazione della stessa cosa in `home` sarebbe il difetto F1 del collaudo
  // del 2026-07-31 — due testi diversi per un fatto solo.
  const tAvvisi = useTranslations('avvisi')
  const locale = useLocale()
  const [items, setItems] = useState<Avviso[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!parentId || !studentId) return
    let active = true
    ;(async () => {
      try {
        const sres = await fetch(`/api/diary/students?id=${studentId}`)
        const student = await sres.json()
        const classe = student?.classe_sezione
        if (classe) {
          // 🟠 NIENTE query string: il ramo genitore di `GET /api/avvisi` è
          // SERVER-DERIVED da G3 (`listaAvvisiGenitore`, src/app/api/avvisi/route.ts)
          // — figli e classi si ricavano dalla sessione, e `classe`/`parentId`/
          // `studentId` in query erano stati chiusi apposta perché forgiabili in
          // anonimo: da lì si leggevano gli avvisi di famiglie altrui (difetto G3).
          // Passarli qui non filtrerebbe niente: sarebbero innocui e fuorvianti.
          const res = await fetch('/api/avvisi')
          const data = await res.json()
          if (active && Array.isArray(data)) setItems(data)
        }
      } catch (err) {
        // 🔴 Lettura best-effort della sezione avvisi sulla home più vista
        // dell'app: un guasto muto qui significa una home vuota senza che
        // nessuno se ne accorga (AGENTS §6, regola 6). `error` come le altre
        // letture fallite di questa pagina (LockerTodayCard.tsx,
        // `armadietto-soglie-home-fallite`): non è un 4xx atteso del server
        // (quello lo vede e lo logga già lui), è un'eccezione — rete, parsing —
        // che qui non aveva nessuna traccia.
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `avvisi-preview-caricamento-fallito: ${nomeErrore(err)}`,
          route: '/parent',
        })
      } finally {
        if (active) setLoaded(true)
      }
    })()
    return () => {
      active = false
    }
  }, [parentId, studentId])

  if (!loaded || items.length === 0) return null

  // Priorità: adesione non risposta → presa-visione non letta → resto.
  const score = (a: Avviso) => {
    const answered = !!a.my_response?.risposta
    const read = !!a.my_response?.letto_il
    if (a.tipo === 'adesione' && !answered) return 0
    if (a.tipo !== 'adesione' && !read) return 1
    return 2
  }
  const top = [...items].sort((a, b) => score(a) - score(b)).slice(0, 2)

  return (
    <div className="flex flex-col gap-3">
      {top.map((a) => {
        const isAdesione = a.tipo === 'adesione'
        const Icon = isAdesione ? ClipboardList : Megaphone
        const answered = a.my_response?.risposta
        const read = !!a.my_response?.letto_il
        // ── «HAI ADERITO» A CHI È IN CODA, SULLA SCHERMATA PIÙ VISTA ────────
        //
        // 🔴 Questa riga decideva sul solo `risposta`, quindi diceva «Hai aderito»
        // anche a una famiglia in lista d'attesa — la stessa frase falsa che la
        // card della bacheca ha smesso di dire, ripetuta qui dove si arriva per
        // primi. `stato_adesione` arriva dalla STESSA `GET /api/avvisi` che questa
        // anteprima già chiama: non mancava il dato, mancava lo sguardo.
        //
        // Come sulla card, basta UN figlio in coda: `figli` porta lo stato di
        // ciascuno, e l'aggregato è `null` proprio quando non concordano.
        const inAttesa =
          a.my_response?.stato_adesione === 'in_attesa'
          || (a.figli ?? []).some((f) => f.stato_adesione === 'in_attesa')
        let tone: BadgeTone
        let label: string
        if (isAdesione) {
          if (answered) {
            tone = answered === 'si' ? (inAttesa ? 'warn' : 'success') : 'error'
            label =
              answered === 'si'
                ? (inAttesa ? tAvvisi('badgeInAttesa') : t('avvisiHaiAderito'))
                : t('avvisiNonAderisci')
          } else {
            tone = 'unread'
            label = t('avvisiRichiedeAdesione')
          }
        } else {
          tone = read ? 'read' : 'info'
          label = read ? t('avvisiLetto') : t('avvisiDaLeggere')
        }
        return (
          <Card key={a.id} className={cx('p-[14px]', !isAdesione && read && 'opacity-70')}>
            <div className="flex items-start gap-3">
              <div
                className={cx(
                  'flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-xl text-kidville-green',
                  isAdesione ? 'bg-kidville-yellow' : 'bg-kidville-green-soft',
                )}
              >
                <Icon size={19} strokeWidth={1.8} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={tone}>{label}</Badge>
                  <span className="font-maven text-[11px] text-kidville-muted">{fmtDate(a.created_at, locale)}</span>
                </div>
                <h3 className="mt-1.5 line-clamp-1 font-barlow text-base font-extrabold uppercase leading-tight text-kidville-green">
                  {a.titolo}
                </h3>
                <p className="mt-1 line-clamp-2 font-maven text-[12.5px] leading-snug text-[#55615c]">
                  {a.contenuto}
                </p>
              </div>
            </div>
          </Card>
        )
      })}
    </div>
  )
}
