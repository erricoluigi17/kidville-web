'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useDateFormat } from '@/lib/i18n/date';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { GIORNI_CESTINO_REGISTRO } from '@/lib/primaria/cestino-registro';
import {
  chiaveErroreFascicolo,
  leggiEsitoFascicolo,
  rifiutoRichiedeRilettura,
} from '@/lib/primaria/fascicolo-ui';

/**
 * Il CESTINO del fascicolo (spec 2026-09-24, compito F2): i documenti eliminati o
 * sostituiti dell'alunno, ancora ripristinabili, con «Ripristina».
 *
 * L'elenco viene da `GET /api/primaria/fascicolo/cestino`, che applica già le due
 * regole che contano: solo le voci entro la custodia (`GIORNI_CESTINO_REGISTRO`),
 * e per chi non è Segreteria/Direzione solo i documenti che ha caricato lui — gli
 * unici che può ripristinare. Qui quindi ogni voce ha il suo «Ripristina», senza
 * un secondo filtro che divergerebbe da quello del server.
 *
 * Ripristinare un documento SOSTITUITO lo riaggiunge accanto a quello nuovo (spec,
 * «Decisioni aggiunte»): è il server a farlo, la UI rilegge i due elenchi.
 */

interface VoceCestino {
  id: string;
  document_type: string | null;
  descrizione: string | null;
  file_name: string | null;
  eliminato_il: string;
  giorniResidui: number;
}

function rottaPagina(): string | undefined {
  return typeof window !== 'undefined' ? window.location.pathname : undefined;
}

export interface CestinoFascicoloProps {
  alunnoId: string;
  userId: string;
  /**
   * La finalità scritta in pagina, letta al momento della richiesta. Deve essere un
   * getter STABILE (`useCallback` senza dipendenze sulla pagina): è una dipendenza
   * della lettura, e un'identità nuova a ogni tasto rileggerebbe il cestino.
   */
  finalita: () => string;
  /**
   * Cambia quando l'elenco dei documenti cambia (eliminazione, sostituzione):
   * il cestino si rilegge, perché la voce appena eliminata ci deve comparire.
   */
  versione: number;
  /** Un documento è tornato vivo: la pagina rilegge l'elenco dei documenti. */
  onRipristinato: () => void;
  onEsito: (testo: string, tipo: 'ok' | 'errore') => void;
}

export function CestinoFascicolo({ alunnoId, userId, finalita, versione, onRipristinato, onEsito }: CestinoFascicoloProps) {
  const t = useTranslations('teacherPrimaria');
  const f = useDateFormat();
  const [voci, setVoci] = useState<VoceCestino[] | null>(null);
  /** La CHIAVE del messaggio, tradotta al render: `t` non entra fra le dipendenze della lettura. */
  const [erroreLettura, setErroreLettura] = useState<string | null>(null);
  const [inVolo, setInVolo] = useState<string | null>(null);
  const [giro, setGiro] = useState(0);

  const rileggi = useCallback(() => setGiro((g) => g + 1), []);

  useEffect(() => {
    let vivo = true;
    const q = new URLSearchParams({ alunnoId, userId });
    const fz = finalita();
    if (fz) q.set('finalita', fz);
    (async () => {
      try {
        const r = await fetch(`/api/primaria/fascicolo/cestino?${q.toString()}`);
        const esito = await leggiEsitoFascicolo<VoceCestino[]>(r);
        if (!vivo) return;
        if (!esito.ok) {
          setVoci([]);
          setErroreLettura(chiaveErroreFascicolo(esito.stato, esito.codice));
          return;
        }
        setErroreLettura(null);
        setVoci(Array.isArray(esito.dati) ? esito.dati : []);
      } catch (e) {
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `fascicolo-cestino-lettura-fallita: ${nomeErrore(e)}`,
          route: rottaPagina(),
        });
        // Una LETTURA fallita: nessuna operazione in dubbio, solo l'elenco mancante.
        if (vivo) { setVoci([]); setErroreLettura('fascicoloErroreLetturaDocumenti'); }
      }
    })();
    return () => { vivo = false; };
  }, [alunnoId, userId, finalita, versione, giro]);

  const ripristina = async (voce: VoceCestino) => {
    if (inVolo) return;
    setInVolo(voce.id);
    try {
      const r = await fetch(`/api/primaria/fascicolo/cestino?userId=${encodeURIComponent(userId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ id: voce.id }),
      });
      const esito = await leggiEsitoFascicolo(r);
      if (!esito.ok) {
        onEsito(t(chiaveErroreFascicolo(esito.stato, esito.codice)), 'errore');
        if (rifiutoRichiedeRilettura(esito.codice)) { rileggi(); onRipristinato(); }
        return;
      }
      onEsito(t('fascicoloRipristinato'), 'ok');
      rileggi();
      onRipristinato();
    } catch (e) {
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `fascicolo-ripristino-fallito: ${nomeErrore(e)}`,
        route: rottaPagina(),
      });
      onEsito(t('fascicoloErroreRete'), 'errore');
      // Esito ignoto (la risposta può essersi persa dopo il ripristino): si
      // rileggono cestino e documenti, che dicono lo stato vero.
      rileggi();
      onRipristinato();
    } finally {
      setInVolo(null);
    }
  };

  return (
    <div data-testid="fascicolo-cestino">
      <h3 className="font-barlow text-base font-bold text-kidville-ink mb-1 flex items-center gap-2">
        <Trash2 size={16} className="text-kidville-error" /> {t('fascicoloCestinoTitolo')}
      </h3>
      <p className="font-maven text-xs text-kidville-sub mb-3">
        {t('fascicoloCestinoSpiega', { giorni: GIORNI_CESTINO_REGISTRO })}
      </p>
      {erroreLettura && (
        <p role="alert" className="mb-2 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error">
          {t(erroreLettura)}
        </p>
      )}
      {voci === null ? (
        <p className="font-maven text-sm text-kidville-sub">{t('comuneCaricamento')}</p>
      ) : voci.length === 0 ? (
        !erroreLettura && <p className="font-maven text-sm text-kidville-sub">{t('fascicoloCestinoVuoto')}</p>
      ) : (
        <ul className="divide-y divide-kidville-line">
          {voci.map((v) => {
            const nome = v.file_name || v.descrizione || t('fascicoloDocumento');
            return (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="font-maven text-sm font-semibold text-kidville-ink break-words">
                    {v.document_type && (
                      <span className="rounded-pill bg-kidville-line px-2 py-0.5 text-[11px] text-kidville-sub uppercase">{v.document_type}</span>
                    )}
                    {' '}{nome}
                  </p>
                  <p className="font-maven text-xs text-kidville-sub">
                    {t('fascicoloCestinoEliminatoIl', { data: f.dataBreve(v.eliminato_il), residui: v.giorniResidui })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => ripristina(v)}
                  disabled={inVolo !== null}
                  aria-label={t('fascicoloRipristinaAria', { documento: nome })}
                  className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green disabled:opacity-50"
                >
                  <RotateCcw size={13} /> {t('fascicoloRipristina')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
