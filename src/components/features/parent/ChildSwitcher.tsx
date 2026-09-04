'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  useParentIdentity,
  fetchFigli,
  invalidaFigliCache,
  type FiglioAnagrafica,
} from '@/lib/auth/use-parent-identity';

type Figlio = FiglioAnagrafica;

function initials(nome: string, cognome: string) {
  return `${nome?.[0] ?? ''}${cognome?.[0] ?? ''}`.toUpperCase();
}

/**
 * I FIGLI STANNO IN PLESSI DIVERSI?
 *
 * Un genitore può avere due figli in due sedi — `parents` non ha `scuola_id`, ed
 * è una scelta esplicita che serve proprio a permetterlo. Finché le sedi
 * coincidono, scriverne il nome è rumore: la sede è la stessa di sempre e
 * occupa spazio in un chip che ne ha poco. Quando invece divergono, senza il
 * nome i due chip sono INDISTINGUIBILI ogni volta che le sezioni si chiamano
 * uguale — e «2 ANNI» esiste davvero in più plessi di Kidville.
 *
 * Il confronto è su `scuola_id` normalizzato: in Postgres `uuid` è un tipo, e
 * 'AAAA…' è lo stesso valore di 'aaaa…'. Chi non ha sede (dato mancante) non
 * conta come «un plesso in più», altrimenti un campo a `null` accenderebbe
 * l'etichetta per tutti.
 */
function sediDivergono(figli: readonly Figlio[]): boolean {
  const sedi = new Set(
    figli
      .map((f) => (typeof f.scuola_id === 'string' ? f.scuola_id.trim().toLowerCase() : ''))
      .filter((v) => v.length > 0),
  );
  return sedi.size > 1;
}

/**
 * Selettore del figlio per i genitori con più figli — chip ad avatar orizzontali
 * (design DR KvUI.ChildSwitcher). Persiste la scelta in localStorage
 * (kv_student_id) e ricarica, così tutte le pagine genitore mostrano il figlio
 * selezionato. Si nasconde se c'è meno di 2 figli.
 */
export function ChildSwitcher() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [figli, setFigli] = useState<Figlio[]>([]);
  // Testo dell'aria-label del selettore dal namespace i18n «nav». I nomi dei
  // figli e la classe sono DATI: restano invariati, non si traducono.
  const t = useTranslations('nav');

  // L'elenco arriva dalla cache condivisa con `useParentIdentity`: è la STESSA
  // GET che l'identità sta già facendo per risolvere il figlio attivo. Farne
  // una propria era la quinta richiesta identica dello stesso caricamento.
  useEffect(() => {
    if (!parentId) return;
    let annullato = false;
    void fetchFigli(parentId).then((lista) => {
      if (!annullato) setFigli(lista ?? []);
    });
    return () => { annullato = true; };
  }, [parentId]);

  // Niente da scegliere: non mostrare nulla.
  if (!ready || figli.length < 2) return null;

  // Si decide UNA volta per l'intero elenco, non per chip: l'etichetta o c'è
  // per tutti o non c'è per nessuno, così l'altezza della riga è la stessa
  // dall'inizio alla fine. ⚠️ Su WebKit un elemento che cambia altezza fa
  // risalire il pulsante sotto il dito mentre lo si sta premendo: è un difetto
  // già pagato due volte in questo repo, e il modo di non ripagarlo è non far
  // comparire e sparire niente in risposta a un tocco.
  const mostraSede = sediDivergono(figli);

  const onSelect = (id: string) => {
    if (!id || id === studentId) return;
    try { localStorage.setItem('kv_student_id', id); } catch { /* ignore */ }
    // La cache dell'elenco è di modulo: un ricaricamento vero la azzera da sé,
    // ma dentro la shell nativa (WebView) e nelle navigazioni SPA non è detto.
    // Invalidare qui è la differenza fra "riparte dal backend" e "riparte da
    // ciò che era vero per il figlio precedente".
    invalidaFigliCache();
    // Ricarico così ogni hook/identità rilegge il nuovo figlio.
    window.location.reload();
  };

  return (
    <div
      className="flex gap-2.5 overflow-x-auto px-5 pt-3 pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label={t('ariaSelezionaFiglio')}
    >
      {figli.map((f) => {
        const on = f.id === studentId;
        return (
          /*
            ⚠️ I COLORI NON STANNO PIÙ NELLO `style` INLINE (2026-08-08).
            Erano scritti a mano — `background:'#006A5F'`, `color:'#FDC400'` —
            e uno stile inline batte qualunque foglio di stile senza
            `!important`: né la rete di `globals.css` sulla coppia di brand né
            il rimappaggio dell'Alto Contrasto potevano raggiungerli. Misurato
            dal collaudo (axe-core, impact «serious», 8 nodi): 4,05:1 su testo
            14px/bold e 10,5px/normal, e in Alto Contrasto lo stesso identico
            valore — l'unico elemento della schermata che non partecipava
            affatto al ribaltamento. Ed è l'unico posto che dice DI QUALE
            bambino si sta comunicando l'assenza.
            Coi token: `bg-kidville-green` + `text-kidville-yellow-ink`
            (#FFDA5C su #006A5F = 4,78:1). Padding e ombra restano inline —
            non sono colori e nessuna rete li deve raggiungere.
            Lock: `__tests__/a11y/contrasto-skip-link-e-selettore-figlio.test.tsx`.
          */
          <button
            key={f.id}
            type="button"
            onClick={() => onSelect(f.id)}
            role="tab"
            aria-selected={on}
            // Il nome della sede sta nell'etichetta accessibile di OGNI chip,
            // non solo di quello aperto: i chip chiusi mostrano due iniziali, e
            // due fratelli hanno lo stesso cognome. Chi naviga a voce, senza
            // questo, sceglie fra due bottoni che si chiamano uguale.
            aria-label={
              mostraSede && f.scuola_nome ? `${f.nome} ${f.cognome} — ${f.scuola_nome}` : undefined
            }
            className={`flex flex-shrink-0 items-center gap-2.5 rounded-pill transition-all ${
              on ? 'bg-kidville-green' : 'bg-kidville-white'
            }`}
            style={{
              padding: on ? '6px 16px 6px 6px' : '6px',
              boxShadow: on ? '0 6px 16px -8px rgba(0,90,80,.5)' : '0 2px 8px -5px rgba(0,0,0,.18)',
            }}
          >
            <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-full bg-kidville-green font-barlow text-[14px] font-black text-kidville-yellow-ink">
              {initials(f.nome, f.cognome)}
            </span>
            {on && (
              <span className="text-left">
                <span className="block font-barlow text-sm font-extrabold uppercase leading-none tracking-wide text-white">
                  {f.nome}
                </span>
                {(f.classe_sezione || (mostraSede && f.scuola_nome)) && (
                  <span className="block font-maven text-[10.5px] font-semibold text-kidville-yellow-ink">
                    {[f.classe_sezione, mostraSede ? f.scuola_nome : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
