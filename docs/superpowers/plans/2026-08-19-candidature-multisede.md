# «Lavora con noi»: marchio, sede al plurale, copia al plesso — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** il modulo pubblico `/lavora-con-noi` porta il marchio, accetta la candidatura su più sedi insieme, e recapita a ogni sede scelta una copia completa del modulo con il curriculum allegato.

**Architecture:** tre blocchi che si rilasciano in quest'ordine e ognuno dei quali funziona da solo. **A** — il logo entra in `PublicPageHeader`, cioè in un posto solo, e appare sulle cinque superfici pubbliche. **B** — `sendEmailDetailed` impara ad allegare, nasce il generatore della copia (che itera il template dei campi invece di ribatterne l'elenco) e la route pubblica spedisce alla sede: a sede singola funziona subito. **C** — la tabella `candidature_sedi` con lo `stato` di `candidature_insegnanti` mantenuto per trigger, e la copia alla sede diventa un ciclo su più plessi.

**Tech Stack:** Next.js App Router · TypeScript · Supabase (PostgREST + Storage) · Resend · zod · react-hook-form · next-intl · Vitest + Testing Library

**Spec:** [`docs/superpowers/specs/2026-08-19-candidature-multisede-design.md`](../specs/2026-08-19-candidature-multisede-design.md)

---

## Cose da sapere prima di cominciare

**Lingua.** Codice, commenti, messaggi di commit e testi a schermo: **italiano**. È la regola di `AGENTS.md`, non una preferenza di stile.

**Il vocabolario.** `candidature_sedi` NON si chiama «tabella figlia» in nessun commento. Si dice **«le righe di sede»**. In questo repo esistono `alunni`, `parents`, `student_parents`: «i figli» sono bambini veri, e la parola ha già prodotto un fraintendimento durante la stesura della spec.

**Il logging non è un extra.** Ogni ramo nuovo logga, **successo compreso**. Mai `console.*` in `src/` (`no-console` è attivo). Mai dati personali nei log: `redact()` è a lista bianca e non la si allarga. PostgREST **non lancia**: si controlla sempre il valore di ritorno `{ error }`, un `try/catch` attorno a `await supabase.from(…)` non scatta mai.

**Il DB E2E della CI non è migrato.** Il codice nuovo deve degradare pulito: `42P01`/`PGRST205` = tabella assente, `PGRST204` su INSERT/UPDATE, `42703` su SELECT. Il cockpit ha già l'infrastruttura (`TABELLA_ASSENTE`, `COLONNA_ASSENTE`, `conResilienza`).

**In produzione ci sono dati reali di minori.** `npm run e2e` e `npm run e2e:seed` in locale sono **vietati**: `.env.local` punta al DB di produzione e il seed ci scriverebbe dentro. L'E2E si verifica in CI. Sul database si fanno **solo `SELECT`** finché non si applica la migrazione, e la migrazione si mostra prima di applicarla.

**Il gate, prima di dire «fatto»:**

```bash
npx eslint . --max-warnings 0
npx tsc --noEmit
npx vitest run
npm run build
```

---

## Struttura dei file

### Si creano

| File | Responsabilità |
|---|---|
| `src/lib/email/messaggi/candidatura-alla-sede.ts` | genera la copia completa iterando `INSEGNANTE_FIELDS` + `CONSENSI_INSEGNANTI_FIELDS` |
| `src/lib/candidature/copia-alla-sede.ts` | orchestra un invio: risolve il destinatario, scarica il CV, spedisce, logga |
| `supabase/migrations/20260819HHMMSS_candidature_sedi.sql` | tabella `candidature_sedi`, FK, trigger di aggregazione, backfill |
| `__tests__/lib/email/candidatura-alla-sede.test.ts` | il generatore non perde campi |
| `__tests__/lib/candidature/copia-alla-sede.test.ts` | destinatario, ripiego, allegato, log |
| `__tests__/components/PublicPageHeader-logo.test.tsx` | il marchio c'è, ha l'`alt`, non è un link |
| `__tests__/api/candidature-insegnanti-multisede.test.ts` | `scuole_ids`, righe di sede, degrado |

### Si modificano

| File | Cosa cambia |
|---|---|
| `src/components/ui/PublicPageHeader.tsx` | il logo entra nel gruppo di destra |
| `src/lib/email/send.ts:39-49,103,128-133` | `attachments` e `replyTo` |
| `src/app/api/iscrizione/insegnanti/route.ts:202-203,787-815,1174-1212` | `scuole_ids`, righe di sede, copia alla sede |
| `src/app/api/admin/candidature-insegnanti/route.ts:288-296,455-546,556-604` | filtro di sede dalle righe di sede, PATCH per sede |
| `src/components/features/public/wizard/use-sedi-pubbliche.ts` | modalità multipla, additiva |
| `src/components/features/public/CandidaturaInsegnanteWizard.tsx:1535-1685,918,960` | checkbox, riepilogo, `scuole_ids` |
| `src/components/features/admin/iscrizioni/CandidatureInsegnanti.tsx` | le sedi scelte e il loro stato |
| `src/app/privacy/page.tsx:429-433` | la copia in casella non la cancella nessun cron |
| `messages/it/public.json`, `messages/en/public.json` | testi al plurale |
| `docs/env.md` | `CANDIDATURE_EMAIL_FALLBACK` |
| `__tests__/architecture/isolamento-sede-coverage.test.ts` | le query nuove, dichiarate |
| `PRD REGISTRO ELETTRONICO.md` | changelog datato |

### Non si toccano

`AnagraficaPersonaleWizard.tsx` e il suo uso a sede singola · `src/app/api/gdpr/retention-candidature/route.ts` · gli indici `candidature_insegnanti_email_viva` e `candidature_insegnanti_cv_unico` · `admin/pratiche-personale:PATCH` · `public/logo_green.png`.

---

# FASE A — Il marchio

## Task 1: Il logo verde nella riga di testa pubblica

**Files:**
- Modify: `src/components/ui/PublicPageHeader.tsx`
- Test: `__tests__/components/PublicPageHeader-logo.test.tsx` (create)

L'asset è **`public/logo-kidville.png`**, 2227×571, già il wordmark verde ritagliato in uso su `/auth/login:758`. Non se ne produce uno nuovo e **non** si usa `public/logo_green.png`: è lo stesso logo in 6000×3375 con il marchio confinato nel terzo centrale, e reso a 28 px di altezza il wordmark ne misurerebbe nove.

- [ ] **Step 1: Scrivere il test che fallisce**

`PublicPageHeader` è un componente **server** `async`: nel test si attende la sua chiamata e si rende il JSX risultante.

```tsx
// __tests__/components/PublicPageHeader-logo.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PublicPageHeader } from '@/components/ui/PublicPageHeader'

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (k: string) => k,
  getLocale: async () => 'it',
}))
vi.mock('@/components/ui/PublicContrastButton', () => ({
  PublicContrastButton: () => <button type="button">Alto contrasto</button>,
}))

describe('PublicPageHeader · il marchio', () => {
  it('rende il wordmark verde, con il nome leggibile da chi ascolta', async () => {
    render(await PublicPageHeader({}))
    const logo = screen.getByAltText('Kidville')
    // `next/image` riscrive il `src` in un URL ottimizzato: si cerca il NOME del
    // file dentro l'attributo, non l'uguaglianza — altrimenti il test misura
    // l'ottimizzatore invece del componente.
    expect(logo.getAttribute('src')).toContain('logo-kidville')
  })

  it('NON è un link: la riga di testa ha una sola via d’uscita', async () => {
    render(await PublicPageHeader({}))
    // Un solo link in tutta la testata, ed è il ritorno.
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByAltText('Kidville').closest('a')).toBeNull()
  })

  it('il marchio è l’ULTIMO elemento della riga: «in alto a destra» vuol dire al bordo', async () => {
    const { container } = render(await PublicPageHeader({}))
    const riga = container.firstElementChild as HTMLElement
    const destra = riga.lastElementChild as HTMLElement
    expect(destra.lastElementChild?.querySelector('img')).toBe(screen.getByAltText('Kidville'))
  })

  it('NON usa logo_green.png, che è lo stesso marchio in un file con il 90% di bianco intorno', async () => {
    render(await PublicPageHeader({}))
    expect(screen.getByAltText('Kidville').getAttribute('src')).not.toContain('logo_green')
  })
})
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

```bash
npx vitest run __tests__/components/PublicPageHeader-logo.test.tsx
```

Atteso: **FAIL** — `Unable to find an element with the alt text: Kidville`.

- [ ] **Step 3: Implementare**

In `src/components/ui/PublicPageHeader.tsx`, aggiungere l'import di `next/image` in testa:

```tsx
import Image from 'next/image'
```

e sostituire il gruppo di destra:

```tsx
      <div className="flex flex-wrap items-center gap-2">
        <PublicContrastButton />
        {children}
      </div>
```

con:

```tsx
      <div className="flex flex-wrap items-center gap-2">
        <PublicContrastButton />
        {children}
        {/* ── IL MARCHIO, E PERCHÉ STA QUI E NON IN OGNI PAGINA ────────────────
            Stessa ragione del comando di Alto Contrasto e del link di ritorno:
            finché ogni pagina pubblica ridisegna la propria testata, la prossima
            nasce con la propria copia — che è come sono nate le tre che
            divergevano. Questo è il terzo pezzo che entra nel componente unico.

            ⚠️ L'ASSET È `logo-kidville.png`, NON `logo_green.png`.
            Sono lo stesso wordmark verde, ma il secondo è 6000×3375 con il
            marchio confinato nel terzo centrale e il resto bianco: reso a 28 px
            di altezza, il wordmark ne misurerebbe nove. `logo-kidville.png` è
            2227×571, ritagliato, ed è già quello del login (`auth/login/page.tsx`).

            ⚠️ NON È UN LINK. La riga di testa ha una sola via d'uscita — il
            ritorno a sinistra — ed è ciò che la rende leggibile. Un secondo
            bersaglio cliccabile accanto, che porterebbe altrove, gliela toglie.

            ── LE DUE MISURE ────────────────────────────────────────────────────
            `h-6 sm:h-7` (24/28 px) e non un'altezza sola: MISURATO a 360 px, la
            riga porta già «Torna indietro» (111 px) e «Alto contrasto» (148×46).
            Un logo alto 28 px ne misura 109 di larghezza, e 111+148+109+gap non
            stanno in 360: la riga è `flex-wrap`, quindi non si rompe — va a capo,
            e la testata cresce in altezza SOPRA OGNI PAGINA PUBBLICA. A 24 px il
            wordmark ne misura 93 e la riga regge.

            `dark:` non c'entra: qui la modalità è Alto Contrasto, e la si governa
            con la classe sul documento (vedi `globals.css`). Il rapporto del
            verde su quel fondo va MISURATO sulla pagina viva prima di dichiarare
            questo passo finito — se non regge, sotto quella classe il sorgente
            passa a `logo-light.png`. */}
        <Image
          src="/logo-kidville.png"
          alt="Kidville"
          width={2227}
          height={571}
          priority={false}
          className="h-6 w-auto sm:h-7"
        />
      </div>
```

- [ ] **Step 4: Eseguire il test e verificare che passi**

```bash
npx vitest run __tests__/components/PublicPageHeader-logo.test.tsx
```

Atteso: **PASS**, 4 test.

- [ ] **Step 5: MISURARE sulla pagina viva — non dedurre**

Avviare il server locale. ⚠️ La `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` è sbagliata e nessun login passa; per le pagine **pubbliche** non serve, ma se serve un login:

```bash
K=$(supabase projects api-keys --project-ref uimulkjyekgemjakmepp --experimental -o json \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).find(r=>r.name==='service_role').api_key))")
SUPABASE_SERVICE_ROLE_KEY="$K" npx next dev --port 3100
```

Aprire `http://localhost:3100/lavora-con-noi` a **360 px** di larghezza e misurare, nella console del browser:

```js
const riga = document.querySelector('main > div, body div:has(> a[href="/"])')
console.log('altezza testata:', riga.getBoundingClientRect().height)
```

**Criterio di accettazione:** l'altezza **non aumenta** rispetto a prima della modifica (misurarla anche con `git stash`, per avere il numero di riferimento). Se aumenta, scendere a `h-5 sm:h-6` e rimisurare.

Poi attivare **Alto contrasto** e misurare il contrasto del verde sul fondo:

```js
const img = document.querySelector('img[alt="Kidville"]')
console.log(getComputedStyle(img.parentElement).backgroundColor)
```

Se il fondo è scuro, sostituire il sorgente sotto quella classe con `/logo-light.png`. Annotare **i numeri misurati** nel commento del componente: un commento che dice «misurato» senza il numero non è una misura.

- [ ] **Step 6: Verificare che non si sia rotto nulla nelle altre quattro pagine**

```bash
npx vitest run __tests__/components __tests__/architecture
npx eslint src/components/ui/PublicPageHeader.tsx --max-warnings 0
```

Atteso: tutto verde. Il logo appare anche su `/iscrizione`, `/privacy`, `/termini`, `/assistenza`: è voluto.

- [ ] **Step 7: Commit**

```bash
git add src/components/ui/PublicPageHeader.tsx __tests__/components/PublicPageHeader-logo.test.tsx
git commit -m "Il marchio entra nella riga di testa pubblica, e ci entra una volta sola"
```

---

# FASE B — La copia alla sede

## Task 2: `sendEmailDetailed` impara ad allegare

**Files:**
- Modify: `src/lib/email/send.ts:39-49` (i parametri), `:103` (la firma), `:128-133` (il corpo)
- Test: `__tests__/lib/email/send-allegati.test.ts` (create)

- [ ] **Step 1: Scrivere il test che fallisce**

```ts
// __tests__/lib/email/send-allegati.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const externalFetch = vi.fn()
vi.mock('@/lib/logging/external', () => ({ externalFetch: (...a: unknown[]) => externalFetch(...a) }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logOk: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/redact', () => ({ hashCorrelabile: () => 'hash' }))

import { sendEmailDetailed } from '@/lib/email/send'

/** Il corpo JSON che `sendEmailDetailed` ha passato a `externalFetch`. */
function corpoInviato(): Record<string, unknown> {
  return JSON.parse(externalFetch.mock.calls[0][2].body as string)
}

describe('sendEmailDetailed · allegati e reply-to', () => {
  beforeEach(() => {
    externalFetch.mockReset()
    externalFetch.mockResolvedValue({ ok: true, stato: 200, corpo: '{}', res: { json: async () => ({ id: 'msg_1' }) } })
    process.env.RESEND_API_KEY = 'chiave-di-prova'
  })
  afterEach(() => { delete process.env.RESEND_API_KEY })

  it('inoltra gli allegati a Resend nella forma che Resend si aspetta', async () => {
    await sendEmailDetailed({
      to: 'giugliano@kidville.it',
      subject: 'oggetto',
      text: 'corpo',
      attachments: [{ filename: 'curriculum-rossi-maria.pdf', content: 'JVBERi0=', contentType: 'application/pdf' }],
    })
    expect(corpoInviato().attachments).toEqual([
      { filename: 'curriculum-rossi-maria.pdf', content: 'JVBERi0=', content_type: 'application/pdf' },
    ])
  })

  it('inoltra reply_to, così la sede risponde a chi si è candidato', async () => {
    await sendEmailDetailed({ to: 'a@b.it', subject: 'o', text: 't', replyTo: 'maria.rossi@email.com' })
    expect(corpoInviato().reply_to).toBe('maria.rossi@email.com')
  })

  it('senza allegati e senza reply-to il corpo è IDENTICO a prima: nessuna chiave in più', async () => {
    await sendEmailDetailed({ to: 'a@b.it', subject: 'o', text: 't' })
    expect(Object.keys(corpoInviato()).sort()).toEqual(['from', 'subject', 'text', 'to'])
  })

  it('un elenco di allegati VUOTO non aggiunge la chiave: [] e «niente» non si distinguono per Resend', async () => {
    await sendEmailDetailed({ to: 'a@b.it', subject: 'o', text: 't', attachments: [] })
    expect(corpoInviato()).not.toHaveProperty('attachments')
  })
})
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

```bash
npx vitest run __tests__/lib/email/send-allegati.test.ts
```

Atteso: **FAIL** — il primo test riceve `undefined` (TypeScript segnalerà anche che `attachments` non esiste su `SendEmailParams`).

- [ ] **Step 3: Implementare**

In `src/lib/email/send.ts`, dentro `SendEmailParams` (dopo `html?: string`, riga ~48):

```ts
  /**
   * Allegati, additivo. Resend li vuole in **base64** dentro `content`, e chiama
   * `content_type` ciò che qui si chiama `contentType`: la traduzione avviene nel
   * corpo della richiesta, sotto, perché il resto dell'applicazione non deve
   * conoscere il vocabolario del provider.
   *
   * ⚠️ Il tetto di Resend è 40 MB per messaggio, e in base64 un file cresce di
   * circa un terzo. Chi allega un curriculum sta sotto i 4 MB — è il limite del
   * corpo di una funzione Vercel, non del bucket — quindi c'è margine; chi
   * allegasse altro faccia il conto prima, perché il rifiuto arriva dal provider
   * e non da qui.
   *
   * ⚠️ Il NOME dell'allegato è ciò che finisce nella casella di chi riceve. Non
   * ci si mette mai un percorso interno né un identificativo tecnico: `cv_path`,
   * per esempio, è la chiave di un gate e non ha motivo di comparire in una
   * casella di posta.
   */
  attachments?: { filename: string; content: string; contentType?: string }[]
  /**
   * A chi risponde chi riceve, quando è diverso dal mittente.
   *
   * Il mittente DEVE restare su `@mail.kidville.it` (Resend rifiuta con 403 tutto
   * il resto — è la scena del delitto descritta in testa a questo file), quindi
   * l'indirizzo di chi si è candidato non può essere il `from`. Senza `reply_to`
   * la sede dovrebbe ricopiarlo a mano dal corpo del messaggio, e chi ricopia un
   * indirizzo a mano prima o poi sbaglia una lettera.
   */
  replyTo?: string
```

Nella firma (riga ~103):

```ts
export async function sendEmailDetailed({ to, subject, text, html, attachments, replyTo }: SendEmailParams): Promise<SendEmailResult> {
```

E nel corpo della richiesta (riga ~128):

```ts
      body: JSON.stringify({
        from: process.env.OTP_FROM_EMAIL ?? DEFAULT_FROM,
        to,
        subject,
        text,
        ...(html ? { html } : {}),
        // Lo `?.length` e non solo la presenza: un elenco vuoto significa «non ho
        // allegati», e mandare `attachments: []` a Resend è dire una cosa diversa
        // da non dirla. Le due forme si equivalgono oggi, ma il contratto di un
        // provider esterno non è una cosa su cui si scommette.
        ...(attachments?.length
          ? {
              attachments: attachments.map((a) => ({
                filename: a.filename,
                content: a.content,
                ...(a.contentType ? { content_type: a.contentType } : {}),
              })),
            }
          : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
```

- [ ] **Step 4: Eseguire i test**

```bash
npx vitest run __tests__/lib/email/send-allegati.test.ts __tests__/lib/email
```

Atteso: **PASS**. I test esistenti (`generatori-email` — allora `dodici-generatori`, rinominato il 2026-09-01 perché il numero nel nome aveva smesso di essere vero —, `pie-di-pagina-senza-buchi`, `credenziali-la-sede-nel-corpo`, `layout-master`) restano verdi: le due chiavi sono additive e nessun chiamante le passa.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/send.ts __tests__/lib/email/send-allegati.test.ts
git commit -m "L'invio email impara ad allegare, e a dire a chi si risponde"
```

---

## Task 3: Il generatore della copia — si costruisce dal template, non a mano

**Files:**
- Create: `src/lib/email/messaggi/candidatura-alla-sede.ts`
- Test: `__tests__/lib/email/candidatura-alla-sede.test.ts` (create)
- Read first: `src/lib/email/messaggi/conferma-candidatura.ts` (il modello: `documento()`, `intestazioneTesto()`, `piedeTesto()`, `p()`, `esc()`, `h`)

Il punto di questo task è **uno solo**, e va capito prima di scrivere codice: l'elenco dei campi **non si ribatte**. Si itera `INSEGNANTE_FIELDS` e `CONSENSI_INSEGNANTI_FIELDS`, che già dichiarano `label`, `options` (con le etichette leggibili) e `condition`. Un elenco scritto a mano diverge al primo campo aggiunto al modulo, **e diverge in silenzio**: la sede riceve una copia «completa» a cui manca esattamente il campo nuovo, e nessun test è rosso.

- [ ] **Step 1: Scrivere il test che fallisce**

```ts
// __tests__/lib/email/candidatura-alla-sede.test.ts
import { describe, it, expect } from 'vitest'
import { messaggioCandidaturaAllaSede } from '@/lib/email/messaggi/candidatura-alla-sede'
import { contestoSenzaSede } from '@/lib/email/contesto'
import { INSEGNANTE_FIELDS } from '@/lib/forms/insegnanti-template'

const SEDE = { ...contestoSenzaSede('Kidville Giugliano'), email: 'giugliano@kidville.it' }

const DATI = {
  nome: 'Maria', cognome: 'Rossi', email: 'maria.rossi@email.com', telefono: '+39 333 1234567',
  residence_city: 'Giugliano in Campania', residence_province: 'NA',
  posizioni: ['insegnante_infanzia', 'cuoca'],
  titolo_studio: 'laurea_magistrale', titolo_dettaglio: 'Scienze della formazione',
  anni_esperienza: 3, disponibilita: 'tempo_pieno', note: 'Mi piacerebbe lavorare con voi.',
}

function messaggio() {
  return messaggioCandidaturaAllaSede({
    dati: DATI,
    consensi: { presa_visione_informativa: true, consenso_conservazione_candidatura: false },
    sediScelte: ['Kidville Giugliano', 'Kidville Aversa'],
    inviataIl: '19/08/2026, 10:30',
    conCurriculum: true,
  }, SEDE)
}

describe('messaggioCandidaturaAllaSede', () => {
  it('l’oggetto nomina la persona e la sede: la casella riceve anche altro', () => {
    expect(messaggio().oggetto).toContain('Rossi')
    expect(messaggio().oggetto).toContain('Kidville Giugliano')
  })

  it('traduce i valori in codice nelle etichette leggibili del modulo', () => {
    const t = messaggio().testo
    expect(t).toContain('Laurea magistrale')
    expect(t).not.toContain('laurea_magistrale')
    expect(t).toContain('Tempo pieno')
    expect(t).not.toContain('tempo_pieno')
  })

  it('rende TUTTI i campi compilati, e li rende con l’etichetta del template', () => {
    const t = messaggio().testo
    for (const f of INSEGNANTE_FIELDS) {
      if (f.id === 'cv_path') continue // l'allegato si annuncia a parte, non come percorso
      if (DATI[f.id as keyof typeof DATI] === undefined) continue
      expect(t, `manca il campo «${f.label}»`).toContain(f.label)
    }
  })

  it('dice l’esito di OGNI consenso, anche di quello NON dato', () => {
    const t = messaggio().testo
    expect(t).toContain('Ho letto l’informativa sulla privacy')
    expect(t).toContain('Conservate la mia candidatura per future opportunità')
    expect(t).toMatch(/Conservate la mia candidatura[^\n]*\n?[^\n]*No/i)
  })

  it('dice a QUALI sedi è stata inviata: chi valuta deve sapere che è in gioco anche altrove', () => {
    expect(messaggio().testo).toContain('Kidville Aversa')
  })

  it('annuncia il curriculum come allegato, MAI il suo percorso nel bucket', () => {
    const t = messaggio().testo
    expect(t.toLowerCase()).toContain('curriculum')
    expect(t).not.toContain('candidature/')
  })

  it('senza curriculum lo DICE, invece di tacere: «non allegato» e «non guardato» non sono la stessa cosa', () => {
    const senza = messaggioCandidaturaAllaSede({
      dati: DATI, consensi: {}, sediScelte: ['Kidville Giugliano'],
      inviataIl: '19/08/2026, 10:30', conCurriculum: false,
    }, SEDE)
    expect(senza.testo.toLowerCase()).toContain('nessun curriculum')
  })

  it('OMETTE i campi non compilati invece di stampare l’etichetta col vuoto accanto', () => {
    const scarno = messaggioCandidaturaAllaSede({
      dati: { nome: 'Ada', cognome: 'Bianchi', email: 'ada@b.it', posizioni: ['cuoca'] },
      consensi: { presa_visione_informativa: true },
      sediScelte: ['Kidville Cesa'], inviataIl: '19/08/2026, 10:30', conCurriculum: false,
    }, SEDE)
    expect(scarno.testo).not.toContain('Anni di esperienza')
    expect(scarno.testo).not.toMatch(/:\s*\n/)
  })

  it('l’HTML fa scappare i metacaratteri: un nome col « < » non apre un tag', () => {
    const cattivo = messaggioCandidaturaAllaSede({
      dati: { ...DATI, nome: '<script>alert(1)</script>' }, consensi: {},
      sediScelte: ['Kidville Giugliano'], inviataIl: '19/08/2026, 10:30', conCurriculum: false,
    }, SEDE)
    expect(cattivo.html).not.toContain('<script>')
    expect(cattivo.html).toContain('&lt;script&gt;')
  })
})
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

```bash
npx vitest run __tests__/lib/email/candidatura-alla-sede.test.ts
```

Atteso: **FAIL** — `Cannot find module '@/lib/email/messaggi/candidatura-alla-sede'`.

- [ ] **Step 3: Implementare**

Leggere prima `src/lib/email/messaggi/conferma-candidatura.ts` per la forma esatta di `documento()`, `intestazioneTesto()`, `piedeTesto()`, `p()`, `esc()` e del template tag `h` — questo file **deve** usare gli stessi mattoni, altrimenti la copia alla sede sarà l'unica email dell'applicazione con un'impaginatura sua.

```ts
// src/lib/email/messaggi/candidatura-alla-sede.ts
import type { ContestoSede } from '../contesto'
import { INSEGNANTE_FIELDS, CONSENSI_INSEGNANTI_FIELDS } from '@/lib/forms/insegnanti-template'
import type { FormField } from '@/types/database.types'

// =============================================================================
// LA COPIA COMPLETA CHE ARRIVA ALLA SEDE.
//
// ─── PERCHÉ ITERA IL TEMPLATE INVECE DI ELENCARE I CAMPI ─────────────────────
// Perché un elenco scritto a mano diverge al primo campo aggiunto al modulo, e
// diverge IN SILENZIO: la sede riceverebbe una copia «completa» a cui manca
// esattamente il campo nuovo, e nessun test sarebbe rosso. È lo stesso difetto
// di famiglia del riepilogo del wizard, che fino all'11/08/2026 mostrava due
// fatti su tredici campi compilabili.
//
// `INSEGNANTE_FIELDS` dichiara già tutto ciò che serve: l'etichetta con cui il
// campo è stato CHIESTO (che è quella con cui va riletto), e le `options` con le
// etichette leggibili. Chi riceve deve leggere «Laurea magistrale», non
// `laurea_magistrale`: il secondo è un valore di database, e in una casella di
// posta è rumore.
//
// ─── LA REGOLA DELL'OMISSIONE ────────────────────────────────────────────────
// È la stessa di `lib/email/contesto.ts`: ciò che manca si OMETTE, non si stampa
// vuoto. Un'etichetta seguita dal nulla non è un dato mancante, è una riga rotta
// in mezzo a una copia che deve poter essere letta come un documento.
//
// ─── IL CURRICULUM NON COMPARE COME PERCORSO ─────────────────────────────────
// `cv_path` è un identificativo tecnico ed è la CHIAVE DI UN GATE
// (`candidature_insegnanti_cv_unico` + `assertCurriculumInScope`): chi lo conosce
// può tentare di rivendicarlo. Non ha nessun motivo di comparire in una casella
// di posta, e qui non compare. Si dice solo SE il curriculum c'è, e il file
// viaggia in allegato con un nome ricostruito.
// =============================================================================

export interface DatiCandidaturaAllaSede {
    /** I valori del modulo, con le chiavi degli `id` di `INSEGNANTE_FIELDS`. */
    dati: Record<string, unknown>
    /** L'esito di ogni consenso. Assente ⇒ non spuntato. */
    consensi: Record<string, boolean>
    /** I NOMI dei plessi scelti — non gli uuid: questa email la legge una persona. */
    sediScelte: string[]
    /** L'istante d'invio, già formattato per `it-IT` da chi chiama. */
    inviataIl: string
    conCurriculum: boolean
}

/** L'etichetta leggibile di un valore, quando il campo dichiara delle opzioni. */
function etichettaDi(campo: FormField, valore: unknown): string {
    const opzioni = campo.options
    if (!Array.isArray(opzioni)) return String(valore)
    const trovata = opzioni.find((o) => o.value === valore)
    // Il ripiego è il valore grezzo, non una stringa vuota: un valore che non sta
    // più fra le opzioni (perché l'elenco è cambiato dopo l'invio) è un dato che
    // la sede deve comunque vedere. Tacerlo sarebbe peggio che mostrarlo brutto.
    return trovata?.label ?? String(valore)
}

/** Il valore di un campo, già leggibile. `null` quando il campo è da omettere. */
function valoreLeggibile(campo: FormField, grezzo: unknown): string | null {
    if (grezzo === null || grezzo === undefined || grezzo === '') return null
    if (Array.isArray(grezzo)) {
        if (grezzo.length === 0) return null
        return grezzo.map((v) => etichettaDi(campo, v)).join(', ')
    }
    if (typeof grezzo === 'boolean') return grezzo ? 'Sì' : 'No'
    return etichettaDi(campo, grezzo)
}

/** Le righe «Etichetta: valore» dei campi compilati, nell'ordine del modulo. */
export function righeDellaCopia(d: DatiCandidaturaAllaSede): { etichetta: string; valore: string }[] {
    const righe: { etichetta: string; valore: string }[] = []
    for (const campo of INSEGNANTE_FIELDS) {
        // Il curriculum si annuncia a parte: vedi la testata.
        if (campo.id === 'cv_path') continue
        const valore = valoreLeggibile(campo, d.dati[campo.id])
        if (valore !== null) righe.push({ etichetta: campo.label, valore })
    }
    return righe
}

/** I consensi con il loro esito. Ci sono TUTTI, anche quelli non dati. */
export function righeDeiConsensi(d: DatiCandidaturaAllaSede): { etichetta: string; valore: string }[] {
    // ⚠️ Anche i consensi NON dati compaiono, con «No».
    // «Non gliel'ho chiesto» e «ha detto no» non sono la stessa cosa, e la
    // differenza conta il giorno in cui si decide se ricontattare qualcuno per
    // una posizione futura: senza la riga, l'assenza si legge come un errore del
    // modulo invece che come una scelta della persona.
    return CONSENSI_INSEGNANTI_FIELDS.map((c) => ({
        etichetta: c.label,
        valore: d.consensi[c.id] === true ? 'Sì' : 'No',
    }))
}
```

Il resto del file compone `oggetto`, `testo` e `html` con i mattoni di `conferma-candidatura.ts`. La forma del testo:

```
Candidatura di Maria Rossi — Kidville Giugliano          ← oggetto

È arrivata una candidatura dal modulo «Lavora con noi».
Inviata il 19/08/2026, 10:30.
Sedi scelte: Kidville Giugliano, Kidville Aversa.
Questa copia è per: Kidville Giugliano.

── I DATI DEL MODULO ──
Nome: Maria
Cognome: Rossi
…

── I CONSENSI ──
Ho letto l'informativa sulla privacy: Sì
Conservate la mia candidatura per future opportunità: No

── ALLEGATO ──
Curriculum in allegato a questo messaggio.        (oppure: «Nessun curriculum allegato.»)
```

L'HTML rende le stesse righe in una tabella a due colonne dentro `documento(sede, …)`, e **ogni valore passa da `esc()`**: i valori vengono da un modulo pubblico e non sono mai fidati.

- [ ] **Step 4: Eseguire i test**

```bash
npx vitest run __tests__/lib/email/candidatura-alla-sede.test.ts
npx vitest run __tests__/lib/email/generatori-email.test.ts
```

Atteso: **PASS** su entrambi. ⚠️ `generatori-email.test.ts` (fino al 2026-09-01: `dodici-generatori.test.ts`) elenca i generatori di email: aggiungendone uno **va aggiornato** — dichiarando il nuovo, non allentando l'elenco. Aprirlo e leggere cosa pretende prima di modificarlo.

- [ ] **Step 5: Il test che dimostra che il lock funziona davvero**

Un lock che non si è mai visto fallire non è un lock. Verificare a mano che il terzo test («rende TUTTI i campi compilati») sia vivo: aggiungere temporaneamente `if (campo.id === 'telefono') continue` in `righeDellaCopia`, rieseguire, **vedere il rosso**, poi togliere la riga.

```bash
npx vitest run __tests__/lib/email/candidatura-alla-sede.test.ts
```

Atteso col sabotaggio: **FAIL** con «manca il campo «Numero di telefono»». Senza: **PASS**.

- [ ] **Step 6: Commit**

```bash
git add src/lib/email/messaggi/candidatura-alla-sede.ts __tests__/lib/email/candidatura-alla-sede.test.ts __tests__/lib/email/generatori-email.test.ts
git commit -m "La copia alla sede si costruisce dal template dei campi, non da un elenco scritto a mano"
```

---

## Task 4: L'orchestratore dell'invio — destinatario, allegato, log

**Files:**
- Create: `src/lib/candidature/copia-alla-sede.ts`
- Modify: `docs/env.md`
- Test: `__tests__/lib/candidature/copia-alla-sede.test.ts` (create)

- [ ] **Step 1: Scrivere il test che fallisce**

```ts
// __tests__/lib/candidature/copia-alla-sede.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const sendEmailDetailed = vi.fn()
const logEvento = vi.fn()
const risolviContestoSede = vi.fn()
vi.mock('@/lib/email/send', () => ({ sendEmailDetailed: (...a: unknown[]) => sendEmailDetailed(...a) }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: (...a: unknown[]) => logEvento(...a), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/email/contesto', async (orig) => ({
  ...(await orig<typeof import('@/lib/email/contesto')>()),
  risolviContestoSede: (...a: unknown[]) => risolviContestoSede(...a),
}))

import { inviaCopiaAllaSede } from '@/lib/candidature/copia-alla-sede'
import { contestoSenzaSede } from '@/lib/email/contesto'

const SCUOLA = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'
const BASE = {
  dati: { nome: 'Maria', cognome: 'Rossi', email: 'maria@e.it', posizioni: ['cuoca'] },
  consensi: { presa_visione_informativa: true },
  sediScelte: ['Kidville Giugliano'],
  inviataIl: '19/08/2026, 10:30',
  entitaId: '11111111-1111-1111-1111-111111111111',
  cvPath: null as string | null,
}

/** Un client Supabase finto: solo lo Storage, che è l'unica cosa che si usa. */
function supabaseCon(download: unknown) {
  return { storage: { from: () => ({ download: async () => download }) } } as never
}

describe('inviaCopiaAllaSede', () => {
  beforeEach(() => {
    sendEmailDetailed.mockReset().mockResolvedValue({ ok: true, error: null, messageId: 'm1' })
    logEvento.mockReset()
    risolviContestoSede.mockReset().mockResolvedValue({
      ...contestoSenzaSede('Kidville Giugliano'), email: 'giugliano@kidville.it',
    })
    delete process.env.CANDIDATURE_EMAIL_FALLBACK
  })
  afterEach(() => { delete process.env.CANDIDATURE_EMAIL_FALLBACK })

  it('spedisce alla casella dichiarata nell’anagrafica della sede', async () => {
    await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), { ...BASE, scuolaId: SCUOLA })
    expect(sendEmailDetailed.mock.calls[0][0].to).toBe('giugliano@kidville.it')
  })

  it('mette in reply-to l’indirizzo di chi si è candidato', async () => {
    await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), { ...BASE, scuolaId: SCUOLA })
    expect(sendEmailDetailed.mock.calls[0][0].replyTo).toBe('maria@e.it')
  })

  it('anagrafica senza email → livello ERROR, non info: una configurazione mancante è un incidente', async () => {
    risolviContestoSede.mockResolvedValue(contestoSenzaSede('Kidville Aversa'))
    process.env.CANDIDATURE_EMAIL_FALLBACK = 'info@kidville.it'
    await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), { ...BASE, scuolaId: SCUOLA })
    const errori = logEvento.mock.calls.filter((c) => c[1] === 'error')
    expect(errori.length).toBeGreaterThan(0)
    expect(sendEmailDetailed.mock.calls[0][0].to).toBe('info@kidville.it')
  })

  it('senza anagrafica E senza ripiego non spedisce, ma lo dice', async () => {
    risolviContestoSede.mockResolvedValue(contestoSenzaSede('Kidville Cesa'))
    const esito = await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), { ...BASE, scuolaId: SCUOLA })
    expect(sendEmailDetailed).not.toHaveBeenCalled()
    expect(esito.ok).toBe(false)
    expect(logEvento.mock.calls.some((c) => c[1] === 'error')).toBe(true)
  })

  it('allega il curriculum in base64, con un nome ricostruito e MAI il percorso del bucket', async () => {
    const blob = { arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4').buffer }
    await inviaCopiaAllaSede(supabaseCon({ data: blob, error: null }), {
      ...BASE, scuolaId: SCUOLA, cvPath: 'candidature/abc123.pdf',
    })
    const [allegato] = sendEmailDetailed.mock.calls[0][0].attachments
    expect(allegato.filename).toBe('curriculum-rossi-maria.pdf')
    expect(allegato.filename).not.toContain('abc123')
    expect(allegato.content).toBe(Buffer.from('%PDF-1.4').toString('base64'))
  })

  it('curriculum non scaricabile → l’email PARTE COMUNQUE, senza allegato, e il buco è a log', async () => {
    await inviaCopiaAllaSede(supabaseCon({ data: null, error: { message: 'Object not found' } }), {
      ...BASE, scuolaId: SCUOLA, cvPath: 'candidature/abc123.pdf',
    })
    expect(sendEmailDetailed).toHaveBeenCalled()
    expect(sendEmailDetailed.mock.calls[0][0].attachments).toBeUndefined()
    // `logEvento(evento, livello, campi, errore)` → i campi sono il TERZO
    // argomento, cioè `c[2]`. Sbagliare indice qui produce un test che passa
    // sempre, cioè nessun test.
    expect(logEvento.mock.calls.some(
      (c) => (c[2] as { esito?: string })?.esito === 'curriculum-non-allegato',
    )).toBe(true)
  })

  it('logga anche il SUCCESSO: senza, «nessun log» non distingue «tutte partite» da «niente è partito»', async () => {
    await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), { ...BASE, scuolaId: SCUOLA })
    const esiti = logEvento.mock.calls.map((c) => (c[2] as { esito?: string })?.esito)
    expect(esiti).toContain('copia-sede-inviata')
  })

  it('non lancia MAI: la candidatura è già registrata, e un’email non deve poterla annullare', async () => {
    sendEmailDetailed.mockRejectedValue(new Error('rete giù'))
    await expect(
      inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), { ...BASE, scuolaId: SCUOLA }),
    ).resolves.toMatchObject({ ok: false })
  })

  it('nei log NON finisce mai il nome, l’email o il percorso del curriculum', async () => {
    await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), {
      ...BASE, scuolaId: SCUOLA, cvPath: 'candidature/abc123.pdf',
    })
    const tutto = JSON.stringify(logEvento.mock.calls)
    expect(tutto).not.toContain('Maria')
    expect(tutto).not.toContain('maria@e.it')
    expect(tutto).not.toContain('abc123')
  })
})
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

```bash
npx vitest run __tests__/lib/candidature/copia-alla-sede.test.ts
```

Atteso: **FAIL** — `Cannot find module '@/lib/candidature/copia-alla-sede'`.

- [ ] **Step 3: Implementare**

```ts
// src/lib/candidature/copia-alla-sede.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmailDetailed } from '@/lib/email/send'
import { risolviContestoSede } from '@/lib/email/contesto'
import { messaggioCandidaturaAllaSede } from '@/lib/email/messaggi/candidatura-alla-sede'
import { logEvento } from '@/lib/logging/logger'
import { BUCKET_CURRICULUM } from './percorso-cv'

// =============================================================================
// LA COPIA DELLA CANDIDATURA CHE ARRIVA ALLA CASELLA DEL PLESSO.
//
// ─── BEST-EFFORT, MA MAI MUTO ────────────────────────────────────────────────
// Quando questa funzione parte la candidatura è GIÀ REGISTRATA: un'email che non
// parte non deve trasformare un 201 in un 500. Perciò non lancia mai e ritorna un
// esito. Ma non tace: ogni ramo lascia una riga, successo compreso — con i soli
// errori, «nessun log» non distingue «tutte partite» da «non è mai partito
// niente», ed è esattamente l'ambiguità che ha tenuto nascosto per mesi il guasto
// delle email delle credenziali.
//
// ─── IL DESTINATARIO, E PERCHÉ IL RIPIEGO È A LIVELLO `error` ────────────────
// L'indirizzo viene da `scuole.config.anagrafica.email`, lo stesso campo che firma
// il piè di pagina di tutte le email della sede. Se manca, la candidatura NON si
// perde — si ripiega su `CANDIDATURE_EMAIL_FALLBACK` — ma la riga è `error` e non
// `info`: una configurazione critica assente in produzione è un incidente, non una
// nota a piè di pagina (AGENTS, logging §4). Un ripiego silenzioso significa che
// per mesi le candidature di Aversa arrivano a info@ e nessuno se ne accorge.
//
// ─── NIENTE DATI PERSONALI NEI LOG ───────────────────────────────────────────
// Qui passano un nome, un'email e il percorso di un curriculum: nei log finiscono
// solo uuid, booleani e conteggi. `cv_path` in particolare è la chiave di un gate
// (`candidature_insegnanti_cv_unico`), e un percorso a log è un percorso che
// qualcuno può leggere.
// =============================================================================

/** Il nome dell'ambiente su cui ripiegare quando l'anagrafica non ha la casella. */
const ENV_RIPIEGO = 'CANDIDATURE_EMAIL_FALLBACK'

export interface EsitoCopiaAllaSede {
    ok: boolean
    /** Vero quando il provider ha detto «non oggi» (429) e non «non si può». */
    rinviabile: boolean
}

export interface DatiCopiaAllaSede {
    scuolaId: string
    dati: Record<string, unknown>
    consensi: Record<string, boolean>
    sediScelte: string[]
    inviataIl: string
    entitaId: string
    cvPath: string | null
}

/** `curriculum-rossi-maria.pdf` — leggibile, e senza niente del bucket dentro. */
function nomeAllegato(dati: Record<string, unknown>, cvPath: string): string {
    const pezzo = (v: unknown) =>
        String(v ?? '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
    const estensione = cvPath.split('.').pop()?.toLowerCase() ?? 'pdf'
    const cognome = pezzo(dati.cognome) || 'candidatura'
    const nome = pezzo(dati.nome)
    return `curriculum-${cognome}${nome ? `-${nome}` : ''}.${estensione}`
}

export async function inviaCopiaAllaSede(
    supabase: SupabaseClient,
    d: DatiCopiaAllaSede,
): Promise<EsitoCopiaAllaSede> {
    const operazione = 'iscrizione/insegnanti:POST'
    try {
        const sede = await risolviContestoSede(supabase, d.scuolaId, operazione)
        const ripiego = process.env[ENV_RIPIEGO]
        const destinatario = sede.email ?? ripiego ?? null

        if (sede.email === null) {
            logEvento('config', 'error', {
                operazione,
                esito: destinatario ? 'casella-sede-assente-ripiego' : 'casella-sede-assente',
                scuola_id: d.scuolaId,
                msg: destinatario
                    ? `nessuna email in anagrafica per questa sede: la copia parte su ${ENV_RIPIEGO}`
                    : `nessuna email in anagrafica per questa sede e ${ENV_RIPIEGO} non è impostata: la copia NON parte`,
            })
        }
        if (destinatario === null) return { ok: false, rinviabile: false }

        // ── L'ALLEGATO ──────────────────────────────────────────────────────
        // Un curriculum che non si scarica NON ferma l'email: la sede riceve
        // comunque i dati, e il buco resta scritto. Il contrario — nessuna email
        // perché manca l'allegato — perderebbe anche ciò che si poteva consegnare.
        let allegati: { filename: string; content: string; contentType?: string }[] | undefined
        if (d.cvPath !== null) {
            const { data: file, error } = await supabase.storage.from(BUCKET_CURRICULUM).download(d.cvPath)
            if (error !== null || file === null || file === undefined) {
                logEvento('candidatura', 'warn', {
                    operazione, esito: 'curriculum-non-allegato',
                    entita_id: d.entitaId, scuola_id: d.scuolaId,
                }, error ?? new Error('curriculum non trovato nello storage'))
            } else {
                const buf = Buffer.from(await (file as Blob).arrayBuffer())
                allegati = [{ filename: nomeAllegato(d.dati, d.cvPath), content: buf.toString('base64') }]
            }
        }

        const messaggio = messaggioCandidaturaAllaSede({
            dati: d.dati, consensi: d.consensi, sediScelte: d.sediScelte,
            inviataIl: d.inviataIl, conCurriculum: allegati !== undefined,
        }, sede)

        const invio = await sendEmailDetailed({
            to: destinatario,
            subject: messaggio.oggetto,
            text: messaggio.testo,
            html: messaggio.html,
            ...(allegati ? { attachments: allegati } : {}),
            // Chi riceve risponde a chi si è candidato. Il mittente non può
            // esserlo: deve restare su @mail.kidville.it o Resend rifiuta con 403.
            ...(typeof d.dati.email === 'string' ? { replyTo: d.dati.email } : {}),
        })

        logEvento('candidatura', invio.ok ? 'info' : 'warn', {
            operazione,
            esito: invio.ok ? 'copia-sede-inviata' : 'copia-sede-non-inviata',
            canale: 'email',
            entita_id: d.entitaId,
            scuola_id: d.scuolaId,
            con_allegato: allegati !== undefined,
        }, invio.ok ? undefined : new Error(invio.error ?? 'motivo sconosciuto'))

        return { ok: invio.ok, rinviabile: invio.rinviabile === true }
    } catch (e) {
        logEvento('candidatura', 'warn', {
            operazione, esito: 'copia-sede-non-inviata',
            entita_id: d.entitaId, scuola_id: d.scuolaId,
        }, e)
        return { ok: false, rinviabile: false }
    }
}
```

- [ ] **Step 4: Eseguire i test**

```bash
npx vitest run __tests__/lib/candidature/copia-alla-sede.test.ts
```

Atteso: **PASS**, 9 test.

- [ ] **Step 5: Documentare la variabile d'ambiente**

Aprire `docs/env.md`, trovare la tabella delle variabili **non critiche** (l'applicazione funziona senza: la copia semplicemente non parte se anche l'anagrafica è vuota) e aggiungere:

| Nome | A cosa serve | Se manca |
|---|---|---|
| `CANDIDATURE_EMAIL_FALLBACK` | casella su cui ripiegare per la copia della candidatura, quando la sede non ha un'email in Impostazioni → Anagrafica sede | la copia non parte per quella sede; la candidatura resta comunque nel pannello, e la riga in `app_log` è a livello `error` |

⚠️ **Solo il nome.** `docs/env.md` documenta i nomi; il valore si imposta su Vercel. Il lock `env-critiche-documentate.test.ts` fa cadere la build se in quel file compare qualcosa che sembra il valore di un segreto, e questo repo è pubblico.

```bash
npx vitest run __tests__/architecture/env-critiche-documentate.test.ts
```

Atteso: **PASS**.

- [ ] **Step 6: Commit**

```bash
git add src/lib/candidature/copia-alla-sede.ts __tests__/lib/candidature/copia-alla-sede.test.ts docs/env.md
git commit -m "La copia alla sede: destinatario dall'anagrafica, curriculum in allegato, e ogni esito a log"
```

---

## Task 5: La route pubblica spedisce la copia (ancora a sede singola)

**Files:**
- Modify: `src/app/api/iscrizione/insegnanti/route.ts:1174-1212`
- Test: `__tests__/api/candidature-insegnanti-post.test.ts` (aggiungere casi)

A questo punto la copia funziona **prima** della multi-sede: la funzionalità che hai chiesto è già viva a una sede, e la Fase C la trasformerà in un ciclo. Rilasciabile così com'è.

- [ ] **Step 1: Scrivere i test che falliscono**

Aggiungere in `__tests__/api/candidature-insegnanti-post.test.ts` (seguire i mock già presenti nel file: leggerlo prima):

```ts
  it('a candidatura registrata parte ANCHE la copia alla sede, non solo la conferma alla candidata', async () => {
    // …invio valido…
    expect(inviaCopiaAllaSede).toHaveBeenCalledTimes(1)
    expect(inviaCopiaAllaSede.mock.calls[0][1].scuolaId).toBe(SCUOLA_VALIDA)
  })

  it('la copia NON parte nel ramo del duplicato: la sede aprirebbe una pratica che non esiste', async () => {
    // …invio che scatta su `candidature_insegnanti_email_viva` (23505)…
    expect(inviaCopiaAllaSede).not.toHaveBeenCalled()
  })

  it('se la copia fallisce la risposta resta 201: la candidatura è già registrata', async () => {
    inviaCopiaAllaSede.mockResolvedValue({ ok: false, rinviabile: false })
    const res = await POST(richiestaValida())
    expect(res.status).toBe(201)
  })
```

- [ ] **Step 2: Eseguire e verificare il rosso**

```bash
npx vitest run __tests__/api/candidature-insegnanti-post.test.ts
```

Atteso: **FAIL** — `inviaCopiaAllaSede` non è mai chiamata.

- [ ] **Step 3: Implementare**

In `src/app/api/iscrizione/insegnanti/route.ts`, importare in testa:

```ts
import { inviaCopiaAllaSede } from '@/lib/candidature/copia-alla-sede'
```

e **subito dopo** il blocco «LA CONFERMA ALLA CANDIDATA» (che finisce alla riga ~1212, prima del `return NextResponse.json({ id: entitaId }, { status: 201 })`), inserire:

```ts
    // ─── LA COPIA ALLA SEDE ─────────────────────────────────────────────────
    // Stessa disciplina della conferma qui sopra, e per le stesse due ragioni:
    // best-effort (la candidatura è già registrata) e mai muta (ogni esito lascia
    // una riga).
    //
    // ⚠️ E come la conferma, NON sta nel ramo del duplicato. Mandare alla
    // segreteria la copia di una candidatura respinta perché ce n'è già una
    // aperta le farebbe istruire una pratica che non esiste — e la persona ne
    // avrebbe due in valutazione senza averne inviate due.
    //
    // ⚠️ `sediScelte` porta i NOMI, non gli uuid: questa email la legge una
    // persona, e un uuid in una casella di posta non dice niente a nessuno.
    await inviaCopiaAllaSede(supabase, {
      scuolaId,
      dati: normalizzati,
      consensi: Object.fromEntries(
        CONSENSI_INSEGNANTI_FIELDS.map((c) => [c.id, normalizzati[c.id] === true]),
      ),
      sediScelte: [nomeDellaSede],
      inviataIl: formattaIstante(new Date(), 'it', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      }),
      entitaId,
      cvPath,
    })
```

`nomeDellaSede` si ricava con `nomeSede(supabase, scuolaId, OPERAZIONE)` (già importato indirettamente via `risolviContestoSede`; se non lo è, importarlo da `@/lib/scuole/reali`) con ripiego su `'Kidville'`.

- [ ] **Step 4: Eseguire i test**

```bash
npx vitest run __tests__/api/candidature-insegnanti-post.test.ts __tests__/api/candidature-insegnanti-log-senza-pii.test.ts
```

Atteso: **PASS** su entrambi. Il secondo verifica che nei log non finisca PII: se cade, il difetto è nel nuovo blocco.

- [ ] **Step 5: Gate parziale e commit**

```bash
npx eslint src/app/api/iscrizione/insegnanti/route.ts src/lib/candidature --max-warnings 0
npx tsc --noEmit
git add src/app/api/iscrizione/insegnanti/route.ts __tests__/api/candidature-insegnanti-post.test.ts
git commit -m "Ogni candidatura arriva anche nella casella del plesso, curriculum compreso"
```

---

## Task 6: La voce in `/privacy` dice il vero

**Files:**
- Modify: `src/app/privacy/page.tsx:429-433`
- Test: `__tests__/api/gdpr-retention-candidature.test.ts` (il lock che confronta la voce col codice)

⚠️ Leggere prima `__tests__/api/gdpr-retention-candidature.test.ts`: **isola il `<li>` della candidatura e lo confronta con i mesi che il cron applica**. Cambiare quel `<li>` senza guardare il lock lo fa cadere.

Oggi la voce promette che *«Il curriculum allegato viene cancellato insieme alla candidatura»*. Da questo rilascio una copia con l'allegato vive nella casella della sede, e **non la cancella nessun cron**. La finalità e il titolare non cambiano — le tre sedi sono la stessa cooperativa — ma il **termine promesso** non è più vero per quella copia.

- [ ] **Step 1: Leggere cosa pretende il lock**

```bash
sed -n '1,80p' __tests__/api/gdpr-retention-candidature.test.ts
```

Individuare la stringa esatta che il lock estrae e con cosa la confronta.

- [ ] **Step 2: Correggere la voce**

Aggiungere alla voce esistente, **senza toccare i numeri che il lock confronta**, una frase che dica il fatto:

> Al momento dell'invio, una copia della candidatura con il curriculum allegato viene recapitata alla casella di posta di ogni sede scelta, perché è la sede che la deve valutare. **Quella copia vive nella casella e non è cancellata dal job automatico**: la cancellazione dopo dodici mesi (ventiquattro col consenso alla conservazione) riguarda i dati archiviati nell'applicazione e il file nel suo archivio. Per la copia in posta, la richiesta di cancellazione si rivolge alla segreteria della sede.

- [ ] **Step 3: Eseguire il lock**

```bash
npx vitest run __tests__/api/gdpr-retention-candidature.test.ts __tests__/architecture/informativa-conservazione-dichiarata.test.ts
```

Atteso: **PASS**. Se cade, la frase ha toccato la parte che il lock confronta: spostarla in un `<li>` o in un paragrafo adiacente invece che dentro quello sorvegliato.

- [ ] **Step 4: Commit**

```bash
git add src/app/privacy/page.tsx
git commit -m "L'informativa dice anche ciò che il cron non cancella"
```

---

# FASE C — La sede al plurale

## Task 7: La migrazione — `candidature_sedi`, la FK, il trigger, il backfill

**Files:**
- Create: `supabase/migrations/20260819HHMMSS_candidature_sedi.sql`

⚠️ **Si applica con lo strumento MCP `apply_migration`, poi `get_advisors` a 0 ERROR.** In produzione ci sono dati reali: **mostrare la migrazione prima di applicarla**, anche se nessuno chiederà conferma.

⚠️ **`scuola_id` DEVE dichiarare la sua FK verso `schools(id)` nella stessa migrazione.** Il lock `fk-scuola-id.test.ts` guarda le migrazioni più recenti della fotografia e cade su una colonna `scuola_id` nuova senza riferimento. Esiste perché trentuno tabelle su sessantacinque se n'erano dimenticate, producendo righe che nessun filtro di sede vede più — non una fuga, una **sparizione**.

- [ ] **Step 1: Scrivere la migrazione**

```sql
-- =============================================================================
-- LE SEDI DI UNA CANDIDATURA — «Lavora con noi» accetta più plessi insieme.
--
-- ─── PERCHÉ NON UNA RIGA PER SEDE ────────────────────────────────────────────
-- Perché due indici UNIQUE globali lo impediscono, ed entrambi per buone ragioni:
--   · `candidature_insegnanti_email_viva`  — una sola candidatura viva per persona
--     su TUTTA la cooperativa;
--   · `candidature_insegnanti_cv_unico`    — il gate anti-IDOR del curriculum.
-- La seconda riga della stessa persona prende 23505 su entrambi, e per farla
-- passare bisognerebbe allentare proprio il secondo — cioè riaprire di proposito
-- il buco che la migrazione 20260814225302 ha chiuso.
-- Quindi: UNA candidatura, e qui dentro le sedi a cui è rivolta.
--
-- ─── SUL VOCABOLARIO ─────────────────────────────────────────────────────────
-- In gergo questa si chiamerebbe «tabella figlia». In questo schema esistono
-- `alunni`, `parents` e `student_parents`: qui i figli sono bambini veri, e la
-- parola ha già prodotto un fraintendimento. Si dicono «le righe di sede».
-- =============================================================================

create table if not exists public.candidature_sedi (
  candidatura_id  uuid not null references public.candidature_insegnanti(id) on delete cascade,
  -- ⚠️ LA FK NON È FACOLTATIVA. Senza, questo `scuola_id` è un uuid libero: il
  -- database accetterebbe un valore che non corrisponde a nessuna sede, e quella
  -- riga diventerebbe invisibile a ogni `.in('scuola_id', plessi)`. Non è una
  -- fuga di dati, è una sparizione silenziosa. Il lock `fk-scuola-id` la pretende.
  scuola_id       uuid not null references public.schools(id),
  stato           text not null default 'pending'
                  check (stato in ('pending','approvata','rifiutata')),
  evasa_il        timestamptz,
  evasa_da        uuid references public.utenti(id),
  motivo_rifiuto  text,
  creata_il       timestamptz not null default now(),
  primary key (candidatura_id, scuola_id)
);

-- Il cockpit interroga «cosa c'è da valutare nelle MIE sedi», in quest'ordine.
create index if not exists candidature_sedi_scuola_stato_idx
  on public.candidature_sedi (scuola_id, stato, creata_il desc);

-- ── IL BACKFILL: nessuna candidatura esistente resta senza la sua riga ───────
-- Va PRIMA del trigger: il trigger ricalcola lo stato della candidatura dalle
-- righe di sede, e con zero righe scriverebbe uno stato che nessuno ha deciso.
insert into public.candidature_sedi (candidatura_id, scuola_id, stato, evasa_il, evasa_da, motivo_rifiuto, creata_il)
select c.id,
       c.scuola_id,
       case when c.stato = 'in_approvazione' then 'pending' else c.stato end,
       c.evasa_il, c.evasa_da, c.motivo_rifiuto, c.creata_il
  from public.candidature_insegnanti c
 where not exists (
       select 1 from public.candidature_sedi s
        where s.candidatura_id = c.id and s.scuola_id = c.scuola_id);

-- ── LO STATO DELLA CANDIDATURA È L'AGGREGATO DELLE SUE SEDI ──────────────────
-- Non è zucchero sintattico: è ciò che tiene in piedi, SENZA TOCCARLO, l'indice
-- `candidature_insegnanti_email_viva`. Se Giugliano rifiuta e Aversa sta ancora
-- valutando, quella persona è ancora in gioco: la candidatura resta `pending`,
-- l'indice continua a dire «ne ha già una viva», e il modulo pubblico continua a
-- rispondere 201 con esito `duplicata` nei log invece di diventare un oracolo di
-- enumerazione su chi si è candidato.
--
-- E il cron di conservazione GDPR continua a leggere la colonna che ha sempre
-- letto, con la semantica che ha sempre avuto: nessuna sua riga cambia.
--
-- `in_approvazione` non compare fra gli stati delle righe di sede: il claim in
-- due tempi è morto il 2026-08-15, quando approvare ha smesso di creare account e
-- di spedire password. Resta nel check di `candidature_insegnanti` solo perché lo
-- storico lo contiene.
create or replace function public.candidature_ricalcola_stato()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Solo INSERT e UPDATE: `old` non serve più (vedi il trigger, che non ascolta
  -- le cancellazioni e spiega perché).
  v_candidatura uuid := new.candidatura_id;
  v_stato text;
begin
  select case
           when count(*) filter (where stato = 'pending')   > 0 then 'pending'
           when count(*) filter (where stato = 'approvata') > 0 then 'approvata'
           when count(*) > 0                                     then 'rifiutata'
           else null
         end
    into v_stato
    from public.candidature_sedi
   where candidatura_id = v_candidatura;

  -- Zero righe di sede non è più raggiungibile da qui (il trigger non ascolta le
  -- cancellazioni), ma la guardia resta: costa niente, e il giorno in cui qualcuno
  -- riaggiunge `or delete` al trigger è l'unica cosa che sta fra quel gesto e un
  -- UPDATE con `stato = null` su una colonna `not null`.
  if v_stato is not null then
    update public.candidature_insegnanti
       set stato = v_stato, aggiornata_il = now()
     where id = v_candidatura and stato is distinct from v_stato;
  end if;

  return null;
end;
$$;

-- ⚠️ NIENTE `or delete`, ED È UNA CORREZIONE, NON UN'OMISSIONE.
-- La prima stesura aggregava anche in cancellazione. Ma le righe di sede si
-- cancellano in un modo solo — `on delete cascade`, quando sparisce la
-- candidatura, cioè quando il cron di conservazione GDPR fa il suo lavoro — e in
-- quel momento un trigger `after delete` proverebbe a fare UPDATE sulla riga di
-- `candidature_insegnanti` che lo stesso comando sta cancellando. Con due sedi
-- succede alla prima delle due: ne resta una, l'aggregato non è nullo, e parte un
-- UPDATE contro una riga in cancellazione. Un guasto che si presenta solo su una
-- candidatura con più di una sede, solo alla scadenza dei dodici mesi, dentro un
-- cron notturno: cioè fra un anno, di notte, dove nessuno lo sta guardando.
-- Se un giorno servisse togliere UNA sede senza cancellare la candidatura, quella
-- sarà un'operazione nuova e sarà lei a ricalcolare lo stato.
drop trigger if exists candidature_sedi_aggrega on public.candidature_sedi;
create trigger candidature_sedi_aggrega
  after insert or update of stato on public.candidature_sedi
  for each row execute function public.candidature_ricalcola_stato();

comment on table public.candidature_sedi is
  'I plessi a cui una candidatura di «Lavora con noi» è rivolta, uno per riga, ciascuno col PROPRIO stato: dal 2026-08-19 una persona può proporsi a più sedi insieme e ogni sede valuta per conto suo. Lo `stato` di candidature_insegnanti è l''AGGREGATO di queste righe, mantenuto dal trigger candidature_sedi_aggrega — non si scrive a mano.';
comment on column public.candidature_sedi.stato is
  'pending | approvata | rifiutata, per QUESTA sede. Niente `in_approvazione`: il claim in due tempi è morto il 2026-08-15, quando approvare ha smesso di creare account.';
```

- [ ] **Step 2: Mostrare la migrazione e applicarla**

Stampare il file per intero, poi:

```
mcp__supabase__apply_migration  (name: "candidature_sedi", query: <il file>)
mcp__supabase__get_advisors     (type: "security")  → 0 ERROR
mcp__supabase__get_advisors     (type: "performance") → 0 ERROR
```

- [ ] **Step 3: Verificare il backfill con una SELECT (sola lettura)**

```sql
select
  (select count(*) from candidature_insegnanti)                             as candidature,
  (select count(*) from candidature_sedi)                                   as righe_di_sede,
  (select count(*) from candidature_insegnanti c
     where not exists (select 1 from candidature_sedi s where s.candidatura_id = c.id)) as senza_sede;
```

**Criterio di accettazione:** `senza_sede = 0`, e `righe_di_sede >= candidature`.

- [ ] **Step 4: Verificare che il trigger faccia ciò che dice**

Su **una sola** candidatura di prova, in una transazione con `rollback` — non su una vera:

```sql
begin;
  -- si prende una candidatura pending qualunque e le si aggiunge una seconda sede
  -- …update di una riga di sede a 'rifiutata'…
  -- attesa: la candidatura resta 'pending' finché una riga è pending
rollback;
```

- [ ] **Step 5: Rigenerare la fotografia FK e verificare il lock**

```bash
node scripts/fk-sede-fotografia.mjs
npx vitest run __tests__/architecture/fk-scuola-id.test.ts __tests__/architecture/rls-per-sede.test.ts
```

Atteso: **PASS**. Se `rls-per-sede` cade, la tabella nuova vuole la sua policy: seguire il modello di `candidature_insegnanti`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/ __tests__/fixtures/fk-scuola-id-snapshot.json
git commit -m "Le sedi di una candidatura diventano righe, e lo stato della candidatura diventa la loro somma"
```

---

## Task 8: La porta pubblica accetta `scuole_ids`

**Files:**
- Modify: `src/app/api/iscrizione/insegnanti/route.ts:202-203` (schema), `:787-815` (validazione e scrittura), il blocco della copia del Task 5
- Test: `__tests__/api/candidature-insegnanti-multisede.test.ts` (create)

- [ ] **Step 1: Scrivere i test che falliscono**

```ts
// __tests__/api/candidature-insegnanti-multisede.test.ts
// (i mock di Supabase e di sediReali si copiano da candidature-insegnanti-post.test.ts: leggerlo prima)
describe('POST /api/iscrizione/insegnanti · più sedi', () => {
  it('accetta un elenco di sedi e scrive una riga di sede per ciascuna', async () => {
    const res = await POST(richiestaCon({ scuole_ids: [GIUGLIANO, AVERSA] }))
    expect(res.status).toBe(201)
    expect(righeDiSedeScritte()).toEqual([
      { candidatura_id: expect.any(String), scuola_id: GIUGLIANO },
      { candidatura_id: expect.any(String), scuola_id: AVERSA },
    ])
  })

  it('la candidatura porta come scuola_id la PRIMA dell’elenco', async () => {
    await POST(richiestaCon({ scuole_ids: [AVERSA, GIUGLIANO] }))
    expect(candidaturaScritta().scuola_id).toBe(AVERSA)
  })

  it('un elenco di UNA sede è un elenco: nessun ramo speciale, ed è il caso di ?sede=', async () => {
    const res = await POST(richiestaCon({ scuole_ids: [GIUGLIANO] }))
    expect(res.status).toBe(201)
    expect(righeDiSedeScritte()).toHaveLength(1)
  })

  it('OGNI sede viene verificata contro sediReali, non solo la prima', async () => {
    const res = await POST(richiestaCon({ scuole_ids: [GIUGLIANO, 'aaaaaaaa-0000-0000-0000-000000000000'] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ codice: 'SEDE_DA_SPECIFICARE' })
  })

  it('un elenco VUOTO è un rifiuto: senza sede non si archivia niente', async () => {
    expect((await POST(richiestaCon({ scuole_ids: [] }))).status).toBe(400)
  })

  it('le sedi ripetute si contano una volta: la stessa casella non riceve due copie', async () => {
    await POST(richiestaCon({ scuole_ids: [GIUGLIANO, GIUGLIANO] }))
    expect(righeDiSedeScritte()).toHaveLength(1)
  })

  it('parte UNA copia per ogni sede scelta, ognuna alla sua casella', async () => {
    await POST(richiestaCon({ scuole_ids: [GIUGLIANO, AVERSA] }))
    expect(inviaCopiaAllaSede).toHaveBeenCalledTimes(2)
    expect(inviaCopiaAllaSede.mock.calls.map((c) => c[1].scuolaId).sort())
      .toEqual([AVERSA, GIUGLIANO].sort())
  })

  it('ogni copia dice a chi la legge TUTTE le sedi scelte: chi valuta deve sapere', async () => {
    await POST(richiestaCon({ scuole_ids: [GIUGLIANO, AVERSA] }))
    for (const c of inviaCopiaAllaSede.mock.calls) expect(c[1].sediScelte).toHaveLength(2)
  })

  it('DEGRADO · se candidature_sedi non esiste (DB della CI) la candidatura si registra lo stesso', async () => {
    inserimentoRigheDiSedeFallisceCon({ code: 'PGRST205' })
    const res = await POST(richiestaCon({ scuole_ids: [GIUGLIANO, AVERSA] }))
    expect(res.status).toBe(201)
    expect(esitiLoggati()).toContain('sedi-multiple-non-registrate')
  })

  it('la conferma alla candidata resta UNA, non una per sede', async () => {
    await POST(richiestaCon({ scuole_ids: [GIUGLIANO, AVERSA] }))
    expect(sendEmailDetailed).toHaveBeenCalledTimes(1) // la conferma; le copie passano da inviaCopiaAllaSede
  })
})
```

- [ ] **Step 2: Eseguire e verificare il rosso**

```bash
npx vitest run __tests__/api/candidature-insegnanti-multisede.test.ts
```

Atteso: **FAIL** su tutti — lo schema rifiuta `scuole_ids` perché pretende `scuola_id`.

- [ ] **Step 3: Implementare**

Nello schema (riga ~202):

```ts
const postBodySchema = z.object({
  /**
   * LE SEDI, AL PLURALE dal 2026-08-19: una persona può proporsi a più plessi
   * con un invio solo, e ogni plesso valuta per conto suo.
   *
   * ⚠️ Resta OBBLIGATORIO averne almeno una, e la rotta resta più severa della
   * sorella `POST /api/iscrizione`, che ammette l'assenza e poi deduce: con tre
   * plessi, dedurre la sede vuol dire archiviare la candidatura nel posto
   * sbagliato IN SILENZIO.
   *
   * ⚠️ Un elenco di UNO è un elenco. È il caso di `?sede=<uuid>`, che non è
   * cambiato: quando c'è, il modulo salta il passo e invia quella sola sede. Non
   * esiste un ramo speciale per il caso singolo — un ramo che si percorre quasi
   * sempre e uno che si percorre di rado divergono, e diverge quello di rado.
   *
   * `max(3)`: i plessi sono tre. Un elenco più lungo o è un errore o è qualcuno
   * che prova a far spedire N email con un invio, e in entrambi i casi la
   * risposta è no.
   */
  scuole_ids: z.array(z.string().uuid()).min(1, 'Indicare la sede della candidatura').max(3),
  …
```

Nella validazione (riga ~787), sostituire `const scuolaId = b.data.scuola_id` con:

```ts
    // Dedup PRIMA della verifica: due volte la stessa sede è un elenco di una, e
    // due righe uguali farebbero due copie nella stessa casella.
    const scuoleRichieste = [...new Set(b.data.scuole_ids)]
    // ⚠️ OGNI sede si verifica, non solo la prima. Un elenco che ne controlla una
    // su tre è peggio di uno che non ne controlla nessuna: sembra difeso.
    const tutteReali = scuoleRichieste.every((id) => sediAmmesse.has(id))
    if (!tutteReali) {
      logEvento('candidatura', 'warn', {
        operazione: OPERAZIONE, esito: 'sede-non-valida', n_sedi: scuoleRichieste.length,
      })
      return NextResponse.json(
        { error: 'Indicare la sede della candidatura.', codice: 'SEDE_DA_SPECIFICARE' },
        { status: 400 },
      )
    }
    // La sede di PRIMO ARRIVO, che resta sulla candidatura. Da qui in avanti non
    // autorizza più niente — è un dato storico — ma dà un valore certo a ogni
    // codice che legge quella colonna senza sapere che esistano le righe di sede.
    const scuolaId = scuoleRichieste[0]
```

Dopo l'insert della candidatura (riga ~815), aggiungere la scrittura delle righe di sede con il degrado dichiarato:

```ts
    // ── LE RIGHE DI SEDE ────────────────────────────────────────────────────
    // ⚠️ Il DB E2E della CI non è migrato: se la tabella non c'è, la candidatura
    // si registra COMUNQUE sulla sede di primo arrivo e il 201 resta un 201. Chi
    // si candida non deve pagare una migrazione mancante — e un 500 qui
    // butterebbe via un modulo appena compilato per intero.
    const { error: errSedi } = await supabase
      .from('candidature_sedi')
      .insert(scuoleRichieste.map((sid) => ({ candidatura_id: entitaId, scuola_id: sid })))
    if (errSedi) {
      const codice = (errSedi as { code?: string }).code ?? null
      const tabellaAssente = codice === '42P01' || codice === 'PGRST205'
      logEvento('candidatura', tabellaAssente ? 'warn' : 'error', {
        operazione: OPERAZIONE,
        esito: 'sedi-multiple-non-registrate',
        entita_id: entitaId,
        scuola_id: scuolaId,
        n_sedi: scuoleRichieste.length,
      }, errSedi)
    }
```

E il blocco della copia (Task 5) diventa un ciclo su `scuoleRichieste`, con `sediScelte` che porta **i nomi di tutte** le sedi scelte. Gli invii vanno in sequenza, non in `Promise.all`: sono al massimo tre, e una raffica parallela contro un tetto di quota è il modo più veloce per prendersi un `429` su tutte e tre invece che su una.

- [ ] **Step 4: Eseguire i test**

```bash
npx vitest run __tests__/api/candidature-insegnanti-multisede.test.ts __tests__/api/candidature-insegnanti-post.test.ts __tests__/api/candidature-insegnanti-log-senza-pii.test.ts
```

Atteso: **PASS** su tutti e tre.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/iscrizione/insegnanti/route.ts __tests__/api/candidature-insegnanti-multisede.test.ts
git commit -m "La porta pubblica accetta l'elenco delle sedi, e un elenco di uno è un elenco"
```

---

## Task 9: L'hook impara la scelta multipla, senza cambiare l'altro modulo

**Files:**
- Modify: `src/components/features/public/wizard/use-sedi-pubbliche.ts`
- Test: `__tests__/components/CandidaturaInsegnanteWizard-sede.test.tsx` (aggiungere casi)

⚠️ `use-sedi-pubbliche` è usato **anche** da `AnagraficaPersonaleWizard.tsx`, che resta a sede singola. Quel modulo deve uscire da questo task **identico** a com'è entrato: l'aggiunta è additiva e il comportamento a sede singola non si tocca.

- [ ] **Step 1: Scrivere i test**

L'impalcatura (mock di `fetch` su `/api/iscrizione/sedi`, `render`, helper) **si copia
dal file stesso**, che la ha già: aprirlo e riusarla, non reinventarla.

```tsx
it('con più plessi si possono spuntare due sedi, e restano spuntate', async () => {
  render(<CandidaturaInsegnanteWizard />)
  const giugliano = await screen.findByLabelText(/Giugliano/)
  const aversa = screen.getByLabelText(/Aversa/)
  await userEvent.click(giugliano)
  await userEvent.click(aversa)
  expect(giugliano).toBeChecked()
  expect(aversa).toBeChecked()
})

it('togliendo l’ultima spunta l’avviso NON si spegne: il passo è tornato com’era', async () => {
  render(<CandidaturaInsegnanteWizard />)
  const giugliano = await screen.findByLabelText(/Giugliano/)
  // «Avanti» senza spunte accende l'avviso…
  await userEvent.click(screen.getByRole('button', { name: /Avanti/ }))
  expect(screen.getByRole('alert')).toHaveTextContent(/almeno una sede/i)
  // …spuntare lo spegne…
  await userEvent.click(giugliano)
  expect(screen.queryByRole('alert')).toBeNull()
  // …e TOGLIERE l'ultima spunta lo riaccende, invece di lasciare il passo
  // vuoto e silenzioso.
  await userEvent.click(giugliano)
  expect(screen.getByRole('alert')).toHaveTextContent(/almeno una sede/i)
})

it('con una sola sede in elenco resta auto-spuntata e il passo non compare: invariato', async () => {
  elencoSediRisponde([{ id: GIUGLIANO, nome: 'Kidville Giugliano' }])
  render(<CandidaturaInsegnanteWizard />)
  expect(await screen.findByLabelText(/Nome/)).toBeInTheDocument()
  expect(screen.queryByRole('group', { name: /Sedi della candidatura/i })).toBeNull()
})

it('con ?sede= il passo NON compare e parte quella sola sede: `?sede=` non è cambiato', async () => {
  render(<CandidaturaInsegnanteWizard sedeId={GIUGLIANO} />)
  expect(await screen.findByLabelText(/Nome/)).toBeInTheDocument()
  expect(screen.queryByLabelText(/Aversa/)).toBeNull()
})
```

- [ ] **Step 2: Verificare il rosso**

```bash
npx vitest run __tests__/components/CandidaturaInsegnanteWizard-sede.test.tsx
```

- [ ] **Step 3: Implementare — additivo**

In `SediPubbliche`, accanto a `sedeScelta`/`scegliSede`, aggiungere:

```ts
  /**
   * Le sedi spuntate, quando il modulo ne ammette più d'una.
   *
   * ⚠️ Convive con `sedeScelta` invece di sostituirla, e non è indecisione:
   * `AnagraficaPersonaleWizard` usa questo stesso hook a sede singola e deve
   * uscire da qui identico. `sedeScelta` resta la prima di questo elenco, così
   * ogni ramo che già la legge continua a leggere qualcosa di vero.
   */
  sediScelte: string[]
  /** Spunta o toglie la spunta a una sede. */
  commutaSede: (id: string) => void
  /** Le sedi che partiranno nel POST: il link se regge, altrimenti le spunte. */
  sediDecise: string[]
```

Nell'implementazione, `sediScelte` è lo stato (`useState<string[]>([])`), `sedeScelta` diventa `sediScelte[0] ?? null`, e `sediDecise` è `sedeDaLink !== null ? [sedeDaLink] : sediScelte`. L'auto-scelta con un solo plesso (riga ~265) diventa `if (lista.length === 1) setSediScelte([lista[0].id])`. `sedeSmentitaDalServer` azzera l'elenco.

`mostraSede` **non cambia**: `sedeDaLink === null && (giaCompilato || sedi.length > 1)`. È la riga che tiene `?sede=` esattamente com'è.

- [ ] **Step 4: Verificare che l'ALTRO modulo non sia cambiato**

```bash
npx vitest run __tests__/components/AnagraficaPersonaleWizard*.test.tsx __tests__/components/CandidaturaInsegnanteWizard-sede.test.tsx
```

Atteso: **PASS**. Se un test di `AnagraficaPersonaleWizard` cade, l'aggiunta non era additiva: rivederla.

- [ ] **Step 5: Commit**

```bash
git add src/components/features/public/wizard/use-sedi-pubbliche.ts __tests__/components/CandidaturaInsegnanteWizard-sede.test.tsx
git commit -m "L'elenco delle sedi impara il plurale, e il modulo del personale non se ne accorge"
```

---

## Task 10: Le card diventano caselle, il riepilogo dice «Sedi»

**Files:**
- Modify: `src/components/features/public/CandidaturaInsegnanteWizard.tsx:1535-1685` (le card), `:835-840` (la validazione del passo), `:918,960` (l'invio), `:1087,1197` (il riepilogo)
- Modify: `messages/it/public.json:29-33`, `messages/en/public.json:29-33`
- Test: `__tests__/components/CandidaturaInsegnanteWizard-sede.test.tsx`, `-riepilogo.test.tsx`, `candidatura-card-di-scelta-unico-linguaggio.test.tsx`

⚠️ Il lock `__tests__/components/candidatura-card-di-scelta-unico-linguaggio.test.tsx` **rende entrambe le famiglie di card e confronta le classi calcolate**. Le classi della card (`border-kidville-green bg-kidville-green-soft` da scelta, `border-kidville-neutral bg-kidville-white` a riposo, `border-[1.5px] border-kidville-error` in errore) **non cambiano**: cambia solo `type="radio"` → `type="checkbox"`.

- [ ] **Step 1: I testi**

`messages/it/public.json`:

```json
  "candSede": "Sedi",
  "candSedeSub": "Scegli uno o più plessi a cui vuoi proporti",
  "candSedeLegenda": "Sedi della candidatura",
  "candSedeErrore": "Scegli almeno una sede per proseguire",
```

`messages/en/public.json`:

```json
  "candSede": "Locations",
  "candSedeSub": "Choose one or more locations you want to apply to",
  "candSedeLegenda": "Application locations",
  "candSedeErrore": "Choose at least one location to continue",
```

`candSedeDalLinkTitolo` **non cambia**: con `?sede=` la sede è una sola, e la frase al singolare è quella giusta.

- [ ] **Step 2: Le card**

Nella `<fieldset>` (riga ~1535): sostituire `const scelta = sedeScelta === s.id` con `const scelta = sediScelte.includes(s.id)`, e sull'`<input>`:

```tsx
                            type="checkbox"
                            id={`sede-${s.id}`}
                            name="sedi"
                            value={s.id}
                            ref={i === 0 ? primaCasellaRef : undefined}
                            checked={scelta}
                            onChange={() => {
                              commutaSede(s.id)
                              // ⚠️ L'avviso si spegne solo se dopo questo gesto
                              // RESTA almeno una spunta. Con i radio bastava
                              // toccarne uno — sceglierne uno E averne uno erano
                              // lo stesso fatto. Con le caselle non lo sono più:
                              // TOGLIERE l'ultima spunta è un gesto che riporta
                              // il passo esattamente nello stato che l'avviso
                              // descrive, e spegnerlo lì direbbe che il problema
                              // è risolto mentre si è appena ricreato.
                              const dopo = scelta
                                ? sediScelte.filter((x) => x !== s.id)
                                : [...sediScelte, s.id]
                              if (dopo.length > 0) { setErroreSede(false); setErroreInvio(null) }
                            }}
                            className="h-4 w-4 accent-kidville-green"
```

⚠️ `primoRadioRef` **si rinomina** in `primaCasellaRef` (dichiarazione a riga ~514, uso a `:613` e qui): un nome che dice «radio» su una casella è la prossima persona che cerca un radio che non c'è.

- [ ] **Step 3: La validazione del passo e l'invio**

Riga ~835: `if (!sedeScelta)` → `if (sediScelte.length === 0)`.
Riga ~918: `const sede = sedeDecisa; if (!sede)` → `const sedi = sediDecise; if (sedi.length === 0)`.
Riga ~960: `scuola_id: sede` → `scuole_ids: sedi`.
Il ramo `SEDE_DA_SPECIFICARE` (riga ~975): `sedeSmentitaDalServer(sede)` → `sedeSmentitaDalServer(sedi[0])`.

- [ ] **Step 4: Il riepilogo**

Riga ~1087 e ~1197: il blocco «Sede» diventa «Sedi» e stampa **i nomi di tutte** le sedi decise, separati da virgola. Chi arriva al riepilogo deve vedere dove sta mandando la candidatura — è il passo che esiste perché fino all'11/08/2026 mostrava due fatti su tredici.

- [ ] **Step 5: Eseguire tutti i test del wizard**

```bash
npx vitest run __tests__/components/CandidaturaInsegnanteWizard-sede.test.tsx \
  __tests__/components/CandidaturaInsegnanteWizard-riepilogo.test.tsx \
  __tests__/components/candidatura-card-di-scelta-unico-linguaggio.test.tsx \
  __tests__/components/CandidaturaInsegnanteWizard-errore-invio.test.tsx \
  __tests__/components/CandidaturaInsegnanteWizard-forma-visiva.test.tsx
```

Atteso: **PASS** su tutti e cinque.

- [ ] **Step 6: Provarlo davvero, nel browser**

Con il server su `:3100`, aprire `/lavora-con-noi`, spuntare **due** sedi, arrivare al riepilogo e verificare che le nomini entrambe. Poi aprire `/lavora-con-noi?sede=d53b0fbc-a9eb-4073-b302-73d1d5abd529` e verificare che il passo **non compaia**: `?sede=` non è cambiato.

⚠️ **Non inviare davvero**: la porta pubblica scrive nel database di produzione.

- [ ] **Step 7: Commit**

```bash
git add src/components/features/public/CandidaturaInsegnanteWizard.tsx messages/ __tests__/components/
git commit -m "Nel modulo le sedi si spuntano, e togliere l'ultima spunta non spegne l'avviso"
```

---

## Task 11: Il cockpit filtra e valuta per sede

**Files:**
- Modify: `src/app/api/admin/candidature-insegnanti/route.ts:288-296` (elenco), `:255-300` (dettaglio), `:455-546` (gate curriculum), `:556-604` (`cambiaStato`), `:311-360` (PATCH)
- Test: `__tests__/api/candidature-insegnanti-scope-sede.test.ts`, `-approva.test.ts`, `-rifiuta.test.ts`, `-gate.test.ts`

- [ ] **Step 1: Scrivere i test**

I mock di Supabase, `requireStaff` e `resolveScuoleAttive` **si copiano da
`candidature-insegnanti-scope-sede.test.ts`**, che li ha già nella forma giusta.
Lo scenario comune: una candidatura **arrivata a Giugliano** (`scuola_id = GIUGLIANO`)
e **rivolta a Giugliano e Aversa**, con un operatore della sola **Aversa**.

```ts
it('l’elenco mostra una candidatura rivolta ANCHE alla mia sede, non solo quella arrivata da me', async () => {
  staffDi([AVERSA])
  const body = await (await GET(richiestaElenco())).json()
  expect(body.data.map((r: { id: string }) => r.id)).toContain(CANDIDATURA)
})

it('una candidatura compare UNA volta, non una per sede: si cerca una persona, non una pratica', async () => {
  staffDi([GIUGLIANO, AVERSA]) // entrambe le sedi sono sue
  const body = await (await GET(richiestaElenco())).json()
  const id = body.data.map((r: { id: string }) => r.id)
  expect(id.filter((x: string) => x === CANDIDATURA)).toHaveLength(1)
  expect(body.total).toBe(1) // ⚠️ il conteggio non deve sdoppiare col join
})

it('la riga porta lo stato DELLA MIA sede', async () => {
  statoDiSede(CANDIDATURA, GIUGLIANO, 'rifiutata')
  statoDiSede(CANDIDATURA, AVERSA, 'pending')
  staffDi([AVERSA])
  const body = await (await GET(richiestaElenco())).json()
  expect(body.data[0].stato).toBe('pending')
})

it('la scheda dice le altre sedi e il loro stato: chi valuta deve sapere che è in gioco altrove', async () => {
  staffDi([AVERSA])
  const body = await (await GET(richiestaDettaglio(CANDIDATURA))).json()
  expect(body.data.sedi).toEqual(expect.arrayContaining([
    { scuola_id: GIUGLIANO, stato: 'pending' },
    { scuola_id: AVERSA, stato: 'pending' },
  ]))
})

it('il curriculum si apre se la candidatura è rivolta a una MIA sede, anche se è arrivata da un’altra', async () => {
  staffDi([AVERSA])
  expect((await GET(richiestaCurriculum('candidature/abc.pdf'))).status).toBe(200)
})

it('il curriculum NON si apre se nessuna delle sue sedi è mia, e il messaggio è lo stesso del 404', async () => {
  staffDi([CESA])
  const res = await GET(richiestaCurriculum('candidature/abc.pdf'))
  expect(res.status).toBe(403)
  // Un messaggio diverso da quello del 404 direbbe a chi non ha titolo che quella
  // candidatura esiste: è l'oracolo di enumerazione che il messaggio unico chiude.
  expect((await res.json()).error).toContain('non esiste, oppure appartiene a un')
})

it('rifiutare tocca SOLO la mia riga di sede: l’altra resta pending', async () => {
  staffDirezioneDi([AVERSA])
  await PATCH(richiestaPatch({ id: CANDIDATURA, action: 'rifiuta', motivo: 'no' }))
  expect(statoScrittoSu(AVERSA)).toBe('rifiutata')
  expect(statoScrittoSu(GIUGLIANO)).toBeUndefined()
})

it('rifiutata la mia sede, la candidatura resta pending finché l’altra decide', async () => {
  // Lo stato aggregato lo scrive il TRIGGER, non la route: la route non deve
  // toccare `candidature_insegnanti.stato`. Se lo toccasse, due autorità
  // scriverebbero la stessa colonna.
  staffDirezioneDi([AVERSA])
  await PATCH(richiestaPatch({ id: CANDIDATURA, action: 'rifiuta', motivo: 'no' }))
  expect(scrittureSu('candidature_insegnanti')).toHaveLength(0)
})

it('operatore multi-sede senza scuola_id nel corpo → 400, non una sede indovinata', async () => {
  staffDirezioneDi([GIUGLIANO, AVERSA])
  const res = await PATCH(richiestaPatch({ id: CANDIDATURA, action: 'approva' }))
  expect(res.status).toBe(400)
})

it('l’email di esito nomina la sede CHE HA RIFIUTATO, non quella di primo arrivo', async () => {
  staffDirezioneDi([AVERSA])
  await PATCH(richiestaPatch({ id: CANDIDATURA, action: 'rifiuta', motivo: 'no', scuola_id: AVERSA }))
  expect(risolviContestoSede.mock.calls.at(-1)?.[1]).toBe(AVERSA)
})
```

- [ ] **Step 2: Verificare il rosso**

```bash
npx vitest run __tests__/api/candidature-insegnanti-scope-sede.test.ts
```

- [ ] **Step 3: Implementare**

**L'elenco** (riga ~288): il filtro passa dalle righe di sede. Con PostgREST si usa il join incorporato, con `!inner` perché il filtro deve restringere e non solo arricchire:

```ts
      supabase
        .from(TABELLA)
        .select(`${colonne}, sedi:candidature_sedi!inner(scuola_id, stato)`, { count: 'exact' })
        .in('candidature_sedi.scuola_id', scuole)
        .order('creata_il', { ascending: false })
        .range(offset, offset + limit - 1),
```

⚠️ `!inner` **con `count: 'exact'` su un join uno-a-molti può contare più volte la stessa candidatura**: verificarlo con un caso a due sedi entrambe visibili all'operatore, ed è precisamente ciò che il test «compare UNA volta» misura. Se il conteggio sdoppia, la strada è due query — prima gli `id` distinti dalle righe di sede, poi le candidature per quegli id — e la si documenta nel codice.

⚠️ **`.in('scuola_id', scuole)` sulla tabella madre va TOLTO**, non lasciato «per sicurezza»: due criteri di sede per la stessa risorsa sono due risposte diverse alla stessa domanda, e lasciandolo una candidatura arrivata a Giugliano e rivolta anche ad Aversa resterebbe invisibile alla segreteria di Aversa — cioè il difetto che questo task esiste per chiudere.

**Il gate del curriculum** (`assertCurriculumInScope`, riga ~455): la lettura `.eq('cv_path', docPath).in('scuola_id', scuole)` diventa una lettura che passa dalle righe di sede. Il **doppio messaggio** («non esiste, oppure appartiene a un'altra sede») e il log del tentativo cross-sede restano identici: sono la parte che impedisce l'enumerazione.

**`cambiaStato`** (riga ~556): scrive su `candidature_sedi` filtrando per `(candidatura_id, scuola_id)` con gli stati di partenza ammessi nel `WHERE` — è ciò che lo rende atomico, e resta. Lo `stato` della candidatura **non si scrive**: lo mette il trigger.

**Il PATCH** (riga ~311): il corpo accetta `scuola_id` facoltativo; la sede si risolve con `resolveScuolaScrittura`, che risponde **400** quando l'operatore ne ha più d'una e nessuna è indicata.

- [ ] **Step 4: Eseguire i test**

```bash
npx vitest run __tests__/api/candidature-insegnanti-*.test.ts
```

Atteso: **PASS** su tutti e sei.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/candidature-insegnanti/route.ts __tests__/api/
git commit -m "Il pannello vede le candidature rivolte alla propria sede, e ne valuta solo la propria riga"
```

---

## Task 12: Il pannello mostra le sedi

**Files:**
- Modify: `src/components/features/admin/iscrizioni/CandidatureInsegnanti.tsx`
- Test: `__tests__/components/CandidatureInsegnanti.test.tsx`

- [ ] **Step 1: Scrivere i test**

```tsx
it('la scheda elenca le sedi scelte con lo stato di ciascuna', async () => {
  render(<CandidatureInsegnanti />)
  await userEvent.click(await screen.findByText('Rossi Maria'))
  expect(await screen.findByText(/Kidville Giugliano/)).toBeInTheDocument()
  expect(screen.getByText(/Kidville Aversa/)).toBeInTheDocument()
})

it('la sede di chi guarda è distinguibile dalle altre', async () => {
  render(<CandidatureInsegnanti />) // operatore di Aversa
  await userEvent.click(await screen.findByText('Rossi Maria'))
  // Non basta che i nomi ci siano: chi guarda deve capire su QUALE riga sta
  // decidendo. Senza, con tre plessi si approva quello sbagliato.
  const propria = screen.getByTestId('sede-propria')
  expect(propria).toHaveTextContent(/Aversa/)
})

it('una candidatura già valutata altrove lo dice, e i propri pulsanti restano vivi', async () => {
  schedaCon([
    { scuola_id: GIUGLIANO, nome: 'Kidville Giugliano', stato: 'rifiutata' },
    { scuola_id: AVERSA, nome: 'Kidville Aversa', stato: 'pending' },
  ])
  render(<CandidatureInsegnanti />) // operatore di Aversa
  await userEvent.click(await screen.findByText('Rossi Maria'))
  expect(screen.getByText(/rifiutata/i)).toBeInTheDocument()
  // ⚠️ La decisione altrui NON spegne la propria: ogni sede valuta per conto suo,
  // ed è tutto il senso di questo lavoro.
  expect(screen.getByRole('button', { name: /Approva/ })).toBeEnabled()
})
```

- [ ] **Step 2: Verificare il rosso, implementare, rieseguire**

```bash
npx vitest run __tests__/components/CandidatureInsegnanti.test.tsx
```

Usare i token del design system Kidville — `#006A5F` (`kidville-green`), `#FDC400`, `#FEF1E4` — e le classi già in uso nel file. Il lock `design-tokens-admin.test.ts` sorveglia questa superficie.

- [ ] **Step 3: Commit**

```bash
git add src/components/features/admin/iscrizioni/CandidatureInsegnanti.tsx __tests__/components/CandidatureInsegnanti.test.tsx
git commit -m "La scheda dice a quali plessi la persona si è proposta, e come stanno"
```

---

## Task 13: I lock, il PRD, il gate

**Files:**
- Modify: `__tests__/architecture/isolamento-sede-coverage.test.ts`
- Modify: `PRD REGISTRO ELETTRONICO.md`

- [ ] **Step 1: Dichiarare le query nuove nel lock d'isolamento**

```bash
npx vitest run __tests__/architecture/isolamento-sede-coverage.test.ts
```

Il lock elencherà le query nuove su `candidature_sedi`. **Dichiararle** con il loro filtro di sede e alzare la soglia. ⚠️ **Nessuna finisce fra le esenzioni**: le uniche legittime di questa funzionalità sono quelle che già esistono per il cron di conservazione, che deve valere su tutte le sedi insieme.

- [ ] **Step 2: Il gate completo**

```bash
npx eslint . --max-warnings 0
npx tsc --noEmit
npx vitest run
npm run build
```

Atteso: **tutti e quattro verdi**. ⚠️ `npx tsc --noEmit` e `npm run build` cadono per cose diverse: nel repo è già successo che `vitest` fosse verde e `npm run build` rotta insieme. Si eseguono entrambi.

- [ ] **Step 3: Il PRD**

Aggiungere in `PRD REGISTRO ELETTRONICO.md` una voce di changelog datata **2026-08-19**, sul modello delle voci esistenti, e aggiornare le tabelle di stato in cima. Un intervento non è completo se il PRD non è allineato — è la regola 2 di `AGENTS.md`.

Cosa deve dire: il modulo pubblico porta il marchio; una candidatura può essere rivolta a più plessi e ogni plesso la valuta per conto suo; ogni plesso riceve una copia completa con il curriculum in allegato; la voce di `/privacy` ora dichiara che la copia in casella non è cancellata dal job di conservazione.

- [ ] **Step 4: Commit**

```bash
git add __tests__/architecture/isolamento-sede-coverage.test.ts "PRD REGISTRO ELETTRONICO.md"
git commit -m "I lock dichiarano le query nuove, e il PRD racconta cos'è cambiato"
```

---

## Verifica finale, prima di dire «fatto»

- [ ] `npx eslint . --max-warnings 0` → 0 errori
- [ ] `npx tsc --noEmit` → 0 errori
- [ ] `npx vitest run` → tutti verdi
- [ ] `npm run build` → ok
- [ ] `get_advisors` (security **e** performance) → **0 ERROR**
- [ ] `select count(*) from candidature_insegnanti c where not exists (select 1 from candidature_sedi s where s.candidatura_id = c.id)` → **0**
- [ ] altezza della testata a 360 px **misurata** e non peggiorata, numero annotato nel commento
- [ ] contrasto del logo in Alto Contrasto **misurato**
- [ ] E2E Playwright verde **in CI** (in locale è vietato: il seed scriverebbe in produzione)
- [ ] `CANDIDATURE_EMAIL_FALLBACK` impostata su Vercel (produzione **e** preview)
- [ ] **Una candidatura di prova inviata davvero** a una sede, e la copia **verificata nella casella** con l'allegato apribile. È l'unico modo di sapere se funziona: nel repo è già successo che un'operazione dichiarasse successo senza aver fatto niente, e che per mesi nessuna email arrivasse mentre nessun test era rosso.
