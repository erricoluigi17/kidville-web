'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Building2 } from 'lucide-react';
import { parseAnagraficaSede, type AnagraficaSede } from '@/lib/scuole/anagrafica';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { CampiAnagraficaSede, type ValoriSede } from './CampiAnagraficaSede';
import { card, h3, hint } from './ui';
import { SaveRow } from './fields';

/**
 * L'anagrafica della sede SELEZIONATA, dentro le Impostazioni.
 *
 * Perché qui e non solo in `/admin/schools`: i prestampati che si chiudono con la
 * firma del legale rappresentante rifiutano di uscire con il messaggio
 * «aggiungilo nelle impostazioni della sede» (`api/prestampati/banco.ts`), e fino
 * a oggi quella frase mandava in una schermata che non esiste — il pannello
 * Multi-sede non compare in nessuna voce di menu, e il campo del legale
 * rappresentante non c'era in nessun form del prodotto.
 *
 * `/admin/schools` resta la gestione dell'ELENCO delle sedi (crea, rinomina,
 * disattiva), che è un'altra cosa e riguarda solo la Direzione. Qui si compila la
 * scheda di UNA sede, quella su cui si sta già lavorando.
 *
 * Il salvataggio è lo stesso `PATCH /api/admin/schools`, che fa il merge
 * server-side in `config.anagrafica` e resta riservato alla Direzione: a chi non
 * lo è, il 403 si dice, non si nasconde.
 */

/**
 * L'errore come CODICE, non come frase: `permesso` (403), `scope` (sede non fra
 * le proprie), o il messaggio che il server ha mandato — tradotti al render.
 */
type Errore = null | 'permesso' | 'scope' | { generico: string };

export function AnagraficaSedeSettings({ userId, scuolaId }: { userId: string; scuolaId: string }) {
  const t = useTranslations('adminSettings');
  const [nome, setNome] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errore, setErrore] = useState<Errore>(null);
  const [msg, setMsg] = useState('');
  const [anagrafica, setAnagrafica] = useState<AnagraficaSede>({});
  const [sede, setSede] = useState<ValoriSede>({ citta: '', indirizzo: '' });

  /**
   * Il caricamento NON dipende da `t`, ed è la stessa ragione già scritta in
   * `useAdminSettings`: `useTranslations` non promette un'identità stabile fra i
   * render, quindi un effetto che ci dipende riparte da solo. Qui è costato una
   * prima versione rossa in collaudo — il GET ripartiva a ogni render e
   * riscriveva sopra ciò che si stava digitando. In una schermata che si compila
   * a mano è il difetto peggiore possibile: cancella il lavoro di chi scrive
   * senza dire niente.
   *
   * Perciò nello stato finisce un CODICE d'errore, non una frase già tradotta:
   * la traduzione si fa al render, dove `t` può cambiare quanto vuole.
   *
   * `active` evita di scrivere sullo stato di un pannello già smontato quando si
   * cambia sede mentre la lettura è in volo.
   */
  useEffect(() => {
    let active = true;
    fetch('/api/admin/schools', { headers: { 'x-user-id': userId } })
      .then(async (res) => ({ ok: res.ok, status: res.status, corpo: await res.json().catch(() => null) }))
      .then(({ ok, status, corpo }) => {
        if (!active) return;
        if (!ok) {
          setErrore(status === 403 ? 'permesso' : { generico: messaggioDaCorpo(corpo, '') });
          logClient({ livello: 'warn', evento: 'fetch', messaggio: 'admin/schools:GET — anagrafica di sede non letta', stato: status });
          return;
        }
        const righe: unknown[] = Array.isArray(corpo) ? corpo : [];
        const riga = righe.find((s) => String((s as { id?: string })?.id) === scuolaId) as
          | { nome?: unknown; citta?: string | null; indirizzo?: string | null; config?: unknown }
          | undefined;
        if (!riga) {
          // Non è «errore di rete»: è una sede che questo account non ha in scope.
          // Si logga lo stesso — senza, «schermata vuota» e «sede fuori portata»
          // sono lo stesso silenzio.
          setErrore('scope');
          logClient({ livello: 'warn', evento: 'fetch', messaggio: 'admin/schools:GET — sede selezionata non presente fra quelle dell’utente' });
          return;
        }
        setNome(typeof riga.nome === 'string' ? riga.nome : null);
        setAnagrafica(parseAnagraficaSede(riga.config));
        setSede({ citta: riga.citta ?? '', indirizzo: riga.indirizzo ?? '' });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setErrore({ generico: '' });
        logClient({ livello: 'warn', evento: 'fetch', messaggio: `admin/schools:GET — ${nomeErrore(err)}` });
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId, scuolaId]);

  const salva = async () => {
    setSaving(true);
    setMsg('');
    setErrore(null);
    try {
      const res = await fetch('/api/admin/schools', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ id: scuolaId, citta: sede.citta, indirizzo: sede.indirizzo, anagrafica }),
      });
      const corpo = await res.json().catch(() => null);
      if (!res.ok) {
        setErrore(res.status === 403 ? 'permesso' : { generico: messaggioDaCorpo(corpo, '') });
        // Un'anagrafica che non si salva è un guasto operativo: senza questa riga
        // resterebbe solo la frase rossa a schermo, che nessuno rilegge domani.
        // Nel messaggio nessun testo del server (può contenere un dato): solo lo stato.
        logClient({ livello: 'warn', evento: 'fetch', messaggio: 'admin/schools:PATCH — anagrafica di sede non salvata', stato: res.status });
        return;
      }
      // Si rilegge quello che il server ha SCRITTO, non quello che si è digitato:
      // la normalizzazione lato server mette in maiuscolo la sigla di provincia e
      // azzera le stringhe vuote, e un form che resta sulla propria versione fa
      // credere salvato ciò che non lo è.
      if (corpo && typeof corpo === 'object') {
        setAnagrafica(parseAnagraficaSede((corpo as { config?: unknown }).config));
        setSede({
          citta: (corpo as { citta?: string | null }).citta ?? '',
          indirizzo: (corpo as { indirizzo?: string | null }).indirizzo ?? '',
        });
      }
      setMsg(t('salvato'));
    } catch (err: unknown) {
      setErrore({ generico: '' });
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `admin/schools:PATCH — ${nomeErrore(err)}` });
    } finally {
      setSaving(false);
    }
  };

  const testoErrore =
    errore === null ? null
      : errore === 'permesso' ? t('scAzioneRiservata')
      : errore === 'scope' ? t('anSedeNonInScope')
      : errore.generico || t('errore');

  if (loading) return <p className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>;

  return (
    <section className={card}>
      <h3 className={h3}><Building2 size={16} /> {t('anTitolo')}</h3>

      {nome && (
        <p className="font-maven text-sm text-kidville-sub mb-4">{t('anSottotitolo', { sede: nome })}</p>
      )}

      <CampiAnagraficaSede
        anagrafica={anagrafica}
        onAnagrafica={(agg) => { setMsg(''); setAnagrafica(agg); }}
        sede={sede}
        onSede={(agg) => { setMsg(''); setSede(agg); }}
      />

      <SaveRow onSave={salva} saving={saving} msg={msg} error={testoErrore} />
      <p className={hint}>{t('anHint')}</p>
    </section>
  );
}
