'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { CalendarDays, ChartColumn, Clock, ContactRound, PhoneCall } from 'lucide-react'
import { Tabs, type TabOption } from '@/components/ui/cockpit'
import { ColonnaDettaglio } from '@/components/ui/ColonnaDettaglio'
import { schedaDaParametro, tabDaParametro, type TabCrm } from '@/lib/crm/tab'
import { AgendaSettimana } from './agenda/AgendaSettimana'
import { DisponibilitaPersona } from './disponibilita/DisponibilitaPersona'
import { DaRichiamare } from './follow-up/DaRichiamare'
import { DettaglioScheda } from './schede/DettaglioScheda'
import { ElencoSchede } from './schede/ElencoSchede'
import { StatisticheCrm } from './statistiche/StatisticheCrm'

/**
 * CRM DELLA SEGRETERIA · LA CORNICE: cinque schede e un pannello di dettaglio.
 *
 * ── LE CINQUE SCHEDE ───────────────────────────────────────────────────────────
 * `?tab=` sceglie quella aperta; senza `tab`, o con un valore che non è una delle cinque, si apre
 * l'agenda. Un indirizzo inventato non deve mai dare una pagina vuota: `tabDaParametro`
 * (`src/lib/crm/tab.ts`) ripiega sempre su una scheda che esiste.
 *
 * ── LA SEDE ARRIVA DI FUORI ────────────────────────────────────────────────────
 * `scuolaId` lo decide la pagina (`SedeRequired`): l'admin con più sedi ne sceglie una, la segreteria
 * ha la sua. Qui non si indovina niente — AGENTS.md: ogni lettura di plesso dichiara la sua sede — e
 * ogni schermata riceve lo STESSO `scuolaId`.
 *
 * ── IL PANNELLO DI DETTAGLIO ───────────────────────────────────────────────────
 * Aprire una famiglia (dall'elenco, dall'agenda o dai richiami) la mostra nello stesso posto: la
 * colonna ferma accanto alla lista sul computer, un foglio sopra di essa sul telefono
 * (`ColonnaDettaglio`, la stessa delle candidature). Nella scheda «Schede» la colonna c'è sempre,
 * con un invito a scegliere; nelle altre compare solo quando se ne apre una.
 *
 * ⚠️ Il contenuto della scheda sta nello STESSO punto dell'albero con o senza colonna: aprire una
 * famiglia dall'agenda non deve rimontare l'agenda (si perderebbe la settimana che si stava guardando).
 * Per questo il contenitore è sempre lo stesso `<div>` e cambia solo la sua griglia.
 *
 * ⚠️ Cambiare scheda chiude il dettaglio: una famiglia aperta dalla lista dei richiami, rimasta lì
 * accanto all'agenda, direbbe di appartenere a un elenco che non si sta più guardando.
 *
 * ── L'INDIRIZZO ─────────────────────────────────────────────────────────────────
 * La verità è lo stato di React, e l'indirizzo la insegue con `history.replaceState` (la scelta di
 * `useFiltri`, e il modo in cui Next sincronizza `useSearchParams`). Se l'indirizzo cambia da fuori — un
 * collegamento a `/admin/crm?tab=richiamare` cliccato mentre si è già sulla pagina — lo stato lo segue
 * (vedi `parametroVisto`). Passando da una scheda all'altra si tolgono gli altri parametri: i filtri
 * dell'elenco, su un'agenda, sarebbero rumore.
 *
 * ── `?scheda=<uuid>`: IL COLLEGAMENTO CHE APRE UNA FAMIGLIA ─────────────────────
 * `/admin/crm?scheda=<id>` (lo mette la lista «Quote dal CRM» della contabilità) apre quella famiglia nel
 * pannello di dettaglio della scheda «Schede», anche se `?tab=` dice altro: il collegamento è fatto per
 * arrivare lì. Si legge UNA volta, al montaggio (stato iniziale, non effetto): da quel momento la verità è lo
 * stato, e chiudere il pannello non lo fa riaprire al render dopo. Un valore che non è un uuid si ignora
 * (`schedaDaParametro`). Se il collegamento è cliccato mentre si è GIÀ sulla pagina non si riapre da solo:
 * `parametroVisto` guarda `?tab=`, e il caso — arrivare da un'altra pagina — è sempre un montaggio nuovo.
 * Cambiando scheda l'indirizzo viene riscritto con il solo `?tab=` (`scriviTab`), e `scheda` se ne va.
 */

function scriviTab(tab: TabCrm): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  const dopo = new URLSearchParams({ tab })
  url.search = dopo.toString()
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

export function CrmShell({ scuolaId }: { scuolaId: string }) {
  const t = useTranslations('crmShell')
  const ricerca = useSearchParams()
  const parametro = ricerca.get('tab')

  // `?scheda=` si legge una volta, nello stato iniziale: una famiglia indicata dall'indirizzo apre le Schede.
  const [schedaIndicata] = useState(() => schedaDaParametro(ricerca.get('scheda')))
  const [tab, setTab] = useState<TabCrm>(() => (schedaIndicata !== null ? 'schede' : tabDaParametro(parametro)))
  // L'indirizzo è cambiato da fuori: lo stato lo segue. Si confronta durante il render (e non in un
  // effetto) perché è il modo documentato di adattare lo stato a una prop che cambia.
  const [parametroVisto, setParametroVisto] = useState(parametro)
  const [schedaAperta, setSchedaAperta] = useState<string | null>(schedaIndicata)
  if (parametro !== parametroVisto) {
    setParametroVisto(parametro)
    setTab(tabDaParametro(parametro))
    setSchedaAperta(null)
  }

  const scegli = (id: string) => {
    const nuova = tabDaParametro(id)
    if (nuova === tab) return
    setTab(nuova)
    setSchedaAperta(null)
    scriviTab(nuova)
  }
  const apri = (schedaId: string) => setSchedaAperta(schedaId)
  const chiudi = () => setSchedaAperta(null)

  const opzioni: TabOption[] = [
    { id: 'agenda', label: t('tabAgenda'), icon: CalendarDays },
    { id: 'richiamare', label: t('tabRichiamare'), icon: PhoneCall },
    { id: 'schede', label: t('tabSchede'), icon: ContactRound },
    { id: 'disponibilita', label: t('tabDisponibilita'), icon: Clock },
    { id: 'statistiche', label: t('tabStatistiche'), icon: ChartColumn },
  ]

  // Le statistiche e la disponibilità non aprono famiglie: nessun pannello laterale, mai.
  const conDettaglio = tab === 'agenda' || tab === 'richiamare' || tab === 'schede'
  const colonnaVisibile = conDettaglio && (tab === 'schede' || schedaAperta !== null)

  return (
    <>
      <Tabs value={tab} options={opzioni} onChange={scegli} />

      <div className={colonnaVisibile ? 'grid gap-5 lg:grid-cols-2 lg:items-start' : undefined}>
        <div className="min-w-0">
          {tab === 'agenda' && <AgendaSettimana scuolaId={scuolaId} onApriScheda={apri} />}
          {tab === 'richiamare' && <DaRichiamare scuolaId={scuolaId} onApriScheda={apri} />}
          {tab === 'schede' && <ElencoSchede scuolaId={scuolaId} onApri={apri} />}
          {tab === 'disponibilita' && <DisponibilitaPersona scuolaId={scuolaId} />}
          {tab === 'statistiche' && <StatisticheCrm scuolaId={scuolaId} />}
        </div>

        {colonnaVisibile && (
          <ColonnaDettaglio
            aperto={schedaAperta !== null}
            onChiudi={chiudi}
            titolo={t('dettaglioTitolo')}
            occupato={false}
            chiaveContenuto={schedaAperta}
            segnaposto={
              <div className="rounded-card border border-kidville-line bg-kidville-white p-10 text-center font-maven text-kidville-sub">
                {t('selezionaScheda')}
              </div>
            }
          >
            {schedaAperta !== null && <DettaglioScheda key={schedaAperta} schedaId={schedaAperta} onChiudi={chiudi} />}
          </ColonnaDettaglio>
        )}
      </div>
    </>
  )
}
