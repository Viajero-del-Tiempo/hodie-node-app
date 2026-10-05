import express from "express";
import { createCatalogController } from "../controllers/catalog.controller.js";

export function createCatalogRouter(service) {
  const router = express.Router();
  const controller = createCatalogController(service);
  router.get("/categories", controller.categories);
  router.get("/products", controller.products);
  router.get("/products/by-slug/:slug", controller.bySlug);
  router.get("/products/:id", controller.byId);
  return router;
}

export const router = createCatalogRouter();
