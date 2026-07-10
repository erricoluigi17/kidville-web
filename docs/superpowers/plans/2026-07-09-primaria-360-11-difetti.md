# Piano — Risoluzione 11 difetti Test 360° Primaria (2026-07-09)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (esecuzione inline con checkpoint). Gli step usano checkbox (`- [ ]`).

**Goal:** Risolvere gli 11 difetti del giro diagnostico 360° della scuola primaria (TEST 1A, sede Kidville Giugliano), senza regressioni su altri ruoli/flussi, aggiornando report e PRD.

**Architecture:** Next.js App Router + Supabase (service-role + gate applicativo + zod). Fix mirate e minime, riusando gli helper/pattern delle pagine sorelle già corrette. Nessuna migrazione DB. Branch `feat/logout-anagrafica-fullscreen` (NON committare/deployare senza richiesta).

**Tech Stack:** React client components, Recharts, Playwright (harness `e2e/primaria-360`), Vitest, ESLint, MCP Supabase (DB prod).

**Decisioni prese con l'utente (2026-07-09):**
- **F9** → *fail-closed per la primaria*: il diario 0-6 è nascosto ai docenti solo-primaria salvo attivazione esplicita del toggle admin. Aggiorno anche la config Giugliano (ora `true` per residuo del test) a `false`.
- **F3 e F4** → *nessuna modifica di codice*: non riproducibili come bug (DB attuale = 23 iscritti, query KPI corretta; BarChart mappa `count→altezza` con dominio `[0,dataMax]`). Erano artefatti (seed a metà / screenshot durante animazione). Documentare come falsi allarmi in report + PRD con prova DB.

**Riscontri DB già raccolti (prod uimulkjyekgemjakmepp, sede d53b0fbc…):**
- 23 alunni tutti `stato='iscritto'`; 2 senza sezione (classe_sezione NULL); TEST 1A=11 (primaria), TEST Infanzia=10 (infanzia).
- `admin_settings.diario_config.diario_primaria_visibile = true` (residuo e2e 84).

---

## Fase 1 — F1 (GRAVE) · Mensa genitore "— ticket" (data-binding)

**Files:** Modify `src/components/features/parent/mensa/MensaCalendar.tsx:61-66`

**Causa:** la fetch a riga 51 avvolge la risposta in `{ status, data: <body> }`; il body è `{ success, data:{ saldo, prenotazioni, cutoffOra } }`. Quindi il payload utile è `pRaw.data.data.*`, non `pRaw.data.*`. `pRaw.data.success` (r.61) è corretto, ma saldo/cutoffOra/prenotazioni (r.62-65) leggono un livello troppo alto → `undefined` → badge "—", banner assente, pulsanti disabilitati (`bloccaSaldo` con `(undefined ?? 0) <= 0`).

- [ ] **Step 1 — Applicare la fix (aggiungere il livello `.data` mancante):**

```tsx
      } else if (pRaw?.data?.success) {
        const payload = pRaw.data.data ?? {};
        setSaldo(payload.saldo ?? 0);
        setCutoffOra(payload.cutoffOra ?? null);
        const map: Record<string, Prenotazione> = {};
        for (const p of (payload.prenotazioni ?? []) as Prenotazione[]) map[p.data] = p;
        setPren(map);
      }
```

Lasciare invariate r.58 (`pRaw.status` per 401/403) e r.61 (`pRaw?.data?.success`). NON toccare i rami POST/DELETE (r.79-96) che usano `j = await res.json()` e leggono correttamente `j.data.*`.

- [ ] **Step 2 — Verifica DB (F1):** saldo ticket per alunni TEST 1A via MCP; scegliere un alunno con saldo > 0.
- [ ] **Step 3 — Verifica backend:** GET `/api/mensa/prenotazioni` (sessione genitore) → `{success:true, data:{saldo, prenotazioni, cutoffOra}}`.
- [ ] **Step 4 — Verifica UI:** badge mostra numero reale (0 se nessun ticket), banner cutoff presente se configurato, pulsanti "Prenota" attivi con saldo>0; con saldo 0 badge "0" + banner rosso + pulsanti disabilitati (comportamento corretto).
- [ ] **Step 5 — Gate:** eslint 0, `grep -n "pRaw.data.prenotazioni\|pRaw.data.saldo" MensaCalendar.tsx` = vuoto.

---

## Fase 2 — F2 (GRAVE) · Armadietto docente sezione 'Girasoli' hardcoded

**Files:** Modify `src/app/(dashboard)/teacher/locker/page.tsx`

**Causa:** `const SEZIONE = 'Girasoli'` (r.15) usato in 3 fetch (`fetchCarico`/`fetchConsumo`/`fetchMensile`), nell'header (r.175) e nella modale (r.319). Le sorelle (`attendance`, `modulistica`, `diary`) derivano le sezioni reali da `/api/educator-sections`.

- [ ] **Step 1 — Rimuovere `const SEZIONE = 'Girasoli';` (r.15).**
- [ ] **Step 2 — Aggiungere stato + fetch sezioni** dentro `TeacherLockerInner`, dopo `settingsHref`:

```tsx
    const [availableSections, setAvailableSections] = useState<string[]>([]);
    const [sezione, setSezione] = useState('');

    useEffect(() => {
        if (!userId) return;
        fetch(`/api/educator-sections?userId=${userId}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => {
                const secs: string[] = d?.sectionNames ?? [];
                setAvailableSections(secs);
                setSezione(prev => prev || secs[0] || '');
            })
            .catch(() => {});
    }, [userId]);
```

- [ ] **Step 3 — Sostituire `${SEZIONE}` con `${encodeURIComponent(sezione)}`** nei 3 fetch e aggiungere `sezione` alle deps delle `useCallback` (fetchCarico r.89, fetchConsumo r.101, fetchMensile r.124).
- [ ] **Step 4 — Guardare gli effetti su `sezione`:**

```tsx
    useEffect(() => { if (sezione) { fetchCarico(); fetchConsumo(); } }, [sezione, fetchCarico, fetchConsumo]);
    useEffect(() => { if (view === 'mensile' && sezione) fetchMensile(month); }, [view, month, sezione, fetchMensile]);
```

- [ ] **Step 5 — Header (r.175):** `Scorte e consegne · Sezione {sezione || '…'}`. **Modale (r.319):** `classeSezione={sezione}`. Nel refresh button (r.185) invariato (usa i fetch).
- [ ] **Step 6 — Selettore multi-sezione** (pill, come diary), subito dopo l'header verde, se `availableSections.length > 1`:

```tsx
            {availableSections.length > 1 && (
                <div className="mt-4 flex flex-wrap gap-2">
                    {availableSections.map(s => (
                        <button key={s} onClick={() => { setSezione(s); setExpandedCarico(null); setExpandedConsumo(null); }}
                            className={`rounded-pill border px-3 py-1.5 font-maven text-xs font-semibold transition-colors ${
                                sezione === s ? 'border-kidville-green/20 bg-kidville-green text-kidville-yellow' : 'border-kidville-line bg-white text-kidville-muted'
                            }`} aria-pressed={sezione === s}>
                            {s}
                        </button>
                    ))}
                </div>
            )}
```

- [ ] **Step 7 — Verifica:** `grep -n "SEZIONE" page.tsx` = vuoto; docente Girasoli invariato; altra sezione mostra la sua; multi-sezione mostra selettore; network usa `classe_sezione=<reale>`. Gate eslint 0 + build.

---

## Fase 3 — F3 (MEDIO) · KPI "Alunni iscritti" 19 vs 23 → **DOC-ONLY (falso allarme)**

**Files:** nessuna modifica di codice.

- [ ] **Step 1 — Prova DB:** `SELECT count(*) FROM alunni WHERE scuola_id='d53b0fbc…' AND stato='iscritto'` = 23; riprodurre la query KPI (`.in scuola_id [Giugliano] .eq stato iscritto`) = 23.
- [ ] **Step 2 — Verifica live:** dashboard direzione → card "Alunni iscritti" = 23 (via API `/api/admin/dashboard` con sessione staff, campo `studenti.iscritti`).
- [ ] **Step 3 — Documentare** in PRD (changelog) + report: era artefatto di seed transitorio (07-08), risolto dai dati; query semanticamente corretta (stato iscritto · sedi attive), etichette esplicite già presenti.

---

## Fase 4 — F4 (MEDIO) · Grafico "Alunni per classe" barre a ~0 → **DOC-ONLY (falso allarme)**

**Files:** nessuna modifica di codice.

- [ ] **Step 1 — Prova statica:** `DashboardCharts.tsx` `StudentiPerClasseChart` usa `<Bar dataKey="count">` con `<YAxis>` senza `domain` → default Recharts `[0,'auto']=[0,dataMax]`, baseline 0. Mapping corretto.
- [ ] **Step 2 — Prova dati:** payload `studenti.perClasse` = TEST 1A:11, TEST Infanzia:10, Non assegnati:2. Barre proporzionali (non 0).
- [ ] **Step 3 — Documentare:** le "barre a ~0" erano screenshot catturato durante l'animazione `isAnimationActive animationDuration={1200}` / compilazione dev. Nessun bug di scala. (Nessuna modifica per scelta utente.)

---

## Fase 5 — F5 (MEDIO) · Bottom-nav DOCENTE doppio-attivo

**Files:** Modify `src/components/features/teacher/TeacherBottomNav.tsx:97-110`

**Causa:** `isMenuSectionActive` (r.97-99) accende MENU su ogni item dei groups il cui href è prefisso del pathname (escluso solo `/teacher/attendance`), inclusi item con tab dedicato (diary/primaria/chat/gallery) → doppio-attivo su quelle rotte.

- [ ] **Step 1 — Fix:** aggiungere la guardia "nessun main tab attivo":

```tsx
  const isActive = (href: string) => {
    if (href === '/teacher') return pathname === '/teacher';
    return pathname.startsWith(href);
  };

  // Il MENU non deve accendersi sulle rotte già rappresentate da un tab dedicato.
  const anyMainTabActive = mainTabs.some((t) => t.href && isActive(t.href));
  const isMenuSectionActive = !anyMainTabActive && groups.some((g) =>
    g.items.some((i) => i.href && pathname.startsWith(i.href)),
  );
```

(Rimuovere l'esclusione parziale `i.href !== '/teacher/attendance'`: con `anyMainTabActive` non serve più e la sua presenza spegneva erroneamente il MENU su `/teacher/attendance`.)

- [ ] **Step 2 — Verifica UI (non-regressione componente condiviso):** su `/teacher/diary`, `/teacher/chat`, `/teacher/gallery`, `/teacher/primaria` → UNA sola voce attiva (rispettivo tab, non Menu). Su `/teacher/attendance`, `/teacher/tasks`, `/teacher/locker`, `/teacher/mensa`, `/teacher/avvisi`, `/teacher/modulistica` → SOLO Menu attivo. Su `/teacher` → SOLO Dashboard. Menu aperto → Menu acceso (via `showMenu`).
- [ ] **Step 3 — Gate:** eslint 0, vitest, build.

---

## Fase 6 — F6 (MEDIO) · Bottom-nav GENITORE doppio-attivo

**Files:** Modify `src/components/features/parent/BottomNav.tsx:111-124`

**Causa:** identica a F5. Voce menu 'registro' (r.59) ha href `/parent/primaria` = tab 'scuola' (r.99). Doppio-attivo su `/parent/primaria` e sottopagine, e su `/parent/avvisi`, `/parent/chat`, `/parent/diary`.

- [ ] **Step 1 — Fix (stesso pattern di F5):**

```tsx
  const isMenuSectionActive = visibleGroups.some((g) =>
    g.items.some((i) => i.href && pathname.startsWith(i.href)),
  );
  const anyMainTabActive = mainTabs.some((t) => t.href && isActive(t.href));
```

e modificare r.124:

```tsx
              const active = tab.href ? isActive(tab.href) : ((isMenuSectionActive && !anyMainTabActive) || showMenu);
```

- [ ] **Step 2 — Verifica UI:** primaria → su `/parent/primaria` + sottopagine (`/note`,`/pagelle`,`/assenze`,orario) SOLO "Scuola" attivo. Su `/parent/mensa`,`/parent/pagamenti`,`/parent/gallery`,`/parent/compiti`,`/parent/lezioni`,`/parent/modulistica`,`/parent/divise`,`/parent/locker` → SOLO Menu. Non-primaria: `/parent/diary` → SOLO Diario. Un solo `aria-current="page"`.
- [ ] **Step 3 — Gate:** eslint 0, vitest, build.

---

## Fase 7 — F7 (MEDIO) · Impostazioni armadietto: spinner permanente

**Files:** Modify `src/app/(dashboard)/teacher/settings/locker/page.tsx:49-59`

**Causa:** `loading` va a `false` solo nel `finally` di `fetchMateriali`, chiamata solo se `classeFilter` valorizzato. Senza sezioni nido/infanzia (primaria) `classeFilter` resta '' → spinner eterno. Anche `if(!d.success) return` e `.catch(()=>{})` non chiudono `loading`.

- [ ] **Step 1 — Fix (chiudere loading su tutti i rami terminali):**

```tsx
    useEffect(() => {
        fetch('/api/admin/sections/scoped?grado=nido,infanzia')
            .then(r => r.json())
            .then(d => {
                if (!d.success) { setLoading(false); return; }
                const names: string[] = (d.data ?? []).flatMap((g: { sezioni: { name: string }[] }) => g.sezioni.map(s => s.name));
                setSezioniReali(names);
                setClasseFilter(cur => cur || names[0] || '');
                if (names.length === 0) setLoading(false);
            })
            .catch(() => setLoading(false));
    }, []);
```

- [ ] **Step 2 — Verifica UI:** con plesso senza sezioni nido/infanzia (primaria) → spinner sparisce, resta empty-state "Nessuna sezione nido/infanzia disponibile."; con sezioni presenti → carica materiali (invariato).
- [ ] **Step 3 — Gate:** eslint 0, build.

---

## Fase 8 — F8 (MEDIO) · Note genitore "4 nota" (plurale)

**Files:** Modify `src/app/(dashboard)/parent/primaria/note/page.tsx:94`

**Causa:** ternario no-op `inAttesa.length > 1 ? ' in attesa' : ' in attesa'` + 'nota' fisso.

- [ ] **Step 1 — Fix:**

```tsx
                {inAttesa.length} {inAttesa.length > 1 ? 'note' : 'nota'} in attesa di firma
```

- [ ] **Step 2 — Verifica:** N>1 → "N note in attesa di firma"; N=1 → "1 nota in attesa di firma".
- [ ] **Step 3 — Gate:** eslint 0.

---

## Fase 9 — F9 (MINORE) · Diario 0-6 fail-closed per la primaria

**Files:**
- Modify `src/app/api/diary/config/route.ts:32`
- Modify `src/app/(dashboard)/teacher/diary/page.tsx:40`
- Modify `src/components/features/admin/settings/DiarioSettings.tsx:69,72`
- Modify `e2e/primaria-360/journeys/84-diario-primaria.spec.ts` (commento) — allineare la descrizione al nuovo default
- DB: `admin_settings.diario_config.diario_primaria_visibile` Giugliano → `false`

**Causa:** default fail-open (`!== false`) → primaria vede 0-6.

- [ ] **Step 1 — Config route (r.32):** `diario_primaria_visibile: cfg.diario_primaria_visibile === true` (default false).
- [ ] **Step 2 — Diary page (r.40):** `const primariaVisibile = conf?.diario_primaria_visibile === true;`
- [ ] **Step 3 — DiarioSettings (r.69):** `checked={cfg.diario_primaria_visibile ?? false}`; copy r.72: "Disattivo di default" invece di "Attivo di default".
- [ ] **Step 4 — DB Giugliano:** `UPDATE admin_settings SET diario_config = jsonb_set(diario_config,'{diario_primaria_visibile}','false') WHERE scuola_id='d53b0fbc…';`
- [ ] **Step 5 — Commento e2e 84:** aggiornare le righe 5-8 (il default ora è nascosto; il toggle ON riespone). Le asserzioni restano valide (impostano ON/OFF esplicito).
- [ ] **Step 6 — Verifica:** GET `/api/diary/config` (config assente/false) → `false`; `/teacher/diary` docente primaria → empty-state "Il diario 0-6 non è attivo per la primaria… usa il Registro", niente NANNA/SVEGLIA/BAGNO. Toggle ON → torna visibile. Infanzia/nido invariati. e2e 84 verde (`--workers=1`).
- [ ] **Step 7 — Gate:** eslint 0, vitest, build.

---

## Fase 10 — F10 (MINORE) · Overflow avatar "TEST 1A" (Le mie classi)

**Files:** Modify `src/app/(dashboard)/teacher/primaria/page.tsx:66-68`

**Causa:** badge quadrato `h-[52px] w-[52px]` stampa l'intero `{c.name}` con `text-xl font-black`, senza overflow control → "TEST 1A" trabocca.

- [ ] **Step 1 — Fix CSS (badge contenuto, no cambio dati/label):**

```tsx
                <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-[15px] bg-kidville-green px-1 text-center font-barlow text-sm font-black uppercase leading-tight text-kidville-yellow [word-break:break-word]">
                  {c.name}
                </div>
```

- [ ] **Step 2 — Verifica UI:** `/teacher/primaria` con "TEST 1A" (e nome breve "1A") → testo dentro i bordi, badge 52×52 quadrato, a larghezza mobile. Label "Classe {c.name}" accanto invariata.
- [ ] **Step 3 — Gate:** eslint 0, build.

---

## Fase 11 — F11 (ESTETICO) · Grafico Incassi asse Y non uniforme

**Files:** Modify `src/components/features/admin/DashboardCharts.tsx` (`TrendIncassiChart` r.38-78 + formatter r.21-25)

**Causa:** `<YAxis>` senza `domain`/`ticks` → tick auto non uniformi; `tickFormatter` misto (`k` sopra 1000, numero grezzo sotto) → "2k,1k,900,450,0".

- [ ] **Step 1 — Formatter tick it-IT** (accanto a `euroFmt`):

```ts
const tickFmt = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });
```

- [ ] **Step 2 — Dominio + tick uniformi** in `TrendIncassiChart`, prima del `return`:

```tsx
  const step = 500;
  const maxVal = Math.max(0, ...data.map((d) => d.incassato));
  const top = Math.max(step, Math.ceil(maxVal / step) * step);
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
```

- [ ] **Step 3 — YAxis:**

```tsx
        <YAxis
          domain={[0, top]}
          ticks={ticks}
          tickFormatter={(v) => tickFmt.format(Number(v))}
          tickLine={false}
          axisLine={false}
          fontSize={12}
          stroke="#9ca3af"
          width={44}
        />
```

- [ ] **Step 4 — Verifica UI:** asse Y con tick equidistanti (0, 500, 1.000, 1.500, 2.000…), formato it-IT coerente; Tooltip invariato (€). `StudentiPerClasseChart` (stesso file) invariato.
- [ ] **Step 5 — Gate:** eslint 0, vitest, build.

---

## Verifica finale (dopo tutte le fasi)

- [ ] **Gate globali:** `npx eslint . --max-warnings 0` = 0 · `npx vitest run` verde · `npm run build` ok.
- [ ] **Sicurezza/scoping (non-regressione):** IDOR→403, PII anonimo→401, cross-role→403 ancora verdi.
- [ ] **Rigenerare storageState** (setup) e lanciare le journey 84-88 + sweep copertura, ≥50 iterazioni (`--repeat-each`) tutte verdi; al primo rosso → ri-ragiona e riparti.
- [ ] **Report:** `node e2e/primaria-360/scripts/build-report-fresh.mjs` → `run/report-360.html`; i difetti risolti NON compaiono più; F3/F4 marcati falsi-allarme.
- [ ] **PRD:** `PRD REGISTRO ELETTRONICO.md` — changelog datato 2026-07-09 (cosa risolto, come, loop di verifica; F3/F4 falsi allarmi con prova DB).
- [ ] **Native:** dichiarare non rieseguibile senza emulatore/simulatore (non fingere).
