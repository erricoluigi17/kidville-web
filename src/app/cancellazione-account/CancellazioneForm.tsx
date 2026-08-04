'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

// Form pubblico di richiesta cancellazione: un campo email + invio. La risposta
// del server è SEMPRE generica (anti-enumerazione), quindi il messaggio di
// successo NON conferma che l'email esista — dice solo "se è associata, riceverai
// un link". Nessuna cancellazione avviene qui: parte solo l'email di conferma.
export function CancellazioneForm() {
  const t = useTranslations('public')
  const [email, setEmail] = useState('')
  const [stato, setStato] = useState<'idle' | 'invio' | 'inviato' | 'errore'>('idle')

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStato('invio')
    try {
      const res = await fetch('/api/public/cancellazione-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      setStato(res.ok ? 'inviato' : 'errore')
    } catch {
      setStato('errore')
    }
  }

  if (stato === 'inviato') {
    return (
      <p
        role="status"
        className="rounded-card border border-kidville-green/30 bg-kidville-green/5 p-4 font-maven text-[15px] leading-relaxed text-kidville-ink"
      >
        {t('cancInviato')}
      </p>
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <label
          htmlFor="canc-email"
          className="block font-barlow text-sm font-bold uppercase tracking-wide text-kidville-green"
        >
          {t('cancEmailLabel')}
        </label>
        <input
          id="canc-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('cancEmailPlaceholder')}
          className="w-full rounded-input border border-kidville-line bg-white px-4 py-2.5 font-maven text-[15px] text-kidville-ink outline-none focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/20"
        />
      </div>

      {/* T09-F4, secondo punto: il rilievo ne nominava uno solo (la pagina di
          conferma), ma lo stesso paragrafo d'errore, con lo stesso token e lo stesso
          fondo bianco, sta anche qui. `error` #E53935 su bianco = 4,23:1, sotto i
          4,5:1 di AA per il testo normale; `error-strong` #C62828 = 5,62:1. */}
      {stato === 'errore' && (
        <p role="alert" className="font-maven text-sm text-kidville-error-strong">
          {t('cancErrore')}
        </p>
      )}

      <button
        type="submit"
        disabled={stato === 'invio'}
        className="inline-flex items-center justify-center rounded-pill bg-kidville-green px-6 py-2.5 font-barlow text-sm font-bold uppercase tracking-wide text-white transition-colors hover:bg-kidville-green/90 disabled:opacity-60"
      >
        {stato === 'invio' ? t('cancInvio') : t('cancCta')}
      </button>
    </form>
  )
}
