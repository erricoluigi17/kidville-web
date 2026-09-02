'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bell, Check, Upload } from 'lucide-react';
import { BarraFiltri, testiBarraFiltri } from '@/components/ui/BarraFiltri';
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco';
import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton';
import { decidiStatoElenco } from '@/lib/ui/filtri/motore';
import { useFiltri } from '@/lib/ui/filtri/use-filtri';
import type { ValoreFiltro } from '@/lib/ui/filtri/tipi';
import { logClient } from '@/lib/logging/client';
import { cx } from '@/lib/ui/cx';
import { campiSemaforo, type ModuloSelezionabile, type RigaSemaforo } from '@/components/features/teacher/filtri-modulistica';

/**
 * ─── IL SEMAFORO DEI CONSENSI, CON LA SUA BARRA ─────────────────────────────
 *
 * ── PERCHÉ È UN COMPONENTE E NON UN PEZZO DELLA PAGINA ─────────────────────
 * `useFiltri` legge i valori di partenza UNA VOLTA SOLA, nell'inizializzatore
 * pigro di `useState`: è ciò che impedisce all'indirizzo di riportare indietro
 * quello che l'utente sta scrivendo. La conseguenza è che la CORNICE — sezione e
 * modulo — deve essere già nota quando la barra nasce. Montata dentro la pagina,
 * la barra sarebbe nata con «Sezione: (vuoto)» e ci sarebbe rimasta finché
 * qualcuno non avesse toccato la tendina, perché nessun effetto ha il diritto di
 * riscriverle lo stato (`react-hooks/set-state-in-effect` è un ERRORE nel gate di
 * questo repo, non un avviso).
 *
 * La pagina perciò monta questo pannello **solo quando la sezione e i suoi moduli
 * ci sono**, e con `key={sezione}`: la sezione è l'IDENTITÀ del pannello, e
 * cambiarla lo fa rinascere già sulla sezione nuova, col modulo predefinito di
 * QUELLA sezione. È anche il motivo per cui il selettore «Sezione» qui dentro non
 * scrive nel proprio stato ma chiama `onSezione`: due verità per lo stesso valore,
 * anche solo per la durata di un render, sono il modo in cui il semaforo di una
 * sezione finisce sotto il titolo di un'altra.
 */

interface PannelloSemaforoProps {
  teacherId: string;
  /** Tutte le sezioni del docente: sono le voci del selettore. */
  sezioni: readonly string[];
  /** La sezione corrente. È anche la `key` con cui la pagina monta il pannello. */
  sezione: string;
  /** I moduli di autorizzazione assegnati a questa sezione. */
  moduli: readonly ModuloSelezionabile[];
  onSezione: (sezione: string) => void;
  onToast: (messaggio: string) => void;
}

export function PannelloSemaforo({
  teacherId,
  sezioni,
  sezione,
  moduli,
  onSezione,
  onToast,
}: PannelloSemaforoProps) {
  const t = useTranslations('teacherServizi');
  const ts = useTranslations('shared');

  const campi = campiSemaforo<RigaSemaforo>(t, { sezioni, moduli, sezionePredefinita: sezione });
  // L'indirizzo si LEGGE (un `?class_name=` incollato apre la sezione giusta) ma
  // non si riscrive: le due schede di questa pagina governano gli stessi nomi di
  // parametro, e due barre che scrivono a turno lasciano nella barra degli
  // indirizzi i filtri dell'ultima che ha toccato — cioè un indirizzo che non
  // descrive più quello che si vede.
  const stato = useFiltri<RigaSemaforo>(campi, { scriviUrl: false });

  const [alunni, setAlunni] = useState<RigaSemaforo[]>([]);
  const [inCorso, setInCorso] = useState(true);
  const [errore, setErrore] = useState(false);

  const [proxyPer, setProxyPer] = useState<RigaSemaforo | null>(null);
  const [proxyFile, setProxyFile] = useState<File | null>(null);
  const [proxyInvio, setProxyInvio] = useState(false);

  const formId = typeof stato.valori.form_id === 'string' ? stato.valori.form_id : '';
  const chiaveServer = stato.chiaveServer;

  /**
   * ⚠️ `inCorso` NON si accende qui dentro: `react-hooks/set-state-in-effect` è un
   * ERRORE in questo gate, e un `setInCorso(true)` in cima a una funzione chiamata
   * da un effetto gira SINCRONO nel corpo dell'effetto. Si accende dal gestore
   * d'evento che fa partire la richiesta e dallo stato iniziale; qui si spegne
   * soltanto — e lo spegnimento senza modulo è l'unico ramo che non attende, ma
   * è anche l'unico che non parte.
   */
  const carica = useCallback(async () => {
    try {
      // Il fallimento è un VALORE, non un `catch`: vedi la stessa nota in
      // `PannelloCertificatiMedici` — `fetch` può lanciare in modo sincrono, e uno
      // `setState` dentro un `catch` sarebbe una scrittura sincrona nel corpo
      // dell'effetto.
      const res = await fetch(`/api/teacher/modulistica?${chiaveServer}`).catch(() => null);
      const dati = await res?.json().catch(() => null);
      if (!res?.ok || !Array.isArray(dati)) {
        // Un guasto che non lascia traccia si presenterebbe come un elenco vuoto,
        // indistinguibile da «questa sezione non ha bambini».
        setErrore(true);
        logClient({
          livello: res ? 'warn' : 'error',
          evento: 'fetch',
          messaggio: 'semaforo consensi non letto',
          route: '/teacher/modulistica',
          ...(res ? { stato: res.status } : null),
        });
        return;
      }
      setAlunni(dati as RigaSemaforo[]);
      setErrore(false);
    } finally {
      setInCorso(false);
    }
  }, [chiaveServer]);

  /**
   * Senza modulo non si chiede NIENTE: non c'è una domanda da fare, e l'elenco è
   * VUOTO — non «senza risultati». La guardia sta QUI e non dentro `carica`,
   * perché lì sarebbe un ramo che scrive lo stato senza mai attendere, cioè una
   * scrittura sincrona nel corpo dell'effetto.
   */
  useEffect(() => {
    if (!formId) return;
    void carica();
  }, [carica, formId]);

  const inviaProxy = async () => {
    if (!proxyPer || !proxyFile) return;
    setProxyInvio(true);
    try {
      const fd = new FormData();
      fd.append('file', proxyFile);
      fd.append('form_id', formId);
      fd.append('student_id', proxyPer.student_id);
      const res = await fetch('/api/teacher/modulistica', {
        method: 'POST',
        headers: { 'x-user-id': teacherId },
        body: fd,
      });
      if (!res.ok) throw new Error(`stato ${res.status}`);
      onToast(t('modulisticaAutorizzazioneRegistrata', { nome: proxyPer.nome }));
      setProxyPer(null);
      setProxyFile(null);
      void carica();
    } catch (err) {
      onToast(t('modulisticaErrInserimento'));
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `proxy cartaceo non registrato: ${err instanceof Error ? err.name : 'errore di rete'}`,
        route: '/teacher/modulistica',
      });
    } finally {
      setProxyInvio(false);
    }
  };

  const impostaFiltro = (chiave: string, valore: ValoreFiltro) => {
    if (chiave === 'class_name' && typeof valore === 'string') {
      onSezione(valore);
      return;
    }
    // Solo un campo `server` fa ripartire una richiesta: attenuare le righe per un
    // filtro che ha già agito sotto le dita sarebbe lentezza inventata.
    if (campi.find((c) => c.chiave === chiave)?.dove === 'server') setInCorso(true);
    stato.imposta(chiave, valore);
  };

  const riprova = () => {
    setInCorso(true);
    void carica();
  };

  const visibili = stato.filtra(alunni);
  const schermata = decidiStatoElenco({
    // Senza modulo non c'è nessuna lettura in corso, e non deve girare nessuna
    // rotellina: quella schermata è VUOTA, e lo stato vuoto dice che cosa manca.
    caricamento: inCorso && formId !== '',
    errore,
    totale: alunni.length,
    mostrati: visibili.length,
  });
  const attenuato = (inCorso || stato.inAttesa) && visibili.length > 0;

  return (
    <div className="space-y-4">
      <BarraFiltri
        campi={campi}
        stato={{ ...stato, imposta: impostaFiltro }}
        testi={testiBarraFiltri(ts)}
        totale={alunni.length}
        mostrati={visibili.length}
        variante="compatta"
      />

      <div className="overflow-hidden rounded-card border border-kidville-line bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-kidville-line bg-kidville-cream p-4">
          <h3 className="font-barlow text-base font-bold uppercase tracking-wide text-kidville-green">
            {t('modulisticaStatoApprovazioni')}
          </h3>
          <div className="flex items-center gap-3 font-maven text-xs font-semibold text-kidville-sub">
            <span className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-full bg-kidville-success" />{' '}
              {t('modulisticaFirmati', { count: visibili.filter((s) => s.status === 'green').length })}
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-full bg-kidville-error" />{' '}
              {t('modulisticaMancanti', { count: visibili.filter((s) => s.status === 'red').length })}
            </span>
          </div>
        </div>

        <StatoElenco
          stato={schermata}
          testi={{
            ...testiStatoElenco(ts),
            vuotoTitolo: moduli.length === 0 ? t('modulisticaNessunModuloSezione') : t('modulisticaVuotoSemaforo'),
            vuotoCorpo: t('modulisticaVuotoSemaforoTesto'),
          }}
          attivi={stato.attivi}
          onPulisci={stato.pulisci}
          onRiprova={riprova}
        />

        {/* Le righe NON spariscono mentre si ricarica: restano attenuate e inerti,
            con `aria-busy` per chi non le vede. Sostituirle con uno spinner a ogni
            cambio di modulo è il difetto peggiore di una barra filtri — si perde
            il posto in cui si era, e la schermata lampeggia. */}
        <div
          aria-busy={attenuato}
          className={cx('divide-y divide-kidville-line', attenuato && 'pointer-events-none opacity-60')}
        >
          {visibili.map((alunno) => (
            <div
              key={alunno.student_id}
              className="flex items-center justify-between gap-4 p-4 transition-colors hover:bg-kidville-cream/50"
            >
              <div className="flex items-center gap-3">
                <span
                  className={cx(
                    'h-3.5 w-3.5 rounded-full shadow-inner',
                    alunno.status === 'green' ? 'bg-kidville-success' : 'bg-kidville-error',
                  )}
                />
                <span className="font-maven text-sm font-semibold text-kidville-ink">
                  {alunno.cognome} {alunno.nome}
                </span>
              </div>

              <div className="flex items-center gap-2">
                {alunno.status === 'red' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => onToast(t('modulisticaSollecitoInviato', { nome: alunno.nome }))}
                      className="rounded-lg p-2 text-kidville-sub transition-colors hover:bg-kidville-cream-dark hover:text-kidville-info"
                      title={t('modulisticaInviaSollecito')}
                      aria-label={t('modulisticaInviaSollecito')}
                    >
                      <Bell size={18} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setProxyPer(alunno)}
                      className="flex items-center gap-1 rounded-pill border border-kidville-green/10 bg-kidville-cream px-3 py-1.5 font-barlow text-xs font-bold uppercase text-kidville-green transition-colors hover:bg-kidville-green hover:text-kidville-yellow"
                      title={t('modulisticaProxyCartaceo')}
                    >
                      <Upload size={13} aria-hidden="true" /> {t('modulisticaProxy')}
                    </button>
                  </>
                ) : (
                  <span className="flex items-center gap-1 rounded-full bg-kidville-success-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-kidville-success">
                    <Check size={12} aria-hidden="true" /> {t('modulisticaFesOk')}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {proxyPer && (
        <div className="animate-fadeIn fixed inset-0 z-50 flex items-center justify-center bg-kidville-green/30 p-4">
          <div className="w-full max-w-sm rounded-card bg-white p-6 text-center shadow-2xl">
            <Upload className="mx-auto mb-3 text-kidville-green" size={40} aria-hidden="true" />
            <h3 className="mb-1 font-barlow text-xl font-black uppercase tracking-wide text-kidville-green">
              {t('modulisticaProxyTitolo')}
            </h3>
            <p className="mb-6 font-maven text-xs text-kidville-sub">
              {t.rich('modulisticaProxyDescrizione', { nome: proxyPer.nome, strong: (c) => <strong>{c}</strong> })}
            </p>

            <div className="space-y-4">
              {proxyFile ? (
                <div className="flex select-none items-center justify-between rounded-xl border-2 border-kidville-success/30 bg-kidville-success-soft px-3 py-2 text-xs font-semibold text-kidville-success">
                  <span>📄 {proxyFile.name}</span>
                  <button type="button" onClick={() => setProxyFile(null)} className="text-kidville-sub hover:text-kidville-error">
                    ✕
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <label className="flex h-12 w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-kidville-line text-xs font-semibold text-kidville-ink transition-colors hover:border-kidville-green">
                    <Upload size={14} aria-hidden="true" /> {t('modulisticaCaricaFile')}
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      className="hidden"
                      onChange={(e) => setProxyFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  {/* Nativo: scatta la foto del modulo cartaceo firmato. Su web non compare. */}
                  <ScattaFotoButton
                    onFile={(f) => setProxyFile(f)}
                    label={t('modulisticaScattaFoto')}
                    className="flex h-12 w-full items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-kidville-line text-xs font-semibold text-kidville-green transition-colors hover:border-kidville-green"
                  />
                </div>
              )}
            </div>

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setProxyPer(null);
                  setProxyFile(null);
                }}
                className="h-11 flex-1 rounded-pill border border-kidville-line font-maven text-sm text-kidville-sub transition-colors hover:bg-kidville-cream"
              >
                {t('modulisticaAnnulla')}
              </button>
              <button
                type="button"
                disabled={!proxyFile || proxyInvio}
                onClick={() => void inviaProxy()}
                className="h-11 flex-1 rounded-pill bg-kidville-green font-barlow font-black uppercase tracking-wider text-kidville-yellow transition-all hover:opacity-90 disabled:opacity-50"
              >
                {proxyInvio ? t('modulisticaCaricamentoBtn') : t('modulisticaRegistraFirma')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
