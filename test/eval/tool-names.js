export const TOOL_NAMES = Object.freeze([
  "buscar_productos", "ver_producto", "enviar_imagenes",
  "carrito_ver", "carrito_agregar", "carrito_modificar", "carrito_quitar",
  "datos_envio", "datos_facturacion", "cotizar", "crear_pedido",
  "estado_pedido", "registrar_comprobante", "consultar_politicas", "derivar", "responder",
]);
export const TOOL_ALIASES = Object.freeze({
  carrito: Object.freeze(TOOL_NAMES.filter(name => name.startsWith("carrito_"))),
});
export function resolveToolNames(name) {
  if (TOOL_NAMES.includes(name)) return [name];
  return Object.hasOwn(TOOL_ALIASES, name) ? TOOL_ALIASES[name] : null;
}
export function checkToolSpecification(markdown) {
  const section = markdown.replace(/\r\n/g, "\n").split("## Herramientas\n")[1]?.split("### Reglas comunes")[0] ?? "";
  const documented = [...section.matchAll(/^\| \x60([^\x60]+)\x60 \|/gm)].map(match => match[1]);
  const missing = TOOL_NAMES.filter(name => !documented.includes(name));
  const extra = documented.filter(name => !TOOL_NAMES.includes(name));
  return { valid: missing.length === 0 && extra.length === 0, missing, extra };
}
