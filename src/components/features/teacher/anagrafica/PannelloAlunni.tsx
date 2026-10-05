'use client'

import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { BarraFiltri, testiBarraFiltri } from '@/components/ui/BarraFiltri'
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco'
import { Badge } from '@/components/ui/Badge'
import { decidiStatoElenco } from '@/lib/ui/filtri/motore'
import { useFiltri } from '@/lib/ui/filtri/use-filtri'
import { useAllergeneLabel } from '@/lib/mensa/allergeni'
import { isoToIt } from '@/lib/format/data'
import { salvaRitornoElenco } from '@/lib/anagrafiche/docente/ritorno-elenco'
import type { ElencoAlunniRisposta, SezioneElenco, VoceElencoAlunno } from '@/lib/anagrafiche/docente/tipi'
import { campiAlunni } from './filtri-alunni'

interface Gruppo {
  chiave: string
  nome: string
  alunni: VoceElencoAlunno[]
}

/** I bambini (già filtrati) per sezione, nell'ordine delle sezioni; chi non ne ha va in fondo. */
function raggruppa(alunni: readonly VoceElencoAlunno[], sezioni: readonly SezioneElenco[], senzaSezione: string): Gruppo[] {
  const perSezione = new Map<string, VoceElencoAlunno[]>()
  const orfani: VoceElencoAlunno[] = []
  const note = new Set(sezioni.map((s) => s.id))
  for (const a of alunni) {
    if (a.sectionId && note.has(a.sectionId)) perSezione.set(a.sectionId, [...(perSezione.get(a.sectionId) ?? []), a])
    else orfani.push(a)
  }
  const gruppi = sezioni.flatMap((s) => {
    const membri = perSezione.get(s.id)
    return membri ? [{ chiave: s.id, nome: s.nome, alunni: membri }] : []
  })
  if (orfani.length > 0) gruppi.push({ chiave: 'senza-sezione', nome: senzaSezione, alunni: orfani })
  return gruppi
}

/**
 * Barra filtri + elenco. Si monta SOLO a dati arrivati: le opzioni dei filtri
 * nascono dai dati, e `useFiltri` legge l'indirizzo una volta sola.
 */
export function PannelloAlunni({ dati }: { dati: ElencoAlunniRisposta }) {
  const t = useTranslations('teacherServizi')
  const ts = useTranslations('shared')
  const etichettaAllergene = useAllergeneLabel()
  const campi = campiAlunni(t, { sezioni: dati.sezioni, alunni: dati.alunni, etichettaAllergene })
  const stato = useFiltri<VoceElencoAlunno>(campi)

  const visibili = stato.filtra(dati.alunni)
  const schermata = decidiStatoElenco({
    caricamento: false,
    errore: false,
    totale: dati.alunni.length,
    mostrati: visibili.length,
  })
  const gruppi = raggruppa(visibili, dati.sezioni, t('anagraficaSenzaSezione'))
  const testiStato = {
    ...testiStatoElenco(ts),
    vuotoTitolo: t('anagraficaVuotoTitolo'),
    vuotoCorpo: t('anagraficaVuotoCorpo'),
  }

  // Zero bambini: la barra non avrebbe niente da filtrare, e un «0 risultati su 0»
  // sopra il messaggio direbbe che il problema sono i filtri. Resta solo il passo da fare.
  if (schermata === 'vuoto') return <StatoElenco stato="vuoto" testi={testiStato} />

  return (
    <div className="space-y-4">
      <BarraFiltri
        campi={campi}
        stato={stato}
        testi={testiBarraFiltri(ts)}
        totale={dati.alunni.length}
        mostrati={visibili.length}
        variante="compatta"
      />

      <StatoElenco stato={schermata} testi={testiStato} attivi={stato.attivi} onPulisci={stato.pulisci} />

      {gruppi.map((g) => (
        <section key={g.chiave} aria-labelledby={`sezione-${g.chiave}`} className="space-y-2">
          <h2 id={`sezione-${g.chiave}`} className="flex items-baseline justify-between px-1 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green">
            <span>{g.nome}</span>
            <span className="font-maven text-xs font-semibold normal-case tracking-normal text-kidville-sub">
              {t('anagraficaConteggioSezione', { n: g.alunni.length })}
            </span>
          </h2>
          <ul className="divide-y divide-kidville-line overflow-hidden rounded-card border border-kidville-line bg-kidville-white">
            {g.alunni.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/teacher/alunni/${a.id}`}
                  // Niente prefetch: l'elenco della Direzione supera le 700 righe, e ogni riga
                  // visibile ne chiederebbe uno. In questo repo il volume di richieste è già
                  // costato caro; la scheda si carica al tocco, e i suoi dati arrivano comunque
                  // dall'API, mai dal prefetch.
                  prefetch={false}
                  // I filtri attuali (mai la ricerca per nome) per il pulsante di ritorno.
                  onClick={() => salvaRitornoElenco(window.location.search)}
                  // L'`<ul>` ha `overflow-hidden` (gli angoli tondi) e taglierebbe l'anello di
                  // fuoco globale, che sta FUORI dal link: con un bambino solo non si vedrebbe
                  // affatto (WCAG 2.4.7). Lo si porta dentro. Il `!` serve: la regola
                  // `:focus-visible` di `globals.css` vive fuori dai layer e batte qualunque
                  // utility Tailwind senza `!important` (misurato in Chromium: senza, resta 2px).
                  className="flex min-h-[56px] items-center gap-3 px-4 py-3 transition-colors hover:bg-kidville-cream focus-visible:outline-offset-[-3px]!"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-barlow text-sm font-extrabold uppercase text-kidville-green">
                      {a.cognome} {a.nome}
                    </p>
                    {a.dataNascita && <p className="font-maven text-xs text-kidville-sub">{isoToIt(a.dataNascita)}</p>}
                  </div>
                  {a.haAllergie && <Badge tone="error">{t('anagraficaBadgeAllergie')}</Badge>}
                  <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-kidville-sub" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
