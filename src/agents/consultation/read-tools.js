import { createOrderAccess } from "./order-access.js";
import { createProductImages } from "./product-images.js";

export function createReadTools(runtime) {
  const { catalog, orders, getState } = runtime;
  const images = runtime.productImages ??= createProductImages(runtime);
  const orderAccess = createOrderAccess({ repository: orders, getIdentity: getState });
  return {
    async buscar_productos({ consulta, categoriaId, opciones, soloDisponibles = false, limite = 5 }, { signal } = {}) {
      signal?.throwIfAborted();
      const products = await catalog.searchProducts({ query: consulta, categoryId: categoriaId,
        options: opciones ?? {}, onlyAvailable: soloDisponibles, limit: limite });
      signal?.throwIfAborted();
      if (products.length) images.allowForTurn();
      return { code: "OK", products };
    },
    async ver_producto({ productId }, { signal } = {}) {
      signal?.throwIfAborted();
      const product = await catalog.getProduct(productId);
      signal?.throwIfAborted();
      if (product) images.allowForTurn();
      return product ? { code: "OK", product } : { code: "PRODUCTO_NO_ENCONTRADO" };
    },
    async enviar_imagenes({ productId, variantId, packagingType }, { signal } = {}) {
      const product = await catalog.getProduct(productId);
      signal?.throwIfAborted();
      if (!product) return { code: "PRODUCTO_NO_ENCONTRADO", sent: 0 };
      const variant = variantId === undefined ? null : product.variants.find(item => item.id === variantId);
      if (variantId !== undefined && !variant) return { code: "VARIANTE_INACTIVA", sent: 0 };
      images.allowForTurn();
      return images.sendRequested(product, variant, { signal, packagingType });
    },
    async consultar_politicas() { images.excludeForTurn(); return { code: "OK", policies: await catalog.listPolicies() }; },
    async estado_pedido(args, context) { images.excludeForTurn(); return orderAccess(args, context); },
  };
}
