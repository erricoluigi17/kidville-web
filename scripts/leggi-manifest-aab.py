#!/usr/bin/env python3
"""
Legge AndroidManifest.xml da un .aab. Dentro un bundle il manifest NON è XML e
non è il binario di aapt: è protobuf (schema Resources.proto di aapt2). aapt2
36.x rifiuta di dumparlo e bundletool non è installato, quindi qui c'è un
decoder generico del wire format — nessuna dipendenza, nessuna euristica sui byte.

Schema usato (Resources.proto):
  XmlNode      { XmlElement element = 1; string text = 2 }
  XmlElement   { ns_decl = 1; string namespace_uri = 2; string name = 3;
                 repeated XmlAttribute attribute = 4; repeated XmlNode child = 5 }
  XmlAttribute { string namespace_uri = 1; string name = 2; string value = 3;
                 SourcePosition source = 4; uint32 resource_id = 5; Item compiled_item = 6 }
  Item         { ... Primitive prim = 7 ... }
  Primitive    { ... int_decimal_value = 6 ... }   (un solo campo valorizzato)

Uso: python3 leggi-manifest-aab.py <file.aab>
"""
import sys, zipfile, io

def leggi_varint(b, i):
    r = 0; s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7F) << s
        if not (x & 0x80):
            return r, i
        s += 7

def campi(b):
    """Genera (numero_campo, tipo_wire, payload) per un messaggio protobuf."""
    i = 0
    while i < len(b):
        chiave, i = leggi_varint(b, i)
        num, wt = chiave >> 3, chiave & 7
        if wt == 0:
            v, i = leggi_varint(b, i); yield num, wt, v
        elif wt == 2:
            n, i = leggi_varint(b, i); yield num, wt, b[i:i+n]; i += n
        elif wt == 5:
            yield num, wt, int.from_bytes(b[i:i+4], 'little'); i += 4
        elif wt == 1:
            yield num, wt, int.from_bytes(b[i:i+8], 'little'); i += 8
        else:
            raise ValueError(f'wire type non gestito: {wt}')

def valore_primitivo(item_bytes):
    """Item → Primitive (campo 7) → primo campo valorizzato, che è il numero."""
    for num, wt, val in campi(item_bytes):
        if num == 7 and wt == 2:
            for _n, _wt, v in campi(val):
                if _wt == 0:
                    return v
    return None

def attributi(elem_bytes):
    """Restituisce {nome: valore} degli attributi di un XmlElement."""
    out = {}
    for num, wt, val in campi(elem_bytes):
        if num == 4 and wt == 2:  # XmlAttribute
            nome = grezzo = None; compilato = None
            for n2, wt2, v2 in campi(val):
                if n2 == 2 and wt2 == 2: nome = v2.decode('utf-8', 'replace')
                elif n2 == 3 and wt2 == 2: grezzo = v2.decode('utf-8', 'replace')
                elif n2 == 6 and wt2 == 2: compilato = valore_primitivo(v2)
            if nome:
                # il valore compilato è la verità; `value` è la stringa sorgente
                out[nome] = compilato if (grezzo in (None, '') and compilato is not None) else (grezzo or compilato)
    return out

def elemento_radice(nodo_bytes):
    for num, wt, val in campi(nodo_bytes):
        if num == 1 and wt == 2:
            return val
    return None

def cerca(elem_bytes, nome_cercato, profondita=0):
    """Cerca ricorsivamente il primo elemento con quel nome; ritorna i suoi attributi."""
    nome = None
    for num, wt, val in campi(elem_bytes):
        if num == 3 and wt == 2:
            nome = val.decode('utf-8', 'replace')
    if nome == nome_cercato:
        return attributi(elem_bytes)
    for num, wt, val in campi(elem_bytes):
        if num == 5 and wt == 2:  # child XmlNode
            figlio = elemento_radice(val)
            if figlio is not None:
                r = cerca(figlio, nome_cercato, profondita + 1)
                if r is not None:
                    return r
    return None

def permessi(elem_bytes, acc=None):
    if acc is None: acc = []
    nome = None
    for num, wt, val in campi(elem_bytes):
        if num == 3 and wt == 2: nome = val.decode('utf-8', 'replace')
    if nome == 'uses-permission':
        a = attributi(elem_bytes)
        if 'name' in a: acc.append(str(a['name']))
    for num, wt, val in campi(elem_bytes):
        if num == 5 and wt == 2:
            figlio = elemento_radice(val)
            if figlio is not None: permessi(figlio, acc)
    return acc

aab = sys.argv[1]
with zipfile.ZipFile(aab) as z:
    dati = z.read('base/manifest/AndroidManifest.xml')

radice = elemento_radice(dati)
man = attributi(radice)
print('applicationId (package) =', man.get('package'))
print('versionCode             =', man.get('versionCode'))
print('versionName             =', man.get('versionName'))

sdk = cerca(radice, 'uses-sdk')
if sdk:
    print('minSdkVersion           =', sdk.get('minSdkVersion'))
    print('targetSdkVersion        =', sdk.get('targetSdkVersion'))

app = cerca(radice, 'application')
if app:
    ct = app.get('usesCleartextTraffic')
    print('usesCleartextTraffic    =', ct if ct is not None else '(assente)')
    print('networkSecurityConfig   =', app.get('networkSecurityConfig', '(assente)'))

p = permessi(radice)
print('permessi ({}):'.format(len(p)))
for x in sorted(p):
    print('   ', x)
