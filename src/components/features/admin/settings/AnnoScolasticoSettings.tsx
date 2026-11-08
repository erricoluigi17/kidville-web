'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarDays } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { annoAttivoDelCalendario, etichettaAnno, giornoValido, type RigaCalendario } from '@/lib/anno-scolastico';
import { useTestoStatoAnno } from '@/lib/context/anno-context';
import { useCalendario, useCalendarioDi } from '@/lib/context/calendario-context';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { btnPrimary, card, h3, hint, input, label } from './ui';

/**
 * LA SEZIONE «ANNO SCOLASTICO» DELLE IMPOSTAZIONI (PR 4.2, compito 4.2.7).
 *
 * È la schermata con cui la segreteria sposta il confine fra due anni, fissa le date del registro, apre le
 * iscrizioni e sospende le domande dal sito, per UNA sede alla volta (la pagina la passa da `conSede`).
 * Le regole stanno nel database e nelle route `/api/admin/anni/…` (4.2.4): qui si fa vedere ciò che
 * rispondono, con le parole che la segreteria capisce.
 *
 * ─── COSE CHE NON SI TOCCANO ─────────────────────────────────────────────────
 *  · Un rifiuto NON cancella ciò che si stava digitando: i campi tengono la loro bozza, l'errore sta sotto.
 *  · Lo stato d'errore è un CODICE (`ErroreUi`) tradotto al render: il caricamento non dipende da `t`
 *    (stessa lezione di `AnagraficaSedeSettings`).
 *  · Gli anni vengono dal calendario della 4.1 (nessuna seconda fetch); dopo un salvataggio riuscito si
 *    chiama `ricarica()`. Mentre si rilegge, il modulo resta com'è e i comandi si fermano.
 *  · Nel messaggio di un rifiuto passano solo nomi di tabelle e numeri: mai righe di bambini.
 */

type Blocco = 'confine' | 'date' | 'iscrizioni' | 'domande';

/** L'errore come CODICE; il testo si compone al render. */
type ErroreUi =
  | { tipo: 'rete' }
  | { tipo: 'permesso' }
  | { tipo: 'data' }
  | { tipo: 'risposta'; corpo: unknown };

type EsitoUi = { blocco: Blocco; tipo: 'salvato' | 'invariato' } | { blocco: Blocco; tipo: 'errore'; errore: ErroreUi };

/** `stato: 0` = la richiesta non è arrivata (rete). */
type Risposta = { stato: number; corpo: unknown };

const PREREQUISITI = ['quota_conferma', 'quota_nuova', 'moduli_conferma', 'moduli_nuova'];

/** '2027-09-01' → '1/9/2027'. Stringa su stringa: nessun fuso, nessuna `Date`. */
function dataBreve(ymd: string): string {
  const [a, m, g] = ymd.split('-').map(Number);
  return `${g}/${m}/${a}`;
}

/** Il giorno dopo, 'AAAA-MM-GG', oppure `null` se la data non è valida. */
function giornoDopo(ymd: string): string | null {
  if (!giornoValido(ymd)) return null;
  const [a, m, g] = ymd.split('-').map(Number);
  if (a < 1000) return null;
  return new Date(Date.UTC(a, m - 1, g + 1)).toISOString().slice(0, 10);
}

/**
 * Una chiamata alle route dell'anno. Non lancia mai: una rete caduta è `stato: 0`, e ogni esito non riuscito
 * si registra (fisso, senza dati: né uuid né testo del server).
 */
async function chiama(
  metodo: 'GET' | 'PATCH' | 'POST',
  url: string,
  userId: string,
  corpo?: Record<string, unknown>,
): Promise<Risposta> {
  const operazione = `admin/anni:${metodo}`;
  try {
    const res = await fetch(url, {
      method: metodo,
      headers: corpo ? { 'Content-Type': 'application/json', 'x-user-id': userId } : { 'x-user-id': userId },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    });
    const letto: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `${operazione} — richiesta non riuscita`, stato: res.status });
    }
    return { stato: res.status, corpo: letto };
  } catch (err: unknown) {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `${operazione} — ${nomeErrore(err)}` });
    return { stato: 0, corpo: null };
  }
}

const erroreDa = (r: Risposta): ErroreUi =>
  r.stato === 0 ? { tipo: 'rete' } : r.stato === 403 ? { tipo: 'permesso' } : { tipo: 'risposta', corpo: r.corpo };

const dataDi = (r: Risposta): Record<string, unknown> | null => {
  const d = (r.corpo as { data?: unknown } | null)?.data;
  return d !== null && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
};

/** I codici dei prerequisiti mancanti, nell'ordine in cui arrivano, solo quelli noti. `null` = forma illeggibile. */
function mancanoDa(valore: unknown): string[] | null {
  return Array.isArray(valore)
    ? valore.filter((m): m is string => typeof m === 'string' && PREREQUISITI.includes(m))
    : null;
}

export function AnnoScolasticoSettings({ userId, scuolaId }: { userId: string; scuolaId: string }) {
  const t = useTranslations('adminSettings');
  const testoStato = useTestoStatoAnno();
  const calendario = useCalendarioDi(scuolaId);
  const { loading, errore, ricarica } = useCalendario();
  const [scelto, setScelto] = useState<string | null>(null);

  const intestazione = (
    <h3 className={h3}>
      <CalendarDays size={16} /> {t('annoTitolo')}
    </h3>
  );

  if (!calendario || calendario.length === 0) {
    // Nessun calendario per la sede: o sta arrivando, o la lettura è fallita, o il database non ha lo schema
    // dell'anno (l'E2E in CI). Sono tre cose diverse e si dicono in tre modi.
    return (
      <section className={card}>
        {intestazione}
        {loading ? (
          <p className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>
        ) : errore ? (
          <p role="alert" className="font-maven text-sm text-kidville-error">{t('annoCalendarioErrore')}</p>
        ) : (
          <p className="font-maven text-sm text-kidville-sub">{t('annoCalendarioNonDisponibile')}</p>
        )}
      </section>
    );
  }

  const righe = [...calendario].sort((a, b) => b.annoInizio - a.annoInizio);
  const riga =
    righe.find((r) => r.annoId === scelto) ?? annoAttivoDelCalendario(calendario) ?? righe[0];
  const successivo = calendario.find((r) => r.annoInizio === riga.annoInizio + 1) ?? null;

  return (
    <section className={card}>
      {intestazione}
      <p className="font-maven text-sm text-kidville-sub mb-4">{t('annoIntro')}</p>

      <ul aria-label={t('annoElencoAria')} className="mb-5 space-y-2">
        {righe.map((r) => {
          const attiva = r.annoSedeId === riga.annoSedeId;
          return (
            <li key={r.annoSedeId}>
              <button
                type="button"
                aria-pressed={attiva}
                onClick={() => setScelto(r.annoId)}
                className={`flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-input px-3 py-2 text-left font-maven text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-kidville-green ${
                  attiva
                    ? 'bg-kidville-green text-kidville-yellow'
                    : 'bg-kidville-cream/60 text-kidville-ink hover:bg-kidville-green-soft'
                }`}
              >
                <strong className="font-barlow font-black">{etichettaAnno(r.annoInizio, 'breve')}</strong>{' '}
                <span>{testoStato(r.stato)}</span>{' '}
                <span>{t('annoRigaPeriodo', { inizio: dataBreve(r.inizio), fine: dataBreve(r.fine) })}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <DettaglioAnno
        key={riga.annoSedeId}
        userId={userId}
        riga={riga}
        successivo={successivo}
        occupato={loading}
        onModificato={ricarica}
      />
    </section>
  );
}

const legenda = 'font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green';
const gruppoClasse = 'mt-5 border-t border-kidville-line pt-4';
const bloccatoClasse = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-45';

function DettaglioAnno({
  userId,
  riga,
  successivo,
  occupato,
  onModificato,
}: {
  userId: string;
  riga: RigaCalendario;
  successivo: RigaCalendario | null;
  /** Il calendario si sta rileggendo dopo un salvataggio. */
  occupato: boolean;
  onModificato: () => void;
}) {
  const t = useTranslations('adminSettings');
  const testoStato = useTestoStatoAnno();
  const id = useId();
  const url = `/api/admin/anni/${riga.annoSedeId}`;
  const chiuso = riga.stato === 'chiuso';
  const inChiusura = riga.stato === 'in_chiusura';

  // Le bozze: partono dal calendario e da lì in poi sono di chi scrive (il componente si rimonta cambiando anno).
  const [fine, setFine] = useState(riga.fine);
  const [ultimo, setUltimo] = useState(riga.ultimoGiornoAperto);
  const [prepara, setPrepara] = useState(riga.preparaSuccessivoDal);
  const [inCorso, setInCorso] = useState<Blocco | null>(null);
  const [esito, setEsito] = useState<EsitoUi | null>(null);
  const [dialogo, setDialogo] = useState(false);
  // Che cosa manca per aprire le iscrizioni: `null` finché non è arrivato.
  const [lettura, setLettura] = useState<{ mancano: string[] } | { errore: ErroreUi } | null>(null);

  // `vivo`: se si cambia sede (o anno) con una scrittura in volo, il pannello smontato non riceve più stato.
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  // I prerequisiti si chiedono solo per un anno in preparazione. `active` come per ogni lettura in volo.
  const inPreparazione = riga.stato === 'in_preparazione';
  useEffect(() => {
    if (!inPreparazione) return;
    let active = true;
    chiama('GET', url, userId).then((r) => {
      if (!active) return;
      if (r.stato >= 200 && r.stato < 300) {
        const mancano = mancanoDa(dataDi(r)?.mancano);
        setLettura(mancano ? { mancano } : { errore: { tipo: 'risposta', corpo: null } });
      } else {
        setLettura({ errore: erroreDa(r) });
      }
    });
    return () => {
      active = false;
    };
  }, [inPreparazione, url, userId]);

  const occupatoOra = inCorso !== null || occupato;

  /** Una scrittura: segna «in corso», chiama, mostra l'esito sotto il blocco giusto, rilegge se è cambiato qualcosa. */
  const esegui = async (blocco: Blocco, metodo: 'PATCH' | 'POST', indirizzo: string, corpo: Record<string, unknown>) => {
    setInCorso(blocco);
    setEsito(null);
    const r = await chiama(metodo, indirizzo, userId, metodo === 'POST' ? undefined : corpo);
    if (!vivo.current) return null;
    setInCorso(null);
    if (r.stato === 0 || r.stato >= 400) {
      setEsito({ blocco, tipo: 'errore', errore: erroreDa(r) });
      return r;
    }
    const cambiato = dataDi(r)?.cambiato !== false;
    setEsito({ blocco, tipo: cambiato ? 'salvato' : 'invariato' });
    if (cambiato) onModificato();
    return r;
  };

  const erroreData = (blocco: Blocco) => setEsito({ blocco, tipo: 'errore', errore: { tipo: 'data' } });

  const salvaFine = () => {
    if (!giornoValido(fine)) return erroreData('confine');
    void esegui('confine', 'PATCH', url, { azione: 'confine', nuova_fine: fine });
  };

  const salvaDate = () => {
    const corpo: Record<string, unknown> = { azione: 'date' };
    // L'ultimo giorno aperto di un anno in chiusura è passato: non parte nemmeno.
    if (!inChiusura) {
      if (!giornoValido(ultimo)) return erroreData('date');
      corpo.ultimo_giorno_aperto = ultimo;
    }
    if (!giornoValido(prepara)) return erroreData('date');
    corpo.prepara_successivo_dal = prepara;
    void esegui('date', 'PATCH', url, corpo);
  };

  const confermaApertura = async () => {
    setDialogo(false);
    const r = await esegui('iscrizioni', 'POST', `${url}/apri-iscrizioni`, {});
    // Il server può sapere più di quanto sapesse la schermata: se rifiuta per i prerequisiti, si aggiorna l'elenco.
    const aggiornato = r ? mancanoDa((r.corpo as { mancano?: unknown } | null)?.mancano) : null;
    if (vivo.current && aggiornato && aggiornato.length > 0) setLettura({ mancano: aggiornato });
  };

  const cambiaDomande = () => {
    void esegui('domande', 'PATCH', url, { azione: 'domande', aperte: !riga.domandeAperte });
  };

  // ── Testi ────────────────────────────────────────────────────────────────────────────────────

  const nomeTabella = (nome: string): string => {
    switch (nome) {
      case 'presenze': return t('annoTabPresenze');
      case 'eventi_diario': return t('annoTabDiario');
      case 'valutazioni': return t('annoTabValutazioni');
      case 'pagamenti': return t('annoTabPagamenti');
      case 'chat_messages': return t('annoTabChat');
      case 'avvisi': return t('annoTabAvvisi');
      case 'galleria_media_v2': return t('annoTabGalleria');
      case 'gallery_photo_uploads': return t('annoTabFotoCaricate');
      default: return nome; // nome tecnico: solo il nome di una tabella, mai una riga
    }
  };

  const testoErrore = (e: ErroreUi): string => {
    if (e.tipo === 'rete') return t('annoErroreRete');
    if (e.tipo === 'permesso') return t('annoPermesso');
    if (e.tipo === 'data') return t('annoDataMancante');
    const corpo = e.corpo as { codice?: unknown; motivo?: unknown; righe?: unknown; tabelle?: unknown } | null;
    switch (corpo?.codice) {
      case 'CONFINE_CON_RIGHE': {
        const voci =
          corpo.tabelle !== null && typeof corpo.tabelle === 'object'
            ? Object.entries(corpo.tabelle as Record<string, unknown>).filter(
                (v): v is [string, number] => typeof v[1] === 'number',
              )
            : [];
        const righe = typeof corpo.righe === 'number' ? corpo.righe : voci.reduce((s, [, n]) => s + n, 0);
        const elenco = voci.map(([nome, n]) => `${nomeTabella(nome)} ${n}`).join(', ');
        return t('annoConfineRighe', { righe, elenco });
      }
      case 'DATE_NON_VALIDE':
        if (corpo.motivo === 'fuori_periodo') {
          return t('annoDateFuoriPeriodo', { inizio: dataBreve(riga.inizio), fine: dataBreve(riga.fine) });
        }
        if (corpo.motivo === 'ultimo_giorno_nel_passato') return t('annoDateNelPassato');
        break;
      case 'CONFINE_NON_VALIDO':
        switch (corpo.motivo) {
          case 'fine_non_dopo_inizio': return t('annoConfineFineNonDopoInizio');
          case 'inizio_successivo_non_prima_della_fine': return t('annoConfineSuccessivoSenzaGiorni');
          case 'ultimo_giorno_aperto_fuori': return t('annoConfineUltimoGiornoFuori');
          case 'prepara_successivo_dal_fuori': return t('annoConfinePreparaFuori');
          case 'ultimo_giorno_aperto_successivo_fuori': return t('annoConfineUltimoSuccessivoFuori');
          case 'prepara_successivo_dal_successivo_fuori': return t('annoConfinePreparaSuccessivoFuori');
        }
        break;
    }
    return messaggioDaCorpo(e.corpo, t('errore'));
  };

  const nomeMancante = (codice: string): string => {
    switch (codice) {
      case 'quota_conferma': return t('annoMancaQuotaConferma');
      case 'quota_nuova': return t('annoMancaQuotaNuova');
      case 'moduli_conferma': return t('annoMancaModuliConferma');
      default: return t('annoMancaModuliNuova');
    }
  };

  /** L'esito di un blocco: «Salvato», «Nessuna modifica» o l'errore. Sta sotto il blocco a cui appartiene. */
  const esitoDi = (blocco: Blocco, salvato = t('salvato')) => {
    if (!esito || esito.blocco !== blocco) return null;
    if (esito.tipo === 'errore') {
      return (
        <p role="alert" className="mt-2 font-maven text-sm text-kidville-error">
          {testoErrore(esito.errore)}
        </p>
      );
    }
    return (
      <p role="status" className="mt-2 font-maven text-sm text-kidville-success">
        {esito.tipo === 'salvato' ? salvato : t('annoNessunaModifica')}
      </p>
    );
  };

  const nuovoInizio = giornoDopo(fine);
  const annoSuccessivo = etichettaAnno(riga.annoInizio + 1, 'breve');

  const domandeConsentite = riga.stato === 'iscrizioni_aperte' || riga.stato === 'corrente';
  const domandeBloccate = !riga.domandeAperte && !domandeConsentite;

  const mancano = lettura && 'mancano' in lettura ? lettura.mancano : null;
  const puoAprire = mancano !== null && mancano.length === 0;
  const idStato = `${id}-iscrizioni-stato`;
  const titoloDialogo = t('annoApriTitolo', { anno: etichettaAnno(riga.annoInizio, 'breve') });

  return (
    <div>
      <h4 className="font-barlow text-base font-black text-kidville-green">
        {t('annoDettaglioTitolo', { anno: etichettaAnno(riga.annoInizio, 'breve') })}{' '}
        <span className="font-maven text-sm font-normal text-kidville-sub">({testoStato(riga.stato)})</span>
      </h4>

      {chiuso ? (
        <p className="mt-3 font-maven text-sm text-kidville-sub">{t('annoChiusoSolaLettura')}</p>
      ) : (
        <>
          {/* ── Fine dell'anno (il confine con l'anno dopo) ─────────────────────────────── */}
          <fieldset className={gruppoClasse}>
            <legend className={legenda}>{t('annoFineTitolo')}</legend>
            <label htmlFor={`${id}-fine`} className="sr-only">{t('annoFineTitolo')}</label>
            <input
              id={`${id}-fine`}
              type="date"
              value={fine}
              disabled={successivo === null}
              onChange={(e) => { setEsito(null); setFine(e.target.value); }}
              aria-describedby={`${id}-fine-sotto`}
              className={input}
            />
            <p id={`${id}-fine-sotto`} className={hint}>
              {successivo === null
                ? t('annoFineSenzaSuccessivo')
                : nuovoInizio
                  ? t('annoFineSotto', { anno: annoSuccessivo, data: dataBreve(nuovoInizio) })
                  : null}
            </p>
            {successivo !== null && (
              <div className="mt-3">
                <button type="button" onClick={salvaFine} disabled={occupatoOra} className={btnPrimary}>
                  {inCorso === 'confine' ? t('salvataggioInCorso') : t('salva')}
                </button>
              </div>
            )}
            {esitoDi('confine')}
          </fieldset>

          {/* ── Le date del registro ───────────────────────────────────────────────────── */}
          <fieldset className={gruppoClasse}>
            <legend className={legenda}>{t('annoDateTitolo')}</legend>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
              <div>
                <label htmlFor={`${id}-ultimo`} className={label}>{t('annoUltimoGiorno')}</label>
                <input
                  id={`${id}-ultimo`}
                  type="date"
                  value={ultimo}
                  disabled={inChiusura}
                  onChange={(e) => { setEsito(null); setUltimo(e.target.value); }}
                  aria-describedby={`${id}-ultimo-hint`}
                  className={input}
                />
                <span id={`${id}-ultimo-hint`} className={`${hint} ml-2`}>{t('annoUltimoGiornoPredefinito')}</span>
              </div>
              <div>
                <label htmlFor={`${id}-prepara`} className={label}>{t('annoPreparaDal')}</label>
                <input
                  id={`${id}-prepara`}
                  type="date"
                  value={prepara}
                  onChange={(e) => { setEsito(null); setPrepara(e.target.value); }}
                  aria-describedby={`${id}-prepara-hint`}
                  className={input}
                />
                <span id={`${id}-prepara-hint`} className={`${hint} ml-2`}>{t('annoPreparaPredefinito')}</span>
              </div>
            </div>
            {inChiusura && <p className={hint}>{t('annoUltimoGiornoBloccato')}</p>}
            <div className="mt-3">
              <button type="button" onClick={salvaDate} disabled={occupatoOra} className={btnPrimary}>
                {inCorso === 'date' ? t('salvataggioInCorso') : t('salva')}
              </button>
            </div>
            {esitoDi('date')}
          </fieldset>

          {/* ── Aprire le iscrizioni (solo un anno in preparazione) ────────────────────── */}
          {inPreparazione && (
            <fieldset className={gruppoClasse}>
              <legend className={legenda}>{t('annoIscrizioniTitolo')}</legend>
              <p className="font-maven text-sm text-kidville-sub">{t('annoIscrizioniIntro')}</p>
              <div id={idStato} className="mt-2 font-maven text-sm text-kidville-ink">
                {lettura === null ? (
                  <p>{t('annoMancanoControllo')}</p>
                ) : 'errore' in lettura ? (
                  <p role="alert" className="text-kidville-error">{testoErrore(lettura.errore)}</p>
                ) : lettura.mancano.length > 0 ? (
                  <>
                    <p>{t('annoMancano', { elenco: lettura.mancano.map(nomeMancante).join(', ') })}</p>
                    <p className={hint}>{t('annoListinoNelleRette')}</p>
                  </>
                ) : (
                  <p>{t('annoIscrizioniPronte')}</p>
                )}
              </div>
              <div className="mt-3">
                <button
                  type="button"
                  aria-disabled={!puoAprire}
                  aria-describedby={idStato}
                  disabled={occupatoOra}
                  onClick={() => { if (puoAprire) setDialogo(true); }}
                  className={`${btnPrimary} ${bloccatoClasse}`}
                >
                  {t('annoIscrizioniTitolo')}
                </button>
              </div>
              {esitoDi('iscrizioni', t('annoApriFatto'))}
            </fieldset>
          )}

          {/* ── Le domande dal sito ────────────────────────────────────────────────────── */}
          <fieldset className={gruppoClasse}>
            <legend className={legenda}>{t('annoDomandeTitolo')}</legend>
            <p className="font-maven text-sm text-kidville-ink">
              {riga.domandeAperte ? t('annoDomandeAperte') : t('annoDomandeSospese')}
            </p>
            {domandeBloccate && <p className={hint}>{t('annoDomandeNonDisponibili')}</p>}
            <div className="mt-3">
              <button
                type="button"
                aria-disabled={domandeBloccate}
                disabled={occupatoOra}
                onClick={() => { if (!domandeBloccate) cambiaDomande(); }}
                className={`${btnPrimary} ${bloccatoClasse}`}
              >
                {riga.domandeAperte ? t('annoDomandeSospendi') : t('annoDomandeRiapri')}
              </button>
            </div>
            {esitoDi('domande', t('salvato'))}
          </fieldset>
        </>
      )}

      <Modal open={dialogo} onClose={() => setDialogo(false)} title={titoloDialogo} className="w-full max-w-md">
        <div className="rounded-3xl border border-kidville-line bg-kidville-white p-5 shadow-2xl">
          <h2 className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">{titoloDialogo}</h2>
          <p className="mt-3 font-maven text-sm text-kidville-ink">{t('annoApriCorpo')}</p>
          <div className="mt-5 flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() => setDialogo(false)}
              className="rounded-pill px-4 py-2 font-barlow text-sm font-extrabold uppercase text-kidville-green ring-[1.5px] ring-inset ring-kidville-line hover:ring-kidville-green/50"
            >
              {t('annulla')}
            </button>
            <button type="button" onClick={() => { void confermaApertura(); }} className={btnPrimary}>
              {t('annoApriConferma')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
