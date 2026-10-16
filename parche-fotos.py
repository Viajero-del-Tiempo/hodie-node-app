#!/usr/bin/env python3
"""Parche de test/eval/conversations.yaml para las fotos automáticas (entrega 5C).
Uso: python3 parche-fotos.py test/eval/conversations.yaml
- Agrega imageUrls ficticias a las variantes (salvo la caja para termo, que queda sin fotos).
- Actualiza C-04 a 3 opciones con foto.
- Agrega P-08 (producto sin fotos).
Funciona con variantes en una sola línea o en varias líneas (formato de Prettier)."""
import re, sys

if len(sys.argv) != 2:
    sys.exit("Uso: python3 parche-fotos.py test/eval/conversations.yaml")
path = sys.argv[1]
s = open(path, encoding="utf-8").read()
if "example.test/hodie" in s:
    sys.exit("El parche ya fue aplicado; no se modifica nada.")

SIN_FOTOS = {"caja-tm-negro"}
url = lambda vid: f'"https://example.test/hodie/{vid}.jpg"'
n = 0

# Formato 1: variante en una sola línea  - { id: x, sku: ..., stock: 3 }
def una_linea(m):
    global n
    vid = m.group(2)
    if vid in SIN_FOTOS:
        return m.group(0)
    n += 1
    return f"{m.group(1)}{m.group(3)}, imageUrls: [{url(vid)}] }}"
s = re.sub(r"^(\s*- \{ id: ([a-z0-9-]+), sku: )(.*?) \}$", una_linea, s, flags=re.M)

# Formato 2: variante en varias líneas
#   - {
#       id: x,
#       sku: ...,
def multi_linea(m):
    global n
    indent, vid = m.group(2), m.group(3)
    if vid in SIN_FOTOS:
        return m.group(0)
    n += 1
    return f"{m.group(0)}\n{indent}imageUrls: [{url(vid)}],"
s = re.sub(r"^(\s*- \{\s*\n(\s+)id: ([a-z0-9-]+),)$", multi_linea, s, flags=re.M)

if n == 0:
    sys.exit("No se encontraron variantes: no se modificó el archivo. Pasale el error a Claude.")

reemplazos = [
    (r"^(\s*)- Muestra pocas opciones \(como máximo 5\) relacionadas con graduación o regalo para él, con su precio\.\s*$",
     r"\1- Muestra como máximo 3 opciones relacionadas con graduación o regalo para él, con su precio."),
    (r"^(\s*)- Ofrece mostrar fotos o dar más detalles\.\s*$",
     r"\1- Envía la foto de cada opción mostrada."),
]
for patron, nuevo in reemplazos:
    s, k = re.subn(patron, nuevo, s, flags=re.M)
    if k != 1:
        sys.exit(f"No se encontró exactamente una vez el criterio de C-04 ({k}); no se modificó el archivo.")

s = s.rstrip("\n") + '''

  # ------------------------------------------------------------------
  # Fotos automáticas (entrega 5C)
  # ------------------------------------------------------------------
  - id: P-08
    category: producto
    turns:
      - user: "¿Tienen caja para regalar un termo de mate? ¿Me pasás una foto?"
    expect:
      tools_called: [buscar_productos]
      must:
        - Informa la caja para termo de mate con su precio y medidas.
        - Aclara que por ahora no tiene una foto para enviar.
      must_not:
        - Envía o promete una foto que no existe.
      handoff: "no"
'''
open(path, "w", encoding="utf-8").write(s)
print(f"OK: {n} variantes con foto; C-04 actualizado; P-08 agregado.")
