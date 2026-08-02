'use client'

import { useState, useRef, useEffect, useId } from 'react'
import { useTranslations } from 'next-intl'
import { ShieldCheck, Loader2, AlertCircle, Mail, X, CheckCircle2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'

interface Props {
  open: boolean
  email: string | null
  devCode?: string
  onClose: () => void
  /** Verifica il codice e finalizza la firma. Ritorna esito + eventuale errore. */
  onVerify: (code: string) => Promise<{ ok: boolean; error?: string }>
}

/**
 * Modale di firma elettronica semplice (FES) tramite OTP via email.
 * Stile conforme a design.md (sfondi chiari, verde Kidville, niente scuri).
 *
 * ACCESSIBILITÀ (a11y #4 e #3 del collaudo 2026-08-02). Questa è la finestra in
 * cui un genitore appone una firma con VALORE LEGALE su un modulo scolastico, e
 * per chi usa uno screen reader era muta su tutti e quattro i fronti:
 *   · non era un dialogo (niente `role="dialog"`, niente `aria-modal`, nessun
 *     nome): il Tab usciva sulla pagina sotto ed Esc non chiudeva — nel file non
 *     compariva la stringa «Escape» nemmeno una volta;
 *   · il campo del codice non aveva nome, quindi il nome accessibile calcolato
 *     era il PLACEHOLDER: sei puntini letti a voce;
 *   · «codice errato» non stava in nessuna live region: si riprovava alla cieca;
 *   · il ✕ non aveva nome (axe `button-name`, impact critical).
 *
 * LA CAUSA ERA UNA SOLA, ed è la lezione già scritta per questo ciclo: una
 * regola valida per due strade deve vivere in un posto solo. Il gemello
 * `OtpSignatureModal` — stessa firma, altro punto del prodotto — usa da sempre
 * la primitiva `@/components/ui/Modal` e ha i suoi `aria-label`; questo era
 * stato riscritto a mano, e la differenza fra i due era casuale. Adesso la
 * finestra è una sola implementazione: dialogo, focus-trap ciclico, Esc,
 * sfondo `inert`, tasto Indietro di Android, ripristino del focus al trigger.
 *
 * `closeOnBackdrop={false}` è il comportamento che c'era già (l'overlay scritto
 * a mano non aveva alcun handler di click) ed è quello giusto: un click distratto
 * fuori dalla finestra non deve annullare una firma a metà.
 *
 * CONTRASTI, misurati sui valori dei token (sRGB, WCAG 2.x). Gli hex restano in
 * `globals.css`, che è il posto dove i colori si dichiarano:
 *   · il ✕ era dipinto con la utility Tailwind `text-gray-400` — fuori dal tema,
 *     quindi ignorato anche dall'Alto Contrasto — e vale 2,60:1 su bianco. Un ✕
 *     è un COMPONENTE d'interfaccia (1.4.11, soglia 3:1), non un testo
 *     decorativo → `kidville-sub` = 6,46:1. E il bersaglio passa da 28×28 a
 *     44×44 (2.5.8) con la pastiglia visiva ferma a 28: si allarga l'area, non
 *     il disegno.
 *   · il messaggio d'errore era `kidville-error` su bianco = 4,23:1 con
 *     `text-xs`, sotto i 4,5:1 di AA → `error-strong` = 5,62:1, che è già il
 *     token usato per gli errori in Contabilità.
 */
export function OtpEmailModal({ open, email, devCode, onClose, onVerify }: Props) {
  const t = useTranslations('parentForms')
  const [code, setCode] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Id per ISTANZA (non costanti scritte a mano): il titolo è il bersaglio di
  // `aria-labelledby`, l'errore quello di `aria-describedby`. Due modali nella
  // stessa pagina non devono rubarsi il nome a vicenda.
  const uid = useId()
  const idTitolo = `${uid}-titolo`
  const idErrore = `${uid}-errore`

  // Reset dello stato a ogni apertura del modale
  // (adjust-state-during-render, prior art: AvvisoForm.tsx / TaskForm.tsx)
  const [prevOpen, setPrevOpen] = useState(false)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setCode('')
      setError(null)
      setSuccess(false)
    }
  }

  // La primitiva porta il focus sul PRIMO controllo del dialogo (il ✕); qui lo
  // si sposta subito sul campo del codice, che è l'unica cosa da fare in questa
  // finestra. Stesso gesto del gemello `OtpSignatureModal`, e il timer si
  // annulla allo smontaggio: un focus che arriva a finestra chiusa lo
  // strapperebbe a quello che l'utente sta facendo dopo.
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [open])

  async function handleVerify() {
    if (code.length !== 6) {
      setError(t('inserisciCodice6'))
      return
    }
    setVerifying(true)
    setError(null)
    const res = await onVerify(code)
    setVerifying(false)
    if (!res.ok) {
      setError(res.error ?? t('verificaFallita'))
      return
    }
    setSuccess(true)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('firmaElettronica')}
      labelledBy={idTitolo}
      closeOnBackdrop={false}
      className="w-full max-w-sm rounded-card p-6 bg-white shadow-2xl border border-kidville-green/10"
    >
      {!success && (
        <button
          type="button"
          onClick={onClose}
          aria-label={t('chiudi')}
          className="group absolute top-2.5 right-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl"
        >
          <span className="w-7 h-7 rounded-lg flex items-center justify-center text-kidville-sub group-hover:text-kidville-green group-hover:bg-kidville-cream transition-all">
            <X className="w-4 h-4" aria-hidden="true" />
          </span>
        </button>
      )}

      {/* Regione viva PERSISTENTE per l'esito: esiste già, vuota, prima che la
          firma parta. Uno screen reader annuncia i cambiamenti di una regione
          che c'era prima — se nascesse insieme al testo, la conferma della
          firma potrebbe non essere letta affatto. */}
      <div role="status">
        {success && (
          <div className="flex flex-col items-center text-center py-4">
            <div className="w-16 h-16 rounded-2xl bg-kidville-success/15 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-8 h-8 text-kidville-success" aria-hidden="true" />
            </div>
            <h3 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide">
              {t('moduloFirmato')}
            </h3>
            <p className="font-maven text-sm text-kidville-sub mt-1">
              {t('firmaRegistrata')}
            </p>
          </div>
        )}
      </div>

      {!success && (
        <div>
          <div className="w-12 h-12 rounded-2xl bg-kidville-green/10 flex items-center justify-center mb-4">
            <ShieldCheck className="w-6 h-6 text-kidville-green" aria-hidden="true" />
          </div>
          <h3 id={idTitolo} className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide">
            {t('firmaElettronica')}
          </h3>
          <p className="flex items-center gap-1.5 font-maven text-sm text-kidville-sub mt-1.5">
            <Mail className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            {t('codiceInviatoA')}{' '}
            <span className="text-kidville-green font-semibold">{email ?? t('laTuaEmail')}</span>
          </p>

          {devCode && (
            <p className="mt-3 px-3 py-2 rounded-lg bg-kidville-yellow-light border border-kidville-yellow/40 text-xs text-kidville-green">
              Dev: codice <span className="font-mono font-bold tracking-widest">{devCode}</span>
            </p>
          )}

          {/* Il placeholder resta un SUGGERIMENTO: il nome lo porta l'etichetta,
              altrimenti lo screen reader annuncia «••••••». */}
          <input
            ref={inputRef}
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={e => e.key === 'Enter' && handleVerify()}
            inputMode="numeric"
            aria-label={t('ariaCodiceFirma')}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? idErrore : undefined}
            placeholder="••••••"
            className="mt-5 w-full px-4 py-4 rounded-xl bg-kidville-cream border-2 border-kidville-green/15 text-center text-2xl font-mono tracking-[0.5em] text-kidville-green placeholder-kidville-green/30 focus:outline-none focus:border-kidville-green transition-all"
          />

          {error && (
            <p id={idErrore} role="alert" className="flex items-center gap-1.5 text-xs text-kidville-error-strong mt-2">
              <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={handleVerify}
            disabled={verifying || code.length !== 6}
            className="mt-5 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-pill bg-kidville-green text-kidville-yellow font-barlow font-black uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-all"
          >
            {verifying
              ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              : <ShieldCheck className="w-4 h-4" aria-hidden="true" />}
            {t('firmaCompleta')}
          </button>
        </div>
      )}
    </Modal>
  )
}
