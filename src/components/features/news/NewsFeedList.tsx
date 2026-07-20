'use client'

import { useState, useEffect, useCallback } from 'react'
import { Search, X, CalendarDays, RotateCcw } from 'lucide-react'
import { withIdentity } from '@/lib/auth/current-user'
import { cx } from '@/lib/ui/cx'
import type { NewsCategoria, NewsPost } from '@/lib/news/tipi'
import { NewsCard } from './NewsCard'
import { NewsArchivioDrawer, formattaMeseArchivio } from './NewsArchivioDrawer'

// =============================================================================
// Contratto API tollerante (Step 3 sviluppa in parallelo): il feed può tornare
// come array diretto, come { posts | data | items }, oppure { disponibile:false }
// sul DB E2E non migrato. In ogni caso la UI non deve rompersi → normalizzatori
// puri e testati che degradano a lista vuota.
// =============================================================================

/** Estrae la lista di post da una risposta feed di forma variabile. */
export function estraiFeed(data: unknown): NewsPost[] {
  if (Array.isArray(data)) return data as NewsPost[]
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    if (o.disponibile === false) return []
    for (const k of ['posts', 'data', 'items', 'news']) {
      if (Array.isArray(o[k])) return o[k] as NewsPost[]
    }
  }
  return []
}

/** Estrae l'aggregato mensile [{mese,conteggio}] da ?archivio=1, tollerante. */
export function estraiArchivio(data: unknown): { mese: string; conteggio: number }[] {
  let raw: unknown[] = []
  if (Array.isArray(data)) raw = data
  else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    if (o.disponibile === false) return []
    if (Array.isArray(o.archivio)) raw = o.archivio
    else if (Array.isArray(o.mesi)) raw = o.mesi
    else if (Array.isArray(o.data)) raw = o.data
  }
  return raw
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>
      const mese = typeof o.mese === 'string' ? o.mese : ''
      const conteggio = typeof o.conteggio === 'number' ? o.conteggio : Number(o.conteggio) || 0
      return { mese, conteggio }
    })
    .filter((r) => /^\d{4}-\d{2}$/.test(r.mese))
}

/** Estrae le categorie attive da /api/news/categorie, tollerante. */
function estraiCategorie(data: unknown): NewsCategoria[] {
  let raw: unknown[] = []
  if (Array.isArray(data)) raw = data
  else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    if (o.disponibile === false) return []
    if (Array.isArray(o.categorie)) raw = o.categorie
    else if (Array.isArray(o.data)) raw = o.data
    else if (Array.isArray(o.items)) raw = o.items
  }
  return (raw as NewsCategoria[]).filter((c) => c && typeof c.id === 'string' && c.attivo !== false)
}

interface Props {
  parentId: string | null
  studentId: string | null
  /** Callback opzionale col numero di post caricati (per header conteggi). */
  onCount?: (n: number) => void
}

export function NewsFeedList({ parentId, studentId, onCount }: Props) {
  const [posts, setPosts] = useState<NewsPost[]>([])
  const [categorie, setCategorie] = useState<NewsCategoria[]>([])
  const [mesiArchivio, setMesiArchivio] = useState<{ mese: string; conteggio: number }[]>([])
  const [archivioCaricato, setArchivioCaricato] = useState(false)

  const [q, setQ] = useState('')
  const [queryAttiva, setQueryAttiva] = useState('')
  const [catFiltro, setCatFiltro] = useState<string | null>(null)
  const [meseFiltro, setMeseFiltro] = useState<string | null>(null)

  const [loading, setLoading] = useState(true)
  const [errore, setErrore] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const caricaFeed = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (queryAttiva) params.set('q', queryAttiva)
      if (catFiltro) params.set('categoria_id', catFiltro)
      if (meseFiltro) params.set('mese', meseFiltro)
      const qs = params.toString()
      const res = await fetch(`/api/news/feed${qs ? `?${qs}` : ''}`, parentId ? { headers: { 'x-user-id': parentId } } : undefined)
      if (res.ok) {
        const lista = estraiFeed(await res.json())
        setPosts(lista)
        setErrore(false)
        onCount?.(lista.length)
      } else {
        setErrore(true)
      }
    } finally {
      setLoading(false)
    }
  }, [queryAttiva, catFiltro, meseFiltro, parentId, onCount])

  useEffect(() => {
    caricaFeed()
  }, [caricaFeed])

  // Categorie best-effort (per le pillole e il nome sulla card). Degrado silenzioso.
  useEffect(() => {
    let attivo = true
    const carica = async () => {
      try {
        const res = await fetch('/api/news/categorie', parentId ? { headers: { 'x-user-id': parentId } } : undefined)
        if (res.ok && attivo) setCategorie(estraiCategorie(await res.json()))
      } finally {
        /* degrado silenzioso: senza categorie non ci sono le pillole */
      }
    }
    carica()
    return () => {
      attivo = false
    }
  }, [parentId])

  const caricaArchivio = useCallback(async () => {
    try {
      const res = await fetch('/api/news/feed?archivio=1', parentId ? { headers: { 'x-user-id': parentId } } : undefined)
      if (res.ok) setMesiArchivio(estraiArchivio(await res.json()))
    } finally {
      setArchivioCaricato(true)
    }
  }, [parentId])

  const apriArchivio = () => {
    setDrawerOpen(true)
    if (!archivioCaricato) void caricaArchivio()
  }

  const nomeCategoria = (id: string | null): string | null => {
    if (!id) return null
    return categorie.find((c) => c.id === id)?.nome ?? null
  }

  const inviaRicerca = (e: React.FormEvent) => {
    e.preventDefault()
    setQueryAttiva(q.trim())
  }

  const azzeraRicerca = () => {
    setQ('')
    setQueryAttiva('')
  }

  const filtriAttivi = !!queryAttiva || !!catFiltro || !!meseFiltro

  return (
    <div>
      {/* Ricerca */}
      <form onSubmit={inviaRicerca} className="mb-3 flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-pill border border-kidville-line bg-kidville-white px-3.5 py-2.5">
          <Search size={17} className="text-kidville-muted" strokeWidth={2} />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cerca nelle news…"
            aria-label="Cerca nelle news"
            className="min-w-0 flex-1 bg-transparent font-maven text-sm text-kidville-ink outline-none placeholder:text-kidville-muted"
          />
          {q && (
            <button type="button" onClick={azzeraRicerca} aria-label="Cancella ricerca" className="text-kidville-muted">
              <X size={16} strokeWidth={2.4} />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={apriArchivio}
          aria-label="Archivio per mese"
          className="flex h-[42px] w-[42px] flex-shrink-0 items-center justify-center rounded-pill border border-kidville-line bg-kidville-white text-kidville-green active:scale-95"
        >
          <CalendarDays size={19} strokeWidth={1.9} />
        </button>
      </form>

      {/* Pillole categoria (solo se disponibili) */}
      {categorie.length > 0 && (
        <div className="mb-3 -mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Filtra per categoria">
          <button
            type="button"
            role="tab"
            aria-selected={catFiltro === null}
            onClick={() => setCatFiltro(null)}
            className={cx(
              'flex-shrink-0 rounded-pill px-3.5 py-1.5 font-barlow text-[12px] font-extrabold uppercase tracking-wide',
              catFiltro === null ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-white text-kidville-green border border-kidville-line',
            )}
          >
            Tutte
          </button>
          {categorie.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={catFiltro === c.id}
              onClick={() => setCatFiltro((v) => (v === c.id ? null : c.id))}
              className={cx(
                'flex-shrink-0 rounded-pill px-3.5 py-1.5 font-barlow text-[12px] font-extrabold uppercase tracking-wide',
                catFiltro === c.id ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-white text-kidville-green border border-kidville-line',
              )}
            >
              {c.nome}
            </button>
          ))}
        </div>
      )}

      {/* Filtro mese attivo */}
      {meseFiltro && (
        <div className="mb-3 flex items-center justify-between rounded-card bg-kidville-green-soft px-3.5 py-2">
          <span className="font-barlow text-[12.5px] font-extrabold uppercase tracking-wide text-kidville-green">
            {formattaMeseArchivio(meseFiltro)}
          </span>
          <button
            type="button"
            onClick={() => setMeseFiltro(null)}
            className="flex items-center gap-1 font-barlow text-[11.5px] font-extrabold uppercase tracking-wide text-kidville-green"
          >
            <RotateCcw size={13} strokeWidth={2.4} />
            Tutti i mesi
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[120px] animate-pulse rounded-card bg-kidville-white" />
          ))}
        </div>
      )}

      {/* Errore con retry */}
      {!loading && errore && (
        <div className="flex flex-col items-center justify-center rounded-card bg-kidville-white py-12 text-center">
          <p className="font-maven text-sm text-kidville-muted">Non è stato possibile caricare le news.</p>
          <button
            type="button"
            onClick={() => {
              setLoading(true)
              void caricaFeed()
            }}
            className="mt-3 inline-flex items-center gap-2 rounded-pill bg-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-yellow active:scale-95"
          >
            <RotateCcw size={15} strokeWidth={2.4} />
            Riprova
          </button>
        </div>
      )}

      {/* Vuoto */}
      {!loading && !errore && posts.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-cream text-4xl">📰</div>
          <h2 className="mb-1 font-barlow text-xl font-bold uppercase text-kidville-green">
            {filtriAttivi ? 'Nessun risultato' : 'Ancora nessuna news'}
          </h2>
          <p className="max-w-xs font-maven text-sm text-kidville-muted">
            {filtriAttivi ? 'Prova a rimuovere i filtri di ricerca.' : 'Qui compariranno le novità e i comunicati della scuola.'}
          </p>
        </div>
      )}

      {/* Feed */}
      {!loading && !errore && posts.length > 0 && (
        <div className="flex flex-col gap-3">
          {posts.map((p) => (
            <NewsCard
              key={p.id}
              post={p}
              categoriaNome={nomeCategoria(p.categoria_id)}
              href={withIdentity(`/parent/news/${p.id}`, parentId, studentId)}
            />
          ))}
        </div>
      )}

      <NewsArchivioDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        mesi={mesiArchivio}
        current={meseFiltro}
        onSelect={(m) => setMeseFiltro(m)}
      />
    </div>
  )
}
