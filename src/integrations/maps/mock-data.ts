import type { Place } from "./types.js";

/** Extra searchable words for a mock place (not part of the public contract). */
export interface MockPlaceEntry {
  readonly place: Place;
  readonly keywords: readonly string[];
}

/** Recursively freezes a value (objects and arrays) so the dataset cannot be tampered with. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Id of the fake ice-cream shop (decision D43). */
export const TEST_ICE_CREAM_PLACE_ID = "mock-place-001";

/**
 * Fictitious dataset. Every entry is fake: example domains, reserved-style phone numbers,
 * made-up addresses. Order here is the deterministic result order.
 */
export const MOCK_PLACES: readonly MockPlaceEntry[] = deepFreeze([
  {
    place: {
      placeId: TEST_ICE_CREAM_PLACE_ID,
      name: "Heladería de Prueba (TEST)",
      address: "Calle Ficticia 100, Ciudad Ejemplo",
      location: { latitude: -34.6, longitude: -58.4 },
      categories: ["ice_cream_shop", "dessert_shop"],
      phone: "+54 11 0000-0001",
      website: "https://heladeria.example.test",
      rating: 4.5,
      businessStatus: "operational",
      isTestData: true,
    },
    keywords: ["heladeria", "helado", "helados", "ice cream", "test business", "negocio de prueba"],
  },
  {
    place: {
      placeId: "mock-place-002",
      name: "Panadería Ejemplo (TEST)",
      address: "Avenida Inventada 200, Ciudad Ejemplo",
      location: { latitude: -34.61, longitude: -58.41 },
      categories: ["bakery", "food_store"],
      phone: "+54 11 0000-0002",
      website: "https://panaderia.example.com",
      rating: 4.1,
      businessStatus: "operational",
      isTestData: true,
    },
    keywords: ["panaderia", "pan", "facturas", "bakery"],
  },
  {
    place: {
      placeId: "mock-place-003",
      name: "Ferretería Ficticia (TEST)",
      address: "Calle Imaginaria 300, Ciudad Ejemplo",
      location: { latitude: -34.62, longitude: -58.39 },
      categories: ["hardware_store", "store"],
      phone: "+54 11 0000-0003",
      website: "https://ferreteria.example.test",
      businessStatus: "operational",
      isTestData: true,
    },
    keywords: ["ferreteria", "herramientas", "hardware"],
  },
  {
    place: {
      placeId: "mock-place-004",
      name: "Heladería Cerrada (TEST)",
      address: "Pasaje Falso 400, Ciudad Ejemplo",
      location: { latitude: -34.7, longitude: -58.5 },
      categories: ["ice_cream_shop"],
      rating: 3.2,
      businessStatus: "closed_permanently",
      isTestData: true,
    },
    keywords: ["heladeria", "helado", "helados", "ice cream"],
  },
]);
