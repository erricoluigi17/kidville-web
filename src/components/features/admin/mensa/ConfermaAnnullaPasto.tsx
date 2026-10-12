'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';

interface Props {
  /** `null` = finestra chiusa. */
  richiesta: { nome: string; dataLeggibile: string } | null;
  /** La disdetta è partita: il pulsante di conferma si spegne. */
  inCorso?: boolean;
  onConferma: () => void;
  onChiudi: () => void;
}

/**
 * La conferma prima di annullare un pasto dalla segreteria (decisione del titolare,
 * 2026-10-12): annullare restituisce il ticket e toglie il bambino dal conteggio della
 * cucina, e in un elenco di venti nomi un tocco sbagliato è facile. In pagina, mai
 * `confirm()` nativo: nella WebView Capacitor su iOS può non tornare. Aggiungere non
 * chiede conferma: si rimedia con un «Annulla».
 */
export function ConfermaAnnullaPasto({ richiesta, inCorso = false, onConferma, onChiudi }: Props) {
  const t = useTranslations('adminMensa');
  const idTitolo = useId();
  return (
    <Modal open={richiesta !== null} onClose={onChiudi} title={t('confermaAnnullaTitolo')} labelledBy={idTitolo} className="w-full max-w-md">
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={idTitolo} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {t('confermaAnnullaTitolo')}
        </h2>
        {richiesta && (
          <p className="mt-2 font-maven text-sm text-kidville-ink">
            {t('confermaAnnullaTesto', { nome: richiesta.nome, data: richiesta.dataLeggibile })}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onChiudi}
            className="min-h-[44px] rounded-full border-2 border-kidville-line px-4 font-maven text-sm font-bold text-kidville-green">
            {t('confermaAnnullaNo')}
          </button>
          <button type="button" onClick={onConferma} disabled={inCorso}
            className="min-h-[44px] rounded-full bg-kidville-error-strong px-4 font-maven text-sm font-bold text-white disabled:opacity-50">
            {t('confermaAnnullaSi')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
