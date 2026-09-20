'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, Trash2, UserMinus, UserPlus } from 'lucide-react';

/**
 * ZONA PERICOLOSA — eliminare un membro del personale, riportarlo a genitore, o
 * dargli anche il profilo genitore.
 *
 * ⚠️ PERCHÉ UN COMPONENTE A PARTE, e non altre righe in `StaffDetailPanel.tsx`.
 * Quel file è già a 1.800 righe, e queste tre operazioni hanno uno stato loro
 * (anteprima → conferma → esito) che non c'entra niente col form dell'incarico.
 * Tenerli insieme avrebbe intrecciato un `editMode` con un `confermaAperta`, che
 * è il modo in cui due bottoni finiscono per abilitarsi a vicenda.
 *
 * ⚠️ E NON STA IN `StaffPanel` (l'elenco). Un comando distruttivo accanto a una
 * matita, in una riga di lista, è il comando che si preme per sbaglio — e
 * l'elenco non ha il contesto (fascicolo, doppio profilo, tracce) che serve per
 * decidere. Questa scheda ce l'ha.
 *
 * ─── LE TRE REGOLE DELL'ANTEPRIMA ─────────────────────────────────────────────
 *
 * 1. **Si dice PRIMA che cosa succederà**, e con quale delle due parole:
 *    CANCELLATO o ARCHIVIATO. Mai un comando generico che decide dopo.
 * 2. **Si dice PERCHÉ**: le voci che hanno pesato, coi loro conteggi. E `null`
 *    si mostra come «non misurato», mai come `0` — un conteggio mancato
 *    presentato come zero è un numero falso.
 * 3. **Si dice che cosa RESTA.** Un elenco di distruzioni senza contrappeso è
 *    metà informazione: chi archivia una maestra si sta chiedendo «perderò il
 *    registro delle sue presenze?», e la risposta deve stare lì.
 *
 * ─── LA CONFERMA ──────────────────────────────────────────────────────────────
 *
 * Si digita il COGNOME. Non una spunta: una spunta si clicca di riflesso, e
 * questo è il gesto che su metà dei casi non ha un annulla. E mai `confirm()`
 * nativo — vietato nel repo, e dentro la WebView iOS può non tornare mai,
 * lasciando il pannello bloccato per sempre.
 */

/**
 * ⚠️ I TRE VALORI SONO SCRITTI QUI, e non importati da
 * `@/lib/anagrafiche/legami-scrittura`, che è la loro fonte sul server.
 *
 * Non è una svista: quel modulo importa `logEvento` → `app-log` →
 * `supabase/server-client`, e questo è un componente `'use client'`. Importarlo
 * trascinerebbe l'intera catena del server nel bundle del browser e farebbe
 * fallire `npm run build` — è lo stesso vincolo, misurato, per cui esiste lo
 * split fra `tracce-docente-voci.ts` e `tracce-docente.ts`. I valori sono tre e
 * li valida comunque lo `z.enum` della route, che li legge dalla fonte vera.
 */
type Relazione = 'mother' | 'father' | 'delegate';

type Decisione = 'cancella' | 'archivia' | 'profilo-doppio' | 'non-deciso';

type Anteprima = {
  decisione: Decisione;
  motivi: { chiave: string | null; n: number | null }[];
  ponteGenitore: boolean | null;
  haAnagrafica: boolean;
  haPraticaOrigine: boolean;
  mantiene: string[];
};

type Alunno = { id: string; nome?: string | null; cognome?: string | null };

type Props = {
  staffId: string;
  /** Il cognome del bersaglio: è ciò che si digita per confermare. */
  cognome: string | null | undefined;
  /** Chiamata dopo un'operazione riuscita: la scheda si ricarica o si chiude. */
  onFatto: () => void;
};

const CMD_ROSSO =
  'flex h-11 w-full items-center justify-center gap-2 rounded-pill bg-kidville-error-strong font-barlow text-sm font-black uppercase tracking-wide text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-50';
const CMD_BORDO =
  'flex h-11 w-full items-center justify-center gap-2 rounded-pill border-2 border-kidville-error/40 font-barlow text-sm font-bold uppercase text-kidville-error-strong transition-all hover:bg-kidville-error/5 disabled:opacity-50';
const CMD_NEUTRO =
  'flex h-11 w-full items-center justify-center gap-2 rounded-pill border-2 border-kidville-green/40 font-barlow text-sm font-bold uppercase text-kidville-green transition-all hover:bg-kidville-green/5 disabled:opacity-50';

export function ZonaPericolosaStaff({ staffId, cognome, onFatto }: Props) {
  const t = useTranslations('adminStudents');
  const tTracce = useTranslations('adminAltro');

  const [aperta, setAperta] = useState(false);
  const [anteprima, setAnteprima] = useState<Anteprima | null>(null);
  const [caricando, setCaricando] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [inCorso, setInCorso] = useState(false);
  const [esito, setEsito] = useState<string | null>(null);

  /** Quale comando sta chiedendo conferma. `null` = nessuno. */
  const [conferma, setConferma] = useState<'elimina' | 'genitore' | null>(null);
  const [digitato, setDigitato] = useState('');

  const [ancheGenitore, setAncheGenitore] = useState(false);
  const [cerca, setCerca] = useState('');
  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [alunnoScelto, setAlunnoScelto] = useState<Alunno | null>(null);
  const [relazione, setRelazione] = useState<Relazione>('mother');

  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const caricaAnteprima = useCallback(async () => {
    setCaricando(true);
    setErrore(null);
    try {
      const res = await fetch(`/api/admin/staff/eliminazione?id=${encodeURIComponent(staffId)}`);
      const corpo = await res.json();
      if (!vivo.current) return;
      if (!res.ok) {
        setErrore(corpo?.error ?? t('zpGuasto'));
        setAnteprima(null);
        return;
      }
      setAnteprima(corpo.data as Anteprima);
    } catch {
      if (vivo.current) setErrore(t('zpGuasto'));
    } finally {
      if (vivo.current) setCaricando(false);
    }
  }, [staffId, t]);

  // ⚠️ L'anteprima si carica al CLICK, non in un effetto. La regola
  // `react-hooks/set-state-in-effect` è un errore nel gate di questo repo, e ha
  // ragione: un effetto che chiama `setState` su una condizione di stato
  // innesca render a cascata. Qui l'apertura è un GESTO — c'è un punto preciso
  // in cui la fetch deve partire, e non serve dedurlo da uno stato.

  // La ricerca del bambino riusa l'endpoint che il dialogo dei legami già usa:
  // nessuna rotta nuova, nessuna seconda regola di ricerca che diverga.
  useEffect(() => {
    // Lo svuotamento sta DENTRO il timeout, non nel corpo dell'effetto: stessa
    // regola di sopra. Il debounce c'era comunque, quindi non costa niente.
    const id = setTimeout(async () => {
      if (!ancheGenitore || cerca.trim().length < 2) {
        setAlunni([]);
        return;
      }
      try {
        const res = await fetch(
          `/api/admin/legami-familiari?tipo=alunni&q=${encodeURIComponent(cerca.trim())}`,
        );
        const corpo = await res.json();
        if (vivo.current && res.ok) setAlunni((corpo?.alunni ?? []) as Alunno[]);
      } catch {
        // Ricerca fallita: l'elenco resta vuoto, e il comando è comunque
        // saltabile. Non si blocca la persona per una lista di suggerimenti.
        if (vivo.current) setAlunni([]);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [cerca, ancheGenitore]);

  async function esegui(url: string, corpo: unknown, messaggioEsito: (d: unknown) => string) {
    setInCorso(true);
    setErrore(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      const risposta = await res.json();
      if (!vivo.current) return;
      if (!res.ok) {
        setErrore(risposta?.error ?? t('zpGuasto'));
        return;
      }
      setEsito(messaggioEsito(risposta?.data));
      setConferma(null);
      setAncheGenitore(false);
      onFatto();
    } catch {
      if (vivo.current) setErrore(t('zpGuasto'));
    } finally {
      if (vivo.current) setInCorso(false);
    }
  }

  const cognomeAtteso = (cognome ?? '').trim().toLocaleLowerCase();
  const cognomeOk = cognomeAtteso.length > 0 && digitato.trim().toLocaleLowerCase() === cognomeAtteso;

  if (!aperta) {
    return (
      <div className="border-t border-kidville-line p-5">
        <button
          type="button"
          onClick={() => {
            setAperta(true);
            void caricaAnteprima();
          }}
          data-testid="zona-pericolosa-apri"
          className={CMD_BORDO}
        >
          <AlertTriangle size={15} /> {t('zpApri')}
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="zona-pericolosa"
      className="space-y-3 border-t-2 border-kidville-error/30 bg-kidville-error/5 p-5"
    >
      <p className="font-barlow text-sm font-black uppercase tracking-wide text-kidville-error-strong">
        <AlertTriangle size={14} className="mr-1 inline" /> {t('zpTitolo')}
      </p>

      {esito && (
        <p data-testid="zona-pericolosa-esito" className="font-maven text-sm text-kidville-ink">
          {esito}
        </p>
      )}

      {errore && (
        <p data-testid="zona-pericolosa-errore" className="font-maven text-sm text-kidville-error-strong">
          {errore}
        </p>
      )}

      {caricando && (
        <p className="flex items-center gap-2 font-maven text-xs text-kidville-sub">
          <Loader2 size={14} className="animate-spin" /> {t('zpMisuro')}
        </p>
      )}

      {anteprima && !esito && (
        <>
          {/* 1. CHE COSA SUCCEDERÀ — la parola esatta, non un comando generico. */}
          {anteprima.decisione === 'cancella' && (
            <div data-testid="zona-pericolosa-decisione">
              <p className="font-barlow text-base font-black uppercase text-kidville-error-strong">
                {t('zpCancella')}
              </p>
              <p className="font-maven text-xs text-kidville-sub">{t('zpCancellaSpiega')}</p>
            </div>
          )}
          {anteprima.decisione === 'archivia' && (
            <div data-testid="zona-pericolosa-decisione">
              <p className="font-barlow text-base font-black uppercase text-kidville-ink">
                {t('zpArchivia')}
              </p>
              <p className="font-maven text-xs text-kidville-sub">{t('zpArchiviaSpiega')}</p>
            </div>
          )}
          {anteprima.decisione === 'profilo-doppio' && (
            <div data-testid="zona-pericolosa-decisione">
              <p className="font-maven text-sm text-kidville-ink">{t('zpProfiloDoppio')}</p>
              <p className="font-maven text-xs text-kidville-sub">{t('zpProfiloDoppioRimando')}</p>
            </div>
          )}
          {anteprima.decisione === 'non-deciso' && (
            <p data-testid="zona-pericolosa-decisione" className="font-maven text-sm text-kidville-ink">
              {t('zpNonDeciso')}
            </p>
          )}

          {/* 2. PERCHÉ — le voci che hanno pesato, coi conteggi. */}
          {anteprima.motivi.length > 0 && (
            <div>
              <p className="font-barlow text-xs font-bold uppercase text-kidville-sub">{t('zpPerche')}</p>
              <ul className="font-maven text-xs text-kidville-ink">
                {anteprima.motivi.map((m, i) => (
                  <li key={m.chiave ?? i}>
                    {m.chiave ? tTracce(m.chiave) : m.chiave}
                    {': '}
                    {/* `null` NON diventa `0`: si dice che non è stato misurato. */}
                    {m.n === null ? t('zpNonMisurato') : m.n}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {anteprima.haAnagrafica && anteprima.decisione !== 'profilo-doppio' && (
            <p className="font-maven text-xs text-kidville-error-strong">{t('zpFascicolo')}</p>
          )}

          {/* 3. CHE COSA RESTA — il contrappeso. */}
          {anteprima.decisione === 'archivia' && anteprima.mantiene.length > 0 && (
            <div>
              <p className="font-barlow text-xs font-bold uppercase text-kidville-sub">{t('zpMantiene')}</p>
              <ul className="font-maven text-xs text-kidville-sub">
                {anteprima.mantiene.map((k) => (
                  <li key={k}>{tTracce(k)}</li>
                ))}
              </ul>
            </div>
          )}

          {/* I COMANDI. «O il comando, o la ragione per cui non c'è»: su
              `profilo-doppio` e `non-deciso` l'eliminazione non compare, e la
              spiegazione sta qui sopra. */}
          {conferma === null && !ancheGenitore && (
            <div className="space-y-2 pt-1">
              {(anteprima.decisione === 'cancella' || anteprima.decisione === 'archivia') && (
                <button
                  type="button"
                  onClick={() => {
                    setConferma('elimina');
                    setDigitato('');
                  }}
                  data-testid="zona-pericolosa-elimina"
                  className={CMD_ROSSO}
                >
                  <Trash2 size={15} /> {t('zpBottoneElimina')}
                </button>
              )}
              {anteprima.ponteGenitore === true && (
                <button
                  type="button"
                  onClick={() => {
                    setConferma('genitore');
                    setDigitato('');
                  }}
                  data-testid="zona-pericolosa-genitore"
                  className={CMD_BORDO}
                >
                  <UserMinus size={15} /> {t('zpBottoneGenitore')}
                </button>
              )}
              <button
                type="button"
                onClick={() => setAncheGenitore(true)}
                data-testid="zona-pericolosa-anche-genitore"
                className={CMD_NEUTRO}
              >
                <UserPlus size={15} /> {t('zpBottoneAncheGenitore')}
              </button>
            </div>
          )}

          {/* LA CONFERMA: si digita il cognome. Non una spunta. */}
          {conferma !== null && (
            <div className="space-y-2 pt-1">
              <p className="font-maven text-xs text-kidville-ink">{t('zpDigitaCognome')}</p>
              <input
                type="text"
                value={digitato}
                onChange={(e) => setDigitato(e.target.value)}
                aria-label={t('zpCognome')}
                data-testid="zona-pericolosa-cognome"
                className="h-11 w-full rounded-pill border-2 border-kidville-line px-4 font-maven text-sm"
              />
              <button
                type="button"
                disabled={!cognomeOk || inCorso}
                data-testid="zona-pericolosa-conferma"
                onClick={() =>
                  conferma === 'elimina'
                    ? void esegui(
                        '/api/admin/staff/eliminazione',
                        { id: staffId, decisioneAttesa: anteprima.decisione, conferma: true },
                        (d) => {
                          const dato = d as { esito?: string; motivo?: string | null };
                          if (dato?.motivo === 'cancellazione-rifiutata') return t('zpEsitoRipiego');
                          return dato?.esito === 'cancellato'
                            ? t('zpEsitoCancellato')
                            : t('zpEsitoArchiviato');
                        },
                      )
                    : void esegui(
                        '/api/admin/staff/riporta-a-genitore',
                        { utenteId: staffId, conferma: true },
                        () => t('zpEsitoGenitore'),
                      )
                }
                className={CMD_ROSSO}
              >
                {inCorso ? <Loader2 size={15} className="animate-spin" /> : null} {t('zpConferma')}
              </button>
              <button type="button" onClick={() => setConferma(null)} className={CMD_NEUTRO}>
                {t('zpAnnulla')}
              </button>
            </div>
          )}

          {/* ANCHE GENITORE: il figlio si sceglie, oppure si rimanda. */}
          {ancheGenitore && (
            <div className="space-y-2 pt-1">
              <input
                type="text"
                value={cerca}
                onChange={(e) => setCerca(e.target.value)}
                placeholder={t('zpCercaBambino')}
                aria-label={t('zpCercaBambino')}
                data-testid="zona-pericolosa-cerca-bambino"
                className="h-11 w-full rounded-pill border-2 border-kidville-line px-4 font-maven text-sm"
              />
              {alunni.length > 0 && (
                <ul className="max-h-40 overflow-y-auto">
                  {alunni.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => setAlunnoScelto(a)}
                        className={`w-full rounded-lg px-3 py-2 text-left font-maven text-sm ${
                          alunnoScelto?.id === a.id ? 'bg-kidville-green/10' : ''
                        }`}
                      >
                        {a.nome} {a.cognome}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {alunnoScelto && (
                <label className="block font-maven text-xs text-kidville-sub">
                  {t('zpRelazione')}
                  <select
                    value={relazione}
                    onChange={(e) =>
                      setRelazione(e.target.value as Relazione)
                    }
                    className="ml-2 rounded-lg border border-kidville-line px-2 py-1 font-maven text-sm"
                  >
                    <option value="mother">{t('zpRelMother')}</option>
                    <option value="father">{t('zpRelFather')}</option>
                    <option value="delegate">{t('zpRelDelegate')}</option>
                  </select>
                </label>
              )}
              {!alunnoScelto && (
                <p className="font-maven text-xs text-kidville-sub">{t('zpAreaVuota')}</p>
              )}
              <button
                type="button"
                disabled={inCorso}
                data-testid="zona-pericolosa-anche-genitore-conferma"
                onClick={() =>
                  void esegui(
                    '/api/admin/staff/anche-genitore',
                    {
                      utenteId: staffId,
                      ...(alunnoScelto ? { alunnoId: alunnoScelto.id, relazione } : {}),
                    },
                    () => t('zpEsitoAncheGenitore'),
                  )
                }
                className={CMD_NEUTRO}
              >
                {inCorso ? <Loader2 size={15} className="animate-spin" /> : null}{' '}
                {alunnoScelto ? t('zpConferma') : t('zpSaltaFiglio')}
              </button>
              <button type="button" onClick={() => setAncheGenitore(false)} className={CMD_NEUTRO}>
                {t('zpAnnulla')}
              </button>
            </div>
          )}
        </>
      )}

      <button type="button" onClick={() => setAperta(false)} className="font-maven text-xs underline">
        {t('zpChiudi')}
      </button>
    </div>
  );
}
