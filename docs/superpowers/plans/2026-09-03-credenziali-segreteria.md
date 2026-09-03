# La Segreteria rigenera le credenziali anche allo staff — piano di implementazione

> **Per chi esegue:** SKILL RICHIESTA: `superpowers:subagent-driven-development` (consigliata) oppure
> `superpowers:executing-plans`. I passi usano caselle (`- [ ]`) per essere spuntati.

**Obiettivo:** permettere a chi ha il ruolo `segreteria` di rigenerare le credenziali dello staff del
proprio plesso — con l'eccezione degli account di Direzione (`admin`, `coordinator`) — e aprirle il
rinvio credenziali in blocco, riparando prima il confinamento per sede che oggi non funziona.

**Architettura:** un predicato puro in un modulo nuovo, consultato da quattro chiamanti (due route e
due pannelli). Nessuna migrazione. Il confinamento per sede del rinvio in blocco passa dalle
primitive già collaudate `scuoleDiUtente` / `restringiSedi` / join `student_parents → alunni`,
invece che da un filtro su una colonna inesistente.

**Stack:** Next.js App Router (route handler), TypeScript, Supabase/PostgREST, `zod`, `vitest` +
Testing Library, `next-intl`.

**Specifica:** `docs/superpowers/specs/2026-09-03-credenziali-segreteria-design.md`

---

## Struttura dei file

| File | Responsabilità | Azione |
|---|---|---|
| `src/lib/auth/credenziali-staff.ts` | il predicato puro: chi può rigenerare le credenziali di chi | **creare** |
| `__tests__/lib/auth/credenziali-staff.test.ts` | tabella di verità del predicato | **creare** |
| `src/lib/ui/esito-fetch.ts` | dichiara i due codici d'errore nuovi | modificare |
| `messages/it/shared.json`, `messages/en/shared.json` | le due frasi, nelle due lingue | modificare |
| `src/app/api/admin/regenerate-credentials/route.ts` | applica il predicato sul ramo staff | modificare |
| `src/app/api/admin/credentials-pdf/route.ts` | applica lo stesso predicato al download del PDF | modificare |
| `src/app/api/admin/iscrizioni/rinvia-credenziali/route.ts` | gate aperto + confinamento sede riparato | modificare |
| `src/components/features/admin/StaffDetailPanel.tsx` | separa «modifica» da «rigenera» | modificare |
| `src/components/features/admin/settings/StaffPanel.tsx` | idem, per riga | modificare |
| `__tests__/api/regenerate-credentials.test.ts` | prove del nuovo gate | modificare |
| `__tests__/api/credentials-pdf-*.test.ts` | prova del PDF negato | creare/modificare |
| `__tests__/api/iscrizioni-rinvia-credenziali.test.ts` | prove di confinamento | modificare |
| `__tests__/components/StaffPanel-credenziali.test.tsx` | pulsanti visibili/nascosti | **creare** |
| `PRD REGISTRO ELETTRONICO.md` | changelog datato | modificare |

---

## Task 1: Il predicato, in un posto solo

**File:**
- Creare: `src/lib/auth/credenziali-staff.ts`
- Test: `__tests__/lib/auth/credenziali-staff.test.ts`

- [ ] **Passo 1: scrivere il test che fallisce**

```ts
import { describe, it, expect } from 'vitest'
import { puoRigenerareCredenzialiStaff } from '@/lib/auth/credenziali-staff'

describe('puoRigenerareCredenzialiStaff — chi rigenera le credenziali di chi', () => {
  it('la Direzione può su chiunque, Direzione compresa', () => {
    for (const attore of ['admin', 'coordinator'] as const) {
      for (const bersaglio of ['admin', 'coordinator', 'segreteria', 'educator', 'cuoca']) {
        expect(puoRigenerareCredenzialiStaff(attore, bersaglio)).toBe(true)
      }
    }
  })

  it('la Segreteria può sullo staff che non è Direzione', () => {
    for (const bersaglio of ['segreteria', 'educator', 'cuoca']) {
      expect(puoRigenerareCredenzialiStaff('segreteria', bersaglio)).toBe(true)
    }
  })

  it('la Segreteria NON può su admin e coordinator', () => {
    expect(puoRigenerareCredenzialiStaff('segreteria', 'admin')).toBe(false)
    expect(puoRigenerareCredenzialiStaff('segreteria', 'coordinator')).toBe(false)
  })

  it('chi non è staff di gestione non può mai', () => {
    for (const attore of ['educator', 'cuoca', 'genitore'] as const) {
      expect(puoRigenerareCredenzialiStaff(attore, 'educator')).toBe(false)
    }
  })

  /**
   * LA RIGA CHE CONTA. `null` arriva quando la lettura di `utenti` non ha
   * prodotto una riga — per assenza o per guasto. Se qui rispondesse `true`, un
   * guasto di lettura diventerebbe un permesso, ed è esattamente il modo in cui
   * un controllo di sicurezza smette di controllare senza che nessuno lo veda.
   */
  it('un bersaglio senza ruolo leggibile si nega, anche alla Direzione', () => {
    expect(puoRigenerareCredenzialiStaff('segreteria', null)).toBe(false)
    expect(puoRigenerareCredenzialiStaff('admin', null)).toBe(false)
    expect(puoRigenerareCredenzialiStaff('admin', '')).toBe(false)
    expect(puoRigenerareCredenzialiStaff('admin', 'ruolo_inventato')).toBe(false)
  })
})
```

- [ ] **Passo 2: eseguirlo e vederlo rosso**

Comando: `npx vitest run __tests__/lib/auth/credenziali-staff.test.ts`
Atteso: FAIL — `Failed to resolve import "@/lib/auth/credenziali-staff"`.

⚠️ Se invece dicesse «No test files found», il test **non è stato eseguito**: `vitest -t` con un
nome inesistente esce **0**. Guardare la riga «Test Files», non il codice di uscita.

- [ ] **Passo 3: scrivere l'implementazione minima**

```ts
import type { AppRole } from './predicati-ruolo'

/**
 * CHI PUÒ RIGENERARE LE CREDENZIALI DI CHI, detto in un posto solo.
 *
 * Lo consultano QUATTRO chiamanti: `admin/regenerate-credentials` (che fa il
 * reset), `admin/credentials-pdf` (che consegna il PDF con la password IN
 * CHIARO), e i due pannelli che mostrano o nascondono il pulsante. Se la regola
 * vivesse in due posti, il giorno in cui cambia ne cambierebbe uno solo — ed è
 * già successo in questo repo (vedi `formula-sezione-un-posto-solo`).
 *
 * PERCHÉ LA DIREZIONE È UN'ECCEZIONE, e non è prudenza astratta. Dopo il reset
 * il PDF con la password in chiaro viene notificato a CHI HA PREMUTO IL
 * PULSANTE, e `credentials-pdf` è aperta a tutto lo staff in scope di sede.
 * Senza questa riga, una segreteria di Aversa resetterebbe l'admin di Aversa —
 * che sta nel suo stesso plesso — ne leggerebbe la password e vi accederebbe.
 * Non è un rischio ipotetico: è il percorso di consegna già in esercizio.
 *
 * PERCHÉ LA MODIFICA DEL RUOLO RESTA ALLA DIREZIONE. Se la Segreteria potesse
 * cambiare il ruolo di un collega, promuoverebbe qualcuno ad `admin` e
 * otterrebbe per via indiretta ciò che questa funzione le nega. Le due riserve
 * si tengono in piedi a vicenda: togliendo l'altra, questa diventa decorativa.
 *
 * È PURA E STA IN UN MODULO SUO. 296 file di test sostituiscono
 * `@/lib/auth/require-staff` per intero: un predicato scritto lì dentro
 * verrebbe mockato via insieme all'I/O, e i test lo verificherebbero finto. È la
 * stessa ragione per cui esiste `predicati-ruolo.ts` — vedi la sua testata.
 */

/** I ruoli che questa funzione riconosce come bersaglio. Fuori da qui: si nega. */
const RUOLI_NOTI = new Set<string>(['admin', 'coordinator', 'segreteria', 'educator', 'cuoca', 'genitore'])

/** Gli account la cui password vale l'intero plesso: solo la Direzione li tocca. */
const DIREZIONE = new Set<string>(['admin', 'coordinator'])

export function puoRigenerareCredenzialiStaff(
  attore: AppRole,
  ruoloBersaglio: string | null | undefined,
): boolean {
  // Si nega ciò che non si è riusciti a leggere. Un `maybeSingle()` che torna
  // `null` — per assenza o per guasto — non deve mai diventare un permesso.
  if (!ruoloBersaglio || !RUOLI_NOTI.has(ruoloBersaglio)) return false
  if (attore === 'admin' || attore === 'coordinator') return true
  if (attore === 'segreteria') return !DIREZIONE.has(ruoloBersaglio)
  return false
}
```

- [ ] **Passo 4: eseguirlo e vederlo verde**

Comando: `npx vitest run __tests__/lib/auth/credenziali-staff.test.ts`
Atteso: PASS, 5 test.

- [ ] **Passo 5: la controprova — rompere il codice e guardare il test diventare rosso**

Sostituire temporaneamente il corpo con `return true`, rieseguire: devono diventare **rosse** almeno
«la Segreteria NON può su admin e coordinator», «chi non è staff di gestione» e «un bersaglio senza
ruolo leggibile». Poi ripristinare.

*Un test mai visto fallire non è un test.* In questo repo un difetto delle classi vuote è passato con
13.254 test verdi perché il mock rispondeva uguale a tutto.

- [ ] **Passo 6: commit**

```bash
git add src/lib/auth/credenziali-staff.ts __tests__/lib/auth/credenziali-staff.test.ts
git commit -m "Il permesso sulle credenziali dello staff smette di essere una riga dentro una route"
```

---

## Task 2: I due codici d'errore e le loro frasi

Il lock `__tests__/architecture/errori-con-codice.test.ts` pretende che ogni `codice:` scritto in
`src/` sia dichiarato in `CODICI_ERRORE` e tradotto in **entrambe** le lingue. Questo task va **prima**
delle route, altrimenti il lock diventa rosso a metà lavoro.

**File:**
- Modificare: `src/lib/ui/esito-fetch.ts`
- Modificare: `messages/it/shared.json`, `messages/en/shared.json`

- [ ] **Passo 1: dichiarare i codici**

In `CODICI_ERRORE`, subito dopo `RINVIO_CREDENZIALI_RISERVATO`:

```ts
    /**
     * 403 — le credenziali di un account di DIREZIONE si rigenerano dalla
     * Direzione (`admin/regenerate-credentials:POST`, `admin/credentials-pdf:GET`).
     *
     * La Segreteria rigenera le credenziali dello staff del proprio plesso, ma
     * non quelle di `admin`/`coordinator`: chi preme il pulsante riceve un PDF
     * con la password IN CHIARO, e su un account di Direzione quello sarebbe un
     * passaggio di consegne, non un recupero credenziali.
     */
    CREDENZIALI_STAFF_RISERVATE: 'erroreCredenzialiStaffRiservate',
    /** 403 — chi chiede il rinvio in blocco non ha nessun plesso: nessuna famiglia da servire. */
    RINVIO_NESSUN_PLESSO: 'erroreRinvioNessunPlesso',
```

- [ ] **Passo 2: le frasi italiane**

In `messages/it/shared.json`, accanto a `erroreRinvioCredenzialiRiservato`:

```json
  "erroreCredenzialiStaffRiservate": "Le credenziali di un account di Direzione si rigenerano dalla Direzione",
  "erroreRinvioNessunPlesso": "Nessuna sede associata al tuo account: non c'è nessuna famiglia da servire",
```

- [ ] **Passo 3: le frasi inglesi**

In `messages/en/shared.json`, nella stessa posizione:

```json
  "erroreCredenzialiStaffRiservate": "Credentials for a management account can only be reset by management",
  "erroreRinvioNessunPlesso": "No site is linked to your account: there are no families to serve",
```

- [ ] **Passo 4: verificare il lock**

Comando: `npx vitest run __tests__/architecture/errori-con-codice.test.ts`
Atteso: PASS. (Verde anche prima delle route: i codici dichiarati e non ancora usati sono ammessi;
l'inverso no.)

- [ ] **Passo 5: commit**

```bash
git add src/lib/ui/esito-fetch.ts messages/it/shared.json messages/en/shared.json
git commit -m "Due dinieghi nuovi nascono già con un codice e due lingue, non con una frase italiana"
```

---

## Task 3: `regenerate-credentials` applica il predicato

**File:**
- Modificare: `src/app/api/admin/regenerate-credentials/route.ts:53-63` (il gate) e il `select` del
  ramo staff (~riga 155)
- Test: `__tests__/api/regenerate-credentials.test.ts`

- [ ] **Passo 1: scrivere le prove che falliscono**

In coda a `__tests__/api/regenerate-credentials.test.ts`, un blocco nuovo. Il finto client di questo
file risponde `h.adminRow` a ogni `select` **tranne** `utenti`+`ruolo` (che è la guardia
anti-lockout del ramo genitore e risponde `h.utentiRuolo`): il ramo staff legge quindi `adminRow`, ed
è lì che si mette il `ruolo` del bersaglio.

```ts
describe('credenziali staff — la Segreteria sì, sulla Direzione no', () => {
  beforeEach(() => {
    h.requireStaff.mockReset()
    h.sendEmail.mockReset()
    h.sendEmail.mockResolvedValue({ ok: true })
    h.logScrittura.mockReset()
    h.updates.length = 0
    h.updateError = null
  })

  /** L'attore, con il ruolo che si vuole provare. */
  function come(role: string) {
    h.requireStaff.mockResolvedValue({ user: { id: 'attore-1', role, scuola_id: 'sede-1' } })
  }

  /** Il bersaglio staff: è la riga che il ramo `else` della route legge da `utenti`. */
  function bersaglioStaff(ruolo: string) {
    h.adminRow = {
      data: { id: 'staff-1', email: 'p@x.it', nome: 'Rosa', scuola_id: 'sede-1', ruolo },
      error: null,
    }
  }

  it('segreteria → educator: rigenera', async () => {
    come('segreteria')
    bersaglioStaff('educator')
    const res = await POST(req({ targetKind: 'staff', targetId: '11111111-1111-4111-8111-111111111111' }))
    expect(res.status).toBe(200)
    expect(h.updates).toHaveLength(1)
  })

  it('segreteria → cuoca: rigenera', async () => {
    come('segreteria')
    bersaglioStaff('cuoca')
    const res = await POST(req({ targetKind: 'staff', targetId: '11111111-1111-4111-8111-111111111111' }))
    expect(res.status).toBe(200)
  })

  it('segreteria → altra segreteria: rigenera', async () => {
    come('segreteria')
    bersaglioStaff('segreteria')
    const res = await POST(req({ targetKind: 'staff', targetId: '11111111-1111-4111-8111-111111111111' }))
    expect(res.status).toBe(200)
  })

  it('segreteria → admin: 403, e LA PASSWORD NON VIENE TOCCATA', async () => {
    come('segreteria')
    bersaglioStaff('admin')
    const res = await POST(req({ targetKind: 'staff', targetId: '11111111-1111-4111-8111-111111111111' }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('CREDENZIALI_STAFF_RISERVATE')
    // Il controllo che conta: non basta il 403 se la password è già cambiata.
    expect(h.updates).toHaveLength(0)
  })

  it('segreteria → coordinator: 403', async () => {
    come('segreteria')
    bersaglioStaff('coordinator')
    const res = await POST(req({ targetKind: 'staff', targetId: '11111111-1111-4111-8111-111111111111' }))
    expect(res.status).toBe(403)
    expect(h.updates).toHaveLength(0)
  })

  it('admin → admin: continua a rigenerare (non regredisce)', async () => {
    come('admin')
    bersaglioStaff('admin')
    const res = await POST(req({ targetKind: 'staff', targetId: '11111111-1111-4111-8111-111111111111' }))
    expect(res.status).toBe(200)
    expect(h.updates).toHaveLength(1)
  })

  /**
   * Il ruolo del bersaglio non è leggibile: 403, non 200. La route NON deve
   * ricadere sul permesso quando la riga è muta.
   */
  it('bersaglio senza ruolo leggibile: si nega, e non si tocca la password', async () => {
    come('segreteria')
    h.adminRow = { data: { id: 'staff-1', email: 'p@x.it', nome: 'Rosa', scuola_id: 'sede-1', ruolo: null }, error: null }
    const res = await POST(req({ targetKind: 'staff', targetId: '11111111-1111-4111-8111-111111111111' }))
    expect(res.status).toBe(403)
    expect(h.updates).toHaveLength(0)
  })
})
```

- [ ] **Passo 2: eseguirle e vederle rosse**

Comando: `npx vitest run __tests__/api/regenerate-credentials.test.ts`
Atteso: FAIL sui tre casi `segreteria → educator/cuoca/segreteria`, che oggi ricevono **403** dal
gate vecchio. Gli altri sono già verdi: sono le prove di non regressione.

- [ ] **Passo 3: rimuovere il gate vecchio**

Cancellare `route.ts:53-63` per intero — il commento e le cinque righe:

```ts
  // Le credenziali dello STAFF sono un'operazione di Direzione (T3): la Segreteria
  // può resettare le credenziali dei GENITORI, non quelle del personale.
  if (targetKind === 'staff' && auth.user.role !== 'admin' && auth.user.role !== 'coordinator') {
    return NextResponse.json(
      { error: 'Credenziali staff: operazione riservata alla Direzione' },
      { status: 403 }
    );
  }
```

- [ ] **Passo 4: leggere il ruolo del bersaglio e applicare il predicato**

Nel ramo `else` (staff), sostituire le quattro righe che leggono `utenti` con:

```ts
  } else {
    // staff: utenti.id È l'auth.users id (FK utenti_id_fkey)
    //
    // `ruolo` è nel select perché da qui in giù serve a DECIDERE, non a mostrare:
    // la Segreteria rigenera le credenziali dello staff del proprio plesso ma non
    // quelle della Direzione, e il ruolo del bersaglio è l'unico modo di saperlo.
    const { data, error: erroreUtente } = await admin
      .from('utenti')
      .select('id, email, nome, scuola_id, ruolo')
      .eq('id', targetId)
      .maybeSingle();
    // PostgREST NON lancia: ritorna `{ error }` (AGENTS.md regola 7). Senza questa
    // riga un guasto di lettura diventerebbe «ruolo assente» → 403: un diniego
    // indistinguibile da un tentativo vero, che riempirebbe di rumore un contatore
    // nato come segnale di sicurezza. E il giorno in cui il guasto fosse
    // intermittente, la Segreteria vedrebbe «riservato alla Direzione» a caso.
    if (erroreUtente) {
      logErrore({ operazione: 'admin/regenerate-credentials:POST', stato: 500, evento: 'db' }, erroreUtente);
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: 'Utente staff non trovato' }, { status: 404 });
    const riga = data as { id: string; email: string | null; nome: string | null; scuola_id: string | null; ruolo: string | null };

    // IL GATE, e sta QUI e non in cima di proposito: l'ordine è
    // «prima la sede, poi il ruolo». `assertUtenteInScope` è già passato 40 righe
    // più su, quindi chi è fuori plesso ha già ricevuto «fuori dal tuo plesso» e
    // non arriva mai a sapere che ruolo abbia quella persona. Anticipare questo
    // controllo trasformerebbe la route in un modo per scoprire chi è admin in
    // una sede che non è la propria.
    if (!puoRigenerareCredenzialiStaff(auth.user.role, riga.ruolo)) {
      // `warn` → persistito: il tentativo di resettare un account di Direzione è
      // un segnale di sicurezza e deve lasciare traccia. Né l'uuid né il ruolo
      // del bersaglio: basta sapere che è successo, e a chi.
      logEvento('auth', 'warn', {
        tipo: 'credenziali-staff-riservate',
        azione: 'admin/regenerate-credentials:POST',
        utente: auth.user.id,
        ruolo: auth.user.role,
      });
      return NextResponse.json(
        {
          error: 'Le credenziali di un account di Direzione si rigenerano dalla Direzione',
          codice: 'CREDENZIALI_STAFF_RISERVATE',
        },
        { status: 403 },
      );
    }

    authId = riga.id;
    email = firstEmail(riga.email);
    nome = riga.nome;
    sedeId = riga.scuola_id ?? null;
  }
```

Aggiungere gli import in testa al file:

```ts
import { puoRigenerareCredenzialiStaff } from '@/lib/auth/credenziali-staff';
```

e aggiungere `logErrore` a quello già presente:

```ts
import { logErrore, logEvento } from '@/lib/logging/logger';
```

- [ ] **Passo 5: eseguire e vedere verde**

Comando: `npx vitest run __tests__/api/regenerate-credentials.test.ts __tests__/api/regenerate-credentials-bucket-log.test.ts`
Atteso: PASS su tutti.

- [ ] **Passo 6: la controprova**

Sostituire la condizione con `if (false)`: devono diventare **rosse** «segreteria → admin», «segreteria
→ coordinator» e «bersaglio senza ruolo leggibile». Poi ripristinare.

- [ ] **Passo 7: commit**

```bash
git add src/app/api/admin/regenerate-credentials/route.ts __tests__/api/regenerate-credentials.test.ts
git commit -m "A Cesa non c'è Direzione: la Segreteria rigenera le credenziali dello staff, non quelle di chi comanda"
```

---

## Task 4: il PDF applica la stessa regola

Senza questo task il Task 3 è aggirabile: la porta è chiusa e la finestra resta aperta. Una segreteria
che venisse a conoscenza della chiave del PDF di un admin — un collegamento inoltrato, una notifica
letta su uno schermo condiviso — lo scaricherebbe con la password in chiaro dentro.

**File:**
- Modificare: `src/app/api/admin/credentials-pdf/route.ts:62-78`
- Test: `__tests__/api/credentials-pdf-credenziali-direzione.test.ts` (**creare**)

- [ ] **Passo 1: scrivere il test che fallisce**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const stato = {
    requireStaff: vi.fn(),
    /** La riga di `utenti` per il bersaglio della chiave. `null` = non è staff. */
    utente: null as null | { id: string; scuola_id: string | null; ruolo: string | null },
    scaricati: [] as string[],
    creaFinto: () => ({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              table === 'utenti'
                ? { data: stato.utente, error: null }
                : { data: null, error: null },
          }),
        }),
      }),
      storage: {
        from: () => ({
          download: async (key: string) => {
            stato.scaricati.push(key)
            return { data: new Blob([new Uint8Array([37, 80, 68, 70])]), error: null }
          },
        }),
      },
    }),
  }
  return stato
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({
  assertUtenteInScope: vi.fn(async () => null),
  assertParentInScope: vi.fn(async () => null),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => h.creaFinto(),
  createClient: async () => h.creaFinto(),
}))

import { GET } from '@/app/api/admin/credentials-pdf/route'
import { NextRequest } from 'next/server'

const CHIAVE = '11111111-1111-4111-8111-111111111111-1756900000000.pdf'
const chiedi = () =>
  GET(new NextRequest(`http://localhost/api/admin/credentials-pdf?key=${encodeURIComponent(CHIAVE)}`))

describe('credentials-pdf — il PDF di un account di Direzione non si scarica dalla Segreteria', () => {
  beforeEach(() => {
    h.requireStaff.mockReset()
    h.scaricati.length = 0
  })

  it('segreteria che chiede il PDF di un admin: 403, e lo storage non viene toccato', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'a1', role: 'segreteria', scuola_id: 's1' } })
    h.utente = { id: 'staff-1', scuola_id: 's1', ruolo: 'admin' }
    const res = await chiedi()
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('CREDENZIALI_STAFF_RISERVATE')
    expect(h.scaricati).toHaveLength(0)
  })

  it('segreteria che chiede il PDF di una maestra del proprio plesso: passa', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'a1', role: 'segreteria', scuola_id: 's1' } })
    h.utente = { id: 'staff-1', scuola_id: 's1', ruolo: 'educator' }
    const res = await chiedi()
    expect(res.status).toBe(200)
    expect(h.scaricati).toEqual([CHIAVE])
  })

  it('admin che chiede il PDF di un admin: passa (non regredisce)', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'a1', role: 'admin', scuola_id: 's1' } })
    h.utente = { id: 'staff-1', scuola_id: 's1', ruolo: 'admin' }
    const res = await chiedi()
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Passo 2: eseguirlo e vederlo rosso**

Comando: `npx vitest run __tests__/api/credentials-pdf-credenziali-direzione.test.ts`
Atteso: FAIL sul primo caso — oggi risponde **200** e scarica.

- [ ] **Passo 3: implementare**

In `credentials-pdf/route.ts`, aggiungere `ruolo` al `select` e il controllo dopo lo scope:

```ts
  const { data: utente, error: errUtente } = await admin
    .from('utenti')
    .select('id, scuola_id, ruolo')
    .eq('id', targetId)
    .maybeSingle();
```

e, dentro il ramo `if (utente) { … }`, subito **dopo** `assertUtenteInScope`:

```ts
  if (utente) {
    const fuoriScope = await assertUtenteInScope(admin, auth.user, targetId);
    if (fuoriScope) return fuoriScope;
    // LA STESSA REGOLA DI `regenerate-credentials`, e per la stessa ragione: qui
    // dentro c'è la password IN CHIARO. Chiudere il reset e lasciare aperto il
    // download significherebbe chiudere la porta e lasciare la finestra — la
    // chiave viaggia in una notifica, e una notifica si inoltra.
    const ruoloBersaglio = (utente.ruolo as string | null) ?? null;
    if (!puoRigenerareCredenzialiStaff(auth.user.role, ruoloBersaglio)) {
      logEvento('auth', 'warn', {
        tipo: 'credenziali-staff-riservate',
        azione: 'admin/credentials-pdf:GET',
        utente: auth.user.id,
        ruolo: auth.user.role,
      });
      return NextResponse.json(
        {
          error: 'Le credenziali di un account di Direzione si rigenerano dalla Direzione',
          codice: 'CREDENZIALI_STAFF_RISERVATE',
        },
        { status: 403 },
      );
    }
    sedeTarget = (utente.scuola_id as string | null) ?? null;
  } else {
```

Import da aggiungere:

```ts
import { puoRigenerareCredenzialiStaff } from '@/lib/auth/credenziali-staff';
import { logErrore, logEvento } from '@/lib/logging/logger';
```

(`logErrore` è già importato: aggiungere solo `logEvento` alla stessa riga.)

- [ ] **Passo 4: eseguire e vedere verde**

Comando: `npx vitest run __tests__/api/credentials-pdf-credenziali-direzione.test.ts`
Atteso: PASS, 3 test.

- [ ] **Passo 5: commit**

```bash
git add src/app/api/admin/credentials-pdf/route.ts __tests__/api/credentials-pdf-credenziali-direzione.test.ts
git commit -m "Chiudere il reset e lasciare aperto il PDF non è chiudere: stessa regola sulle due porte"
```

---

## Task 5: il rinvio in blocco — riparare il confinamento PRIMA di aprirlo

Ordine obbligato: **prima** si ripara il filtro, **poi** si apre il gate. Aprire prima significherebbe
lasciare, anche solo per un commit, una segreteria di Cesa in grado di riscrivere 528 password.

**File:**
- Modificare: `src/app/api/admin/iscrizioni/rinvia-credenziali/route.ts:83-121`
- Test: `__tests__/api/iscrizioni-rinvia-credenziali.test.ts`

- [ ] **Passo 1: scrivere le prove che falliscono**

Aggiungere in coda al file di test esistente (adattando i finti già presenti nel file — leggerne la
testata prima di scrivere):

```ts
describe('rinvio in blocco — il perimetro non arriva più dal client', () => {
  it('la segreteria non riceve più 403: il gate la ammette', async () => {
    // attore: segreteria di sede-1, dry_run per non scrivere niente
    const res = await POST(req({ dry_run: true }, { role: 'segreteria', scuola_id: 'sede-1' }))
    expect(res.status).toBe(200)
  })

  it('una segreteria vede SOLO i genitori con figli nel proprio plesso', async () => {
    // il finto DB ha 3 genitori: due con figli in sede-1, uno in sede-2
    const res = await POST(req({ dry_run: true }, { role: 'segreteria', scuola_id: 'sede-1' }))
    expect((await res.json()).candidati).toBe(2)
  })

  it('una segreteria che chiede un ALTRO plesso: 403 SEDE_NON_ACCESSIBILE', async () => {
    const res = await POST(req({ dry_run: true, scuola_id: 'sede-2' }, { role: 'segreteria', scuola_id: 'sede-1' }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
  })

  /**
   * LA CONTROPROVA DI `formaConfronto`. In Postgres `uuid` è un TIPO: due
   * stringhe con maiuscole diverse sono lo STESSO valore. In JavaScript no — ed
   * è il difetto che il 2026-07-31 fece rispondere «403 sulla PROPRIA sede» a
   * una segreteria. `restringiSedi` confronta in forma canonica: qui si verifica
   * che non sia ricresciuto.
   */
  it('la PROPRIA sede scritta in MAIUSCOLO è ancora la propria sede', async () => {
    const res = await POST(
      { dry_run: true, scuola_id: 'SEDE-1' } as never,
      { role: 'segreteria', scuola_id: 'sede-1' } as never,
    )
    expect(res.status).toBe(200)
  })

  it('un utente senza plesso: 403 e nessuna password riscritta', async () => {
    const res = await POST(req({}, { role: 'segreteria', scuola_id: null }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('RINVIO_NESSUN_PLESSO')
  })

  it("l'admin senza scuola_id nel corpo copre i propri plessi, non tutto il database", async () => {
    const res = await POST(req({ dry_run: true }, { role: 'admin', scuola_id: 'sede-1' }))
    // il ponte utenti_scuole del finto dà sede-1 e sede-2 → tutti e 3 i genitori
    expect((await res.json()).candidati).toBe(3)
  })
})
```

⚠️ Il finto client di questo file va esteso perché sappia rispondere a `utenti_scuole` e alla join
`student_parents → alunni!inner(scuola_id)`. Un finto che risponde **uguale a ogni tabella** qui
non serve a niente: sposterebbe soltanto il guasto. Il finto deve **filtrare davvero** sulla sede,
altrimenti la prova «vede solo il proprio plesso» sarebbe verde anche senza la correzione.

- [ ] **Passo 2: eseguirle e vederle rosse**

Comando: `npx vitest run __tests__/api/iscrizioni-rinvia-credenziali.test.ts`
Atteso: FAIL — oggi la segreteria riceve 403 dal gate, e passando `scuola_id` la route dà **500**.

- [ ] **Passo 3: aprire il gate**

Sostituire il blocco `route.ts:84-94`:

```ts
    // Il rinvio in blocco è aperto allo staff di gestione, Segreteria compresa
    // (decisione del titolare, 2026-09-03): a Cesa non c'è nessun account di
    // Direzione, e la riserva lasciava due segreterie senza strumento.
    //
    // ⚠️ La riserva è stata sostituita da un CONFINAMENTO, non tolta: qui sotto
    // il perimetro si costruisce dalle sedi dell'attore e la sede del corpo può
    // solo restringerlo. Senza quel confinamento questa apertura manderebbe una
    // segreteria di Cesa a riscrivere le password di TUTTE le famiglie: 528
    // contro 156, misurate il 2026-09-03.
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
```

- [ ] **Passo 4: riparare e rendere obbligatorio il confinamento**

Sostituire il blocco `if (b.data.scuola_id) { … }` (`route.ts:109-121`) con:

```ts
    // ── IL PERIMETRO ────────────────────────────────────────────────────────
    // Fino al 2026-09-03 qui c'era `parents.eq('scuola_id', …)`, e `parents`
    // quella colonna NON CE L'HA (27 colonne, verificate sullo schema di
    // produzione): PostgREST rispondeva `42703` e la route dava 500. Il difetto
    // era invisibile perché l'unico che poteva chiamarla era l'admin multi-sede,
    // che la sede non la passa mai. Un genitore non HA una sede: ce l'hanno i
    // suoi figli, e possono averne due diverse.
    const plessi = await scuoleDiUtente(admin, auth.user)
    if (plessi.length === 0) {
        return NextResponse.json(
            { error: 'Nessuna sede associata al tuo account: non c\'è nessuna famiglia da servire', codice: 'RINVIO_NESSUN_PLESSO' },
            { status: 403 },
        )
    }
    // La sede del corpo può solo RESTRINGERE, mai allargare. `restringiSedi`
    // confronta in forma canonica: la propria sede scritta in maiuscolo resta la
    // propria (difetto del 2026-07-31), una sede altrui resta altrui.
    const scope = restringiSedi(plessi, b.data.scuola_id)
    if (!scope) return rifiutoSede('SEDE_NON_ACCESSIBILE')

    // I genitori del perimetro si risolvono DAI FIGLI, con la stessa join di
    // `assertParentInScope`. Sempre — non solo quando il corpo porta una sede.
    const { data: dellaSede, error: erroreSede } = await admin
        .from('student_parents')
        .select('parent_id, alunni!inner(scuola_id)')
        .in('alunni.scuola_id', scope)
    if (erroreSede) {
        logEvento('iscrizione', 'error', { operazione: OPERAZIONE, esito: 'sede-non-risolta' }, erroreSede)
        return NextResponse.json({ error: 'Sede non risolta', codice: 'RINVIO_SEDE_NON_RISOLTA' }, { status: 500 })
    }
    // SEMPRE, anche quando l'elenco è vuoto. Un perimetro vuoto è una risposta
    // legittima — «nessuna famiglia da rimandare» — e la route la produce già da
    // sola: `in('parent_id', [])` restituisce zero righe, il ciclo non gira e i
    // contatori restano a zero. Un ritorno anticipato qui duplicherebbe la forma
    // della risposta finale, ed è il modo in cui due risposte per lo stesso esito
    // cominciano a divergere.
    const idGenitori = [...new Set((dellaSede ?? []).map((r) => String(r.parent_id)))]
    query = query.in('parent_id', idGenitori)
```

Import da aggiungere in testa:

```ts
import { restringiSedi, scuoleDiUtente } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
```

⚠️ Nessun ritorno anticipato sul perimetro vuoto, e nessuna funzione nuova: il flusso normale è già
corretto. La route ha **una sola** costruzione della risposta finale, e deve restare una sola.

- [ ] **Passo 5: eseguire e vedere verde**

Comando: `npx vitest run __tests__/api/iscrizioni-rinvia-credenziali.test.ts`
Atteso: PASS.

- [ ] **Passo 6: la controprova**

Sostituire `.in('alunni.scuola_id', scope)` con `.in('alunni.scuola_id', plessi)` **e** far tornare
`scuoleDiUtente` tutte le sedi: la prova «vede SOLO i genitori del proprio plesso» deve diventare
**rossa**. Se resta verde, il finto non filtra e la prova non prova niente. Poi ripristinare.

- [ ] **Passo 7: commit**

```bash
git add src/app/api/admin/iscrizioni/rinvia-credenziali/route.ts __tests__/api/iscrizioni-rinvia-credenziali.test.ts
git commit -m "Il filtro di sede del rinvio in blocco cercava una colonna che parents non ha mai avuto"
```

---

## Task 6: i due pannelli separano «modifica» da «rigenera»

**File:**
- Modificare: `src/components/features/admin/settings/StaffPanel.tsx:22, 126-133`
- Modificare: `src/components/features/admin/StaffDetailPanel.tsx:522, 1431-1470`
- Test: `__tests__/components/StaffPanel-credenziali.test.tsx` (**creare**)

- [ ] **Passo 1: scrivere il test che fallisce**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StaffPanel } from '@/components/features/admin/settings/StaffPanel'

const h = vi.hoisted(() => ({ role: 'segreteria' as string }))

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'u1', role: h.role, ready: true }),
}))
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }))
vi.mock('@/lib/auth/ruoli', () => ({
  RUOLI_ASSEGNABILI: [],
  useLabelRuolo: () => (r: string) => r,
}))

const STAFF = [
  { id: 's-edu', nome: 'Rosa', cognome: 'Bianchi', email: 'r@x.it', ruolo: 'educator', scuola_id: 'sede-1' },
  { id: 's-adm', nome: 'Luigi', cognome: 'Verdi', email: 'l@x.it', ruolo: 'admin', scuola_id: 'sede-1' },
]

beforeEach(() => {
  h.role = 'segreteria'
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes('/api/admin/staff')) return new Response(JSON.stringify({ data: STAFF }), { status: 200 })
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }) as unknown as typeof fetch
})

describe('StaffPanel — il pulsante «rigenera» dipende da CHI si sta guardando', () => {
  it('la segreteria vede «rigenera» sulla maestra e NON sull\'admin', async () => {
    render(<StaffPanel userId="u1" />)
    const riga = await screen.findByText('Bianchi')
    const rigaAdmin = await screen.findByText('Verdi')
    expect(riga.closest('div')?.parentElement?.querySelector('[title="stRigeneraCredenziali"]')).not.toBeNull()
    expect(rigaAdmin.closest('div')?.parentElement?.querySelector('[title="stRigeneraCredenziali"]')).toBeNull()
  })

  it('la segreteria non vede MAI «modifica», nemmeno sulla maestra', async () => {
    render(<StaffPanel userId="u1" />)
    await screen.findByText('Bianchi')
    expect(screen.queryByTitle('stModifica')).toBeNull()
  })

  it("l'admin vede entrambi su tutti (non regredisce)", async () => {
    h.role = 'admin'
    render(<StaffPanel userId="u1" />)
    await screen.findByText('Bianchi')
    expect(screen.getAllByTitle('stRigeneraCredenziali')).toHaveLength(2)
    expect(screen.getAllByTitle('stModifica')).toHaveLength(2)
  })
})
```

⚠️ I selettori qui sopra sono una **bozza**: verificare contro il DOM reale del componente prima di
darli per buoni, e preferire `within(riga)` a `closest()`. La memoria del repo registra che
`getByText` pesca i sosia — un test che passa restando sull'elemento sbagliato è peggio di nessun
test.

- [ ] **Passo 2: eseguirlo e vederlo rosso**

Comando: `npx vitest run __tests__/components/StaffPanel-credenziali.test.tsx`
Atteso: FAIL — oggi la segreteria non vede nessuno dei due pulsanti.

- [ ] **Passo 3: `StaffPanel.tsx`**

Riga 22 e dintorni:

```tsx
  const { role } = useSessionIdentity();
  // DUE POTERI, non uno. Fino al 2026-09-03 `canEdit` governava insieme la
  // modifica di ruolo/sede/classi e la rigenerazione delle credenziali: sono
  // cose diverse e vanno chieste separatamente. La modifica del ruolo resta
  // della Direzione, ed è ciò che impedisce a una segreteria di promuovere un
  // collega ad `admin` e ottenere per via indiretta ciò che le si nega.
  const canEdit = role === 'admin' || role === 'coordinator';
```

E nel corpo della riga (sostituire il blocco `{canEdit && (<> … </>)}`):

```tsx
                    {/* «Rigenera» dipende dal BERSAGLIO, «Modifica» no. Nascondere
                        un pulsante è una cortesia — niente comandi che finiscono
                        sempre in un 403 — non una difesa: il gate vero è sul server. */}
                    {puoRigenerareCredenzialiStaff(role as AppRole, u.ruolo) && (
                      <button onClick={() => rigenera(u)} disabled={regenId === u.id} className="text-kidville-muted hover:text-kidville-green disabled:opacity-40" title={t('stRigeneraCredenziali')}>
                        {regenId === u.id ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
                      </button>
                    )}
                    {canEdit && (
                      <button onClick={() => apri(u)} className="text-kidville-muted hover:text-kidville-green" title={t('stModifica')}><Pencil size={15} /></button>
                    )}
```

Import:

```tsx
import { puoRigenerareCredenzialiStaff } from '@/lib/auth/credenziali-staff';
import type { AppRole } from '@/lib/auth/predicati-ruolo';
```

- [ ] **Passo 4: `StaffDetailPanel.tsx`**

Riga 522, accanto a `canEdit`:

```tsx
  const canEdit = role === 'admin' || role === 'coordinator';
  /**
   * IL SECONDO POTERE, che fino al 2026-09-03 viaggiava dentro il primo.
   * Dipende da CHI è aperto nella scheda, non solo da chi guarda: la Segreteria
   * rigenera le credenziali di una maestra ma non quelle della Direzione.
   * `member` è `null` finché la scheda carica → nessun pulsante, che è la
   * risposta giusta: non si offre un comando su una persona che non si conosce.
   */
  const canRigenerare = puoRigenerareCredenzialiStaff(role as AppRole, member?.ruolo ?? null);
```

⚠️ `member` è dichiarato **sotto** questa riga nel file attuale: spostare `canRigenerare` dopo la
`useState` di `member`, oppure spostare la `useState` sopra. Non lasciare un uso prima della
dichiarazione — `tsc` lo prende, ma il piano lo dice perché è il punto in cui è facile sbagliare.

Il footer (righe ~1431-1470) diventa:

```tsx
      {tab === 'incarico' && (canEdit || canRigenerare ? (
        <div className="space-y-2 border-t border-kidville-line p-5">
          {!editMode ? (
            <>
              {canEdit && (
                <button onClick={apri}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-pill bg-kidville-green font-barlow text-sm font-black uppercase tracking-wide text-kidville-yellow transition-all hover:opacity-90 active:scale-[0.98]">
                  <Pencil size={15} /> {t('staffDModifica')}
                </button>
              )}
              {canRigenerare && (
                <button onClick={rigenera} disabled={regenBusy}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-pill border-2 border-kidville-green/40 font-barlow text-sm font-bold uppercase text-kidville-green transition-all hover:bg-kidville-green/5 disabled:opacity-50">
                  {regenBusy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} {t('rigeneraCredenziali')}
                </button>
              )}
            </>
          ) : (
```

Il ramo `editMode` (Salva/Annulla) resta identico: ci si entra solo da «Modifica», che è di `canEdit`.

Il ramo `else` — la fascia «azioni riservate» — resta e ora significa ciò che dice: nessuno dei due
poteri.

- [ ] **Passo 5: eseguire e vedere verde**

Comando: `npx vitest run __tests__/components/StaffPanel-credenziali.test.tsx __tests__/components/StaffDetailPanel-anagrafica.test.tsx`
Atteso: PASS. Se `StaffDetailPanel-anagrafica` diventa rosso, leggerne il motivo: potrebbe
legittimamente asserire sul footer vecchio, e in quel caso va aggiornato — **non silenziato**.

- [ ] **Passo 6: commit**

```bash
git add src/components/features/admin/settings/StaffPanel.tsx src/components/features/admin/StaffDetailPanel.tsx __tests__/components/StaffPanel-credenziali.test.tsx
git commit -m "Un interruttore solo governava due poteri diversi: si separano"
```

---

## Task 7: il gate completo e il PRD

- [ ] **Passo 1: la suite intera**

```bash
npx eslint . --max-warnings 0
npx tsc --noEmit
npx vitest run
npm run build
```

Atteso: 0 errori ESLint, 0 errori TypeScript, **≥ 13.327** test verdi (baseline del 2026-09-02: un
numero **più basso** significa test spariti, non lavoro finito), build ok.

⚠️ Non usare `comando | tail; echo $?`: dopo una pipe `$?` è l'uscita dell'**ultimo anello**, non del
comando. Leggere la riga di riepilogo.

- [ ] **Passo 2: il PRD**

In `PRD REGISTRO ELETTRONICO.md`, aggiungere una voce di changelog datata 2026-09-03 che dica:
la Segreteria rigenera le credenziali dello staff del proprio plesso tranne gli account di Direzione;
il PDF delle credenziali applica la stessa regola; il rinvio in blocco è aperto alla Segreteria ed è
ora confinato per sede; e che il filtro di sede precedente interrogava una colonna inesistente su
`parents`. Aggiornare la tabella di stato in cima se cita i permessi sulle credenziali.

- [ ] **Passo 3: commit finale**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "Il PRD dice chi rigenera le credenziali di chi, e da quando"
```

---

## Cosa NON si tocca

- La modifica di ruolo, sede e classi resta di `admin`/`coordinator`: è ciò che rende non aggirabile
  la riserva sulle credenziali di Direzione.
- Il canale di consegna (email + PDF + notifica) non cambia.
- `ensureParentIdentity` e l'auto-riparazione dell'identità genitore non cambiano.
- Nessuna migrazione, e in particolare **nessun `scuola_id` su `parents`**.
- L'isolamento fra plessi non si allarga in nessun punto; in `rinvia-credenziali` si restringe.
