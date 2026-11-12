'use client'

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { History } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { btnClass } from '@/components/ui/Btn'
import { MOTIVO_CORREZIONE_MAX, MOTIVO_CORREZIONE_MIN } from '@/lib/anno/correzione'

/**
 * «REGISTRA COME CORREZIONE» — il dialogo che si apre quando la Direzione o la segreteria scrivono su un anno già chiuso (PR 4.9, 4.9.3).
 *
 * Una sola cosa da dire e una da chiedere: QUALE anno si sta toccando (se la pagina lo sa) e PERCHÉ. Il motivo resta nel registro
 * (`correzioni_anno_chiuso`), non nei log: questo componente non lo scrive in nessun log, non lo mette in nessuna URL e non lo
 * conserva oltre la chiusura (il testo vive nello stato del dialogo, che si smonta con lui).
 *
 * Non invia niente: restituisce il motivo a `useCorrezioneAnno`, che rimanda la richiesta. «Annulla» e Escape restituiscono `null` e
 * la richiesta NON riparte. Il pulsante «Registra» è spento finché il motivo, senza spazi ai bordi, non arriva a
 * `MOTIVO_CORREZIONE_MIN` caratteri (`aria-disabled` e una guardia nel gestore, come ogni conferma del progetto).
 */
export function CorrezioneAnnoDialog({
  etichetta,
  onConferma,
  onAnnulla,
}: {
  /** L'anno che si sta correggendo (es. «2026/27»), se la pagina lo sa. */
  etichetta?: string
  onConferma: (motivo: string) => void
  onAnnulla: () => void
}) {
  const t = useTranslations('annoCorrezione')
  const idTitolo = useId()
  const idMotivo = useId()
  const idAiuto = useId()
  const [motivo, setMotivo] = useState('')
  const lunghezza = motivo.trim().length
  const valido = lunghezza >= MOTIVO_CORREZIONE_MIN && lunghezza <= MOTIVO_CORREZIONE_MAX

  const conferma = () => {
    if (!valido) return
    onConferma(motivo.trim())
  }

  return (
    <Modal
      open
      onClose={onAnnulla}
      title={t('titolo')}
      labelledBy={idTitolo}
      // Non si chiude cliccando fuori: un click distratto non deve poter far partire né far sparire una correzione.
      closeOnBackdrop={false}
      className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-card bg-kidville-white p-5 shadow-xl"
    >
      <div className="mb-3 flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-kidville-warn-soft text-kidville-warn-strong">
          <History size={22} strokeWidth={1.9} aria-hidden="true" />
        </div>
        <h2 id={idTitolo} className="font-barlow text-lg font-bold uppercase leading-tight text-kidville-green">
          {t('titolo')}
        </h2>
      </div>

      <p className="font-maven text-[13px] text-kidville-ink">
        {etichetta ? t('intro', { etichetta }) : t('introSenzaAnno')}
      </p>

      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault()
          conferma()
        }}
      >
        <label htmlFor={idMotivo} className="mb-1.5 block font-maven text-xs font-medium uppercase tracking-wide text-kidville-sub">
          {t('etichettaMotivo')}
        </label>
        <textarea
          id={idMotivo}
          aria-required="true"
          aria-describedby={idAiuto}
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder={t('segnaposto')}
          rows={4}
          maxLength={MOTIVO_CORREZIONE_MAX}
          // 16px: sotto, Safari su iPhone ingrandisce la pagina al tocco.
          style={{ fontSize: '16px' }}
          className="w-full resize-none rounded-2xl border-2 border-kidville-line bg-white px-4 py-2.5 font-maven text-kidville-green focus:border-kidville-green/40 focus:outline-none focus:ring-2 focus:ring-kidville-green/20"
        />
        <p id={idAiuto} className="mt-1 flex justify-between font-maven text-[12px] text-kidville-sub">
          <span>{lunghezza < MOTIVO_CORREZIONE_MIN ? t('minimo', { min: MOTIVO_CORREZIONE_MIN }) : ''}</span>
          <span>{t('conteggio', { n: lunghezza, max: MOTIVO_CORREZIONE_MAX })}</span>
        </p>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onAnnulla} className={btnClass('ghost', 'sm')}>
            {t('annulla')}
          </button>
          <button type="submit" aria-disabled={!valido} className={btnClass('primary', 'sm')}>
            {t('registra')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
