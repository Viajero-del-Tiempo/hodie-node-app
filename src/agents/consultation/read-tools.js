import { createOrderAccess } from "./order-access.js";

export function createReadTools({ catalog, orders, getState, transport }) {
  return {
    async buscar_productos({ consulta, categoriaId, opciones, soloDisponibles = false, limite = 5 }) {
      const products = await catalog.searchProducts({ query: consulta, categoryId: categoriaId,
        options: opciones ?? {}, onlyAvailable: soloDisponibles, limit: limite });
      return { code: "OK", products };
    },
    async ver_producto({ productId }) {
      const product = await catalog.getProduct(productId);
      return product ? { code: "OK", product } : { code: "PRODUCTO_NO_ENCONTRADO" };
    },
    async enviar_imagenes({ productId, variantId }, { signal } = {}) {
      const product = await catalog.getProduct(productId);
      signal?.throwIfAborted();
      if (!product) return { code: "PRODUCTO_NO_ENCONTRADO", sent: 0 };
      const variant = variantId === undefined ? null : product.variants.find(item => item.id === variantId);
      if (variantId !== undefined && !variant) return { code: "VARIANTE_INACTIVA", sent: 0 };
      const sources = [...new Set([...(variant?.imageUrls ?? []), ...(product.imageUrls ?? [])])].slice(0, 3);
      for (const source of sources) {
        signal?.throwIfAborted();
        await transport.sendImage({ source, caption: product.name });
      }
      return { code: sources.length ? "OK" : "SIN_IMAGENES", sent: sources.length };
    },
    async consultar_politicas() { return { code: "OK", policies: await catalog.listPolicies() }; },
    estado_pedido: createOrderAccess({ repository: orders, getIdentity: getState }),
  };
}
