# Caratteri locali

Barlow Condensed e Maven Pro, già usati dall’applicazione, distribuiti con SIL Open Font License 1.1 (testi inclusi).

Fonte ufficiale: [google/fonts](https://github.com/google/fonts/tree/1d0e46c7933245c8180fe83e47917961c913bbdb/ofl), revisione `1d0e46c7933245c8180fe83e47917961c913bbdb`.
Conversione TTF → WOFF2 con fontTools 4.60.2, senza cambiare glifi, pesi o metadati.
Maven Pro conserva l’asse variabile; il layout richiede i pesi 400–800. Barlow Condensed usa i sei pesi 400–900.

I file locali evitano la dipendenza dalla risposta CSS di Google durante build e sviluppo e il bug [Next #99114](https://github.com/vercel/next.js/issues/99114).

| File incluso | Originale nella directory `ofl` | SHA-256 dell’originale TTF |
|---|---|---|
| `BarlowCondensed-Regular.woff2` | `barlowcondensed/BarlowCondensed-Regular.ttf` | `583cec5da3b84bc4dc7c9c72e2a565c94d34e431518b19d7e250b7830ad5f996` |
| `BarlowCondensed-Medium.woff2` | `barlowcondensed/BarlowCondensed-Medium.ttf` | `262bd143292ce479ee0cd09a42b47ab173fca8e9c6eb5ed0b5c8a845bc371d17` |
| `BarlowCondensed-SemiBold.woff2` | `barlowcondensed/BarlowCondensed-SemiBold.ttf` | `7b619d14bc2327509a9ef32b0890f709626f7ecc9ff61191c2a4314c5499d2d9` |
| `BarlowCondensed-Bold.woff2` | `barlowcondensed/BarlowCondensed-Bold.ttf` | `e476562ec9c1e16cf16475895b511f08c804f438cc9a9f80a44ea50a0eeb5b65` |
| `BarlowCondensed-ExtraBold.woff2` | `barlowcondensed/BarlowCondensed-ExtraBold.ttf` | `724c9c25952d5f4a2d87185d9767aa006144c5f0d944dc05bf7d5d603551c260` |
| `BarlowCondensed-Black.woff2` | `barlowcondensed/BarlowCondensed-Black.ttf` | `e74b750df582c608f35db467b711b2b60d2217618e85e60b72b42dfd00446cab` |
| `MavenPro-Variable.woff2` | `mavenpro/MavenPro[wght].ttf` | `bc994ed80baaec6ea61d7cb631f49466a1deb29d4363138021a96931f9faae9a` |
