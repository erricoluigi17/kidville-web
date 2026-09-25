'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { Btn } from '@/components/ui/Btn';
import { Modal } from '@/components/ui/Modal';
import { DateField } from '@/components/ui/DateField';
import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { GIORNI_CESTINO_REGISTRO } from '@/lib/primaria/cestino-registro';
import {
  LIMITE_UPLOAD_FASCICOLO_BYTE,
  TIPI_DOCUMENTO_FASCICOLO,
  chiaveErroreFascicolo,
  corpoModificaFascicolo,
  eTipoDelFascicolo,
  leggiEsitoFascicolo,
  rifiutoRichiedeRilettura,
  type DocumentoFascicoloUi,
} from '@/lib/primaria/fascicolo-ui';

/**
 * «Modifica», «Sostituisci file» ed «Elimina» di un documento del fascicolo
 * (spec 2026-09-24, compito F2). Il server (F1) decide tutto: permesso (autore
 * oppure Segreteria/Direzione), documento ancora vivo, prestampato non
 * modificabile. Qui si decide soltanto cosa MOSTRARE e cosa chiedere prima:
 *
 *  · la pagina monta questo componente solo se chi guarda può gestire il documento
 *    (`puoGestireDocumentoUi`): nessun bottone che risponderebbe 403;
 *  · un modulo firmato o protocollato (tipo fuori da PEI/PDP/diagnosi/104) ha
 *    soltanto «Elimina»: modifica e sostituzione il server le rifiuta con 409;
 *  · «Elimina» chiede SEMPRE conferma e dice dove va il documento (cestino, per i
 *    giorni di `GIORNI_CESTINO_REGISTRO`, la stessa costante della purga);
 *  · la PATCH porta solo i campi cambiati; senza cambi non parte.
 *
 * Il fascicolo NON ha termine (spec, «Convenzioni»): niente «Sblocca».
 */

/** La rotta della pagina, per i log: il luogo dell'incidente, non della fetch. */
function rottaPagina(): string | undefined {
  return typeof window !== 'undefined' ? window.location.pathname : undefined;
}

export interface AzioniDocumentoFascicoloProps {
  documento: DocumentoFascicoloUi;
  /** Il nome mostrato del documento (file, descrizione o «Documento»): entra nei nomi accessibili. */
  nomeDocumento: string;
  /** Identità per le route (fallback legacy di `resolveIdentity`). */
  userId: string;
  /** La finalità di accesso scritta in pagina: va nel log del fascicolo anche per eliminare. */
  finalita: () => string;
  /** Qualcosa è cambiato sul server (o l'elenco è vecchio): la pagina rilegge. */
  onCambiato: () => void;
  onEsito: (testo: string, tipo: 'ok' | 'errore') => void;
}

type Aperta = 'modifica' | 'sostituisci' | 'elimina' | null;

export function AzioniDocumentoFascicolo(props: AzioniDocumentoFascicoloProps) {
  const t = useTranslations('teacherPrimaria');
  const { documento, nomeDocumento } = props;
  const [aperta, setAperta] = useState<Aperta>(null);
  const modificabile = eTipoDelFascicolo(documento.document_type);

  const bottone = 'font-maven inline-flex items-center gap-1 rounded-pill border border-kidville-line px-3 py-1.5 text-xs text-kidville-ink hover:border-kidville-green';

  return (
    <>
      {modificabile && (
        <>
          <button
            type="button"
            onClick={() => setAperta('modifica')}
            aria-label={t('fascicoloModificaAria', { documento: nomeDocumento })}
            className={bottone}
          >
            <Pencil size={12} /> {t('fascicoloModifica')}
          </button>
          <button
            type="button"
            onClick={() => setAperta('sostituisci')}
            aria-label={t('fascicoloSostituisciAria', { documento: nomeDocumento })}
            className={bottone}
          >
            <RefreshCw size={12} /> {t('fascicoloSostituisciFile')}
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => setAperta('elimina')}
        aria-label={t('fascicoloEliminaAria', { documento: nomeDocumento })}
        className="font-maven inline-flex items-center gap-1 rounded-pill border border-kidville-error/30 px-3 py-1.5 text-xs text-kidville-error hover:border-kidville-error"
      >
        <Trash2 size={12} /> {t('fascicoloElimina')}
      </button>

      {aperta === 'modifica' && <ModaleModifica {...props} onChiudi={() => setAperta(null)} />}
      {aperta === 'sostituisci' && <ModaleSostituisci {...props} onChiudi={() => setAperta(null)} />}
      {aperta === 'elimina' && <ModaleElimina {...props} onChiudi={() => setAperta(null)} />}
    </>
  );
}

type ModaleProps = AzioniDocumentoFascicoloProps & { onChiudi: () => void };

/**
 * Manda la richiesta e traduce l'esito. `true` = riuscita. Un rifiuto resta nella
 * modale (l'utente vede perché); un rifiuto che dice «l'elenco è vecchio» chiude la
 * modale, porta il messaggio alla pagina e la fa rileggere. Una fetch che LANCIA
 * (rete) si logga e fa lo stesso: l'esito è ignoto, e solo la rilettura lo dice.
 */
function useInvio(props: ModaleProps, operazione: string) {
  const t = useTranslations('teacherPrimaria');
  const [inVolo, setInVolo] = useState(false);
  // Copia SINCRONA di `inVolo`: lo stato arriva al `Modal` solo al render successivo,
  // e un Escape (o un Indietro) nel frattempo userebbe ancora la chiusura libera.
  const inVoloRef = useRef(false);
  const [errore, setErrore] = useState<string | null>(null);

  /**
   * La chiusura che le modali passano al `Modal` (Escape, clic sullo sfondo, tasto
   * Indietro di Android). Con la richiesta in volo NON chiude, come «Annulla»
   * disabilitato: una modale smontata a metà perderebbe il rifiuto del server
   * (`setErrore` su un componente che non c'è più: nessun avviso, nessun log) e,
   * riaperta, ripartirebbe da `inVolo = false`, lasciando partire una seconda
   * DELETE o sostituzione sullo stesso documento mentre la prima è ancora in volo.
   * Le chiusure decise DA `invia` (rilettura, rete) usano `props.onChiudi` diretta.
   */
  const chiudiSeLibera = () => {
    if (inVoloRef.current) return;
    props.onChiudi();
  };

  const invia = async (url: string, init: RequestInit): Promise<boolean> => {
    if (inVoloRef.current) return false;
    inVoloRef.current = true;
    setInVolo(true);
    setErrore(null);
    try {
      const r = await fetch(url, init);
      const esito = await leggiEsitoFascicolo(r);
      if (!esito.ok) {
        const testo = t(chiaveErroreFascicolo(esito.stato, esito.codice));
        if (rifiutoRichiedeRilettura(esito.codice)) {
          // Il documento è stato eliminato o sostituito da un altro: la rilettura
          // toglie la sua riga, e con lei questa modale. Il messaggio va quindi al
          // livello della PAGINA, che sopravvive alla rilettura; la modale si chiude
          // (è comunque vecchia) PRIMA che l'elenco cambi.
          props.onEsito(testo, 'errore');
          props.onChiudi();
          props.onCambiato();
          return false;
        }
        setErrore(testo);
        return false;
      }
      return true;
    } catch (e) {
      // Niente dati nel messaggio: è il fascicolo di un minore.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `fascicolo-${operazione}-fallita: ${nomeErrore(e)}`,
        route: rottaPagina(),
      });
      // L'esito è IGNOTO: la risposta può essersi persa dopo che il server ha già
      // eliminato o sostituito. Non si dichiara «niente è cambiato»: si porta il
      // messaggio alla pagina, si chiude la modale e si rilegge lo stato vero.
      props.onEsito(t('fascicoloErroreRete'), 'errore');
      props.onChiudi();
      props.onCambiato();
      return false;
    } finally {
      inVoloRef.current = false;
      setInVolo(false);
    }
  };

  return { inVolo, errore, setErrore, invia, chiudiSeLibera };
}

function Errore({ testo }: { testo: string | null }) {
  if (!testo) return null;
  return (
    <p role="alert" className="mt-3 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error">
      {testo}
    </p>
  );
}

function ModaleModifica(props: ModaleProps) {
  const t = useTranslations('teacherPrimaria');
  const { documento, userId, onChiudi, onCambiato, onEsito } = props;
  const titoloId = useId();
  const [documentType, setDocumentType] = useState(documento.document_type);
  const [descrizione, setDescrizione] = useState(documento.descrizione ?? '');
  const [expiryDate, setExpiryDate] = useState(documento.expiry_date ?? '');
  const { inVolo, errore, setErrore, invia, chiudiSeLibera } = useInvio(props, 'modifica');

  const salva = async () => {
    const corpo = corpoModificaFascicolo(documento, { documentType, descrizione, expiryDate });
    if (!corpo) { setErrore(t('fascicoloNienteDaModificare')); return; }
    const ok = await invia(`/api/primaria/fascicolo?userId=${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ id: documento.id, ...corpo }),
    });
    if (!ok) return;
    onEsito(t('fascicoloModificato'), 'ok');
    onChiudi();
    onCambiato();
  };

  return (
    <Modal open onClose={chiudiSeLibera} closeOnBackdrop={!inVolo} title={t('fascicoloModificaTitolo')} labelledBy={titoloId} className="w-full max-w-md">
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {t('fascicoloModificaTitolo')}
        </h2>
        <p className="font-maven mt-1 text-sm font-semibold text-kidville-ink break-words">{props.nomeDocumento}</p>

        <label className="mt-3 block font-maven text-xs font-semibold text-kidville-sub">
          {t('fascicoloTipoLabel')}
          <select
            value={documentType}
            onChange={(e) => setDocumentType(e.target.value)}
            className="mt-1 block w-full rounded-pill border border-kidville-line px-3 py-2 text-sm text-kidville-ink"
          >
            {TIPI_DOCUMENTO_FASCICOLO.map((v) => <option key={v} value={v}>{t(`fascicoloTipo_${v}`)}</option>)}
          </select>
        </label>
        <label className="mt-3 block font-maven text-xs font-semibold text-kidville-sub">
          {t('fascicoloDescrizioneLabel')}
          <input
            value={descrizione}
            onChange={(e) => setDescrizione(e.target.value)}
            maxLength={2000}
            className="mt-1 block w-full rounded-pill border border-kidville-line px-3 py-2 text-sm text-kidville-ink"
          />
        </label>
        <div className="mt-3 font-maven text-xs font-semibold text-kidville-sub">
          <span>{t('fascicoloScadenzaLabel')}</span>
          <DateField
            value={expiryDate}
            onChange={setExpiryDate}
            aria-label={t('fascicoloScadenzaAria')}
            className="mt-1 block w-full rounded-pill border border-kidville-line px-3 py-2 text-sm text-kidville-ink"
          />
        </div>

        <Errore testo={errore} />

        <div className="mt-4 flex justify-end gap-2">
          <Btn variant="ghost" onClick={onChiudi} disabled={inVolo}>{t('fascicoloAnnulla')}</Btn>
          <Btn onClick={salva} disabled={inVolo}>{inVolo ? t('comuneSalvataggio') : t('fascicoloSalva')}</Btn>
        </div>
      </div>
    </Modal>
  );
}

function ModaleSostituisci(props: ModaleProps) {
  const t = useTranslations('teacherPrimaria');
  const { documento, userId, finalita, onChiudi, onCambiato, onEsito } = props;
  const titoloId = useId();
  const fileId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fotoScattata, setFotoScattata] = useState<File | null>(null);
  const { inVolo, errore, setErrore, invia, chiudiSeLibera } = useInvio(props, 'sostituzione');

  const sostituisci = async () => {
    const file = fotoScattata ?? fileRef.current?.files?.[0];
    if (!file) { setErrore(t('fascicoloMsgSelezionaFile')); return; }
    // Il limite che scatta davvero è il body della funzione serverless: dirlo subito.
    if (file.size > LIMITE_UPLOAD_FASCICOLO_BYTE) { setErrore(t('fascicoloMsgFileTroppoGrande')); return; }
    const fd = new FormData();
    fd.append('id', documento.id);
    fd.append('file', file);
    const fz = finalita();
    if (fz) fd.append('finalita', fz);
    const ok = await invia(`/api/primaria/fascicolo/sostituisci?userId=${encodeURIComponent(userId)}`, {
      method: 'POST',
      headers: { 'x-user-id': userId },
      body: fd,
    });
    if (!ok) return;
    onEsito(t('fascicoloSostituito'), 'ok');
    onChiudi();
    onCambiato();
  };

  return (
    <Modal open onClose={chiudiSeLibera} closeOnBackdrop={!inVolo} title={t('fascicoloSostituisciTitolo')} labelledBy={titoloId} className="w-full max-w-md">
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {t('fascicoloSostituisciTitolo')}
        </h2>
        <p className="font-maven mt-1 text-sm font-semibold text-kidville-ink break-words">{props.nomeDocumento}</p>
        <p className="mt-3 rounded-card bg-kidville-info-soft px-3 py-2 font-maven text-xs text-kidville-info">
          {t('fascicoloSostituisciSpiega', { giorni: GIORNI_CESTINO_REGISTRO })}
        </p>

        <label htmlFor={fileId} className="mt-3 block font-maven text-xs font-semibold text-kidville-sub">
          {t('fascicoloNuovoFile')}
        </label>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            id={fileId}
            ref={fileRef}
            type="file"
            accept="application/pdf,image/*"
            onChange={() => { setFotoScattata(null); setErrore(null); }}
            className="font-maven block min-w-[12rem] flex-1 text-sm text-kidville-ink file:mr-3 file:rounded-pill file:border-0 file:bg-kidville-green/10 file:px-4 file:py-1.5 file:text-kidville-green"
          />
          <ScattaFotoButton
            onFile={setFotoScattata}
            className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm font-semibold text-kidville-green transition-colors hover:border-kidville-green"
          />
        </div>
        {fotoScattata && <p className="font-maven mt-1.5 text-xs text-kidville-green">📷 {fotoScattata.name}</p>}

        <Errore testo={errore} />

        <div className="mt-4 flex justify-end gap-2">
          <Btn variant="ghost" onClick={onChiudi} disabled={inVolo}>{t('fascicoloAnnulla')}</Btn>
          <Btn onClick={sostituisci} disabled={inVolo}>{inVolo ? t('comuneCaricamento') : t('fascicoloSostituisci')}</Btn>
        </div>
      </div>
    </Modal>
  );
}

function ModaleElimina(props: ModaleProps) {
  const t = useTranslations('teacherPrimaria');
  const { documento, userId, finalita, onChiudi, onCambiato, onEsito } = props;
  const titoloId = useId();
  const { inVolo, errore, invia, chiudiSeLibera } = useInvio(props, 'eliminazione');

  const elimina = async () => {
    const q = new URLSearchParams({ id: documento.id, userId });
    const fz = finalita();
    if (fz) q.set('finalita', fz);
    const ok = await invia(`/api/primaria/fascicolo?${q.toString()}`, {
      method: 'DELETE',
      headers: { 'x-user-id': userId },
    });
    if (!ok) return;
    onEsito(t('fascicoloEliminato'), 'ok');
    onChiudi();
    onCambiato();
  };

  return (
    <Modal open onClose={chiudiSeLibera} closeOnBackdrop={!inVolo} title={t('fascicoloEliminaTitolo')} labelledBy={titoloId} className="w-full max-w-md">
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-error">
          {t('fascicoloEliminaTitolo')}
        </h2>
        <p className="font-maven mt-3 text-sm text-kidville-ink break-words">
          {t('fascicoloEliminaSpiega', { documento: props.nomeDocumento, giorni: GIORNI_CESTINO_REGISTRO })}
        </p>

        <Errore testo={errore} />

        <div className="mt-4 flex justify-end gap-2">
          <Btn variant="ghost" onClick={onChiudi} disabled={inVolo}>{t('fascicoloAnnulla')}</Btn>
          <Btn variant="danger" onClick={elimina} disabled={inVolo}>{inVolo ? t('comuneSalvataggio') : t('fascicoloElimina')}</Btn>
        </div>
      </div>
    </Modal>
  );
}
