// =============================================================================
// mockDatabase.ts
// =============================================================================
// Central mock data store for the Liquor Store POS System.
//
// Data Model Overview:
//   Product          → A SKU in inventory (bottle, case, pack, etc.)
//   ProductCategory  → Enum of top-level department groupings
//   ParentChildLink  → Defines how a "case" explodes into "singles"
//
// Parent-Child (Case-Break) Relationship:
//   A "parent" product (e.g. Case of Tito's) has a `childSku` pointer and a
//   `unitsPerCase` value.  When a case is sold, the POS can optionally
//   decrement the matching single-bottle child SKU by `unitsPerCase`, or
//   vice-versa when singles are sold and a case needs to be broken.
//
//   parent.childSku  ──►  child.sku   (one-to-one per case relationship)
//   child.parentSku  ──►  parent.sku  (back-reference for UI grouping)
//
// All prices are stored in CENTS (integer) to avoid floating-point drift.
// Display layer is responsible for formatting: (price / 100).toFixed(2)
// =============================================================================

// ---------------------------------------------------------------------------
// Enums & Union Types
// ---------------------------------------------------------------------------

/** Top-level department / category shown on the POS category filter bar. */
export type ProductCategory =
  | "Spirits"
  | "Wine"
  | "Beer"
  | "Tobacco"
  | "Misc";

/**
 * Unit of measure — used by the UI to label quantities correctly.
 * e.g. "1 bottle", "1 pack", "1 case (12 ct)"
 */
export type UnitOfMeasure =
  | "bottle"   // single bottle (spirits / wine)
  | "can"      // single can (beer / seltzers)
  | "pack"     // multi-pack (6-pack, 12-pack of cans/bottles)
  | "case"     // full case (typically 12 or 24 units)
  | "carton"   // cigarette carton (10 packs)
  | "each";    // generic catch-all (lighters, mixers, etc.)

// ---------------------------------------------------------------------------
// Core Product Type
// ---------------------------------------------------------------------------

/**
 * Represents a single inventory SKU.
 *
 * Naming convention for `sku`:
 *   [CATEGORY_PREFIX]-[BRAND_ABBREV]-[SIZE/TYPE]-[VARIANT]
 *   e.g. "SPR-TITO-750"  →  Spirits › Tito's › 750 mL
 *        "SPR-TITO-CASE" →  Spirits › Tito's › Case (12 × 750 mL)
 */
export interface Product {
  /** Internal SKU — unique, human-readable identifier. */
  sku: string;

  /**
   * UPC-A barcode (12 digits).
   * In production this would come from GS1 / supplier data.
   * Mock values are realistic but not real GS1-registered barcodes.
   */
  upc: string;

  /** Display name shown on receipts, search results, and cart rows. */
  name: string;

  /** Optional longer description (shown on product detail / tooltip). */
  description?: string;

  /** Department grouping used for category filter tabs. */
  category: ProductCategory;

  /**
   * Sale price in CENTS (integer).
   * e.g. $24.99  →  2499
   * Integer math eliminates floating-point rounding errors at the register.
   */
  priceInCents: number;

  /**
   * Cost price in CENTS — used for margin reporting (back-office only).
   * Never displayed on the customer-facing receipt.
   */
  costInCents?: number;

  /** Current on-hand stock count (whole units of this SKU). */
  stock: number;

  /** Low-stock alert threshold.  UI highlights row when stock ≤ this value. */
  lowStockThreshold: number;

  /** Unit of measure for labelling quantities. */
  uom: UnitOfMeasure;

  // --- Parent / Child (Case-Break) fields -----------------------------------

  /**
   * If this product IS a case/pack, this points to the child single-unit SKU.
   * e.g. Case of Tito's  →  childSku = "SPR-TITO-750"
   */
  childSku?: string;

  /**
   * How many child units are contained in one unit of this (parent) product.
   * Only meaningful when `childSku` is set.
   * e.g. 12  means  1 case = 12 bottles
   */
  unitsPerCase?: number;

  /**
   * Back-reference: if this product IS a single unit that belongs to a case,
   * this points to the parent case SKU.
   * e.g. Single Tito's 750 mL  →  parentSku = "SPR-TITO-CASE"
   */
  parentSku?: string;

  /** Whether this product is active and available for sale. */
  isActive: boolean;

  /** Whether age verification (21+) is required at point of sale. */
  requiresAgeVerification: boolean;

  /** Optional image URL / path for product tiles (can be placeholder). */
  imageUrl?: string;

  /** Tags for fuzzy search / quick-find (brand, type, flavor, etc.). */
  tags: string[];
}

// ---------------------------------------------------------------------------
// Mock Product Database
// ---------------------------------------------------------------------------

/**
 * MOCK_PRODUCTS
 *
 * In a production system this would be fetched from an API / Supabase table.
 * For now it serves as the initial state seeded into InventoryContext / Zustand.
 *
 * Organised by category for readability; the store itself is a flat Map<sku, Product>.
 */
export const MOCK_PRODUCTS: Product[] = [

  // ==========================================================================
  // SPIRITS
  // ==========================================================================

  // ---------- Tito's Handmade Vodka (case-break pair) -----------------------

  {
    sku: "SPR-TITO-750",
    upc: "852423001009",
    name: "Tito's Handmade Vodka 750 mL",
    description: "America's original craft vodka. Gluten-free, made in Austin, TX.",
    category: "Spirits",
    priceInCents: 2499,          // $24.99
    costInCents: 1350,
    stock: 48,
    lowStockThreshold: 6,
    uom: "bottle",
    parentSku: "SPR-TITO-CASE", // ← belongs to the case below
    isActive: true,
    requiresAgeVerification: true,
    tags: ["vodka", "tito's", "titos", "craft", "gluten free"],
  },
  {
    sku: "SPR-TITO-CASE",
    upc: "852423001016",
    name: "Tito's Handmade Vodka — Case (12 × 750 mL)",
    description: "Full case of Tito's 750 mL. Breaking the case credits 12 singles.",
    category: "Spirits",
    priceInCents: 27000,         // $270.00 (saves ~$29.88 vs buying singles)
    costInCents: 15600,
    stock: 6,
    lowStockThreshold: 1,
    uom: "case",
    childSku: "SPR-TITO-750",   // ← case explodes into this single SKU
    unitsPerCase: 12,
    isActive: true,
    requiresAgeVerification: true,
    tags: ["vodka", "tito's", "titos", "case", "bulk"],
  },

  // ---------- Jack Daniel's Tennessee Whiskey (case-break pair) -------------

  {
    sku: "SPR-JD-750",
    upc: "082184000805",
    name: "Jack Daniel's Old No. 7 750 mL",
    description: "Classic Tennessee whiskey, charcoal mellowed drop by drop.",
    category: "Spirits",
    priceInCents: 2799,          // $27.99
    costInCents: 1580,
    stock: 36,
    lowStockThreshold: 6,
    uom: "bottle",
    parentSku: "SPR-JD-CASE",
    isActive: true,
    requiresAgeVerification: true,
    tags: ["whiskey", "whisky", "tennessee", "jack daniels", "jack"],
  },
  {
    sku: "SPR-JD-CASE",
    upc: "082184000812",
    name: "Jack Daniel's Old No. 7 — Case (12 × 750 mL)",
    category: "Spirits",
    priceInCents: 30000,         // $300.00
    costInCents: 18000,
    stock: 3,
    lowStockThreshold: 1,
    uom: "case",
    childSku: "SPR-JD-750",
    unitsPerCase: 12,
    isActive: true,
    requiresAgeVerification: true,
    tags: ["whiskey", "tennessee", "jack daniels", "case", "bulk"],
  },

  // ---------- Hennessy VS Cognac (single only — no case in this mock) -------

  {
    sku: "SPR-HENN-750",
    upc: "088110110145",
    name: "Hennessy VS Cognac 750 mL",
    description: "The world's best-selling Cognac. Smooth, rich, versatile.",
    category: "Spirits",
    priceInCents: 3999,          // $39.99
    costInCents: 2400,
    stock: 22,
    lowStockThreshold: 4,
    uom: "bottle",
    isActive: true,
    requiresAgeVerification: true,
    tags: ["cognac", "hennessy", "brandy", "henny"],
  },

  // ---------- Patron Silver Tequila (case-break pair) -----------------------

  {
    sku: "SPR-PAT-750",
    upc: "721733001014",
    name: "Patrón Silver Tequila 750 mL",
    description: "Ultra-premium 100% Weber blue agave silver tequila.",
    category: "Spirits",
    priceInCents: 4499,          // $44.99
    costInCents: 2700,
    stock: 18,
    lowStockThreshold: 4,
    uom: "bottle",
    parentSku: "SPR-PAT-CASE",
    isActive: true,
    requiresAgeVerification: true,
    tags: ["tequila", "patron", "silver", "blanco", "agave"],
  },
  {
    sku: "SPR-PAT-CASE",
    upc: "721733001021",
    name: "Patrón Silver Tequila — Case (12 × 750 mL)",
    category: "Spirits",
    priceInCents: 48000,         // $480.00
    costInCents: 31200,
    stock: 2,
    lowStockThreshold: 1,
    uom: "case",
    childSku: "SPR-PAT-750",
    unitsPerCase: 12,
    isActive: true,
    requiresAgeVerification: true,
    tags: ["tequila", "patron", "case", "bulk"],
  },

  // ==========================================================================
  // WINE
  // ==========================================================================

  {
    sku: "WIN-BARED-750",
    upc: "085000002224",
    name: "Barefoot Pinot Grigio 750 mL",
    description: "Light-bodied, crisp and refreshing with notes of peach and citrus.",
    category: "Wine",
    priceInCents: 899,           // $8.99
    costInCents: 450,
    stock: 60,
    lowStockThreshold: 12,
    uom: "bottle",
    isActive: true,
    requiresAgeVerification: true,
    tags: ["wine", "white wine", "pinot grigio", "barefoot", "dry"],
  },
  {
    sku: "WIN-MKELLY-750",
    upc: "040232460036",
    name: "Mark West Pinot Noir 750 mL",
    description: "California Pinot Noir with flavors of cherry, blackberry, and mocha.",
    category: "Wine",
    priceInCents: 1299,          // $12.99
    costInCents: 680,
    stock: 30,
    lowStockThreshold: 6,
    uom: "bottle",
    isActive: true,
    requiresAgeVerification: true,
    tags: ["wine", "red wine", "pinot noir", "mark west", "california"],
  },
  {
    sku: "WIN-LMOO-1500",
    upc: "856505003027",
    name: "La Marca Prosecco 1.5 L (Magnum)",
    description: "Sparkling Italian Prosecco — honey, cream, and peach notes.",
    category: "Wine",
    priceInCents: 2999,          // $29.99
    costInCents: 1600,
    stock: 10,
    lowStockThreshold: 2,
    uom: "bottle",
    isActive: true,
    requiresAgeVerification: true,
    tags: ["wine", "sparkling", "prosecco", "la marca", "italian", "magnum"],
  },

  // ==========================================================================
  // BEER
  // ==========================================================================

  // ---------- Modelo Especial (single can + 6-pack + 24-pack case) ----------

  {
    sku: "BER-MOD-CAN",
    upc: "013800001122",
    name: "Modelo Especial — Single Can 16 oz",
    category: "Beer",
    priceInCents: 199,           // $1.99
    costInCents: 90,
    stock: 144,
    lowStockThreshold: 24,
    uom: "can",
    parentSku: "BER-MOD-6PK",   // belongs to 6-pack
    isActive: true,
    requiresAgeVerification: true,
    tags: ["beer", "modelo", "lager", "mexican", "single"],
  },
  {
    sku: "BER-MOD-6PK",
    upc: "013800001139",
    name: "Modelo Especial — 6-Pack 16 oz Cans",
    category: "Beer",
    priceInCents: 1099,          // $10.99
    costInCents: 520,
    stock: 24,
    lowStockThreshold: 6,
    uom: "pack",
    childSku: "BER-MOD-CAN",
    unitsPerCase: 6,
    parentSku: "BER-MOD-24PK",  // this 6-pack belongs to the 24-pack case
    isActive: true,
    requiresAgeVerification: true,
    tags: ["beer", "modelo", "lager", "6-pack", "6pk"],
  },
  {
    sku: "BER-MOD-24PK",
    upc: "013800001146",
    name: "Modelo Especial — 24-Pack 16 oz Cans (Case)",
    category: "Beer",
    priceInCents: 3799,          // $37.99
    costInCents: 1980,
    stock: 8,
    lowStockThreshold: 2,
    uom: "case",
    childSku: "BER-MOD-6PK",    // case → 6-packs (4 six-packs per case)
    unitsPerCase: 4,             // 4 × 6-packs = 24 cans
    isActive: true,
    requiresAgeVerification: true,
    tags: ["beer", "modelo", "lager", "24-pack", "case", "bulk"],
  },

  // ---------- White Claw Hard Seltzer (6-pack) ------------------------------

  {
    sku: "BER-WCLAW-6PK",
    upc: "085200014005",
    name: "White Claw Hard Seltzer Variety — 6-Pack 12 oz",
    description: "Variety pack: Black Cherry, Mango, Natural Lime, Raspberry.",
    category: "Beer",
    priceInCents: 1099,          // $10.99
    costInCents: 560,
    stock: 30,
    lowStockThreshold: 6,
    uom: "pack",
    isActive: true,
    requiresAgeVerification: true,
    tags: ["seltzer", "hard seltzer", "white claw", "6-pack", "variety"],
  },

  // ==========================================================================
  // TOBACCO
  // ==========================================================================

  // ---------- Marlboro Red (pack + carton pair) -----------------------------

  {
    sku: "TOB-MARLR-PACK",
    upc: "028000083861",
    name: "Marlboro Red — Pack (20 ct)",
    category: "Tobacco",
    priceInCents: 1050,          // $10.50
    costInCents: 720,
    stock: 200,
    lowStockThreshold: 20,
    uom: "each",
    parentSku: "TOB-MARLR-CTN",
    isActive: true,
    requiresAgeVerification: true,
    tags: ["cigarettes", "marlboro", "red", "full flavor", "tobacco"],
  },
  {
    sku: "TOB-MARLR-CTN",
    upc: "028000083878",
    name: "Marlboro Red — Carton (10 packs, 200 ct)",
    category: "Tobacco",
    priceInCents: 9500,          // $95.00
    costInCents: 7100,
    stock: 20,
    lowStockThreshold: 3,
    uom: "carton",
    childSku: "TOB-MARLR-PACK",
    unitsPerCase: 10,            // 1 carton = 10 packs
    isActive: true,
    requiresAgeVerification: true,
    tags: ["cigarettes", "marlboro", "red", "carton", "bulk"],
  },

  // ---------- Newport Menthol (pack + carton pair) --------------------------

  {
    sku: "TOB-NEWP-PACK",
    upc: "012233004442",
    name: "Newport Menthol — Pack (20 ct)",
    category: "Tobacco",
    priceInCents: 1125,          // $11.25
    costInCents: 790,
    stock: 180,
    lowStockThreshold: 20,
    uom: "each",
    parentSku: "TOB-NEWP-CTN",
    isActive: true,
    requiresAgeVerification: true,
    tags: ["cigarettes", "newport", "menthol", "tobacco"],
  },
  {
    sku: "TOB-NEWP-CTN",
    upc: "012233004459",
    name: "Newport Menthol — Carton (10 packs, 200 ct)",
    category: "Tobacco",
    priceInCents: 10200,         // $102.00
    costInCents: 7800,
    stock: 15,
    lowStockThreshold: 3,
    uom: "carton",
    childSku: "TOB-NEWP-PACK",
    unitsPerCase: 10,
    isActive: true,
    requiresAgeVerification: true,
    tags: ["cigarettes", "newport", "menthol", "carton", "bulk"],
  },

  // ==========================================================================
  // MISC (mixers, accessories, non-alcoholic)
  // ==========================================================================

  {
    sku: "MSC-REDBULL-CASE",
    upc: "611269991702",
    name: "Red Bull Energy Drink — Case (24 × 8.4 oz)",
    category: "Misc",
    priceInCents: 4200,          // $42.00
    costInCents: 2400,
    stock: 10,
    lowStockThreshold: 2,
    uom: "case",
    childSku: "MSC-REDBULL-CAN",
    unitsPerCase: 24,
    isActive: true,
    requiresAgeVerification: false,
    tags: ["energy drink", "red bull", "mixer", "non-alcoholic", "case"],
  },
  {
    sku: "MSC-REDBULL-CAN",
    upc: "611269991719",
    name: "Red Bull Energy Drink — Single 8.4 oz",
    category: "Misc",
    priceInCents: 299,           // $2.99
    costInCents: 130,
    stock: 48,
    lowStockThreshold: 12,
    uom: "can",
    parentSku: "MSC-REDBULL-CASE",
    isActive: true,
    requiresAgeVerification: false,
    tags: ["energy drink", "red bull", "mixer", "non-alcoholic"],
  },
  {
    sku: "MSC-FEVER-4PK",
    upc: "876891000061",
    name: "Fever-Tree Club Soda — 4-Pack (4 × 6.8 oz)",
    description: "Premium club soda — the perfect spirit mixer.",
    category: "Misc",
    priceInCents: 599,           // $5.99
    costInCents: 280,
    stock: 40,
    lowStockThreshold: 8,
    uom: "pack",
    isActive: true,
    requiresAgeVerification: false,
    tags: ["mixer", "club soda", "fever-tree", "soda water", "tonic"],
  },
  {
    sku: "MSC-LIGHTER-BIC",
    upc: "070330512118",
    name: "BIC Classic Lighter — Assorted Colors",
    category: "Misc",
    priceInCents: 199,           // $1.99
    costInCents: 60,
    stock: 300,
    lowStockThreshold: 30,
    uom: "each",
    isActive: true,
    requiresAgeVerification: false,
    tags: ["lighter", "bic", "accessories", "misc"],
  },
];

// ---------------------------------------------------------------------------
// Derived Lookup Structures
// ---------------------------------------------------------------------------

/**
 * SKU-keyed Map for O(1) product lookups by SKU throughout the app.
 * Built once at module load; treated as immutable reference data.
 */
export const PRODUCT_BY_SKU = new Map<string, Product>(
  MOCK_PRODUCTS.map((p) => [p.sku, p])
);

/**
 * UPC-keyed Map for barcode scanner lookups.
 * A real scanner fires a string of digits; this resolves it to a Product.
 */
export const PRODUCT_BY_UPC = new Map<string, Product>(
  MOCK_PRODUCTS.map((p) => [p.upc, p])
);

/**
 * Returns all active products belonging to a given category.
 * Used by category filter tabs on the POS grid.
 */
export const getProductsByCategory = (category: ProductCategory): Product[] =>
  MOCK_PRODUCTS.filter((p) => p.category === category && p.isActive);

/**
 * Given a parent SKU, returns the child Product (the single-unit equivalent).
 * Returns undefined if the parent has no childSku or the child doesn't exist.
 */
export const getChildProduct = (parentSku: string): Product | undefined => {
  const parent = PRODUCT_BY_SKU.get(parentSku);
  if (!parent?.childSku) return undefined;
  return PRODUCT_BY_SKU.get(parent.childSku);
};

/**
 * Given a child SKU, returns the parent Product (the case/pack equivalent).
 * Returns undefined if the child has no parentSku or the parent doesn't exist.
 */
export const getParentProduct = (childSku: string): Product | undefined => {
  const child = PRODUCT_BY_SKU.get(childSku);
  if (!child?.parentSku) return undefined;
  return PRODUCT_BY_SKU.get(child.parentSku);
};

/**
 * Formats a price in cents to a US dollar display string.
 * e.g. 2499  →  "$24.99"
 */
export const formatPrice = (cents: number): string =>
  `$${(cents / 100).toFixed(2)}`;
