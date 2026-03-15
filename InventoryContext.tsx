// =============================================================================
// InventoryContext.tsx
// =============================================================================
// Manages the live product inventory for the POS session.
//
// Design Decisions:
//   • Uses React Context + useReducer rather than Zustand so there is zero
//     external dependency beyond React itself.  The shape is intentionally
//     structured to make a 1-for-1 Zustand migration trivial if desired —
//     every action type maps directly to a Zustand action function.
//
//   • All stock mutations go through the reducer so inventory changes are
//     predictable and fully auditable (each dispatch is loggable).
//
//   • Case-break logic lives here: selling a case decrements child stock,
//     and selling children can trigger a "break a case" alert when child
//     stock hits zero but parent (case) stock remains.
//
// Usage:
//   Wrap your app (or POS route) with <InventoryProvider>.
//   Components consume via the `useInventory()` hook.
//
//     const { products, adjustStock, findByUpc } = useInventory();
// =============================================================================

import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";

import {
  MOCK_PRODUCTS,
  PRODUCT_BY_SKU,
  type Product,
  type ProductCategory,
} from "./mockDatabase";

// ---------------------------------------------------------------------------
// State Shape
// ---------------------------------------------------------------------------

export interface InventoryState {
  /**
   * All products keyed by SKU for O(1) access.
   * This is the single source of truth for stock levels during a POS session.
   * In production: hydrate from API, persist mutations back via API.
   */
  products: Map<string, Product>;

  /** Whether inventory data is being loaded (for API integration later). */
  isLoading: boolean;

  /**
   * Non-blocking error message for the last failed inventory operation.
   * Displayed as a toast / status bar message; null when no error.
   */
  error: string | null;

  /**
   * Timestamp of last inventory sync (ISO string).
   * Useful for showing "last synced 2 min ago" in the UI.
   */
  lastSyncedAt: string | null;
}

// ---------------------------------------------------------------------------
// Action Types (Discriminated Union)
// ---------------------------------------------------------------------------
// All state mutations must flow through one of these typed actions.
// This keeps the reducer pure and easily unit-testable.

type InventoryAction =
  /** Replace the entire product map (e.g., after a full API sync). */
  | { type: "INVENTORY_LOADED"; payload: Product[] }

  /**
   * Adjust a product's stock by `delta` (positive = add, negative = remove).
   * Used by: cart checkout (negative), receiving shipment (positive),
   *          manual adjustment, case-break logic.
   */
  | { type: "ADJUST_STOCK"; payload: { sku: string; delta: number } }

  /**
   * Sell a full case: decrements the case stock by 1 AND decrements the
   * corresponding child SKU stock by `unitsPerCase`.
   * The cart adds the *case* product, but physical inventory counts both.
   */
  | { type: "SELL_CASE"; payload: { parentSku: string } }

  /**
   * Break a case manually (e.g., stock clerk opens a case to put singles
   * on the shelf without a sale occurring).
   * Decrements parent by 1, increments child by `unitsPerCase`.
   */
  | { type: "BREAK_CASE"; payload: { parentSku: string } }

  /** Update a single product's fields (price change, name edit, etc.). */
  | { type: "UPDATE_PRODUCT"; payload: Partial<Product> & { sku: string } }

  /** Toggle a product's active status (soft delete / reactivate). */
  | { type: "TOGGLE_ACTIVE"; payload: { sku: string } }

  | { type: "SET_ERROR"; payload: string | null }
  | { type: "SET_LOADING"; payload: boolean };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function inventoryReducer(
  state: InventoryState,
  action: InventoryAction
): InventoryState {
  switch (action.type) {

    case "INVENTORY_LOADED": {
      const products = new Map(action.payload.map((p) => [p.sku, p]));
      return {
        ...state,
        products,
        isLoading: false,
        lastSyncedAt: new Date().toISOString(),
      };
    }

    case "ADJUST_STOCK": {
      const { sku, delta } = action.payload;
      const product = state.products.get(sku);
      if (!product) {
        console.warn(`[Inventory] ADJUST_STOCK: SKU "${sku}" not found.`);
        return state;
      }

      const newStock = Math.max(0, product.stock + delta); // floor at 0
      const updatedProducts = new Map(state.products);
      updatedProducts.set(sku, { ...product, stock: newStock });
      return { ...state, products: updatedProducts };
    }

    case "SELL_CASE": {
      const { parentSku } = action.payload;
      const parent = state.products.get(parentSku);

      if (!parent || !parent.childSku || !parent.unitsPerCase) {
        console.warn(`[Inventory] SELL_CASE: "${parentSku}" is not a valid parent SKU.`);
        return state;
      }

      const child = state.products.get(parent.childSku);
      const updatedProducts = new Map(state.products);

      // Decrement parent case stock by 1
      updatedProducts.set(parentSku, {
        ...parent,
        stock: Math.max(0, parent.stock - 1),
      });

      // Decrement child (single) stock by unitsPerCase
      // (A case sale means those individual units are no longer available)
      if (child) {
        updatedProducts.set(parent.childSku, {
          ...child,
          stock: Math.max(0, child.stock - parent.unitsPerCase),
        });
      }

      return { ...state, products: updatedProducts };
    }

    case "BREAK_CASE": {
      const { parentSku } = action.payload;
      const parent = state.products.get(parentSku);

      if (!parent || !parent.childSku || !parent.unitsPerCase) {
        console.warn(`[Inventory] BREAK_CASE: "${parentSku}" is not a valid parent SKU.`);
        return state;
      }

      if (parent.stock < 1) {
        console.warn(`[Inventory] BREAK_CASE: No cases in stock to break for "${parentSku}".`);
        return { ...state, error: `No cases in stock to break for "${parent.name}".` };
      }

      const child = state.products.get(parent.childSku);
      const updatedProducts = new Map(state.products);

      // Remove one case from parent
      updatedProducts.set(parentSku, { ...parent, stock: parent.stock - 1 });

      // Add unitsPerCase singles to child
      if (child) {
        updatedProducts.set(parent.childSku, {
          ...child,
          stock: child.stock + parent.unitsPerCase,
        });
      }

      return { ...state, products: updatedProducts };
    }

    case "UPDATE_PRODUCT": {
      const { sku, ...updates } = action.payload;
      const existing = state.products.get(sku);
      if (!existing) return state;

      const updatedProducts = new Map(state.products);
      updatedProducts.set(sku, { ...existing, ...updates });
      return { ...state, products: updatedProducts };
    }

    case "TOGGLE_ACTIVE": {
      const product = state.products.get(action.payload.sku);
      if (!product) return state;

      const updatedProducts = new Map(state.products);
      updatedProducts.set(action.payload.sku, {
        ...product,
        isActive: !product.isActive,
      });
      return { ...state, products: updatedProducts };
    }

    case "SET_ERROR":
      return { ...state, error: action.payload };

    case "SET_LOADING":
      return { ...state, isLoading: action.payload };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Initial State — seeded from mock database
// ---------------------------------------------------------------------------

const initialState: InventoryState = {
  products: new Map(MOCK_PRODUCTS.map((p) => [p.sku, p])),
  isLoading: false,
  error: null,
  lastSyncedAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Context Definition
// ---------------------------------------------------------------------------

interface InventoryContextValue {
  // ----- State -----
  /** Live product map (keyed by SKU). Reflects current session stock levels. */
  products: Map<string, Product>;
  isLoading: boolean;
  error: string | null;
  lastSyncedAt: string | null;

  // ----- Derived Selectors (memoised) -----
  /** Returns a flat sorted array of all active products. */
  activeProducts: Product[];
  /** Returns active products filtered to a specific category. */
  getByCategory: (category: ProductCategory) => Product[];
  /** Resolves a UPC barcode string to a Product (or undefined). */
  findByUpc: (upc: string) => Product | undefined;
  /** Resolves a SKU string to a Product (or undefined). */
  findBySku: (sku: string) => Product | undefined;

  // ----- Actions -----
  /** Add/remove stock for a SKU.  delta = +N (receive) or -N (sell/adjust). */
  adjustStock: (sku: string, delta: number) => void;
  /** Sell a full case; auto-decrements both parent and child stock. */
  sellCase: (parentSku: string) => void;
  /** Manually break a case into singles (stock room operation). */
  breakCase: (parentSku: string) => void;
  /** Update arbitrary product fields (price, name, threshold, etc.). */
  updateProduct: (updates: Partial<Product> & { sku: string }) => void;
  /** Soft-delete or restore a product. */
  toggleActive: (sku: string) => void;
  /** Clear the current error message. */
  clearError: () => void;
}

const InventoryContext = createContext<InventoryContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider Component
// ---------------------------------------------------------------------------

interface InventoryProviderProps {
  children: ReactNode;
  /**
   * Optional override for initial products — useful for testing or Storybook.
   * Defaults to MOCK_PRODUCTS when omitted.
   */
  initialProducts?: Product[];
}

export function InventoryProvider({
  children,
  initialProducts,
}: InventoryProviderProps) {
  const seedState: InventoryState = initialProducts
    ? {
        ...initialState,
        products: new Map(initialProducts.map((p) => [p.sku, p])),
      }
    : initialState;

  const [state, dispatch] = useReducer(inventoryReducer, seedState);

  // --- Memoised derived data ------------------------------------------------

  /**
   * Flat array of active products, sorted alphabetically by name.
   * Recalculated only when the products map reference changes.
   */
  const activeProducts = useMemo<Product[]>(
    () =>
      [...state.products.values()]
        .filter((p) => p.isActive)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [state.products]
  );

  /**
   * UPC lookup map derived from the live products map (not the static
   * PRODUCT_BY_UPC) so it reflects any runtime product additions.
   */
  const upcIndex = useMemo<Map<string, Product>>(
    () => new Map([...state.products.values()].map((p) => [p.upc, p])),
    [state.products]
  );

  // --- Stable action callbacks ----------------------------------------------
  // useCallback with empty deps array → referentially stable across renders,
  // preventing unnecessary re-renders in consuming components.

  const adjustStock = useCallback((sku: string, delta: number) => {
    dispatch({ type: "ADJUST_STOCK", payload: { sku, delta } });
  }, []);

  const sellCase = useCallback((parentSku: string) => {
    dispatch({ type: "SELL_CASE", payload: { parentSku } });
  }, []);

  const breakCase = useCallback((parentSku: string) => {
    dispatch({ type: "BREAK_CASE", payload: { parentSku } });
  }, []);

  const updateProduct = useCallback(
    (updates: Partial<Product> & { sku: string }) => {
      dispatch({ type: "UPDATE_PRODUCT", payload: updates });
    },
    []
  );

  const toggleActive = useCallback((sku: string) => {
    dispatch({ type: "TOGGLE_ACTIVE", payload: { sku } });
  }, []);

  const clearError = useCallback(() => {
    dispatch({ type: "SET_ERROR", payload: null });
  }, []);

  // --- Selector helpers (stable references) ---------------------------------

  const getByCategory = useCallback(
    (category: ProductCategory): Product[] =>
      [...state.products.values()].filter(
        (p) => p.category === category && p.isActive
      ),
    [state.products]
  );

  const findByUpc = useCallback(
    (upc: string): Product | undefined => upcIndex.get(upc),
    [upcIndex]
  );

  const findBySku = useCallback(
    (sku: string): Product | undefined => state.products.get(sku),
    [state.products]
  );

  // --- Context value (memoised to prevent needless re-renders) --------------

  const value = useMemo<InventoryContextValue>(
    () => ({
      products: state.products,
      isLoading: state.isLoading,
      error: state.error,
      lastSyncedAt: state.lastSyncedAt,
      activeProducts,
      getByCategory,
      findByUpc,
      findBySku,
      adjustStock,
      sellCase,
      breakCase,
      updateProduct,
      toggleActive,
      clearError,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, activeProducts]
  );

  return (
    <InventoryContext.Provider value={value}>
      {children}
    </InventoryContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Consumer Hook
// ---------------------------------------------------------------------------

/**
 * `useInventory` — primary hook for accessing inventory state and actions.
 *
 * Must be called inside an <InventoryProvider> tree.
 * Throws a clear error if called outside the provider (dev ergonomics).
 *
 * @example
 *   const { activeProducts, adjustStock, findByUpc } = useInventory();
 */
export function useInventory(): InventoryContextValue {
  const ctx = useContext(InventoryContext);
  if (!ctx) {
    throw new Error(
      "[useInventory] must be called inside an <InventoryProvider>. " +
      "Wrap your POS route or app root with <InventoryProvider>."
    );
  }
  return ctx;
}

// Re-export the static lookup helpers from mockDatabase for convenience
export { PRODUCT_BY_SKU, PRODUCT_BY_UPC } from "./mockDatabase";
