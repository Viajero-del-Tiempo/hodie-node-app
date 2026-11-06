# Imagen sintética del guardián

p06-reference.png muestra una caja rectangular oscura con tapa, sin logotipos,
texto ni personas. Es una referencia artificial para P-06: no representa un
producto real ni acredita color, material, medidas o disponibilidad del catálogo.
Esos datos siguen saliendo de las herramientas y de las fixtures del caso.

q03-reference.png es un dibujo sintético de la cabeza de una vaca, sin texto,
personas ni marcas. Sirve como referencia de diseño de personalización para
Q-03/4; no acredita que el diseño pueda producirse sin revisión del equipo.
No hace falta publicar una foto real. El manifiesto guardian-manifest.json asocia
ambas imágenes a sus turnos, sin modificar conversations.yaml.

Regeneración (no ejecuta tests ni usa IA ni servicios externos):

    node test/eval/media/generate-reference.js
    node test/eval/media/generate-personalization.js

Esto ejercita la entrada visual real del modelo, no certifica la calidad con
fotografías de clientes. Las fixtures de medios del repo deben ser sintéticas o
no contener datos personales.
