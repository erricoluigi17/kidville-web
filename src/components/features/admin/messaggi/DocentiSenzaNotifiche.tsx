'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BellOff, Loader2 } from 'lucide-react';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * «MAESTRE CHE NON RICEVONO LE NOTIFICHE» — la scheda della Direzione (C2).
 *
 * ─── IL FATTO, misurato ─────────────────────────────────────────────────────
 *
 * Segnalazione del 2026-09-29: «i messaggi dei genitori non arrivano alle
 * maestre». Fra le cause, le docenti che hanno negato il permesso delle
 * notifiche: non ricevono NESSUNA push, e non lo sa nessuno. Una maestra su
 * Android ha ricevuto 137 messaggi in 30 giorni senza una sola notifica.
 *
 * L'avviso nella home della docente (`AvvisoNotificheDocente`) lo dice a lei;
 * questa scheda lo dice alla Direzione, che può andare a parlarle. I due numeri
 * accanto al nome servono a decidere da chi cominciare: una maestra con dodici
 * messaggi in attesa non è lo stesso caso di una che non ne ha nessuno.
 *
 * ─── I TRE STATI IN CUI UNA SCHERMATA COSÌ MENTE ────────────────────────────
 *
 * In CARICAMENTO non si scrive «tutte le maestre ricevono le notifiche»: «non lo
 * so ancora» non è «va tutto bene». Su ERRORE si mostra il messaggio, perché un
 * elenco vuoto per un guasto di rete è indistinguibile dal caso felice — ed è
 * esattamente la forma di silenzio che ha lasciato correre il difetto originale.
 * Il VUOTO, quando è vero, si dice con parole sue.
 *
 * Il gate vero è nella route (`requireStaff(request, RUOLI_DIREZIONE)`): questa
 * scheda si nasconde alla segreteria per non offrirle un pulsante che darebbe
 * 403, non per proteggere il dato.
 *
 * ⚠️ NIENTE POLLING, e non è un'ottimizzazione: ogni lettura scrive una riga nel
 * registro di vigilanza (la route conta i messaggi delle conversazioni fra
 * famiglie e maestre). Un giro automatico riempirebbe quel registro di righe che
 * nessuno ha chiesto, e un registro pieno di rumore è illeggibile quanto uno
 * vuoto.
 *
 * ⚠️ E NON MANDA NIENTE A NESSUNO. Il promemoria automatico alle maestre è stato
 * escluso dal titolare: qui si guarda, si telefona, si va di persona.
 */

interface RigaDocente {
  id: string;
  nome: string;
  ricevuti30g: number;
  nonLetti: number;
}

/** 503: il registro degli accessi non ha accettato la riga (vedi la route). */
const NON_TRACCIABILE = 'VIGILANZA_NON_TRACCIABILE';

export function DocentiSenzaNotifiche() {
  const t = useTranslations('adminComunicazioni');
  const [righe, setRighe] = useState<RigaDocente[]>([]);
  /**
   * Quante sono in TUTTO, non quante se ne vedono: la route pagina a 100, e
   * `righe.length` direbbe «100 maestre su 240» alla centunesima. Il numero
   * della frase deve essere quello vero, o non è un numero.
   */
  const [totale, setTotale] = useState(0);
  const [docentiTotali, setDocentiTotali] = useState(0);
  const [giorni, setGiorni] = useState(30);
  const [caricamento, setCaricamento] = useState(true);
  const [errore, setErrore] = useState('');

  /**
   * ⚠️ LE ETICHETTE SI RISOLVONO QUI, FUORI DA `carica`, e non è un vezzo.
   *
   * `useTranslations` non promette un'identità stabile fra i render: con `t`
   * nelle dipendenze, `carica` cambia a ogni render, `useEffect` lo rivede
   * nuovo e la richiesta riparte. E ogni richiesta di questa scheda SCRIVE
   * righe nel registro di vigilanza — una per sede. Misurato dal revisore con
   * un mock che rinnova `t` a ogni render: 33.934 richieste in venti secondi.
   * Le STRINGHE invece sono stabili, quindi `carica` lo diventa.
   */
  const erroreLabel = t('docentiSenzaPushErrore');
  const nonTracciabileLabel = t('docentiSenzaPushNonTracciabile');

  const carica = useCallback(() => {
    // `limite=500` è il tetto che la route accetta: sotto, la frase «N maestre
    // su M» direbbe il vero e la tabella ne mostrerebbe cento. Con tre sedi e
    // sessanta docenti non ci arriveremo, ma il giorno che ci si arrivasse la
    // differenza fra il numero e l'elenco non la spiegherebbe nessuno.
    fetch('/api/admin/chat/docenti-senza-push?limite=500')
      .then(async (r) => {
        if (!r.ok) {
          let grezzo: unknown = null;
          try {
            grezzo = await r.json();
          } catch (e) {
            // Corpo non-JSON (un 502 del proxy davanti all'app): non è un dato,
            // e il ripiego qui sotto è il messaggio. Si logga comunque — un
            // catch muto è un bug — al livello più basso che questo canale
            // ammette (`logClient` accetta solo `warn` e `error`).
            logClient({
              livello: 'warn',
              evento: 'fetch',
              messaggio: `docenti-senza-push-corpo-illeggibile: ${nomeErrore(e)}`,
              route: '/admin/messaggi',
            });
          }
          // Il 503 del registro ha una frase SUA. Quella del catalogo condiviso
          // (`shared.erroreVigilanzaNonTracciabile`) finisce con «e per questo
          // la conversazione non è stata aperta»: qui nessuno stava aprendo una
          // conversazione, e un messaggio che racconta un'altra schermata manda
          // chi legge a cercare un problema che non c'è.
          const codice = (grezzo as { codice?: unknown } | null)?.codice;
          setErrore(
            codice === NON_TRACCIABILE
              ? nonTracciabileLabel
              // Il CODICE vince sulla prosa: il server non conosce la lingua
              // dell'interfaccia, e `LETTURA_FALLITA` ha la sua frase in due.
              : messaggioDaCorpo(grezzo, erroreLabel),
          );
          return;
        }
        const corpo = (await r.json()) as {
          success?: boolean;
          data?: RigaDocente[];
          totale?: number;
          docentiTotali?: number;
          giorni?: number;
        };
        // 200 con `success: false`: una risposta che non ha detto no e non ha
        // detto sì. Senza questo ramo la scheda mostrerebbe lo stato vuoto —
        // «tutte hanno un dispositivo» — su una risposta che non l'ha mai detto.
        if (!corpo.success) {
          setErrore(erroreLabel);
          return;
        }
        setErrore('');
        setRighe(corpo.data ?? []);
        setTotale(corpo.totale ?? (corpo.data ?? []).length);
        setDocentiTotali(corpo.docentiTotali ?? 0);
        if (typeof corpo.giorni === 'number') setGiorni(corpo.giorni);
      })
      .catch((e) => {
        // Un catch muto qui vorrebbe dire una schermata vuota indistinguibile da
        // «tutte le maestre ricevono le notifiche»: cioè il difetto originale,
        // rifatto nello strumento nato per scoprirlo.
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `docenti-senza-push-lettura-fallita: ${nomeErrore(e)}`,
          route: '/admin/messaggi',
        });
        setErrore(erroreLabel);
      })
      .finally(() => setCaricamento(false));
  }, [erroreLabel, nonTracciabileLabel]);

  useEffect(() => { carica(); }, [carica]);

  const colonne: [string, string] = [
    t('docentiSenzaPushColRicevuti', { giorni }),
    t('docentiSenzaPushColNonLetti'),
  ];

  return (
    <>
      <div className="mb-3 rounded-card bg-kidville-white p-4 shadow-sm">
        <p className="flex items-center gap-2 font-barlow font-bold text-kidville-green">
          <BellOff size={16} aria-hidden="true" />
          {t('docentiSenzaPushTitolo')}
        </p>
        <p className="mt-1 font-maven text-xs text-kidville-sub">{t('docentiSenzaPushSottotitolo')}</p>
        <p className="mt-1 font-maven text-xs text-kidville-sub">{t('docentiSenzaPushNota')}</p>
      </div>

      <div className="rounded-card bg-kidville-white p-3 shadow-sm">
        {caricamento ? (
          <p role="status" className="flex items-center gap-2 p-2 font-maven text-sm text-kidville-sub">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" /> {t('caricamento')}
          </p>
        ) : errore ? (
          <p role="alert" className="rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
            {errore}
          </p>
        ) : righe.length === 0 ? (
          // Due vuoti diversi, e dirli uguali sarebbe una bugia in una sola
          // direzione: «tutte hanno un dispositivo» su una sede senza maestre
          // rassicurerebbe su una cosa che non è stata verificata da nessuno.
          // E la frase non promette la RICEZIONE: una riga in
          // `push_subscriptions` dice che un dispositivo è registrato, non che
          // la notifica arriva (può mancare il permesso, il token può essere
          // scaduto). Promettere di più sarebbe rifare il difetto al rovescio.
          <p className="p-2 font-maven text-sm text-kidville-sub">
            {docentiTotali === 0 ? t('docentiSenzaPushNessunaDocente') : t('docentiSenzaPushVuoto')}
          </p>
        ) : (
          <>
            <p className="px-2 pb-2 font-maven text-sm font-semibold text-kidville-ink">
              {t('docentiSenzaPushConteggio', { n: totale, totale: docentiTotali })}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse">
                <caption className="sr-only">{t('docentiSenzaPushTitolo')}</caption>
                <thead>
                  <tr className="border-b border-kidville-line text-left">
                    <th scope="col" className="px-2 py-2 font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-sub">
                      {t('docentiSenzaPushColChi')}
                    </th>
                    {colonne.map((etichetta) => (
                      <th
                        key={etichetta}
                        scope="col"
                        className="px-2 py-2 text-right font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-sub"
                      >
                        {etichetta}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {righe.map((d) => (
                    <tr key={d.id} className="border-b border-kidville-line/60">
                      <th scope="row" className="px-2 py-2 text-left font-maven text-sm font-semibold text-kidville-ink">
                        {d.nome}
                      </th>
                      <td className="px-2 py-2 text-right font-maven text-sm text-kidville-ink">{d.ricevuti30g}</td>
                      <td className="px-2 py-2 text-right font-maven text-sm font-bold text-kidville-ink">{d.nonLetti}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
