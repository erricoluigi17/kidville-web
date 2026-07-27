'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

// Bottone di conferma della cancellazione. La mutazione (registrazione della
// richiesta pending) avviene SOLO qui, al click esplicito: il caricamento della
// pagina (GET) non tocca nulla. I parametri firmati del magic-link arrivano dal
// server component e vengono rispediti tali e quali al POST di conferma.
export function ConfermaCancellazioneForm({
  email,
  code,
  expiry,
  ticket,
}: {
  email: string
  code: string
  expiry: string
  ticket: string
}) {
  const t = useTranslations('public')
  const [stato, setStato] = useState<'idle' | 'invio' | 'ok' | 'errore'>('idle')

  async function conferma() {
    setStato('invio')
    try {
      const res = await fetch('/api/public/cancellazione-account/conferma', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, code, expiry: Number(expiry), ticket }),
      })
      setStato(res.ok ? 'ok' : 'errore')
    } catch {
      setStato('errore')
    }
  }

  if (stato === 'ok') {
    return (
      <p
        role="status"
        className="rounded-card border border-kidville-green/30 bg-kidville-green/5 p-4 font-maven text-[15px] leading-relaxed text-kidville-ink"
      >
        {t('cancConfermaOk')}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {stato === 'errore' && (
        <p role="alert" className="font-maven text-sm text-kidville-error">
          {t('cancConfermaErrore')}
        </p>
      )}
      <button
        type="button"
        onClick={conferma}
        disabled={stato === 'invio'}
        className="inline-flex items-center justify-center rounded-pill bg-kidville-green px-6 py-2.5 font-barlow text-sm font-bold uppercase tracking-wide text-white transition-colors hover:bg-kidville-green/90 disabled:opacity-60"
      >
        {stato === 'invio' ? t('cancConfermaInvio') : t('cancConfermaCta')}
      </button>
    </div>
  )
}
