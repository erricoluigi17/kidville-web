import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/**
 * LOCK · un plugin Capacitor non attraversa MAI la risoluzione di una promise.
 *
 * ─── LA STORIA ───────────────────────────────────────────────────────────────
 * Il 2026-09-25, poche ore dopo il rilascio della #166, `app_log` ha cominciato a raccogliere da iOS
 * e da Android — su /parent e su /teacher, una trentina di righe l'ora — lo stesso errore:
 * `"PushNotifications.then()" is not implemented on ios|android`. Nessun test era rosso.
 *
 * `caricaPluginPush()` di `src/lib/push/native-register.ts` teneva in cache
 * `import('@capacitor/push-notifications').then((m) => m.PushNotifications)`: una promise che si
 * RISOLVE con il plugin. Per risolversi con un valore, una promise legge `valore.then` e, se è una
 * funzione, la chiama. Il plugin di Capacitor è un `Proxy` (`registerPlugin` in
 * `@capacitor/core`) che a OGNI proprietà che non conosce risponde con un metodo del bridge — `then`
 * compreso. La promise chiamava `PushNotifications.then(risolvi, rifiuta)`, il bridge rifiutava con
 * «not implemented», e la promise di partenza restava appesa per sempre: niente registrazione del
 * token, niente canale Android, niente `statoPermessoPush()`, quindi niente avviso «notifiche
 * disattivate». Per tutti gli utenti dell'app.
 *
 * I test non potevano vederlo: il plugin finto era un oggetto piatto, senza `then`.
 *
 * ─── LA REGOLA ───────────────────────────────────────────────────────────────
 * In `src/` un plugin Capacitor si prende DOPO l'`await`, dal modulo o da `registerPlugin`, e si usa
 * lì: `const { Share } = await import('@capacitor/share')`. Se va tenuto in cache, si tiene il
 * MODULO (il namespace di un modulo non ha `then`) oppure un involucro `{ plugin }`. Sono vietate le
 * forme che fanno passare il plugin da una risoluzione:
 *
 *  - `import-then`               `.then(…)` su `import('<pacchetto plugin>')`;
 *  - `then-restituisce-plugin`   una callback di `.then`/`.catch` che restituisce un plugin;
 *  - `async-restituisce-plugin`  una funzione `async` che restituisce un plugin;
 *  - `await-plugin`              `await <plugin>`;
 *  - `promise-di-plugin`         un tipo `Promise<…Plugin>` / `Promise<typeof import('…').X>`;
 *  - `promise-risolta-col-plugin` `Promise.resolve(<plugin>)`, `resolve(<plugin>)`, `risolvi(<plugin>)`,
 *                                e il primo parametro dell'esecutore di `new Promise`, qualunque nome abbia;
 *  - `combinatore-con-plugin`    `Promise.all/allSettled/race/any([…, <plugin>, …])`, spread di array
 *                                letterali compresi: ogni elemento passa da `Promise.resolve`;
 *  - `yield-async-plugin`        `yield <plugin>` (o `yield* [<plugin>]`) in una `async function*`:
 *                                lo `yield` di un generatore asincrono fa l'await del valore;
 *  - `for-await-plugin`          `for await (… of [<plugin>, …])`, che risolve ogni elemento.
 *
 * «Plugin» è, per SCOPERTA e non per elenco: un nome importato (non type-only) da un pacchetto plugin,
 * o legato da `const { X } = await import('<pacchetto plugin>')` (anche rinominato, `{ App: A }`);
 * `(await import('<pacchetto plugin>')).X`; `mod.X` con iniziale maiuscola su un modulo di plugin
 * (`const mod = await import(…)`, `import * as mod`, il parametro di `import(…).then((mod) => …)`);
 * una chiamata a `registerPlugin`, una variabile che ne riceve il valore, una funzione (non async) che
 * lo restituisce, un parametro tipato `…Plugin`. In più l'elenco `PLUGIN_NOTI` e i nomi usati come
 * `Nome.metodo(…)`. L'analisi è sull'AST (non sul testo): i commenti, compreso questo, non la ingannano.
 *
 * ─── IL CONTROLLO POSITIVO ──────────────────────────────────────────────────
 * Il lock riconosce il difetto sul codice VECCHIO di `caricaPluginPush`, copiato qui sotto, sulle sue
 * varianti e su un plugin che NON sta in `PLUGIN_NOTI` (`Haptics`), così prova la scoperta e non
 * l'elenco; e tace sulla forma corretta. Senza quel controllo sarebbe un lock cieco.
 */

const RADICE = process.cwd()
const SRC = path.join(RADICE, 'src')

/** I pacchetti che registrano un plugin. `@capacitor/core` no: da lì arriva `registerPlugin`. */
const PACCHETTO_PLUGIN = /^(@capacitor\/(?!core$|cli$|android$|ios$)|@capawesome\/|@capgo\/|@aparajita\/capacitor|capacitor-)/

/** I plugin che l'app usa oggi, anche dove arrivano da `registerPlugin` con un nome stringa. */
const PLUGIN_NOTI = [
  'PushNotifications',
  'App',
  'Filesystem',
  'Share',
  'FileTransfer',
  'Media',
  'FileViewer',
  'NativeSettings',
  'Badge',
  'StatusBar',
  'SplashScreen',
  'Camera',
  'BiometricAuth',
]

type Forma =
  | 'import-then'
  | 'then-restituisce-plugin'
  | 'async-restituisce-plugin'
  | 'await-plugin'
  | 'promise-di-plugin'
  | 'promise-risolta-col-plugin'
  | 'combinatore-con-plugin'
  | 'yield-async-plugin'
  | 'for-await-plugin'

type Violazione = { file: string; riga: number; forma: Forma; testo: string }
type Sorgente = { nome: string; testo: string }

function fileDi(dir: string): string[] {
  const esito: string[] = []
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const pieno = path.join(dir, voce.name)
    if (voce.isDirectory()) esito.push(...fileDi(pieno))
    else if (/\.(ts|tsx)$/.test(voce.name) && !voce.name.endsWith('.d.ts')) esito.push(pieno)
  }
  return esito
}

function parse(s: Sorgente): ts.SourceFile {
  const tipo = s.nome.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(s.nome, s.testo, ts.ScriptTarget.Latest, true, tipo)
}

function visita(nodo: ts.Node, fn: (n: ts.Node) => void): void {
  fn(nodo)
  ts.forEachChild(nodo, (figlio) => visita(figlio, fn))
}

function eImportDiPlugin(n: ts.Node): n is ts.CallExpression {
  if (!ts.isCallExpression(n) || n.expression.kind !== ts.SyntaxKind.ImportKeyword) return false
  const arg = n.arguments[0]
  return !!arg && ts.isStringLiteralLike(arg) && PACCHETTO_PLUGIN.test(arg.text)
}

function scarta(e: ts.Expression): ts.Expression {
  let x = e
  for (;;) {
    if (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) x = x.expression
    else if (ts.isTypeAssertionExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression
    else return x
  }
}

/** Le espressioni che una funzione restituisce, senza entrare nelle funzioni annidate. */
function restituite(f: ts.SignatureDeclaration): ts.Expression[] {
  const corpo = (f as ts.FunctionLikeDeclaration).body
  if (!corpo) return []
  if (!ts.isBlock(corpo)) return [corpo]
  const esito: ts.Expression[] = []
  const giu = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) return
    if (ts.isReturnStatement(n) && n.expression) esito.push(n.expression)
    ts.forEachChild(n, giu)
  }
  ts.forEachChild(corpo, giu)
  return esito
}

function eAsync(f: ts.Node): boolean {
  return !!ts.getModifiers(f as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
}

/** Passo 1: i nomi esportati da pacchetti plugin e usati come `Nome.metodo(…)` in quel file. */
function nomiPluginDelFile(sf: ts.SourceFile): Set<string> {
  const candidati = new Set<string>()
  visita(sf, (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && PACCHETTO_PLUGIN.test(n.moduleSpecifier.text)) {
      const clausola = n.importClause
      if (!clausola || clausola.isTypeOnly) return
      const legami = clausola.namedBindings
      if (legami && ts.isNamedImports(legami)) {
        for (const el of legami.elements) if (!el.isTypeOnly) candidati.add(el.name.text)
      }
    }
    if (
      ts.isVariableDeclaration(n) &&
      ts.isObjectBindingPattern(n.name) &&
      n.initializer &&
      ts.isAwaitExpression(n.initializer) &&
      eImportDiPlugin(scarta(n.initializer.expression))
    ) {
      for (const el of n.name.elements) if (ts.isIdentifier(el.name)) candidati.add(el.name.text)
    }
  })
  const usati = new Set<string>()
  visita(sf, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      candidati.has(n.expression.expression.text)
    ) {
      usati.add(n.expression.expression.text)
    }
  })
  return usati
}

function nomeTipo(t: ts.TypeNode): string | null {
  if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) return t.typeName.text
  return null
}

type Diagnosi = { violazioni: Violazione[]; nomiPlugin: Set<string>; funzioniPlugin: Map<string, Set<string>> }

function analizza(sorgenti: Sorgente[]): Diagnosi {
  const alberi = sorgenti.map((s) => ({ s, sf: parse(s) }))
  const nomiPlugin = new Set(PLUGIN_NOTI)
  for (const { sf } of alberi) for (const nome of nomiPluginDelFile(sf)) nomiPlugin.add(nome)

  const violazioni: Violazione[] = []
  const funzioniPluginPerFile = new Map<string, Set<string>>()

  for (const { s, sf } of alberi) {
    const variabili = new Set<string>()
    const funzioni = new Set<string>()
    const tipi = new Set<string>()
    /** I nomi che portano il MODULO di un pacchetto plugin (`mod` di `const mod = await import(…)`). */
    const moduli = new Set<string>()

    /** `await import('<pacchetto plugin>')`, anche fra parentesi: il namespace del modulo. */
    const eModuloAtteso = (grezza: ts.Expression): boolean => {
      const e = scarta(grezza)
      return ts.isAwaitExpression(e) && eImportDiPlugin(scarta(e.expression))
    }

    const ePlugin = (grezza: ts.Expression): boolean => {
      const e = scarta(grezza)
      if (ts.isIdentifier(e)) return nomiPlugin.has(e.text) || variabili.has(e.text)
      if (ts.isPropertyAccessExpression(e)) {
        // SCOPERTA, non elenco (giro 2 del critico): `(await import('@capacitor/haptics')).Haptics` è un
        // plugin qualunque nome abbia. Su una variabile-modulo si guarda l'iniziale maiuscola, perché i
        // plugin sono esportati in PascalCase e un parametro `m` può avere omonimi nel file.
        if (eModuloAtteso(e.expression)) return true
        const ogg = scarta(e.expression)
        if (ts.isIdentifier(ogg) && moduli.has(ogg.text) && /^[A-Z]/.test(e.name.text)) return true
        return nomiPlugin.has(e.name.text)
      }
      if (ts.isCallExpression(e)) {
        const chi = e.expression
        if (ts.isIdentifier(chi)) return chi.text === 'registerPlugin' || funzioni.has(chi.text)
        if (ts.isPropertyAccessExpression(chi)) return chi.name.text === 'registerPlugin'
        return false
      }
      if (ts.isConditionalExpression(e)) return ePlugin(e.whenTrue) || ePlugin(e.whenFalse)
      if (ts.isBinaryExpression(e)) {
        const op = e.operatorToken.kind
        if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
          return ePlugin(e.left) || ePlugin(e.right)
        }
      }
      return false
    }
    const eTipoPlugin = (t: ts.TypeNode): boolean => {
      if (ts.isUnionTypeNode(t)) return t.types.some(eTipoPlugin)
      if (ts.isParenthesizedTypeNode(t)) return eTipoPlugin(t.type)
      if (ts.isImportTypeNode(t)) {
        const arg = t.argument
        const pacchetto =
          ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal) ? arg.literal.text : ''
        // `typeof import('pkg')` è il MODULO, che una promise attraversa intatto; `.X` è il plugin.
        return t.isTypeOf && !!t.qualifier && PACCHETTO_PLUGIN.test(pacchetto)
      }
      if (ts.isTypeQueryNode(t)) {
        return ts.isIdentifier(t.exprName) && (nomiPlugin.has(t.exprName.text) || variabili.has(t.exprName.text))
      }
      const nome = nomeTipo(t)
      return !!nome && (/Plugin$/.test(nome) || tipi.has(nome))
    }

    // I legami che portano un plugin PER COSTRUZIONE, senza chiedere che il file lo usi come
    // `X.metodo()` (giro 2 del critico: un helper `caricaHaptics()` in un file suo non lo usa mai).
    // Un enum esportato dal pacchetto (`Directory`) entra anche lui: restituirlo da una async sarebbe un
    // falso positivo, accettato perché non succede e perché si vede subito.
    visita(sf, (n) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && PACCHETTO_PLUGIN.test(n.moduleSpecifier.text)) {
        const clausola = n.importClause
        if (!clausola || clausola.isTypeOnly) return
        const legami = clausola.namedBindings
        if (legami && ts.isNamedImports(legami)) {
          // `el.name` è il nome LOCALE: in `import { App as A }` è `A`.
          for (const el of legami.elements) if (!el.isTypeOnly) variabili.add(el.name.text)
        }
        if (legami && ts.isNamespaceImport(legami)) moduli.add(legami.name.text)
      }
      // `import('<pacchetto plugin>').then((m) => …)`: `m` è il modulo.
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'then' &&
        eImportDiPlugin(scarta(n.expression.expression))
      ) {
        const cb = n.arguments[0]
        if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          const p = cb.parameters[0]
          if (p && ts.isIdentifier(p.name)) moduli.add(p.name.text)
        }
      }
    })

    // Punto fisso: variabili, funzioni e tipi che portano un plugin, finché non cresce più niente.
    for (let giro = 0; giro < 5; giro++) {
      const prima = variabili.size + funzioni.size + tipi.size + moduli.size
      visita(sf, (n) => {
        if (ts.isVariableDeclaration(n) && n.initializer) {
          const init = scarta(n.initializer)
          const daModulo = eModuloAtteso(init) || (ts.isIdentifier(init) && moduli.has(init.text))
          if (daModulo && ts.isIdentifier(n.name)) moduli.add(n.name.text)
          if (daModulo && ts.isObjectBindingPattern(n.name)) {
            // `const { App: A } = await import(…)`: `el.name` è `A`, il nome che porta il plugin.
            for (const el of n.name.elements) if (ts.isIdentifier(el.name)) variabili.add(el.name.text)
          }
        }
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
          if (n.initializer && !ts.isFunctionLike(scarta(n.initializer)) && ePlugin(n.initializer)) variabili.add(n.name.text)
          if (n.type && eTipoPlugin(n.type)) variabili.add(n.name.text)
          const init = n.initializer && scarta(n.initializer)
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && !eAsync(init)) {
            if (restituite(init).some(ePlugin)) funzioni.add(n.name.text)
          }
        }
        if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.type && eTipoPlugin(n.type)) variabili.add(n.name.text)
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left) &&
          ePlugin(n.right)
        ) {
          variabili.add(n.left.text)
        }
        if (ts.isFunctionDeclaration(n) && n.name && !eAsync(n) && restituite(n).some(ePlugin)) funzioni.add(n.name.text)
        if (ts.isCallExpression(n) && n.typeArguments && ePlugin(n)) {
          for (const t of n.typeArguments) {
            const nome = nomeTipo(t)
            // Un parametro di tipo (`T`) non è un tipo di plugin: lo sono i suoi argomenti concreti.
            if (nome && nome.length > 1) tipi.add(nome)
          }
        }
      })
      if (variabili.size + funzioni.size + tipi.size + moduli.size === prima) break
    }
    funzioniPluginPerFile.set(s.nome, funzioni)

    const segnala = (n: ts.Node, forma: Forma) => {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
      violazioni.push({ file: s.nome, riga: line + 1, forma, testo: n.getText(sf).split('\n')[0].slice(0, 120) })
    }

    /** Un array LETTERALE con almeno un plugin fra gli elementi, anche dentro uno spread `...[X]`. */
    const arrayConPlugin = (grezza: ts.Expression): boolean => {
      const e = scarta(grezza)
      if (!ts.isArrayLiteralExpression(e)) return false
      return e.elements.some((el) => (ts.isSpreadElement(el) ? arrayConPlugin(el.expression) : ePlugin(el)))
    }

    /** La funzione che contiene `n` è un generatore asincrono (`async function*`, metodo `async *m()`). */
    const inGeneratoreAsync = (n: ts.Node): boolean => {
      let p: ts.Node | undefined = n.parent
      while (p && !ts.isFunctionLike(p)) p = p.parent
      return !!p && !!(p as ts.FunctionLikeDeclaration).asteriskToken && eAsync(p)
    }

    visita(sf, (n) => {
      // Giro 3 del critico: i combinatori passano OGNI elemento a `Promise.resolve`, che legge `.then`.
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression) &&
        n.expression.expression.text === 'Promise' &&
        /^(all|allSettled|race|any)$/.test(n.expression.name.text) &&
        n.arguments[0] &&
        arrayConPlugin(n.arguments[0])
      ) {
        segnala(n, 'combinatore-con-plugin')
      }
      if (ts.isYieldExpression(n) && n.expression && inGeneratoreAsync(n)) {
        // `yield X` fa l'await di X; `yield* [X]` passa da un iteratore sincrono reso asincrono, che
        // fa l'await di ogni elemento.
        const colpevole = n.asteriskToken ? arrayConPlugin(n.expression) : ePlugin(n.expression)
        if (colpevole) segnala(n, 'yield-async-plugin')
      }
      if (ts.isForOfStatement(n) && n.awaitModifier && arrayConPlugin(n.expression)) segnala(n, 'for-await-plugin')

      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const metodo = n.expression.name.text
        if (metodo === 'then' && eImportDiPlugin(scarta(n.expression.expression))) segnala(n, 'import-then')
        if (metodo === 'then' || metodo === 'catch') {
          for (const arg of n.arguments) {
            if ((ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && restituite(arg).some(ePlugin)) {
              segnala(arg, 'then-restituisce-plugin')
            }
          }
        }
        if (
          metodo === 'resolve' &&
          ts.isIdentifier(n.expression.expression) &&
          n.expression.expression.text === 'Promise' &&
          n.arguments[0] &&
          ePlugin(n.arguments[0])
        ) {
          segnala(n, 'promise-risolta-col-plugin')
        }
      }
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        /^(resolve|risolvi)$/.test(n.expression.text) &&
        n.arguments[0] &&
        ePlugin(n.arguments[0])
      ) {
        segnala(n, 'promise-risolta-col-plugin')
      }
      // `new Promise<…>((ok) => ok(X))`: il primo parametro dell'esecutore, QUALUNQUE nome abbia.
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Promise') {
        if (n.typeArguments?.some(eTipoPlugin)) segnala(n, 'promise-di-plugin')
        const esecutore = n.arguments?.[0]
        const primo =
          esecutore && (ts.isArrowFunction(esecutore) || ts.isFunctionExpression(esecutore))
            ? esecutore.parameters[0]
            : undefined
        // `resolve`/`risolvi` li prende già la regola generale qui sopra: niente doppioni.
        if (primo && ts.isIdentifier(primo.name) && !/^(resolve|risolvi)$/.test(primo.name.text)) {
          const nomeRisolvi = primo.name.text
          visita(esecutore!, (c) => {
            if (
              ts.isCallExpression(c) &&
              ts.isIdentifier(c.expression) &&
              c.expression.text === nomeRisolvi &&
              c.arguments[0] &&
              ePlugin(c.arguments[0])
            ) {
              segnala(c, 'promise-risolta-col-plugin')
            }
          })
        }
      }
      if (ts.isFunctionLike(n) && eAsync(n) && restituite(n).some(ePlugin)) segnala(n, 'async-restituisce-plugin')
      if (ts.isAwaitExpression(n) && ePlugin(n.expression)) segnala(n, 'await-plugin')
      if (
        ts.isTypeReferenceNode(n) &&
        ts.isIdentifier(n.typeName) &&
        /^(Promise|PromiseLike)$/.test(n.typeName.text) &&
        n.typeArguments?.some(eTipoPlugin)
      ) {
        segnala(n, 'promise-di-plugin')
      }
    })
  }
  return { violazioni, nomiPlugin, funzioniPlugin: funzioniPluginPerFile }
}

const forme = (sorgenti: Sorgente[]) => analizza(sorgenti).violazioni.map((v) => v.forma)

describe('controllo positivo: il lock riconosce il difetto', () => {
  it('sul codice VECCHIO di caricaPluginPush (la regressione della #166)', () => {
    const vecchio = `
      import type { PushNotificationsPlugin } from '@capacitor/push-notifications'
      let pluginPush: Promise<PushNotificationsPlugin> | null = null
      function caricaPluginPush(): Promise<PushNotificationsPlugin> {
        if (!pluginPush) {
          pluginPush = import('@capacitor/push-notifications').then(
            (m) => m.PushNotifications,
            (e: unknown) => {
              pluginPush = null
              throw e
            },
          )
        }
        return pluginPush
      }
    `
    const trovate = forme([{ nome: 'vecchio.ts', testo: vecchio }])
    expect(trovate).toContain('import-then')
    expect(trovate).toContain('then-restituisce-plugin')
    expect(trovate.filter((f) => f === 'promise-di-plugin')).toHaveLength(2)
  })

  it('su una funzione async che restituisce il plugin (anche in forma concisa)', () => {
    expect(
      forme([
        {
          nome: 'a.ts',
          testo: `
            export async function caricaShare() {
              const { Share } = await import('@capacitor/share')
              return Share
            }
            export const caricaApp = async () => (await import('@capacitor/app')).App
          `,
        },
      ]),
    ).toEqual(['async-restituisce-plugin', 'async-restituisce-plugin'])
  })

  it('su un plugin di registerPlugin: variabile, funzione che lo restituisce, await, Promise<…Minimo>', () => {
    const trovate = forme([
      {
        nome: 'b.ts',
        testo: `
          import { registerPlugin } from '@capacitor/core'
          interface FsMinimo { writeFile(o: unknown): Promise<void> }
          let proxy: FsMinimo | null = null
          function plugin(): FsMinimo {
            if (!proxy) proxy = registerPlugin<FsMinimo>('Filesystem')
            return proxy
          }
          export async function prendi(): Promise<FsMinimo> { return plugin() }
          export async function usa() { const fs = await plugin(); return 1 }
        `,
      },
    ])
    expect(trovate).toEqual(['async-restituisce-plugin', 'promise-di-plugin', 'await-plugin'])
  })

  it('su una promise risolta a mano col plugin', () => {
    const trovate = forme([
      {
        nome: 'c.ts',
        testo: `
          import { Share } from '@capacitor/share'
          export const p = Promise.resolve(Share)
          export const q = new Promise((risolvi) => risolvi(Share))
          export function usa() { return Share.share({ url: 'x' }) }
        `,
      },
    ])
    expect(trovate).toEqual(['promise-risolta-col-plugin', 'promise-risolta-col-plugin'])
  })

  it('su un parametro tipato …Plugin restituito da una funzione async', () => {
    expect(
      forme([
        {
          nome: 'd.ts',
          testo: `
            import type { PushNotificationsPlugin } from '@capacitor/push-notifications'
            export async function passa(pn: PushNotificationsPlugin) { return pn }
          `,
        },
      ]),
    ).toEqual(['async-restituisce-plugin'])
  })

  // SCOPERTA, non elenco (giro 2 del critico). `Haptics` NON sta in PLUGIN_NOTI e in questi file non è
  // mai chiamato come `Haptics.metodo()`: è il caso di chi aggiungerà il prossimo plugin con un helper
  // `caricaX()` in un file suo. Prima di questo giro tutte queste forme davano [].
  it('su un plugin che NON sta in PLUGIN_NOTI e non è mai usato nel file', () => {
    expect(PLUGIN_NOTI).not.toContain('Haptics')
    expect(
      forme([
        {
          nome: 'e.ts',
          testo: `
            export async function caricaHaptics() {
              const { Haptics } = await import('@capacitor/haptics')
              return Haptics
            }
            export async function f() { return (await import('@capacitor/haptics')).Haptics }
            export async function g() {
              const { Haptics: H } = await import('@capacitor/haptics')
              return H
            }
            export async function a() {
              const { App: A } = await import('@capacitor/app')
              return A
            }
            export async function m() {
              const mod = await import('@capacitor/haptics')
              return mod.Haptics
            }
            export const t = import('@capacitor/haptics').then((modulo) => modulo.Haptics)
          `,
        },
      ]),
    ).toEqual([
      'async-restituisce-plugin',
      'async-restituisce-plugin',
      'async-restituisce-plugin',
      'async-restituisce-plugin',
      'async-restituisce-plugin',
      'import-then',
      'then-restituisce-plugin',
    ])
  })

  it('su un import statico di un plugin sconosciuto: restituito da una async, in una new Promise', () => {
    expect(
      forme([
        {
          nome: 'f.ts',
          testo: `
            import { Haptics as Vibra } from '@capacitor/haptics'
            import * as Geo from '@capacitor/geolocation'
            export async function h() { return Vibra }
            export async function geo() { return Geo.Geolocation }
            export const p = new Promise<typeof Vibra>((ok) => ok(Vibra))
          `,
        },
      ]),
    ).toEqual(['async-restituisce-plugin', 'async-restituisce-plugin', 'promise-di-plugin', 'promise-risolta-col-plugin'])
  })

  // Giro 3 del critico: tre famiglie di risoluzione che non passano da `.then`, `return` o `await`.
  // Prima di questo giro ciascuna dava [].
  it('sui combinatori Promise.all/allSettled/race/any con un plugin nell’array', () => {
    expect(
      forme([
        {
          nome: 'g.ts',
          testo: `
            import { Share } from '@capacitor/share'
            export function a() { return Promise.all([Share]) }
            export const b = Promise.allSettled([1, ...[Share]])
            export const c = Promise.race([Share] as const)
            export async function d() {
              const { Haptics } = await import('@capacitor/haptics')
              return Promise.any([Promise.resolve(1), Haptics])
            }
          `,
        },
      ]),
    ).toEqual(['combinatore-con-plugin', 'combinatore-con-plugin', 'combinatore-con-plugin', 'combinatore-con-plugin'])
  })

  it('su yield di un plugin dentro un generatore asincrono (anche yield* di un array)', () => {
    expect(
      forme([
        {
          nome: 'h.ts',
          testo: `
            import { App } from '@capacitor/app'
            export async function* plugins() { yield App }
            export async function* altri() {
              const { Haptics } = await import('@capacitor/haptics')
              yield* [Haptics]
            }
            export const o = { async *m() { yield (await import('@capacitor/haptics')).Haptics } }
          `,
        },
      ]),
    ).toEqual(['yield-async-plugin', 'yield-async-plugin', 'yield-async-plugin'])
  })

  it('su for await di un array che contiene un plugin', () => {
    expect(
      forme([
        {
          nome: 'i.ts',
          testo: `
            import { Share } from '@capacitor/share'
            export async function a() { for await (const x of [Share]) void x }
            export async function b() {
              const { Haptics } = await import('@capacitor/haptics')
              for await (const x of [1, ...[Haptics]]) void x
            }
          `,
        },
      ]),
    ).toEqual(['for-await-plugin', 'for-await-plugin'])
  })

  it('e tace sulla forma corretta: il MODULO in cache, il plugin preso dopo l’await', () => {
    const giusto = `
      import type { PushNotificationsPlugin } from '@capacitor/push-notifications'
      type ModuloPush = typeof import('@capacitor/push-notifications')
      let moduloPush: Promise<ModuloPush> | null = null
      function caricaModuloPush(): Promise<ModuloPush> {
        if (!moduloPush) {
          moduloPush = import('@capacitor/push-notifications').catch((e: unknown) => {
            moduloPush = null
            throw e
          })
        }
        return moduloPush
      }
      async function crea(PushNotifications: PushNotificationsPlugin): Promise<void> {
        await PushNotifications.createChannel({ id: 'x' })
      }
      export async function stato() {
        const { PushNotifications } = await caricaModuloPush()
        await crea(PushNotifications)
        const { App } = await import('@capacitor/app')
        await App.addListener('resume', () => undefined)
        const { Haptics, ImpactStyle } = await import('@capacitor/haptics')
        await Haptics.impact({ style: ImpactStyle.Light })
        const mod = await import('@capacitor/haptics')
        await mod.Haptics.vibrate()
        await Promise.all([Haptics.vibrate(), App.getInfo()])
        for await (const esito of [Haptics.vibrate()]) void esito
        return (await PushNotifications.checkPermissions()).receive
      }
      export async function* esiti() {
        const { Haptics } = await import('@capacitor/haptics')
        yield await Haptics.vibrate()
        yield* [Haptics.impact({ style: 'LIGHT' })]
      }
      // Un generatore SINCRONO non fa l'await: yield del plugin qui non attraversa nessuna promise.
      export function* sincrono(pn: PushNotificationsPlugin) {
        yield pn
      }
    `
    expect(analizza([{ nome: 'giusto.ts', testo: giusto }]).violazioni).toEqual([])
  })
})

describe('src/: nessun plugin Capacitor passa da una risoluzione di promise', () => {
  const sorgenti: Sorgente[] = fileDi(SRC).map((f) => ({
    nome: path.relative(RADICE, f),
    testo: fs.readFileSync(f, 'utf8'),
  }))
  const diagnosi = analizza(sorgenti)

  it('il lock guarda davvero il codice che usa i plugin (non è cieco)', () => {
    expect(sorgenti.length).toBeGreaterThan(500)
    const nomi = sorgenti.map((s) => s.nome)
    for (const atteso of [
      'src/lib/push/native-register.ts',
      'src/lib/native/scarica.ts',
      'src/lib/native/share.ts',
      'src/lib/mobile/native-shell.ts',
      'src/lib/native/avvisi-settimanali.ts',
    ]) {
      expect(nomi).toContain(atteso)
    }
    // I nomi trovati DAL CODICE (non solo da PLUGIN_NOTI): se la raccolta si rompe, questo cade.
    const trovatiNelCodice = new Set<string>()
    for (const s of sorgenti) for (const n of nomiPluginDelFile(parse(s))) trovatiNelCodice.add(n)
    for (const atteso of ['PushNotifications', 'App', 'Share', 'StatusBar', 'NativeSettings', 'BiometricAuth']) {
      expect(trovatiNelCodice).toContain(atteso)
    }
    // La strada di `registerPlugin` è esercitata sul codice vero: `scarica.ts` ne ha due.
    expect([...(diagnosi.funzioniPlugin.get('src/lib/native/scarica.ts') ?? [])].sort()).toEqual([
      'plugin',
      'pluginNativo',
    ])
  })

  it('nessuna violazione', () => {
    const righe = diagnosi.violazioni.map((v) => `${v.file}:${v.riga} [${v.forma}] ${v.testo}`)
    expect(righe, 'Un plugin Capacitor è un Proxy che risponde anche a `then`: si prende DOPO l’await (const { X } = await import(…)), e in cache si tiene il MODULO. Vedi il commento in testa a questo file.').toEqual([])
  })
})
