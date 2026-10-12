# Mensa: la segreteria aggiunge e annulla i pasti a qualunque ora — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dare alla segreteria (admin · coordinator · segreteria) i pulsanti «Aggiungi» e «Annulla» per i pasti
mensa, senza orario limite, nella settimana del bambino e nell'elenco del giorno del Report cucina.

**Architecture:** server invariato (le route già esentano lo staff dal cutoff). Due funzioni pure in
`src/lib/mensa/` (date della settimana; ruoli e non prenotati), una finestra di conferma su `Modal`, un
componente nuovo `SettimanaMensaStaff`, e `MensaReport` con una prop `gestionePrenotazioni` spenta di
default (cuoca e docenti invariati).

**Tech Stack:** Next.js (App Router, client components), next-intl (cataloghi `messages/{it,en}/adminMensa.json`),
vitest + @testing-library/react (jsdom; `next-intl` è simulato in `test/setup.ts` sui testi ITALIANI veri).

**Spec:** `docs/superpowers/specs/2026-10-12-mensa-segreteria-prenotazioni-design.md`

**Regole del repo che questo piano rispetta:** niente `console.*` (si usa `logClient`), niente `catch`
muti, niente `confirm()` nativo, niente `capitalize` CSS sulle date (si usa `conIniziale`), touch target
≥ 44px, `limit=${LIMITE_ELENCO_ALUNNI}` nelle chiamate all'elenco alunni, mai `t` dentro le dipendenze di un
effetto (il mock di `useTranslations` restituisce una funzione nuova a ogni render: l'effetto girerebbe
all'infinito).

---

## Mappa dei file

| File | Azione | Responsabilità |
|---|---|---|
| `src/lib/mensa/settimana.ts` | nuovo | aritmetica di date `AAAA-MM-GG` in UTC |
| `src/lib/mensa/gestione-staff.ts` | nuovo | ruoli che gestiscono la mensa; non prenotati per classe |
| `src/app/api/mensa/prenotazioni/route.ts` | 1 riga | `STAFF_FORZA` = `RUOLI_GESTIONE_MENSA` |
| `messages/it/adminMensa.json`, `messages/en/adminMensa.json` | modifica | testi nuovi, via i 4 del modulo «un giorno» |
| `src/components/features/admin/mensa/ConfermaAnnullaPasto.tsx` | nuovo | finestra di conferma |
| `src/components/features/admin/mensa/SettimanaMensaStaff.tsx` | nuovo | settimana del bambino con Aggiungi/Annulla |
| `src/components/features/admin/mensa/PrenotazioneSegreteria.tsx` | modifica | colonna destra = `SettimanaMensaStaff` |
| `src/components/features/admin/mensa/MensaReport.tsx` | modifica | `gestionePrenotazioni` |
| `src/app/(dashboard)/admin/mensa/page.tsx` | modifica | scheda «Prenotazioni», prop accesa dal ruolo |
| `src/app/(dashboard)/admin/mensa/cucina/page.tsx` | modifica | prop accesa dal ruolo |
| `__tests__/architecture/limite-elenco-alunni.test.ts` | modifica | `MensaReport.tsx` fra i CHIAMANTI |
| `PRD REGISTRO ELETTRONICO.md` | modifica | voce di changelog |

---

### Task 1: date della settimana (`settimana.ts`)

**Files:**
- Create: `src/lib/mensa/settimana.ts`
- Test: `__tests__/lib/mensa-settimana.test.ts`

- [ ] **Step 1: test che fallisce**

```ts
import { describe, it, expect } from 'vitest'
import { lunediDi, piuGiorni, giorniDellaSettimana } from '@/lib/mensa/settimana'

describe('settimana mensa — date AAAA-MM-GG senza fuso', () => {
  it('il lunedì di un lunedì è sé stesso', () => {
    expect(lunediDi('2026-10-12')).toBe('2026-10-12')
  })
  it('il lunedì di un mercoledì e di una domenica è il 12', () => {
    expect(lunediDi('2026-10-14')).toBe('2026-10-12')
    expect(lunediDi('2026-10-18')).toBe('2026-10-12')
  })
  it('regge la domenica del cambio d’ora (25/10/2026)', () => {
    expect(lunediDi('2026-10-25')).toBe('2026-10-19')
    expect(piuGiorni('2026-10-24', 2)).toBe('2026-10-26')
  })
  it('regge il cambio d’anno', () => {
    expect(lunediDi('2027-01-01')).toBe('2026-12-28')
    expect(giorniDellaSettimana('2026-12-28')).toEqual([
      '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03',
    ])
  })
  it('piuGiorni va anche indietro', () => {
    expect(piuGiorni('2026-10-12', -7)).toBe('2026-10-05')
  })
})
```

- [ ] **Step 2:** `npx vitest run __tests__/lib/mensa-settimana.test.ts` → FAIL (modulo inesistente).

- [ ] **Step 3: implementazione**

```ts
/**
 * Le date della settimana mensa, come stringhe `AAAA-MM-GG`.
 *
 * Si calcola in UTC su mezzogiorno, mai su `Date` locali: il calendario del genitore
 * parte da una mezzanotte LOCALE e la stampa con `toISOString()`, che in Italia la
 * riporta al giorno prima. Qui il giorno resta il giorno, qualunque fuso abbia il
 * browser e in qualunque settimana cada il cambio d'ora. Il punto di partenza è
 * `oggiRoma()` di `@/lib/mensa/cutoff`.
 */

function aData(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`)
}

/** `ymd` spostato di `n` giorni (anche negativi). */
export function piuGiorni(ymd: string, n: number): string {
  const d = aData(ymd)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Il lunedì della settimana di `ymd` (la domenica appartiene alla settimana che finisce). */
export function lunediDi(ymd: string): string {
  const giorno = aData(ymd).getUTCDay() // 0 = domenica
  return piuGiorni(ymd, giorno === 0 ? -6 : 1 - giorno)
}

/** I sette giorni da `lunedi` a domenica. */
export function giorniDellaSettimana(lunedi: string): string[] {
  return Array.from({ length: 7 }, (_, i) => piuGiorni(lunedi, i))
}
```

- [ ] **Step 4:** stesso comando → PASS (5 test).
- [ ] **Step 5:** `git add src/lib/mensa/settimana.ts __tests__/lib/mensa-settimana.test.ts && git commit -m "Mensa: date della settimana in AAAA-MM-GG, senza fuso"`

---

### Task 2: ruoli e non prenotati (`gestione-staff.ts`) + la route li importa

**Files:**
- Create: `src/lib/mensa/gestione-staff.ts`
- Modify: `src/app/api/mensa/prenotazioni/route.ts:4,18-22`
- Test: `__tests__/lib/mensa-gestione-staff.test.ts`

- [ ] **Step 1: test che fallisce**

```ts
import { describe, it, expect } from 'vitest'
import { RUOLI_GESTIONE_MENSA, gestisceMensa, nonPrenotatiPerClasse } from '@/lib/mensa/gestione-staff'

describe('chi gestisce le prenotazioni mensa', () => {
  it('sono admin, coordinator e segreteria — gli stessi che la route esenta dal cutoff', () => {
    expect([...RUOLI_GESTIONE_MENSA]).toEqual(['admin', 'coordinator', 'segreteria'])
  })
  it('cuoca, docente, genitore e ruolo sconosciuto no', () => {
    for (const r of ['cuoca', 'educator', 'genitore', '', null, undefined]) expect(gestisceMensa(r)).toBe(false)
    for (const r of ['admin', 'coordinator', 'segreteria']) expect(gestisceMensa(r)).toBe(true)
  })
})

describe('nonPrenotatiPerClasse', () => {
  const iscritti = [
    { id: 'a1', nome: 'Bimbo', cognome: 'Uno', classe_sezione: 'Girasoli' },
    { id: 'a2', nome: 'Bimba', cognome: 'Due', classe_sezione: 'Girasoli' },
    { id: 'a3', nome: 'Anna', cognome: 'Tre', classe_sezione: 'Girasoli' },
    { id: 'a4', nome: 'Bimbo', cognome: 'Quattro', classe_sezione: 'Tulipani' },
    { id: 'a5', nome: 'Senza', cognome: 'Classe', classe_sezione: null },
  ]
  it('esclude i prenotati, raggruppa per classe e ordina per nome', () => {
    const m = nonPrenotatiPerClasse(iscritti, new Set(['a1']))
    expect(m.get('Girasoli')).toEqual([{ id: 'a3', nome: 'Anna Tre' }, { id: 'a2', nome: 'Bimba Due' }])
    expect(m.get('Tulipani')).toEqual([{ id: 'a4', nome: 'Bimbo Quattro' }])
  })
  it('chi non ha classe va in «—», come nel report', () => {
    expect(nonPrenotatiPerClasse(iscritti, new Set()).get('—')).toEqual([{ id: 'a5', nome: 'Senza Classe' }])
  })
  it('una classe tutta prenotata non compare', () => {
    expect(nonPrenotatiPerClasse(iscritti, new Set(['a4'])).has('Tulipani')).toBe(false)
  })
})
```

- [ ] **Step 2:** `npx vitest run __tests__/lib/mensa-gestione-staff.test.ts` → FAIL.

- [ ] **Step 3: implementazione**

```ts
import type { AppRole } from '@/lib/auth/predicati-ruolo'

/**
 * Chi gestisce le prenotazioni mensa di QUALUNQUE bambino della propria sede, a
 * qualunque ora e anche nei giorni passati (la telefonata del genitore dopo
 * l'orario limite). È la lista che `mensa/prenotazioni/route.ts` esenta dal cutoff
 * e dal blocco del saldo: vive qui perché un `route.ts` di Next non può esportare
 * altro che i metodi HTTP, e l'interfaccia deve mostrare i pulsanti agli STESSI
 * ruoli a cui il server poi dice sì.
 */
export const RUOLI_GESTIONE_MENSA: readonly AppRole[] = ['admin', 'coordinator', 'segreteria']

export function gestisceMensa(ruolo: string | null | undefined): boolean {
  return !!ruolo && (RUOLI_GESTIONE_MENSA as readonly string[]).includes(ruolo)
}

export interface IscrittoMensa { id: string; nome: string; cognome: string; classe_sezione?: string | null }
export interface NonPrenotato { id: string; nome: string }

/**
 * Gli iscritti NON prenotati, per classe e in ordine di nome. La classe si chiama
 * come nel Report cucina (`classe_sezione ?? '—'`), così le due liste si affiancano.
 */
export function nonPrenotatiPerClasse(
  iscritti: readonly IscrittoMensa[],
  prenotatiIds: ReadonlySet<string>,
): Map<string, NonPrenotato[]> {
  const perClasse = new Map<string, NonPrenotato[]>()
  for (const a of iscritti) {
    if (prenotatiIds.has(a.id)) continue
    const classe = a.classe_sezione ?? '—'
    const elenco = perClasse.get(classe) ?? []
    elenco.push({ id: a.id, nome: `${a.nome} ${a.cognome}`.trim() })
    perClasse.set(classe, elenco)
  }
  for (const elenco of perClasse.values()) elenco.sort((x, y) => x.nome.localeCompare(y.nome))
  return perClasse
}
```

Route (`src/app/api/mensa/prenotazioni/route.ts`): l'import diventa
`import { requireUser } from '@/lib/auth/require-staff'` più
`import { RUOLI_GESTIONE_MENSA } from '@/lib/mensa/gestione-staff'`, e la costante:

```ts
// Ruoli che possono FORZARE prenotazione/disdetta della mensa anche fuori orario
// (telefonate out-of-hours dei genitori dopo il cutoff), con saldo che può andare
// in negativo. La Segreteria è inclusa perché gestisce lo sportello (PRD §3:
// Segreteria↔Admin); dirigenza/FEA restano su liste esplicite altrove. La lista
// vive in `@/lib/mensa/gestione-staff`: l'interfaccia mostra i pulsanti agli stessi ruoli.
const STAFF_FORZA = RUOLI_GESTIONE_MENSA
```

- [ ] **Step 4:** `npx vitest run __tests__/lib/mensa-gestione-staff.test.ts __tests__/api/mensa-prenotazioni.test.ts` → PASS.
- [ ] **Step 5:** commit «Mensa: una lista sola dei ruoli che gestiscono le prenotazioni; non prenotati per classe».

---

### Task 3: testi (it/en)

**Files:** `messages/it/adminMensa.json`, `messages/en/adminMensa.json`

- [ ] **Step 1:** rinominare `tabInserisciTicket` in `tabPrenotazioni` («Prenotazioni» / «Bookings»); togliere
  `inserisciTicketGiornaliero`, `dataDelPasto`, `inserisciTicketScala`, `ticketInserito` (solo il modulo
  «un giorno» li usava — verificare con `grep -rn` prima di togliere). Aggiungere:

| chiave | it | en |
|---|---|---|
| `settimanaDelBambino` | Settimana del bambino | Child’s week |
| `settimanaPrecedente` | Settimana precedente | Previous week |
| `settimanaSuccessiva` | Settimana successiva | Next week |
| `tornaAOggi` | Oggi | Today |
| `pastoPrenotato` | Prenotato | Booked |
| `pastoNonPrenotato` | Non prenotato | Not booked |
| `inseritoSegreteria` | inserito dalla segreteria | added by the office |
| `mensaChiusaGiorno` | Mensa chiusa | Canteen closed |
| `menuNonPubblicato` | Menu non pubblicato | Menu not published |
| `nessunGiornoSettimana` | Nessun giorno di mensa in questa settimana. | No canteen days this week. |
| `notaSegreteriaSenzaOrario` | La segreteria non ha orario limite: può aggiungere e annullare anche oggi dopo l’orario e nei giorni passati. | The office has no cut-off time: it can add and cancel meals today after the cut-off and on past days. |
| `aggiungiPasto` | Aggiungi | Add |
| `annullaPasto` | Annulla | Cancel |
| `aggiungiPastoDel` | Aggiungi il pasto di {data} | Add the meal on {data} |
| `annullaPastoDel` | Annulla il pasto di {data} | Cancel the meal on {data} |
| `aggiungiPastoDi` | Aggiungi il pasto di {nome} | Add a meal for {nome} |
| `annullaPastoDi` | Annulla il pasto di {nome} | Cancel {nome}’s meal |
| `aggiungiUnBambino` | Aggiungi un bambino | Add a child |
| `nessunNonPrenotato` | Tutti gli iscritti di questa classe sono già prenotati. | Every enrolled child in this class is already booked. |
| `pastoAggiuntoIl` | Pasto aggiunto per {data}. Saldo ticket: {saldo}. | Meal added for {data}. Ticket balance: {saldo}. |
| `pastoAnnullatoIl` | Pasto di {data} annullato, ticket restituito. Saldo ticket: {saldo}. | Meal on {data} cancelled, ticket returned. Ticket balance: {saldo}. |
| `pastoAggiuntoPer` | Pasto aggiunto per {nome}. Saldo ticket: {saldo}. | Meal added for {nome}. Ticket balance: {saldo}. |
| `pastoAnnullatoPer` | Pasto di {nome} annullato, ticket restituito. Saldo ticket: {saldo}. | {nome}’s meal cancelled, ticket returned. Ticket balance: {saldo}. |
| `confermaAnnullaTitolo` | Annullare il pasto? | Cancel the meal? |
| `confermaAnnullaTesto` | Annullare il pasto di {nome} di {data}? Il ticket torna sul saldo. | Cancel {nome}’s meal on {data}? The ticket goes back to the balance. |
| `confermaAnnullaSi` | Annulla il pasto | Cancel the meal |
| `confermaAnnullaNo` | Lascia com’è | Keep it |
| `erroreReteMensa` | Connessione assente: riprova. | No connection: please try again. |

Apostrofi tipografici (’): l'apostrofo dritto è un carattere di escape in ICU.

- [ ] **Step 2:** `node -e "for (const l of ['it','en']) JSON.parse(require('fs').readFileSync('messages/'+l+'/adminMensa.json','utf8'))"` → nessun errore.
- [ ] **Step 3:** commit «Mensa: testi per aggiungere e annullare i pasti dalla segreteria».

---

### Task 4: finestra di conferma (`ConfermaAnnullaPasto`)

**Files:**
- Create: `src/components/features/admin/mensa/ConfermaAnnullaPasto.tsx`
- Test: `__tests__/components/ConfermaAnnullaPasto.test.tsx`

- [ ] **Step 1: test che fallisce**

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ConfermaAnnullaPasto } from '@/components/features/admin/mensa/ConfermaAnnullaPasto'

afterEach(cleanup)

describe('ConfermaAnnullaPasto', () => {
  it('chiusa non rende niente', () => {
    render(<ConfermaAnnullaPasto richiesta={null} onConferma={vi.fn()} onChiudi={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('aperta nomina bambino e giorno e dice che il ticket torna sul saldo', () => {
    render(<ConfermaAnnullaPasto richiesta={{ nome: 'Bimbo Uno', dataLeggibile: 'Lunedì 12 ottobre' }} onConferma={vi.fn()} onChiudi={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Annullare il pasto di Bimbo Uno di Lunedì 12 ottobre? Il ticket torna sul saldo.')).toBeTruthy()
  })
  it('«Annulla il pasto» conferma, «Lascia com’è» chiude soltanto', () => {
    const onConferma = vi.fn(); const onChiudi = vi.fn()
    render(<ConfermaAnnullaPasto richiesta={{ nome: 'Bimbo Uno', dataLeggibile: 'oggi' }} onConferma={onConferma} onChiudi={onChiudi} />)
    fireEvent.click(screen.getByRole('button', { name: 'Lascia com’è' }))
    expect(onChiudi).toHaveBeenCalledTimes(1); expect(onConferma).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Annulla il pasto' }))
    expect(onConferma).toHaveBeenCalledTimes(1)
  })
  it('i due pulsanti hanno un touch target ≥44px', () => {
    render(<ConfermaAnnullaPasto richiesta={{ nome: 'X', dataLeggibile: 'oggi' }} onConferma={vi.fn()} onChiudi={vi.fn()} />)
    for (const n of ['Lascia com’è', 'Annulla il pasto']) expect(screen.getByRole('button', { name: n }).className).toContain('min-h-[44px]')
  })
})
```

- [ ] **Step 2:** `npx vitest run __tests__/components/ConfermaAnnullaPasto.test.tsx` → FAIL.

- [ ] **Step 3: implementazione**

```tsx
'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';

interface Props {
  /** `null` = finestra chiusa. */
  richiesta: { nome: string; dataLeggibile: string } | null;
  /** La disdetta è partita: il pulsante di conferma si spegne. */
  inCorso?: boolean;
  onConferma: () => void;
  onChiudi: () => void;
}

/**
 * La conferma prima di annullare un pasto dalla segreteria (decisione del titolare,
 * 2026-10-12): annullare restituisce il ticket e toglie il bambino dal conteggio della
 * cucina, e in un elenco di venti nomi un tocco sbagliato è facile. In pagina, mai
 * `confirm()` nativo: nella WebView Capacitor su iOS può non tornare. Aggiungere non
 * chiede conferma: si rimedia con un «Annulla».
 */
export function ConfermaAnnullaPasto({ richiesta, inCorso = false, onConferma, onChiudi }: Props) {
  const t = useTranslations('adminMensa');
  const idTitolo = useId();
  return (
    <Modal open={richiesta !== null} onClose={onChiudi} title={t('confermaAnnullaTitolo')} labelledBy={idTitolo} className="w-full max-w-md">
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={idTitolo} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {t('confermaAnnullaTitolo')}
        </h2>
        {richiesta && (
          <p className="mt-2 font-maven text-sm text-kidville-ink">
            {t('confermaAnnullaTesto', { nome: richiesta.nome, data: richiesta.dataLeggibile })}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onChiudi}
            className="min-h-[44px] rounded-full border-2 border-kidville-line px-4 font-maven text-sm font-bold text-kidville-green">
            {t('confermaAnnullaNo')}
          </button>
          <button type="button" onClick={onConferma} disabled={inCorso}
            className="min-h-[44px] rounded-full bg-kidville-error-strong px-4 font-maven text-sm font-bold text-white disabled:opacity-50">
            {t('confermaAnnullaSi')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4:** stesso comando → PASS.
- [ ] **Step 5:** commit «Mensa: finestra di conferma prima di annullare un pasto».

---

### Task 5: settimana del bambino (`SettimanaMensaStaff`)

**Files:**
- Create: `src/components/features/admin/mensa/SettimanaMensaStaff.tsx`
- Test: `__tests__/components/SettimanaMensaStaff.test.tsx`

- [ ] **Step 1: test che fallisce**

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { SettimanaMensaStaff } from '@/components/features/admin/mensa/SettimanaMensaStaff'

// Mercoledì 14/10/2026, 12:00 a Roma: oltre l'orario limite (09:30) di OGGI, e con
// lunedì e martedì già passati. Per il genitore sarebbero tutti con il lucchetto.
const ADESSO = new Date('2026-10-14T10:00:00Z')
const ALUNNO = { id: 'a1', nome: 'Bimbo', cognome: 'Uno' }

const menu = [
  { data: '2026-10-12', attivo: true, chiuso: false, portate: { primo: 'Pasta' } },
  { data: '2026-10-13', attivo: true, chiuso: false, portate: null },
  { data: '2026-10-14', attivo: true, chiuso: false, portate: { primo: 'Riso' } },
  { data: '2026-10-15', attivo: false, chiuso: true, portate: null, note: 'Gita' },
]
let saldo = 0
let fetchMock: ReturnType<typeof vi.fn>

function json(body: unknown) { return Promise.resolve({ ok: true, json: () => Promise.resolve(body) }) }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ADESSO)
  saldo = 0
  fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const u = String(input); const metodo = init?.method ?? 'GET'
    if (u.startsWith('/api/mensa/menu')) return json({ success: true, data: menu })
    if (u.startsWith('/api/mensa/prenotazioni') && metodo === 'GET')
      return json({ success: true, data: { saldo, prenotazioni: [{ data: '2026-10-12', stato: 'prenotato', origine: 'genitore' }], cutoffOra: '09:30' } })
    if (metodo === 'POST') return json({ success: true, data: { saldo: -1, esiti: [{ data: '2026-10-14', ok: true }] } })
    if (metodo === 'DELETE') return json({ success: true, data: { saldo: 1 } })
    return json({ success: false })
  })
  global.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('SettimanaMensaStaff — la segreteria non ha orario limite', () => {
  it('chiede la settimana del bambino, da lunedì a domenica', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    await screen.findAllByRole('button', { name: /^Aggiungi il pasto di/ })
    const urls = fetchMock.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.startsWith('/api/mensa/menu') && u.includes('alunno_id=a1') && u.includes('from=2026-10-12') && u.includes('to=2026-10-18'))).toBe(true)
  })
  it('oggi oltre l’orario e un giorno passato hanno «Aggiungi» ATTIVO; il prenotato ha «Annulla» attivo', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    const aggiungi = await screen.findAllByRole('button', { name: /^Aggiungi il pasto di/ })
    expect(aggiungi).toHaveLength(2) // martedì 13 (passato) e mercoledì 14 (oggi, oltre le 09:30)
    for (const b of aggiungi) expect((b as HTMLButtonElement).disabled).toBe(false)
    const annulla = screen.getAllByRole('button', { name: /^Annulla il pasto di/ })
    expect(annulla).toHaveLength(1)
    expect((annulla[0] as HTMLButtonElement).disabled).toBe(false)
  })
  it('il giorno di mensa chiusa non ha pulsanti', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    await screen.findByText(/Mensa chiusa/)
    expect(screen.getAllByRole('button', { name: /il pasto di/ })).toHaveLength(3)
  })
  it('«Aggiungi» manda la POST del giorno giusto e mostra il nuovo saldo', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    const aggiungi = await screen.findAllByRole('button', { name: /^Aggiungi il pasto di/ })
    fireEvent.click(aggiungi[1])
    await waitFor(() => expect(fetchMock.mock.calls.some(c => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(true))
    const post = fetchMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'POST')!
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ alunno_id: 'a1', date: ['2026-10-14'] })
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('Saldo ticket: -1'))
  })
  it('«Annulla» chiede conferma: «Lascia com’è» non chiama niente, «Annulla il pasto» manda la DELETE', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Annulla il pasto di/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Lascia com’è' }))
    expect(fetchMock.mock.calls.some(c => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /^Annulla il pasto di/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Annulla il pasto' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(c => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(true))
    const del = fetchMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'DELETE')!
    expect(String(del[0])).toContain('alunno_id=a1')
    expect(String(del[0])).toContain('data=2026-10-12')
  })
  it('con saldo a zero avvisa che aggiungendo si va in negativo', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    expect(await screen.findByText(/il saldo andrà in negativo/)).toBeTruthy()
  })
  it('i pulsanti hanno un touch target ≥44px', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    for (const b of await screen.findAllByRole('button', { name: /il pasto di/ })) expect(b.className).toContain('min-h-[44px]')
  })
})
```

- [ ] **Step 2:** `npx vitest run __tests__/components/SettimanaMensaStaff.test.tsx` → FAIL.

- [ ] **Step 3: implementazione**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Ticket, Plus, X, CalendarOff, AlertTriangle, Info } from 'lucide-react';
import { useDateFormat, conIniziale } from '@/lib/i18n/date';
import { formattaIstante } from '@/i18n/config';
import { oggiRoma } from '@/lib/mensa/cutoff';
import { lunediDi, piuGiorni } from '@/lib/mensa/settimana';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { ConfermaAnnullaPasto } from './ConfermaAnnullaPasto';

interface Portate { primo?: string; secondo?: string; contorno?: string; frutta?: string }
interface MenuGiorno { data: string; attivo: boolean; chiuso: boolean; portate: Portate | null; note?: string | null }
interface Prenotazione { data: string; stato: string; origine: string }
interface Settimana { menu: MenuGiorno[]; pren: Record<string, Prenotazione>; saldo: number | null }
type Esito =
  | { tipo: 'aggiunto' | 'annullato'; data: string; saldo: number }
  | { tipo: 'rifiuto'; motivo?: string }
  | { tipo: 'rete' }
  | { tipo: 'caricamento' };

interface Props { userId: string; alunno: { id: string; nome: string; cognome: string } }

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const ROUTE = '/admin/mensa';

/**
 * Menu e prenotazioni di una settimana. Funzione di MODULO: l'effetto la chiama e
 * mette lo stato nei `.then`, mai in modo sincrono (react-hooks/set-state-in-effect).
 * `null` = il server ha detto no (sessione, sede): lo dice l'interfaccia.
 */
async function caricaSettimana(userId: string, alunnoId: string, from: string, to: string): Promise<Settimana | null> {
  const qs = `userId=${userId}&alunno_id=${alunnoId}&from=${from}&to=${to}`;
  const [m, p] = await Promise.all([
    fetch(`/api/mensa/menu?${qs}`, { headers: hdr(userId) }).then(r => r.json()),
    fetch(`/api/mensa/prenotazioni?${qs}`, { headers: hdr(userId) }).then(r => r.json()),
  ]);
  if (!p?.success) return null;
  const pren: Record<string, Prenotazione> = {};
  for (const x of (p.data?.prenotazioni ?? []) as Prenotazione[]) pren[x.data] = x;
  return { menu: m?.success ? (m.data as MenuGiorno[]) : [], pren, saldo: p.data?.saldo ?? null };
}

/**
 * La settimana mensa di UN bambino, vista dalla segreteria: per ogni giorno aperto
 * «Aggiungi» o «Annulla», sempre attivi — anche oggi dopo l'orario limite e nei
 * giorni passati. Il server lo permette ai ruoli di `RUOLI_GESTIONE_MENSA` dal
 * primo giorno; mancava solo il pulsante (2026-10-12).
 */
export function SettimanaMensaStaff({ userId, alunno }: Props) {
  const t = useTranslations('adminMensa');
  const f = useDateFormat();
  const [lunedi, setLunedi] = useState(() => lunediDi(oggiRoma()));
  const [dati, setDati] = useState<Settimana | null>(null);
  const [caricando, setCaricando] = useState(true);
  const [versione, setVersione] = useState(0);
  const [esito, setEsito] = useState<Esito | null>(null);
  const [inVolo, setInVolo] = useState<string | null>(null);
  const [daAnnullare, setDaAnnullare] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    caricaSettimana(userId, alunno.id, lunedi, piuGiorni(lunedi, 6))
      .then(d => {
        if (!vivo) return;
        setDati(d);
        if (!d) setEsito({ tipo: 'caricamento' });
      })
      .catch(err => {
        logClient({ livello: 'warn', evento: 'fetch', messaggio: `mensa-staff-settimana-non-caricata: ${nomeErrore(err)}`, route: ROUTE });
        if (vivo) setEsito({ tipo: 'rete' });
      })
      .finally(() => { if (vivo) setCaricando(false); });
    return () => { vivo = false; };
  }, [userId, alunno.id, lunedi, versione]);

  const giornoLeggibile = (data: string) =>
    conIniziale(formattaIstante(`${data}T12:00:00Z`, f.locale, { weekday: 'long', day: 'numeric', month: 'long' }));

  const aggiungi = async (data: string) => {
    setInVolo(data); setEsito(null);
    try {
      const res = await fetch('/api/mensa/prenotazioni', {
        method: 'POST', headers: hdr(userId),
        body: JSON.stringify({ alunno_id: alunno.id, date: [data] }),
      });
      const j = await res.json();
      const delGiorno = j?.data?.esiti?.[0];
      if (j?.success && delGiorno?.ok) setEsito({ tipo: 'aggiunto', data, saldo: Number(j.data.saldo) });
      else setEsito({ tipo: 'rifiuto', motivo: delGiorno?.motivo ?? j?.error });
    } catch (err) {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `mensa-staff-aggiungi-fallita: ${nomeErrore(err)}`, route: ROUTE });
      setEsito({ tipo: 'rete' });
    } finally {
      setInVolo(null);
      setVersione(v => v + 1);
    }
  };

  const annulla = async (data: string) => {
    setDaAnnullare(null); setInVolo(data); setEsito(null);
    try {
      const res = await fetch(`/api/mensa/prenotazioni?userId=${userId}&alunno_id=${alunno.id}&data=${data}`, {
        method: 'DELETE', headers: hdr(userId),
      });
      const j = await res.json();
      if (j?.success) setEsito({ tipo: 'annullato', data, saldo: Number(j.data.saldo) });
      else setEsito({ tipo: 'rifiuto', motivo: j?.error });
    } catch (err) {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `mensa-staff-annulla-fallita: ${nomeErrore(err)}`, route: ROUTE });
      setEsito({ tipo: 'rete' });
    } finally {
      setInVolo(null);
      setVersione(v => v + 1);
    }
  };

  const testoEsito = (() => {
    if (!esito) return null;
    switch (esito.tipo) {
      case 'aggiunto': return t('pastoAggiuntoIl', { data: giornoLeggibile(esito.data), saldo: esito.saldo });
      case 'annullato': return t('pastoAnnullatoIl', { data: giornoLeggibile(esito.data), saldo: esito.saldo });
      case 'rifiuto': return esito.motivo ?? t('operazioneNonRiuscita');
      case 'rete': return t('erroreReteMensa');
      case 'caricamento': return t('errore');
    }
  })();

  const saldo = dati?.saldo ?? null;
  const oggi = oggiRoma();
  const giorni = (dati?.menu ?? []).filter(g => g.attivo || g.chiuso);
  const navCls = 'flex h-11 w-11 items-center justify-center rounded-full border-2 border-kidville-line bg-white text-kidville-green';

  return (
    <div className="bg-kidville-cream/60 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <span className="font-maven text-sm text-kidville-green font-bold">{alunno.nome} {alunno.cognome}</span>
        <span className="font-maven text-sm text-kidville-muted flex items-center gap-1">
          <Ticket size={13} /> {t('saldoLabel')}{' '}
          <b className={saldo != null && saldo < 0 ? 'text-kidville-error' : 'text-kidville-green'}>{saldo ?? '—'}</b>
        </span>
      </div>

      <div className="flex items-center gap-1 mb-3">
        <button type="button" onClick={() => setLunedi(piuGiorni(lunedi, -7))} aria-label={t('settimanaPrecedente')} className={navCls}>
          <ChevronLeft size={16} />
        </button>
        <span className="flex-1 text-center font-maven text-xs text-kidville-muted">
          {f.giornoMese(`${lunedi}T12:00:00Z`)} – {f.giornoMese(`${piuGiorni(lunedi, 6)}T12:00:00Z`)}
        </span>
        <button type="button" onClick={() => setLunedi(piuGiorni(lunedi, 7))} aria-label={t('settimanaSuccessiva')} className={navCls}>
          <ChevronRight size={16} />
        </button>
        <button type="button" onClick={() => setLunedi(lunediDi(oggiRoma()))}
          className="min-h-[44px] rounded-full border-2 border-kidville-line bg-white px-3 font-maven text-xs font-bold text-kidville-green">
          {t('tornaAOggi')}
        </button>
      </div>

      <p className="mb-2 font-maven text-[11px] text-kidville-muted flex items-start gap-1">
        <Info size={12} className="mt-0.5 flex-shrink-0" /> {t('notaSegreteriaSenzaOrario')}
      </p>
      {saldo != null && saldo <= 0 && (
        <p className="mb-2 font-maven text-[11px] text-kidville-warn-strong flex items-start gap-1">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" /> {t('notaForzaInserimento')}
        </p>
      )}
      {testoEsito && (
        <p role="status" aria-live="polite" className="mb-2 font-maven text-xs text-kidville-green">{testoEsito}</p>
      )}

      {caricando ? (
        <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>
      ) : giorni.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted">{t('nessunGiornoSettimana')}</p>
      ) : (
        <ul className="space-y-2">
          {giorni.map(g => {
            const p = dati?.pren[g.data];
            const prenotato = p?.stato === 'prenotato';
            const giorno = giornoLeggibile(g.data);
            const portate = g.portate ? [g.portate.primo, g.portate.secondo, g.portate.contorno, g.portate.frutta].filter(Boolean).join(' · ') : '';
            return (
              <li key={g.data} className={`rounded-xl border p-3 ${prenotato ? 'bg-kidville-success-soft/70 border-kidville-success/30' : 'bg-white border-kidville-line'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-maven text-sm font-bold text-kidville-green">
                      {giorno}{g.data === oggi ? ` · ${t('tornaAOggi')}` : ''}
                    </p>
                    {g.chiuso ? (
                      <p className="font-maven text-xs text-kidville-muted flex items-center gap-1">
                        <CalendarOff size={13} /> {t('mensaChiusaGiorno')}{g.note ? ` · ${g.note}` : ''}
                      </p>
                    ) : (
                      <>
                        <p className="font-maven text-[12px] text-kidville-sub">{portate || t('menuNonPubblicato')}</p>
                        <p className="font-maven text-[11px] text-kidville-muted">
                          {prenotato ? t('pastoPrenotato') : t('pastoNonPrenotato')}
                          {prenotato && p?.origine === 'segreteria' ? ` · ${t('inseritoSegreteria')}` : ''}
                        </p>
                      </>
                    )}
                  </div>
                  {!g.chiuso && (prenotato ? (
                    <button type="button" disabled={inVolo === g.data} onClick={() => setDaAnnullare(g.data)}
                      aria-label={t('annullaPastoDel', { data: giorno })}
                      className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border-2 border-kidville-error/40 bg-white px-3 font-maven text-xs font-bold text-kidville-error-strong disabled:opacity-50">
                      <X size={13} /> {t('annullaPasto')}
                    </button>
                  ) : (
                    <button type="button" disabled={inVolo === g.data} onClick={() => aggiungi(g.data)}
                      aria-label={t('aggiungiPastoDel', { data: giorno })}
                      className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full bg-kidville-green px-3 font-maven text-xs font-bold text-white disabled:opacity-50">
                      <Plus size={13} /> {t('aggiungiPasto')}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfermaAnnullaPasto
        richiesta={daAnnullare ? { nome: `${alunno.nome} ${alunno.cognome}`, dataLeggibile: giornoLeggibile(daAnnullare) } : null}
        inCorso={inVolo !== null}
        onConferma={() => { if (daAnnullare) void annulla(daAnnullare); }}
        onChiudi={() => setDaAnnullare(null)}
      />
    </div>
  );
}
```

- [ ] **Step 4:** stesso comando → PASS (7 test). Se un test sulla POST trova `status` vuoto, la causa è il
  ricaricamento: l'esito si scrive PRIMA di `setVersione`, e il caricamento non lo azzera (azzerarlo è solo
  di `caricaSettimana` quando il server dice no).
- [ ] **Step 5:** commit «Mensa: settimana del bambino per la segreteria, con Aggiungi e Annulla a qualunque ora».

---

### Task 6: la scheda «Prenotazioni» usa la settimana

**Files:**
- Modify: `src/components/features/admin/mensa/PrenotazioneSegreteria.tsx` (intero file, 101 righe)
- Modify: `src/app/(dashboard)/admin/mensa/page.tsx:62` (`tabInserisciTicket` → `tabPrenotazioni`)
- Test: `__tests__/features/admin/prenotazione-segreteria-design.test.tsx` (aggiunta)

- [ ] **Step 1: test che fallisce** — in coda al `describe` esistente:

```tsx
  it('scelto un bambino, mostra la sua settimana (menu chiesto per quel bambino)', async () => {
    render(<PrenotazioneSegreteria userId="u1" scuolaId="s1" />);
    (await screen.findByRole('button', { name: /Bimbo Uno/ })).click();
    await screen.findByText('Settimana del bambino');
    await vi.waitFor(() =>
      expect((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(c => String(c[0]).startsWith('/api/mensa/menu') && String(c[0]).includes('alunno_id=a1'))).toBe(true),
    );
  });
```

- [ ] **Step 2:** `npx vitest run __tests__/features/admin/prenotazione-segreteria-design.test.tsx` → FAIL.

- [ ] **Step 3:** il componente diventa (ricerca invariata, colonna destra nuova; via `saldo`, `data`, `msg`,
  `loadSaldo`, `inserisci`, `useDateFormat`):

```tsx
'use client';

import { LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione';
import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Search, CalendarRange } from 'lucide-react';
import { SettimanaMensaStaff } from './SettimanaMensaStaff';

interface Props { userId: string; scuolaId: string }
interface Alunno { id: string; nome: string; cognome: string; classe_sezione?: string }

export function PrenotazioneSegreteria({ userId, scuolaId }: Props) {
  const t = useTranslations('adminMensa');
  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<Alunno | null>(null);

  useEffect(() => {
    // (commento esistente su `stato=iscritto` invariato)
    fetch(`/api/admin/students?stato=iscritto&scuola_id=${scuolaId}&limit=${LIMITE_ELENCO_ALUNNI}`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setAlunni(d.map((a: Alunno) => ({ id: a.id, nome: a.nome, cognome: a.cognome, classe_sezione: a.classe_sezione }))); });
  }, [scuolaId]);

  const filtered = alunni.filter(a => `${a.nome} ${a.cognome}`.toLowerCase().includes(search.toLowerCase())).slice(0, 8);

  return (
    <div className="grid md:grid-cols-2 gap-5">
      {/* colonna sinistra: identica a oggi, con onClick={() => setSel(a)} */}
      <div>
        <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-3 flex items-center gap-2"><CalendarRange size={14} /> {t('settimanaDelBambino')}</h3>
        {!sel ? <p className="font-maven text-sm text-kidville-muted">{t('selezionaUnAlunno')}</p>
          : <SettimanaMensaStaff key={sel.id} userId={userId} alunno={sel} />}
      </div>
    </div>
  );
}
```

`key={sel.id}`: cambiando bambino la settimana riparte da zero (niente saldo o esito del bambino prima).

- [ ] **Step 4:** stesso comando → PASS; `grep -rn "tabInserisciTicket" src` → nessun risultato.
- [ ] **Step 5:** commit «Mensa: la scheda Prenotazioni mostra la settimana del bambino al posto del modulo a un giorno».

---

### Task 7: pulsanti nel Report cucina (`MensaReport`)

**Files:**
- Modify: `src/components/features/admin/mensa/MensaReport.tsx`
- Modify: `__tests__/architecture/limite-elenco-alunni.test.ts` (CHIAMANTI += `MensaReport.tsx`)
- Test: `__tests__/components/MensaReport-gestione-prenotazioni.test.tsx`

- [ ] **Step 1: test che fallisce**

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { MensaReport } from '@/components/features/admin/mensa/MensaReport'

const report = {
  data: '2026-10-14', totale: 1,
  perClasse: [{ classe: 'Girasoli', conteggio: 1, alunni: [{ id: 'a1', nome: 'Bimbo Uno', classe: 'Girasoli', allergeni: [], conflitti: [] }] }],
  allergie: [], alternative_automatiche: [],
}
const iscritti = [
  { id: 'a1', nome: 'Bimbo', cognome: 'Uno', classe_sezione: 'Girasoli' },
  { id: 'a2', nome: 'Bimba', cognome: 'Due', classe_sezione: 'Girasoli' },
  { id: 'a3', nome: 'Bimbo', cognome: 'Tre', classe_sezione: 'Tulipani' },
]
let fetchMock: ReturnType<typeof vi.fn>
const json = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) })
const chiamate = (metodo: string) => fetchMock.mock.calls.filter(c => ((c[1] as RequestInit | undefined)?.method ?? 'GET') === metodo)

beforeEach(() => {
  fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const u = String(input); const metodo = init?.method ?? 'GET'
    if (u.startsWith('/api/mensa/report')) return json({ success: true, data: report })
    if (u.startsWith('/api/mensa/alternative')) return json({ success: true, data: { alternative: [] } })
    if (u.startsWith('/api/admin/students')) return json(iscritti)
    if (u.startsWith('/api/mensa/prenotazioni') && metodo === 'POST') return json({ success: true, data: { saldo: 3, esiti: [{ data: '2026-10-14', ok: true }] } })
    if (u.startsWith('/api/mensa/prenotazioni') && metodo === 'DELETE') return json({ success: true, data: { saldo: 5 } })
    return json({ success: false })
  })
  global.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const card = (classe: string) => screen.getByText(classe, { selector: 'span' }).closest('.kv-admin-rowcard') as HTMLElement

describe('MensaReport — la segreteria aggiunge e annulla dall’elenco del giorno', () => {
  it('senza gestionePrenotazioni (cuoca, docenti) nessun pulsante e nessuna chiamata agli iscritti', async () => {
    render(<MensaReport userId="cuoca-1" scuolaId="s1" />)
    await screen.findByText('Bimbo Uno')
    expect(screen.queryByRole('button', { name: /il pasto di/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Aggiungi un bambino' })).toBeNull()
    expect(fetchMock.mock.calls.some(c => String(c[0]).startsWith('/api/admin/students'))).toBe(false)
  })
  it('chiede solo gli iscritti, con il tetto condiviso', async () => {
    render(<MensaReport userId="seg-1" scuolaId="s1" gestionePrenotazioni />)
    await screen.findByText('Tulipani')
    const u = fetchMock.mock.calls.map(c => String(c[0])).find(x => x.startsWith('/api/admin/students'))!
    expect(u).toContain('stato=iscritto'); expect(u).toContain('scuola_id=s1'); expect(u).toMatch(/limit=\d+/)
  })
  it('compare anche la classe senza prenotati', async () => {
    render(<MensaReport userId="seg-1" scuolaId="s1" gestionePrenotazioni />)
    expect(await screen.findByText('Tulipani')).toBeTruthy()
  })
  it('«Annulla» chiede conferma e poi manda la DELETE del bambino e del giorno', async () => {
    render(<MensaReport userId="seg-1" scuolaId="s1" gestionePrenotazioni />)
    fireEvent.click(await screen.findByRole('button', { name: 'Annulla il pasto di Bimbo Uno' }))
    expect(chiamate('DELETE')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Annulla il pasto' }))
    await waitFor(() => expect(chiamate('DELETE')).toHaveLength(1))
    expect(String(chiamate('DELETE')[0][0])).toMatch(/alunno_id=a1&data=\d{4}-\d{2}-\d{2}/)
  })
  it('«Aggiungi un bambino» elenca solo i non prenotati della classe; «Aggiungi» manda la POST', async () => {
    render(<MensaReport userId="seg-1" scuolaId="s1" gestionePrenotazioni />)
    await screen.findByText('Tulipani')
    const girasoli = card('Girasoli')
    fireEvent.click(within(girasoli).getByRole('button', { name: 'Aggiungi un bambino' }))
    expect(within(girasoli).getByText('Bimba Due')).toBeTruthy()
    expect(within(girasoli).queryByRole('button', { name: 'Aggiungi il pasto di Bimbo Uno' })).toBeNull()
    fireEvent.click(within(girasoli).getByRole('button', { name: 'Aggiungi il pasto di Bimba Due' }))
    await waitFor(() => expect(chiamate('POST')).toHaveLength(1))
    const body = JSON.parse(String((chiamate('POST')[0][1] as RequestInit).body))
    expect(body.alunno_id).toBe('a2'); expect(body.date).toHaveLength(1)
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('Bimba Due'))
  })
  it('i pulsanti nuovi hanno un touch target ≥44px', async () => {
    render(<MensaReport userId="seg-1" scuolaId="s1" gestionePrenotazioni />)
    const annulla = await screen.findByRole('button', { name: 'Annulla il pasto di Bimbo Uno' })
    expect(annulla.className).toMatch(/h-11|min-h-\[44px\]/)
    for (const b of screen.getAllByRole('button', { name: 'Aggiungi un bambino' })) expect(b.className).toContain('min-h-[44px]')
  })
})
```

- [ ] **Step 2:** `npx vitest run __tests__/components/MensaReport-gestione-prenotazioni.test.tsx` → FAIL.

- [ ] **Step 3: implementazione** in `MensaReport.tsx`:

  1. Import: `LIMITE_ELENCO_ALUNNI` da `@/lib/api/paginazione`; `X` da `lucide-react`; `logClient, nomeErrore` da
     `@/lib/logging/client`; `nonPrenotatiPerClasse, type IscrittoMensa` da `@/lib/mensa/gestione-staff`;
     `ConfermaAnnullaPasto` da `./ConfermaAnnullaPasto`.
  2. Prop: `gestionePrenotazioni?: boolean` con commento «admin/coordinator/segreteria: Aggiungi e Annulla
     a qualunque ora; cuoca e docenti no». Default `false`.
  3. Stato:

```tsx
  // Gestione prenotazioni (solo con `gestionePrenotazioni`).
  const [iscritti, setIscritti] = useState<IscrittoMensa[]>([]);
  const [classiAperte, setClassiAperte] = useState<ReadonlySet<string>>(() => new Set());
  const [inVolo, setInVolo] = useState<string | null>(null);
  const [daAnnullare, setDaAnnullare] = useState<{ id: string; nome: string } | null>(null);
  const [esitoPren, setEsitoPren] = useState<string | null>(null);
```

  4. Effetto degli iscritti (dopo i due `useEffect` esistenti):

```tsx
  // Gli iscritti servono solo a chi può AGGIUNGERE: la cuoca e le docenti non li chiedono.
  useEffect(() => {
    if (!gestionePrenotazioni) return;
    let vivo = true;
    fetch(`/api/admin/students?stato=iscritto${scuolaId ? `&scuola_id=${encodeURIComponent(scuolaId)}` : ''}&limit=${LIMITE_ELENCO_ALUNNI}`, { headers: hdr(userId) })
      .then(r => r.json())
      .then(d => { if (vivo && Array.isArray(d)) setIscritti(d as IscrittoMensa[]); })
      .catch(err => logClient({ livello: 'warn', evento: 'fetch', messaggio: `mensa-report-iscritti-non-caricati: ${nomeErrore(err)}`, route: '/admin/mensa' }));
    return () => { vivo = false; };
  }, [gestionePrenotazioni, scuolaId, userId]);
```

  5. Azioni (dopo `elimina`):

```tsx
  const ricarica = async () => { await Promise.all([load(), loadAlternative()]); };

  const aggiungiPasto = async (alunnoId: string, nome: string) => {
    setInVolo(alunnoId); setEsitoPren(null);
    try {
      const res = await fetch('/api/mensa/prenotazioni', {
        method: 'POST', headers: hdr(userId), body: JSON.stringify({ alunno_id: alunnoId, date: [data] }),
      });
      const j = await res.json();
      const delGiorno = j?.data?.esiti?.[0];
      setEsitoPren(j?.success && delGiorno?.ok
        ? t('pastoAggiuntoPer', { nome, saldo: Number(j.data.saldo) })
        : (delGiorno?.motivo ?? j?.error ?? t('operazioneNonRiuscita')));
    } catch (err) {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `mensa-report-aggiungi-fallita: ${nomeErrore(err)}`, route: '/admin/mensa' });
      setEsitoPren(t('erroreReteMensa'));
    } finally {
      setInVolo(null);
      await ricarica();
    }
  };

  const annullaPasto = async (alunnoId: string, nome: string) => {
    setDaAnnullare(null); setInVolo(alunnoId); setEsitoPren(null);
    try {
      const res = await fetch(`/api/mensa/prenotazioni?userId=${userId}&alunno_id=${alunnoId}&data=${data}`, { method: 'DELETE', headers: hdr(userId) });
      const j = await res.json();
      setEsitoPren(j?.success ? t('pastoAnnullatoPer', { nome, saldo: Number(j.data.saldo) }) : (j?.error ?? t('operazioneNonRiuscita')));
    } catch (err) {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `mensa-report-annulla-fallita: ${nomeErrore(err)}`, route: '/admin/mensa' });
      setEsitoPren(t('erroreReteMensa'));
    } finally {
      setInVolo(null);
      await ricarica();
    }
  };

  const alternaClasse = (classe: string) => setClassiAperte(prev => {
    const s = new Set(prev); if (s.has(classe)) s.delete(classe); else s.add(classe); return s;
  });
```

  6. Classi da mostrare (accanto a `tuttiAlunni`):

```tsx
  const sezAttiva = sezione ?? filtroSezione;
  const nonPrenotati = gestionePrenotazioni
    ? nonPrenotatiPerClasse(iscritti.filter(a => !sezAttiva || a.classe_sezione === sezAttiva), new Set(tuttiAlunni.map(a => a.id)))
    : new Map<string, { id: string; nome: string }[]>();
  // Con la gestione accesa compaiono anche le classi senza prenotati: senza, a una classe
  // vuota non si potrebbe aggiungere nessuno.
  const classi = [...(report?.perClasse ?? [])];
  for (const classe of nonPrenotati.keys()) if (!classi.some(c => c.classe === classe)) classi.push({ classe, conteggio: 0, alunni: [] });
  classi.sort((x, y) => x.classe.localeCompare(y.classe));
```

  7. Render: sopra il blocco «Prenotati per sezione» la riga
     `{esitoPren && <p role="status" aria-live="polite" className="font-maven text-xs text-kidville-green">{esitoPren}</p>}`;
     `report.perClasse.length === 0` → `classi.length === 0`, `report.perClasse.map` → `classi.map`; nella riga
     dell'alunno, dentro il `div.flex` dopo il gruppo allergeni:

```tsx
                              {gestionePrenotazioni && (
                                <button type="button" disabled={inVolo === a.id}
                                  onClick={() => setDaAnnullare({ id: a.id, nome: a.nome })}
                                  aria-label={t('annullaPastoDi', { nome: a.nome })}
                                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-kidville-error hover:opacity-70 disabled:opacity-40">
                                  <X size={16} />
                                </button>
                              )}
```

     e in fondo alla card, dopo `</ul>`:

```tsx
                    {gestionePrenotazioni && (
                      <div className="border-t border-kidville-cream px-3 py-1">
                        <button type="button" aria-expanded={classiAperte.has(c.classe)} onClick={() => alternaClasse(c.classe)}
                          className="inline-flex min-h-[44px] items-center gap-1.5 font-maven text-xs font-bold text-kidville-green">
                          <Plus size={14} /> {t('aggiungiUnBambino')}
                        </button>
                        {classiAperte.has(c.classe) && ((nonPrenotati.get(c.classe) ?? []).length === 0 ? (
                          <p className="pb-2 font-maven text-[11px] text-kidville-muted">{t('nessunNonPrenotato')}</p>
                        ) : (
                          <ul className="pb-1">
                            {(nonPrenotati.get(c.classe) ?? []).map(n => (
                              <li key={n.id} className="flex min-h-[44px] items-center justify-between gap-2">
                                <span className="font-maven text-sm text-kidville-ink">{n.nome}</span>
                                <button type="button" disabled={inVolo === n.id} onClick={() => aggiungiPasto(n.id, n.nome)}
                                  aria-label={t('aggiungiPastoDi', { nome: n.nome })}
                                  className="inline-flex min-h-[44px] items-center gap-1 rounded-full bg-kidville-green px-3 font-maven text-xs font-bold text-white disabled:opacity-50">
                                  <Plus size={13} /> {t('aggiungiPasto')}
                                </button>
                              </li>
                            ))}
                          </ul>
                        ))}
                      </div>
                    )}
```

     e prima della `</div>` di chiusura del componente:

```tsx
      {gestionePrenotazioni && (
        <ConfermaAnnullaPasto
          richiesta={daAnnullare ? { nome: daAnnullare.nome, dataLeggibile: f.giornoMese(`${data}T12:00:00Z`) } : null}
          inCorso={inVolo !== null}
          onConferma={() => { if (daAnnullare) void annullaPasto(daAnnullare.id, daAnnullare.nome); }}
          onChiudi={() => setDaAnnullare(null)}
        />
      )}
```

  8. `__tests__/architecture/limite-elenco-alunni.test.ts`: aggiungere
     `'src/components/features/admin/mensa/MensaReport.tsx',` a `CHIAMANTI` e aggiornare il commento
     «I dieci punti…» con il numero contato (`grep -c "^  'src/" ` sul blocco).

- [ ] **Step 4:** `npx vitest run __tests__/components/MensaReport-gestione-prenotazioni.test.tsx __tests__/features/admin/mensa-report-design.test.tsx __tests__/components/MensaReport-sede-scrittura.test.tsx __tests__/architecture/limite-elenco-alunni.test.ts` → PASS.
- [ ] **Step 5:** commit «Mensa: Annulla e Aggiungi un bambino nel Report cucina, solo per la segreteria».

---

### Task 8: le due pagine accendono la gestione dal ruolo

**Files:**
- Modify: `src/app/(dashboard)/admin/mensa/page.tsx` (riga 20 e 71)
- Modify: `src/app/(dashboard)/admin/mensa/cucina/page.tsx` (riga 21 e 93)

- [ ] **Step 1:** in entrambe `const { userId, role } = useSessionIdentity();`, import
  `import { gestisceMensa } from '@/lib/mensa/gestione-staff';`, e su `MensaReport`
  `gestionePrenotazioni={gestisceMensa(role)}`. In `page.tsx` la scheda:
  `{ id: 'prenota', label: t('tabPrenotazioni'), icon: CalendarPlus }`.
- [ ] **Step 2:** `npx tsc --noEmit -p . 2>&1 | tail -5` → nessun errore.
- [ ] **Step 3:** commit «Mensa: Report cucina con i pulsanti per admin, coordinatrice e segreteria».

---

### Task 9: PRD

- [ ] **Step 1:** in testa a `PRD REGISTRO ELETTRONICO.md`, prima della prima voce, una voce
  `## 🍽️ Changelog — Mensa: la segreteria aggiunge e annulla i pasti a qualunque ora, dalla settimana del bambino e dal Report cucina — 2026-10-12 (branch \`feat/mensa-segreteria-prenotazioni\`)`
  con: il problema misurato (server già pronto, interfaccia assente, 61 disdette tutte di genitori), le due
  schermate, la conferma su Annulla, cosa NON cambia (route, schema, schermata del genitore), i test.
- [ ] **Step 2:** commit «PRD: changelog mensa segreteria».

---

### Task 10: gate e PR

- [ ] `npx eslint . --max-warnings 0 2>&1 | tail -20` → 0 problemi
- [ ] `npx tsc --noEmit -p . 2>&1 | tail -5` → 0 errori
- [ ] `npx vitest run 2>&1 | tail -15` → tutti verdi
- [ ] `npm run build 2>&1 | tail -15` → ok
- [ ] push del branch, PR verso `main`, lettura della CI (E2E compreso) con gli strumenti `ccd_pr`.
