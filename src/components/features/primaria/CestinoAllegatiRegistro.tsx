'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Image as ImageIcon, RotateCcw, Trash2 } from 'lucide-react';
import { useDateFormat } from '@/lib/i18n/date';
import { isoToIt } from '@/lib/format/data';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { GIORNI_CESTINO_REGISTRO } from '@/lib/primaria/cestino-registro';
import { inviaScritturaAllegato } from '@/components/features/primaria/AllegatiRegistro';

/**
 * IL CESTINO DEGLI ALLEGATI DELLA CLASSE (spec 2026-09-24, compito R4).
 *
 * L'elenco viene da `GET /api/primaria/allegati/cestino?sectionId=` (R2), che
 * applica già le regole che contano: solo le voci entro la custodia
 * (`GIORNI_CESTINO_REGISTRO`), e a chi non è Segreteria/Direzione solo gli
 * allegati che ha caricato lui — gli unici che può ripristinare. Qui non c'è un
 * secondo filtro che divergerebbe da quello del server.
 *
 * ─── LA LEZIONE DA RIFIRMARE ─────────────────────────────────────────────────
 * Un allegato la cui lezione è stata ELIMINATA torna solo se nello stesso slot
 * (classe + data + ora) c'è di nuovo una lezione firmata (spec, «Decisioni
 * aggiunte»). La GET lo dichiara per voce (`lezioneDaRifirmare`), e la voce lo
 * dice SUBITO, con l'ora e la data da rifirmare. «Ripristina» resta offerto: la
 * lezione può essere stata rifirmata dopo la lettura del cestino, e il server è
 * l'unico a saperlo. Se risponde `409 LEZIONE_DA_RIFIRMARE` il messaggio compare
 * sulla VOCE, non in un banner generico: è lì che serve sapere cosa fare.
 */

export interface VoceCestinoAllegato {
  id: string;
  registro_id: string | null;
  tipo: string;
  file_name: string | null;
  eliminato_il: string;
  slot_data: string | null;
  slot_ora_lezione: number | null;
  giorniResidui: number;
  lezioneDaRifirmare: boolean;
  ripristinabile: boolean;
}

function rottaPagina(): string | undefined {
  return typeof window !== 'undefined' ? window.location.pathname : undefined;
}

export interface CestinoAllegatiRegistroProps {
  sectionId: string;
  userId: string;
  /** Cambia quando gli allegati cambiano (eliminazione, sostituzione, lezione eliminata): il cestino si rilegge. */
  versione: number;
  /** Un allegato è tornato alla sua lezione: la pagina rilegge il registro. */
  onRipristinato: () => void;
  onEsito: (testo: string, tipo: 'ok' | 'errore') => void;
}

export function CestinoAllegatiRegistro({ sectionId, userId, versione, onRipristinato, onEsito }: CestinoAllegatiRegistroProps) {
  const t = useTranslations('teacherPrimaria');
  const f = useDateFormat();
  const [voci, setVoci] = useState<VoceCestinoAllegato[] | null>(null);
  const [erroreLettura, setErroreLettura] = useState(false);
  const [inVolo, setInVolo] = useState<string | null>(null);
  /** Il rifiuto del ripristino, sulla VOCE a cui si riferisce. */
  const [erroriVoce, setErroriVoce] = useState<Record<string, { testo: string; rifirmare: boolean }>>({});
  const [giro, setGiro] = useState(0);
  const rileggi = useCallback(() => setGiro((g) => g + 1), []);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const q = new URLSearchParams({ sectionId, userId });
      let res: Response | null = null;
      try {
        res = await fetch(`/api/primaria/allegati/cestino?${q.toString()}`, { headers: { 'x-user-id': userId } });
      } catch (err) {
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `registro-cestino-non-letto: ${nomeErrore(err)}`,
          route: rottaPagina(),
          stato: 0,
        });
      }
      let corpo: { success?: boolean; data?: VoceCestinoAllegato[] } | null = null;
      if (res) {
        try {
          corpo = await res.json();
        } catch (errJson) {
          logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: `registro-cestino-risposta-non-json: ${nomeErrore(errJson)}`,
            route: rottaPagina(),
            stato: res.status,
          });
        }
      }
      if (!vivo) return;
      if (!res?.ok || !corpo?.success || !Array.isArray(corpo.data)) {
        if (res) {
          logClient({ livello: 'error', evento: 'fetch', messaggio: 'registro-cestino-rifiutato', route: rottaPagina(), stato: res.status });
        }
        setVoci([]);
        setErroreLettura(true);
        return;
      }
      setErroreLettura(false);
      setVoci(corpo.data);
      // Un rifiuto del ripristino vale fino alla lettura successiva: da qui in poi
      // l'avviso (anche «prima rifirma…») lo decide l'ultima risposta del server.
      setErroriVoce({});
    })();
    return () => { vivo = false; };
  }, [sectionId, userId, versione, giro]);

  /** Il messaggio della lezione da rifirmare, con l'ora e la data quando le conosciamo. */
  const testoRifirma = (voce: VoceCestinoAllegato): string =>
    voce.slot_data && voce.slot_ora_lezione != null
      ? t('registroCestinoRifirmaPrima', { ora: voce.slot_ora_lezione, data: isoToIt(String(voce.slot_data).slice(0, 10)) })
      : messaggioDaCorpo({ codice: 'LEZIONE_DA_RIFIRMARE' }, t('registroCestinoRipristinoErrore'));

  const ripristina = async (voce: VoceCestinoAllegato) => {
    if (inVolo) return;
    setInVolo(voce.id);
    setErroriVoce((prima) => {
      if (!(voce.id in prima)) return prima;
      const dopo = { ...prima };
      delete dopo[voce.id];
      return dopo;
    });
    try {
      const esito = await inviaScritturaAllegato(
        `/api/primaria/allegati/cestino?${new URLSearchParams({ userId }).toString()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
          body: JSON.stringify({ id: voce.id }),
        },
        'ripristino',
      );
      if (esito.tipo === 'ok') {
        onEsito(t('registroCestinoRipristinato'), 'ok');
        rileggi();
        onRipristinato();
        return;
      }
      if (esito.tipo === 'rete') {
        // Esito IGNOTO: la risposta può essersi persa dopo il ripristino. Si
        // rileggono cestino e registro, che dicono lo stato vero.
        onEsito(t('comuneErroreRete'), 'errore');
        rileggi();
        onRipristinato();
        return;
      }
      if (esito.codice === 'LEZIONE_DA_RIFIRMARE') {
        // Non un guasto: la regola. Il messaggio va sulla voce, e resta.
        setErroriVoce((prima) => ({ ...prima, [voce.id]: { testo: testoRifirma(voce), rifirmare: true } }));
        return;
      }
      const testo = messaggioDaCorpo(esito.corpo, t('registroCestinoRipristinoErrore'));
      if (esito.stato === 404 || esito.stato === 409) {
        // Non più nel cestino, o scaduto: l'elenco era vecchio.
        onEsito(testo, 'errore');
        rileggi();
        return;
      }
      setErroriVoce((prima) => ({ ...prima, [voce.id]: { testo, rifirmare: false } }));
    } finally {
      setInVolo(null);
    }
  };

  return (
    <section data-testid="registro-cestino" className="mb-4 rounded-card border border-kidville-line bg-kidville-cream/40 p-3">
      <h3 className="flex items-center gap-2 font-barlow text-base font-bold text-kidville-ink">
        <Trash2 size={16} aria-hidden="true" className="text-kidville-error" /> {t('registroCestinoTitolo')}
      </h3>
      <p className="mt-0.5 font-maven text-xs text-kidville-sub">
        {t('registroCestinoSpiega', { giorni: GIORNI_CESTINO_REGISTRO })}
      </p>
      {erroreLettura && (
        <p role="alert" className="mt-2 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
          {t('registroCestinoErroreLettura')}
        </p>
      )}
      {voci === null ? (
        <p className="mt-2 font-maven text-sm text-kidville-sub">{t('comuneCaricamento')}</p>
      ) : voci.length === 0 ? (
        !erroreLettura && <p className="mt-2 font-maven text-sm text-kidville-sub">{t('registroCestinoVuoto')}</p>
      ) : (
        <ul className="mt-2 divide-y divide-kidville-line">
          {voci.map((v) => {
            const nome = v.file_name || t('registroAllegato');
            const errore = erroriVoce[v.id];
            // Il flag della GET oppure il 409 appena ricevuto: la lezione va rifirmata.
            const daRifirmare = v.lezioneDaRifirmare || errore?.rifirmare === true;
            return (
              <li key={v.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5" data-testid={`registro-cestino-voce-${v.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1 break-words font-maven text-sm font-semibold text-kidville-ink">
                    {v.tipo === 'pdf' ? <FileText size={13} aria-hidden="true" /> : <ImageIcon size={13} aria-hidden="true" />}
                    {nome}
                  </p>
                  {v.slot_data && v.slot_ora_lezione != null && (
                    <p className="font-maven text-xs text-kidville-sub">
                      {t('registroCestinoLezione', { ora: v.slot_ora_lezione, data: isoToIt(String(v.slot_data).slice(0, 10)) })}
                    </p>
                  )}
                  <p className="font-maven text-xs text-kidville-sub">
                    {t('registroCestinoEliminatoIl', { data: f.dataBreve(v.eliminato_il), residui: v.giorniResidui })}
                  </p>
                  {daRifirmare && (
                    <p
                      role={errore?.rifirmare ? 'alert' : undefined}
                      data-testid="registro-cestino-rifirmare"
                      className="mt-1 rounded-card bg-kidville-warn-soft px-2 py-1 font-maven text-xs text-kidville-warn-strong"
                    >
                      {testoRifirma(v)}
                    </p>
                  )}
                  {errore && !errore.rifirmare && (
                    <p role="alert" className="mt-1 rounded-card bg-kidville-error-soft px-2 py-1 font-maven text-xs text-kidville-error-strong">
                      {errore.testo}
                    </p>
                  )}
                </div>
                {(v.ripristinabile || v.lezioneDaRifirmare) && (
                  <button
                    type="button"
                    onClick={() => void ripristina(v)}
                    aria-disabled={inVolo !== null}
                    aria-label={t('registroCestinoRipristinaNome', { nome })}
                    className="font-maven inline-flex min-h-6 items-center gap-1.5 rounded-pill bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green aria-disabled:opacity-50"
                  >
                    <RotateCcw size={13} aria-hidden="true" /> {inVolo === v.id ? t('registroAllegatoInCorso') : t('registroCestinoRipristina')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
