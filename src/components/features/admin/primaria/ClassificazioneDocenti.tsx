'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { creaMuta } from '@/lib/ui/muta';

interface Docente {
  id: string;
  nome: string;
  cognome: string;
  email?: string;
  gradi?: string[];
}

// `key` è il valore persistito/confrontato (grado); labelKey è solo display.
const GRADI: { key: string; labelKey: string }[] = [
  { key: 'nido', labelKey: 'classificazioneGradoNido' },
  { key: 'infanzia', labelKey: 'classificazioneGradoInfanzia' },
  { key: 'primaria', labelKey: 'classificazioneGradoPrimaria' },
];

/**
 * Aggiunge o toglie UN grado a un elenco. Serve due volte per ogni spunta — una
 * per applicarla, una per disfarla se il server la rifiuta — e in entrambi i
 * casi va applicata allo stato CORRENTE, non a una copia catturata prima della
 * fetch: vedi il commento di `toggleGrado`.
 */
const applicaGrado = (gradi: string[] | undefined, grado: string, presente: boolean): string[] => {
  const insieme = new Set(gradi ?? []);
  if (presente) insieme.add(grado);
  else insieme.delete(grado);
  return Array.from(insieme);
};

export function ClassificazioneDocenti({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const t = useTranslations('adminPrimaria');
  const [docenti, setDocenti] = useState<Docente[]>([]);
  // Gli id delle righe con una PATCH in volo. È un INSIEME e non un solo id
  // perché due righe possono essere in volo insieme: con un solo id, la prima
  // che risponde riabiliterebbe anche la seconda, che invece sta ancora
  // aspettando.
  const [inVolo, setInVolo] = useState<ReadonlySet<string>>(() => new Set());
  // L'esito dell'ultima mutazione. Prima non esisteva, e questo è il punto del
  // file: vedi il commento di `toggleGrado`.
  const [errore, setErrore] = useState('');

  const load = useCallback(async () => {
    let next: Docente[] | null = null;
    try {
      const r = await fetch(`/api/admin/primaria/docente-gradi?scuolaId=${scuolaId}`, {
        headers: { 'x-user-id': userId },
      });
      const d = await r.json();
      next = d.success ? d.data : [];
    } finally {
      if (next) setDocenti(next);
    }
  }, [scuolaId, userId]);

  useEffect(() => {
    load();
  }, [load]);

  const muta = useMemo(
    () => creaMuta({ route: '/admin/impostazioni', ricarica: load, setErrore, fallback: t('comuneErroreSalvataggio') }),
    [load, t],
  );

  /**
   * LA SPUNTA CHE RESTAVA SU UN DATO CHE IL DATABASE NON AVEVA.
   *
   * Questa mutazione era `await fetch(...)` nudo — nessun `res.ok`, nessun log,
   * nessun avviso — con lo stato ottimistico scritto PRIMA. Su un rifiuto (con
   * tre plessi, il 403 di sede è la risposta normale a una sede sbagliata) la
   * casella restava spuntata per sempre.
   *
   * E i `gradi` non restano qui: `OrarioManager` e `DocentiMaterieManager`
   * filtrano su `(d.gradi ?? []).includes('primaria')`. Il salvataggio rifiutato
   * mostrava quindi il docente come abilitato IN QUESTA TABELLA e lo faceva
   * SPARIRE dalle tendine — due schermate della stessa applicazione che dicevano
   * il contrario, e nessun errore da nessuna parte per spiegarlo.
   *
   * L'ottimismo resta (la casella deve rispondere al dito), ma adesso è
   * REVERSIBILE: sul rifiuto si disfa la spunta. Non basta affidarsi a
   * `ricarica`, che sul ramo «rete giù» non viene chiamata affatto — e quello è
   * proprio il caso in cui lo schermo resterebbe a raccontare una cosa che non è
   * mai arrivata al server.
   *
   * ⚠️ E IL RIPRISTINO NON È UN'ISTANTANEA. La prima stesura salvava l'intero
   * elenco prima della fetch (`const precedenti = docenti`) e lo rimetteva sul
   * rifiuto. Con una sola scrittura in volo funziona; con DUE l'istantanea della
   * seconda contiene già la modifica ottimistica della prima — mai salvata — e
   * rimetterla RISCRIVE a schermo un dato che il server ha rifiutato. Cioè
   * esattamente il difetto che questa funzione esiste per chiudere, reintrodotto
   * dal rimedio. Perciò qui si DISFA LA SINGOLA SPUNTA sullo stato corrente
   * (`applicaGrado(d.gradi, grado, presente)`): l'operazione inversa è
   * indipendente dall'ordine in cui le risposte arrivano, un'istantanea no.
   *
   * Sulla STESSA riga, invece, non c'è inverso che tenga: due PATCH che mandano
   * entrambe l'elenco intero si sovrascrivono anche sul server. Lì la risposta
   * giusta è non farle partire — `inVolo` disabilita la riga finché la prima non
   * ha risposto.
   */
  const toggleGrado = async (doc: Docente, grado: string) => {
    // La casella è già `disabled`; questa è la stessa regola scritta dove non
    // dipende dal fatto che il browser onori l'attributo.
    if (inVolo.has(doc.id)) return;
    const presente = (doc.gradi ?? []).includes(grado);
    const gradi = applicaGrado(doc.gradi, grado, !presente);
    setInVolo((prev) => new Set(prev).add(doc.id));
    // ottimistico
    setDocenti((prev) => prev.map((d) => (d.id === doc.id ? { ...d, gradi: applicaGrado(d.gradi, grado, !presente) } : d)));
    const ok = await muta(
      `/api/admin/primaria/docente-gradi?userId=${userId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ utenteId: doc.id, gradi }),
      },
      'primaria-docente-gradi-respinta',
      // Il nome del docente è ciò che rende il messaggio azionabile: in una
      // tabella di quindici righe «salvataggio non riuscito» non dice su quale
      // rifare il gesto. Resta a schermo — `muta` non lo logga.
      `${doc.nome} ${doc.cognome}`,
    );
    if (!ok) {
      setDocenti((prev) => prev.map((d) => (d.id === doc.id ? { ...d, gradi: applicaGrado(d.gradi, grado, presente) } : d)));
    }
    setInVolo((prev) => {
      const next = new Set(prev);
      next.delete(doc.id);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {errore && (
        <div role="alert" className="flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-3 py-2.5 font-maven text-sm text-kidville-error-strong">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" strokeWidth={1.8} />
          <span>{errore}</span>
        </div>
      )}
      <p className="font-maven text-sm text-kidville-muted">
        {t('classificazioneSottotitolo')}
      </p>
      <table className="w-full text-sm font-maven">
        <thead>
          <tr className="text-left text-kidville-muted">
            <th className="py-2">{t('classificazioneColDocente')}</th>
            {GRADI.map((g) => (
              <th key={g.key} className="py-2 text-center">{t(g.labelKey)}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-kidville-line">
          {docenti.map((doc) => (
            <tr key={doc.id} className={inVolo.has(doc.id) ? 'opacity-60' : ''}>
              <td className="py-2.5">
                <span className="text-kidville-ink">{doc.nome} {doc.cognome}</span>
                {doc.email && <span className="ml-2 text-xs text-kidville-muted">{doc.email}</span>}
              </td>
              {GRADI.map((g) => (
                <td key={g.key} className="py-2.5 text-center">
                  <input
                    type="checkbox"
                    checked={(doc.gradi ?? []).includes(g.key)}
                    // Finché la PATCH di questa riga è in volo la riga non si
                    // tocca: la PATCH manda l'elenco INTERO dei gradi, quindi
                    // due spunte in volo insieme sulla stessa persona si
                    // sovrascriverebbero anche sul server, e l'ultima a
                    // rispondere deciderebbe per tutte e due.
                    disabled={inVolo.has(doc.id)}
                    onChange={() => toggleGrado(doc, g.key)}
                  />
                </td>
              ))}
            </tr>
          ))}
          {docenti.length === 0 && (
            <tr><td colSpan={4} className="py-3 text-kidville-muted">{t('classificazioneNessunDocente')}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
