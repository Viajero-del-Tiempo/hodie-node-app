#!/usr/bin/env python3
"""Parche de test/eval/conversations.yaml: fotos de empaques (agregado de 5C).
Uso: python3 parche-empaques.py test/eval/conversations.yaml
- Agrega imageUrl ficticia a cada opción de empaque de los fixtures
  (salvo el envoltorio de la billetera masculina, que queda sin foto a propósito).
- Agrega Q-06: el cliente pide ver cómo queda la billetera con cada empaque.
Funciona con opciones en una sola línea o en varias líneas (formato de Prettier)."""
import re, sys

if len(sys.argv) != 2:
    sys.exit("Uso: python3 parche-empaques.py test/eval/conversations.yaml")
path = sys.argv[1]
s = open(path, encoding="utf-8").read()
if "example.test/hodie/empaques" in s:
    sys.exit("El parche ya fue aplicado; no se modifica nada.")
if "\ncases:" not in s:
    sys.exit("No se encontró la sección cases:; no se modificó el archivo.")

SIN_FOTO = {("billetera-masculina", "envoltorio")}
fixtures, rest = s.split("\ncases:", 1)
lines = fixtures.split("\n")
out, product, n, i = [], None, 0, 0
while i < len(lines):
    line = lines[i]
    m = re.match(r"^    - id: ([a-z0-9-]+)\s*$", line)
    if m:
        product = m.group(1)
    url = lambda t: f'"https://example.test/hodie/empaques/{product}-{t}.jpg"'
    # Una sola línea: - { type: caja, name: "...", price: 1 }
    m = re.match(r"^(\s*- \{ type: ([a-z]+), .*?) \}\s*$", line)
    if m and product:
        t = m.group(2)
        if (product, t) not in SIN_FOTO:
            line = f"{m.group(1)}, imageUrl: {url(t)} }}"
            n += 1
        out.append(line); i += 1; continue
    # Varias líneas: - {  /  type: caja,
    if re.match(r"^\s*- \{\s*$", line) and i + 1 < len(lines):
        m2 = re.match(r"^(\s+)type: ([a-z]+),\s*$", lines[i + 1])
        if m2 and product:
            out.append(line); out.append(lines[i + 1])
            if (product, m2.group(2)) not in SIN_FOTO:
                out.append(f"{m2.group(1)}imageUrl: {url(m2.group(2))},")
                n += 1
            i += 2; continue
    out.append(line); i += 1

if n == 0:
    sys.exit("No se encontraron opciones de empaque: no se modificó el archivo. Pasale el error a Claude.")

s = "\n".join(out) + "\ncases:" + rest
s = s.rstrip("\n") + '''

  - id: Q-06
    category: personalizacion
    context:
      carrito:
        lineas:
          - { producto: billetera-masculina, variante: bm-negro, cantidad: 1, texto: "AG" }
    turns:
      - user: "¿Cómo queda la billetera con cada empaque? Mandame fotos"
    expect:
      tools_not_called: [crear_pedido]
      must:
        - Envía la foto de la billetera con la caja y con la bolsa, cada una con su precio.
        - Menciona el envoltorio con su precio, aunque no tenga foto.
      must_not:
        - Afirma haber enviado una foto del envoltorio.
      handoff: "no"
'''
open(path, "w", encoding="utf-8").write(s)
print(f"OK: {n} opciones de empaque con foto; Q-06 agregado.")
