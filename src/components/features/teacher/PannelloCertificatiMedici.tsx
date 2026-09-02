'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, Calendar, FileText } from 'lucide-react';
import { BarraFiltri, testiBarraFiltri } from '@/components/ui/BarraFiltri';
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco';
import { decidiStatoElenco } from '@/lib/ui/filtri/motore';
import { useFiltri } from '@/lib/ui/filtri/use-filtri';
import type { ValoreFiltro } from '@/lib/ui/filtri/tipi';
import { useDateFormat } from '@/lib/i18n/date';
import { logClient } from '@/lib/logging/client';
import { cx } from '@/lib/ui/cx';
import { campiCertificatiMedici } from '@/components/features/teacher/filtri-modulistica';

/**
 * ─── I CERTIFICATI MEDICI DELLA SEZIONE ─────────────────────────────────────
 *
 * 🔴 IL FILTRO CHE ESISTEVA E NESSUNO MANDAVA. `GET /api/teacher/medical-certificates`
 * dichiara `stato` nel proprio schema `zod` dal primo giorno e lo applica con
 * `.eq('stato', stato)`. L'interfaccia non gliel'ha mai passato: la scheda
 * scaricava tutto — validati, rifiutati e nuovi mescolati — e chi doveva
 * validare i certificati di oggi se li cercava a occhio in mezzo a quelli di
 * settembre. Non c'era una riga da scrivere sul server: bastava dire il nome.
 *
 * Il pannello si monta con `key={sezione}` (vedi `PannelloSemaforo` per il
 * perché): la sezione è la cornice, e cambiarla fa rinascere la barra già sulla
 * sezione nuova invece di lasciarla mentire per un render.
 */

/** Il certificato come lo serve `GET /api/teacher/medical-certificates`. */
export interface CertificatoDocente {
  id: string;
  alunno_id: string;
  nome_alunno: string;
  cognome_alunno: string;
  file_path: string;
  giorni_coperti?: string[];
  data_inizio?: string | null;
  data_fine?: string | null;
  stato?: string;
  nota_validazione?: string | null;
  note: string;
  creato_il: string;
}

interface PannelloCertificatiMediciProps {
  teacherId: string;
  sezioni: readonly string[];
  sezione: string;
  onSezione: (sezione: string) => void;
  onToast: (messaggio: string) => void;
}

export function PannelloCertificatiMedici({
  teacherId,
  sezioni,
  sezione,
  onSezione,
  onToast,
}: PannelloCertificatiMediciProps) {
  const t = useTranslations('teacherServizi');
  const ts = useTranslations('shared');
  const f = useDateFormat();

  const campi = campiCertificatiMedici<CertificatoDocente>(t, { sezioni, sezionePredefinita: sezione });
  const stato = useFiltri<CertificatoDocente>(campi, { scriviUrl: false });

  const [certificati, setCertificati] = useState<CertificatoDocente[]>([]);
  const [inCorso, setInCorso] = useState(true);
  const [errore, setErrore] = useState(false);

  const [inValidazione, setInValidazione] = useState<CertificatoDocente | null>(null);
  const [nota, setNota] = useState('');

  const chiaveServer = stato.chiaveServer;

  /**
   * ⚠️ `inCorso` NON si accende qui dentro, e non è una svista.
   *
   * `react-hooks/set-state-in-effect` è un ERRORE nel gate di questo repo, e un
   * `setInCorso(true)` in cima a questa funzione è esattamente ciò che vieta:
   * chiamata da un effetto, quella riga gira SINCRONA nel corpo dell'effetto e
   * innesca un render a cascata. Si accende invece dal GESTORE D'EVENTO che fa
   * partire la richiesta (`impostaFiltro`, «Riprova») e dallo stato iniziale per
   * la prima lettura; qui si può solo SPEGNERE, che avviene dopo l'attesa.
   */
  const carica = useCallback(async () => {
    try {
      // ⚠️ Il fallimento è un VALORE (`.catch(() => null)`), non un `catch`
      // attorno alla `fetch`. `fetch` può lanciare in modo SINCRONO, e un `catch`
      // che scrive lo stato diventerebbe una scrittura sincrona nel corpo
      // dell'effetto: è ciò che `react-hooks/set-state-in-effect` vieta, ed è un
      // ERRORE in questo gate. Così ogni ramo sta dopo un `await`.
      const res = await fetch(`/api/teacher/medical-certificates?${chiaveServer}`, {
        headers: { 'x-user-id': teacherId },
      }).catch(() => null);
      const corpo = await res?.json().catch(() => null);
      // La rotta risponde `{ success, data }`; l'array nudo è la forma vecchia,
      // e si accetta ancora perché durante un rilascio il client può essere più
      // nuovo del server (o viceversa).
      const righe = Array.isArray(corpo) ? corpo : corpo?.data;
      if (!res?.ok || !Array.isArray(righe)) {
        setErrore(true);
        logClient({
          livello: res ? 'warn' : 'error',
          evento: 'fetch',
          messaggio: 'certificati medici della sezione non letti',
          route: '/teacher/modulistica',
          ...(res ? { stato: res.status } : null),
        });
        return;
      }
      setCertificati(righe as CertificatoDocente[]);
      setErrore(false);
    } finally {
      // Su OGNI uscita, anche quella imprevista: un'attesa che non si spegne è
      // una rotellina che gira per sempre, e non c'è niente da premere.
      setInCorso(false);
    }
  }, [chiaveServer, teacherId]);

  useEffect(() => {
    void carica();
  }, [carica]);

  const valida = async (esito: 'validato' | 'rifiutato') => {
    if (!inValidazione) return;
    try {
      const res = await fetch('/api/teacher/medical-certificates', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': teacherId },
        body: JSON.stringify({ id: inValidazione.id, esito, nota_validazione: nota || undefined }),
      });
      if (!res.ok) throw new Error(`stato ${res.status}`);
      onToast(esito === 'validato' ? t('modulisticaCertValidato') : t('modulisticaCertRifiutato'));
      setInValidazione(null);
      setNota('');
      void carica();
    } catch (err) {
      onToast(t('modulisticaErrValidazione'));
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `validazione certificato: ${err instanceof Error ? err.name : 'errore di rete'}`,
        route: '/teacher/modulistica',
      });
    }
  };

  const impostaFiltro = (chiave: string, valore: ValoreFiltro) => {
    if (chiave === 'class_name' && typeof valore === 'string') {
      onSezione(valore);
      return;
    }
    // Solo un campo `server` fa ripartire una richiesta: accendere l'attesa su un
    // filtro client attenuerebbe le righe per niente, mentre il filtro ha già
    // agito sotto le dita.
    if (campi.find((c) => c.chiave === chiave)?.dove === 'server') setInCorso(true);
    stato.imposta(chiave, valore);
  };

  const riprova = () => {
    setInCorso(true);
    void carica();
  };

  const visibili = stato.filtra(certificati);
  const schermata = decidiStatoElenco({
    caricamento: inCorso,
    errore,
    totale: certificati.length,
    mostrati: visibili.length,
  });
  const attenuato = (inCorso || stato.inAttesa) && visibili.length > 0;

  return (
    <div className="space-y-4">
      <BarraFiltri
        campi={campi}
        stato={{ ...stato, imposta: impostaFiltro }}
        testi={testiBarraFiltri(ts)}
        totale={certificati.length}
        mostrati={visibili.length}
        variante="compatta"
      />

      <StatoElenco
        stato={schermata}
        testi={{
          ...testiStatoElenco(ts),
          vuotoTitolo: t('modulisticaNessunCert'),
          vuotoCorpo: t('modulisticaVuotoCertTesto'),
        }}
        attivi={stato.attivi}
        onPulisci={stato.pulisci}
        onRiprova={riprova}
      />

      <div aria-busy={attenuato} className={cx('space-y-4', attenuato && 'pointer-events-none opacity-60')}>
        {visibili.map((cert) => (
          <div
            key={cert.id}
            className="flex flex-col justify-between gap-4 rounded-card border border-kidville-line bg-white p-5 md:flex-row md:items-center"
          >
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-barlow text-lg font-bold uppercase text-kidville-green">
                  {cert.cognome_alunno} {cert.nome_alunno}
                </h3>
                <span className="rounded-full bg-kidville-success-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-kidville-success">
                  {t('modulisticaBadgeCertMedico')}
                </span>
              </div>
              <p className="mt-1 font-maven text-xs text-kidville-sub">
                {t('modulisticaCaricatoIl', { data: f.dataBreve(cert.creato_il) })}
              </p>
              {cert.note && (
                <p className="mt-2 rounded-lg bg-kidville-cream p-2 font-maven text-xs italic text-kidville-ink">
                  &quot;{cert.note}&quot;
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {(cert.data_inizio || cert.data_fine) && (
                  <span className="rounded-full bg-kidville-cream px-2.5 py-0.5 text-[10px] font-semibold text-kidville-ink">
                    {cert.data_inizio ?? '—'} → {cert.data_fine ?? '—'}
                  </span>
                )}
                {cert.stato === 'validato' ? (
                  <span className="rounded-full bg-kidville-success-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-kidville-success">
                    {t('modulisticaValidato')}
                  </span>
                ) : cert.stato === 'rifiutato' ? (
                  <span className="rounded-full bg-kidville-error-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-kidville-error">
                    {t('modulisticaRifiutato')}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 rounded-full bg-kidville-warn-soft px-2 py-0.5 font-maven text-[10px] font-bold uppercase tracking-wider text-kidville-warn">
                    <AlertCircle size={10} aria-hidden="true" /> {t('modulisticaInValidazione')}
                  </span>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setInValidazione(cert);
                setNota('');
              }}
              className="flex items-center gap-1 rounded-pill bg-kidville-green px-3.5 py-2 font-barlow text-xs font-black uppercase tracking-wider text-kidville-yellow shadow-sm transition-opacity hover:opacity-90"
            >
              <Calendar size={14} aria-hidden="true" /> {t('modulisticaValida')}
            </button>
          </div>
        ))}
      </div>

      {inValidazione && (
        <div className="animate-fadeIn fixed inset-0 z-50 flex items-center justify-center bg-kidville-green/30 p-4">
          <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-card bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-kidville-line pb-3">
              <h2 className="font-barlow text-xl font-black uppercase tracking-wide text-kidville-green">
                {t('modulisticaValidazioneCert')}
              </h2>
              <button type="button" onClick={() => setInValidazione(null)} className="text-kidville-sub hover:text-kidville-ink">
                ✕
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto pr-1">
              <p className="font-maven text-xs leading-relaxed text-kidville-sub">
                {t.rich('modulisticaValidaDescrizione', {
                  nome: `${inValidazione.cognome_alunno} ${inValidazione.nome_alunno}`,
                  strong: (c) => <strong>{c}</strong>,
                })}
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-kidville-cream/50 px-3 py-2">
                  <p className="font-maven text-[10px] uppercase text-kidville-sub">{t('modulisticaCopertoDal')}</p>
                  <p className="font-maven text-sm font-bold text-kidville-green">{inValidazione.data_inizio ?? '—'}</p>
                </div>
                <div className="rounded-xl bg-kidville-cream/50 px-3 py-2">
                  <p className="font-maven text-[10px] uppercase text-kidville-sub">{t('modulisticaAl')}</p>
                  <p className="font-maven text-sm font-bold text-kidville-green">{inValidazione.data_fine ?? '—'}</p>
                </div>
              </div>

              {inValidazione.note && (
                <p className="font-maven text-xs text-kidville-ink">
                  <span className="font-semibold">{t('modulisticaNoteGenitore')}</span> {inValidazione.note}
                </p>
              )}

              <a
                href={`/api/parent/medical-certificates/file?id=${inValidazione.id}&userId=${teacherId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-bold text-kidville-green hover:underline"
              >
                <FileText size={14} aria-hidden="true" /> {t('modulisticaApriDocumento')}
              </a>

              <div>
                <label
                  htmlFor={`nota-${inValidazione.id}`}
                  className="mb-1 block font-maven text-[10px] font-semibold text-kidville-sub"
                >
                  {t('modulisticaNotaValidazioneLabel')}
                </label>
                <textarea
                  id={`nota-${inValidazione.id}`}
                  value={nota}
                  onChange={(e) => setNota(e.target.value)}
                  rows={2}
                  className="w-full resize-none rounded-lg border border-kidville-line px-3 py-1.5 font-maven text-xs focus:border-kidville-green focus:outline-none"
                  placeholder={t('modulisticaNotaPlaceholder')}
                />
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-3 border-t border-kidville-line pt-4">
              <button
                type="button"
                onClick={() => void valida('rifiutato')}
                className="rounded-pill border border-kidville-error/20 px-4 py-2 font-barlow text-sm font-bold uppercase tracking-wide text-kidville-error hover:bg-kidville-error-soft"
              >
                {t('modulisticaRifiuta')}
              </button>
              <button
                type="button"
                onClick={() => void valida('validato')}
                className="rounded-pill bg-kidville-green px-5 py-2.5 font-barlow text-sm font-black uppercase tracking-wider text-kidville-yellow shadow-md transition-all hover:opacity-90"
              >
                {t('modulisticaValida')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
