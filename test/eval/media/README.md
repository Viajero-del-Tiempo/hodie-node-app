# Imagen sintética del guardián

p06-reference.png muestra una caja rectangular oscura con tapa, sin logotipos,
texto ni personas. Es una referencia artificial para P-06: no representa un
producto real ni acredita color, material, medidas o disponibilidad del catálogo.
Esos datos siguen saliendo de las herramientas y de las fixtures del caso.

No hace falta publicar una foto real. El manifiesto guardian-manifest.json asocia
la imagen exclusivamente a P-06/2, sin modificar conversations.yaml.

Regeneración (no ejecuta tests ni usa IA ni servicios externos):

    node test/eval/media/generate-reference.js

Esto ejercita la entrada visual real del modelo, no certifica la calidad con
fotografías de clientes. Las fixtures de medios del repo deben ser sintéticas o
no contener datos personales.
