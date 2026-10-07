import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { assertLocalEnvironment } from "./local-catalog.config.js";

export async function seedCatalog() {
  // Guardas antes de importar Firebase o leer fixtures.
  assertLocalEnvironment(process.env);
  const [{ db }, { Timestamp }, { createCatalogRepository }, { createCatalogService }] = await Promise.all([
    import("../src/config/firebase.js"), import("firebase-admin/firestore"),
    import("../src/services/catalog.repository.js"), import("../src/services/catalog.service.js"),
  ]);
  const fixtures = JSON.parse(await readFile(new URL("../test/fixtures/catalog-emulator.json", import.meta.url), "utf8"));
  const timestampNow = () => Timestamp.now();
  for (const category of fixtures.categories) {
    const ref = db.collection("categories").doc(category.id);
    if (!(await ref.get()).exists) await createCatalogRepository(db, { timestampNow }).createCategory(category);
  }
  const policyRepository = createCatalogRepository(db, { timestampNow });
  for (const policy of fixtures.policies) {
    if (!(await db.collection("policies").doc(policy.id).get()).exists) await policyRepository.createPolicy(policy);
  }
  for (const { id, ...input } of fixtures.products) {
    if (!id.startsWith("test-")) throw new Error("Las fixtures locales requieren IDs test-");
    if ((await db.collection("products").doc(id).get()).exists) continue;
    const product = {
      ...input,
      variants: input.variants.map(variant => ({ ...variant, imageUrls: variant.imageUrls.map(url => "http://localhost:3000" + url) })),
      packagingOptions: input.packagingOptions.map(option => ({ ...option, ...(option.imageUrl ? { imageUrl: "http://localhost:3000" + option.imageUrl } : {}) })),
    };
    const repository = createCatalogRepository(db, { timestampNow, generateProductId: () => id,
      generateVariantId: () => "test-local-variant-" + randomUUID() });
    await createCatalogService({ repository }).createProduct(product);
  }
  const admin = fixtures.admin;
  const userRef = db.collection("users").doc(admin.uid);
  if (!(await userRef.get()).exists) await userRef.create({ ...admin, createdAt: timestampNow(), updatedAt: timestampNow() });
  for (const customer of fixtures.customers ?? []) {
    if (!customer.uid.startsWith("test-")) throw new Error("Las fixtures de usuarios requieren IDs test-");
    const ref = db.collection("users").doc(customer.uid);
    if (!(await ref.get()).exists) await ref.create({ ...customer, createdAt: timestampNow(), updatedAt: timestampNow() });
    console.log("Cliente local: " + customer.displayName + " | login " + "0" + customer.phoneNumber.slice(3));
  }
  const { createOrderPricingService } = await import("../src/services/order-pricing.service.js");
  const pricing = createOrderPricingService({ catalog: createCatalogService({ repository: createCatalogRepository(db, { timestampNow }) }) });
  const { determineShippingMethod } = await import("../src/services/shipping.service.js");
  for (const example of fixtures.orders ?? []) {
    if (!example.id.startsWith("test-")) throw new Error("Las fixtures de pedidos requieren IDs test-");
    const ref = db.collection("orders").doc(example.id);
    if ((await ref.get()).exists) continue;
    const customer = fixtures.customers.find(row => row.uid === example.customerId);
    const items = [];
    for (const { variantSku, ...item } of example.items) {
      const product = (await db.collection("products").doc(item.productId).get()).data();
      const variant = product.variants.find(row => row.sku === variantSku);
      if (!variant) throw new Error("Variante de fixture inexistente");
      items.push({ ...item, variantId: variant.id });
    }
    const calculated = await pricing(items);
    const address = customer.addresses.find(row => row.id === example.addressId);
    const billing = customer.billingProfiles.find(row => row.id === example.billingProfileId);
    const createdAt = Timestamp.fromMillis(Date.now() - example.daysAgo * 86400000);
    await ref.create({ id: example.id, orderNumber: example.id, userId: customer.uid,
      userPhoneNumber: customer.phoneNumber, userDisplayName: customer.displayName,
      items: calculated.sanitizedItems, subtotal: calculated.subtotal, shippingCost: 0, total: calculated.total,
      shippingAddress: Object.fromEntries(Object.entries(address).filter(([key]) => key !== "id")),
      shippingMethod: determineShippingMethod(address.city),
      ...(billing ? { billing: { invoiceRequested: true, legalName: billing.legalName, ruc: billing.ruc, rucValidation: billing.rucValidation } }
        : example.phoneVerification ? { billing: { invoiceRequested: false } } : {}),
      ...(example.origin ? { origin: example.origin } : {}),
      ...(example.phoneVerification ? { phoneVerification: example.phoneVerification } : {}),
      status: example.status, pdfDelivered: false, createdAt, updatedAt: createdAt,
      customizationPending: calculated.sanitizedItems.some(item => item.customizationPending),
      customizationImagePending: calculated.sanitizedItems.some(item => item.customizationImagePending),
    });
  }
  return admin;
}
