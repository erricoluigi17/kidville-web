'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileSignature } from 'lucide-react';
import { Btn } from '@/components/ui/Btn';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { useDateFormat } from '@/lib/i18n/date';

/**
 * LA FASCIA «MODULI DA RIFIRMARE» — in cima a «Modulistica» (compito 4.8.6).
 *
 * Legge `GET /api/parent/prestampati/da-rifirmare`: i moduli annuali (oggi la delega al ritiro) che il
 * passaggio d'anno ha reso da firmare di nuovo, per i soli figli di chi è collegato. I sanitari non ci sono
 * (valgono fino a revoca). La route consegna al più 20 moduli, il più vecchio scaduto per primo, e il totale
 * vero: se è più grande, la fascia lo dice con «e altri N».
 *
 * Elenco vuoto, lettura fallita o database senza lo schema dell'anno: **la fascia non compare**. Una lettura
 * fallita non diventa un errore a schermo (a una famiglia non serve sapere che un avviso in più non è
 * arrivato), ma si registra: «non c'è niente da rifirmare» e «non ho potuto leggere» non si confondono nei log.
 *
 * Il pulsante «Firma» non firma da sé: passa lo slug e il figlio a chi ospita la fascia, che apre il flusso
 * dei prestampati già esistente (`PrestampatiGenitore`, con OTP) su quel modulo.
 */

export interface FiglioFascia {
  id: string;
  nome: string;
  cognome: string;
}

interface ModuloDaRifirmare {
  slug: string;
  chiaveEtichetta: string;
  /** Il giorno (AAAA-MM-GG, di Roma) dell'ultima firma. */
  ultimaFirma: string;
}

interface GruppoDaRifirmare {
  alunno_id: string;
  moduli: ModuloDaRifirmare[];
}

interface Riga {
  alunnoId: string;
  slug: string;
  chiaveEtichetta: string;
  ultimaFirma: string;
}

interface Elenco {
  righe: Riga[];
  totale: number;
}

/** Il corpo della route, letto con le difese di chi riceve dalla rete: ciò che non torna non è una riga. */
function leggiElenco(corpo: unknown): Elenco | null {
  if (typeof corpo !== 'object' || corpo === null) return null;
  const { success, data, totale } = corpo as { success?: unknown; data?: unknown; totale?: unknown };
  if (success !== true || !Array.isArray(data)) return null;
  const righe: Riga[] = [];
  for (const g of data as GruppoDaRifirmare[]) {
    if (typeof g?.alunno_id !== 'string' || !Array.isArray(g.moduli)) continue;
    for (const m of g.moduli) {
      if (typeof m?.slug !== 'string' || typeof m.chiaveEtichetta !== 'string' || typeof m.ultimaFirma !== 'string') continue;
      righe.push({ alunnoId: g.alunno_id, slug: m.slug, chiaveEtichetta: m.chiaveEtichetta, ultimaFirma: m.ultimaFirma });
    }
  }
  return { righe, totale: typeof totale === 'number' && totale >= righe.length ? totale : righe.length };
}

/**
 * La lettura, che non lancia mai: `null` vale «non c'è nessuna fascia da disegnare», sia che la route abbia
 * risposto male sia che la rete sia caduta. In entrambi i casi resta una riga di registro (livello `warn`,
 * mai un errore a schermo né in console), senza identità né dati della famiglia.
 */
async function leggiDaRifirmare(userId: string): Promise<Elenco | null> {
  try {
    const res = await fetch('/api/parent/prestampati/da-rifirmare', { headers: { 'x-user-id': userId } });
    const letto = res.ok ? leggiElenco(await res.json().catch(() => null)) : null;
    if (!letto) {
      logClient({
        livello: 'warn',
        evento: 'fetch',
        messaggio: 'modulistica genitore: moduli da rifirmare non letti',
        route: '/parent/modulistica',
        stato: res.status,
      });
    }
    return letto;
  } catch (errore) {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `modulistica genitore: moduli da rifirmare non letti (${nomeErrore(errore)})`,
      route: '/parent/modulistica',
    });
    return null;
  }
}

export function FasciaModuliDaRifirmare({
  userId,
  figli,
  onFirma,
}: {
  userId: string | null | undefined;
  figli: readonly FiglioFascia[];
  onFirma: (alunnoId: string, slug: string) => void;
}) {
  const t = useTranslations('annoRifirma');
  // I nomi dei moduli stanno nel catalogo dei prestampati della famiglia (`modelli.<slug>`), come nel resto dell'app.
  const tModelli = useTranslations('prestampatiGenitore');
  const { dataBreve } = useDateFormat();
  const titoloId = useId();
  const [elenco, setElenco] = useState<Elenco | null>(null);

  // Lo stato si scrive nella `then`, non nel corpo dell'effetto; `vivo` evita di scrivere su un componente
  // smontato (o su un'identità che nel frattempo è cambiata).
  useEffect(() => {
    if (!userId) return;
    let vivo = true;
    void leggiDaRifirmare(userId).then((letto) => {
      if (vivo) setElenco(letto);
    });
    return () => {
      vivo = false;
    };
  }, [userId]);

  if (!elenco || elenco.righe.length === 0) return null;

  const nomeDi = (alunnoId: string): string => {
    const f = figli.find((x) => x.id === alunnoId);
    return f ? `${f.nome} ${f.cognome}`.trim() : '';
  };
  const altri = elenco.totale - elenco.righe.length;

  return (
    <section
      aria-labelledby={titoloId}
      className="mt-5 rounded-card border border-kidville-line bg-kidville-warn-soft p-4 sm:p-5 space-y-3"
    >
      <div className="space-y-1">
        <h2 id={titoloId} className="font-barlow font-bold text-lg text-kidville-green uppercase tracking-wide flex items-center gap-2">
          <FileSignature size={18} aria-hidden="true" /> {t('titolo')}
        </h2>
        <p className="font-maven text-xs text-kidville-sub">{t('testo')}</p>
      </div>

      <ul className="space-y-2">
        {elenco.righe.map((r) => {
          const modulo = tModelli(r.chiaveEtichetta);
          const nome = nomeDi(r.alunnoId);
          return (
            <li
              key={`${r.alunnoId}-${r.slug}`}
              className="bg-white rounded-xl border border-kidville-line px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="font-maven">
                <div className="font-semibold text-sm text-kidville-ink">
                  {nome ? t('voce', { modulo, nome }) : modulo}
                </div>
                <div className="text-xs text-kidville-sub">{t('firmatoIl', { data: dataBreve(r.ultimaFirma) })}</div>
              </div>
              <Btn
                variant="primary"
                size="sm"
                className="self-start sm:self-auto"
                aria-label={nome ? t('firmaAria', { modulo, nome }) : modulo}
                onClick={() => onFirma(r.alunnoId, r.slug)}
              >
                {t('firma')}
              </Btn>
            </li>
          );
        })}
      </ul>

      {altri > 0 && <p className="font-maven text-xs text-kidville-sub">{t('altri', { n: altri })}</p>}
    </section>
  );
}
