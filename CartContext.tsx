// =============================================================================
// CartContext.tsx
// =============================================================================
// Manages the active POS transaction (the "ticket" / "order").
//
// Responsibilities:
//   • Hold the list of line items currently being rung up.
//   • Calculate subtotal, tax, and total in real time.
//   • Support per-line and order-level discounts.
//   • Track age-verification and payment state.
//   • Provide a clean checkout / void / hold flow.
//
// What this context does NOT do:
//   • It does NOT mutate inventory — that's InventoryContext's job.
//     The POS controller layer (your checkout handler) calls both:
//       1. cart.checkout()          → finalises + clears the cart
//       2. inventory.adjustStock()  → decrements each sold SKU
//     Keeping the two concerns separate makes each independently testable.
//
// Currency:
//   All monetary values are stored and calculated in CENTS (integers).
//   The display layer formats them via formatPrice() from mockDatabase.ts.
//
// Usage:
//   Wrap your app with <CartProvider>.
//   Components consume via the `useCart()` hook.
//
//     const { lineItems, totalInCents, addItem, removeItem } = useCart();
// =============================================================================

import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";

import type { Product } from "./mockDatabase";

// ---------------------------------------------------------------------------
// Sub-Types
// ---------------------------------------------------------------------------

/**
 * A discount applied to a single line item or to the overall order.
 *
 * type "percent" → discountValue is a percentage  (e.g. 10 = 10% off)
 * type "fixed"   → discountValue is amount in cents (e.g. 500 = $5.00 off)
 */
export interface Discount {
  id: string;             // unique identifier (uuid or slug)
  label: string;          // display label, e.g. "Staff Discount 10%"
  type: "percent" | "fixed";
  discountValue: number;  // percent (0–100) OR cents
}

/**
 * A single line in the cart — one Product at a given quantity with optional
 * per-line overrides.
 *
 * `lineTotal` is always derived / computed; it is NOT stored on this object.
 * The selector `selectLineTotals` provides it for rendering.
 */
export interface CartLineItem {
  /**
   * Unique identifier for this line.  Two separate "adds" of the same product
   * produce TWO line items with different `lineId` values only if they have
   * different per-line notes or discounts.  Otherwise, addItem() increments
   * the qty of the existing line.
   */
  lineId: string;

  /** Full product snapshot at time of add. Prices are locked to scan-time. */
  product: Product;

  /** Number of units on this line.  Always ≥ 1. */
  quantity: number;

  /**
   * Override price in CENTS for this specific line.
   * null = use product.priceInCents (the default).
   * Non-null = manager override / price match.
   */
  overridePriceInCents: number | null;

  /** Optional per-line discount (e.g. loyalty reward on a specific product). */
  lineDiscount: Discount | null;

  /** Cashier / manager notes (e.g. "Customer wants gift wrap"). */
  notes: string;

  /** Whether the cashier has confirmed age verification for this line. */
  ageVerified: boolean;
}

/** Payment methods accepted at the register. */
export type PaymentMethod = "cash" | "card" | "split";

/** Status of the current transaction. */
export type TransactionStatus =
  | "open"        // actively being rung up
  | "held"        // parked / suspended (customer stepped away)
  | "completed"   // payment accepted, drawer opens
  | "voided";     // cancelled by cashier / manager

// ---------------------------------------------------------------------------
// Cart State Shape
// ---------------------------------------------------------------------------

export interface CartState {
  /** Unique ID for this transaction (generated fresh each new ticket). */
  transactionId: string;

  /** All line items currently in the cart. */
  lineItems: CartLineItem[];

  /** Order-level discount (e.g. 10% off entire purchase). */
  orderDiscount: Discount | null;

  /**
   * Tax rate as a decimal fraction.
   * e.g. 0.0875 = 8.75% tax
   * In production this would come from a tax table keyed to jurisdiction.
   */
  taxRate: number;

  /** Whether the cashier has confirmed ALL required age verifications. */
  allAgesVerified: boolean;

  /** Current lifecycle state of the transaction. */
  status: TransactionStatus;

  /**
   * Timestamp when this transaction was opened.
   * Used for reporting and receipt printing.
   */
  openedAt: string;

  /**
   * Payment method chosen at checkout time.
   * null while transaction is still open.
   */
  paymentMethod: PaymentMethod | null;

  /**
   * Amount tendered by customer in CENTS (used for cash transactions).
   * null if not yet entered or not a cash transaction.
   */
  tenderedInCents: number | null;

  /**
   * Completed transaction receipt snapshot.
   * Populated only after `status === "completed"`.
   * Lets the UI show a receipt without re-computing everything.
   */
  receipt: CompletedReceipt | null;
}

/** Immutable snapshot stored after a successful checkout. */
export interface CompletedReceipt {
  transactionId: string;
  lineItems: CartLineItem[];
  subtotalInCents: number;
  discountInCents: number;
  taxInCents: number;
  totalInCents: number;
  paymentMethod: PaymentMethod;
  tenderedInCents: number | null;
  changeInCents: number | null;      // null for card payments
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Action Types
// ---------------------------------------------------------------------------

type CartAction =
  /**
   * Add a product to the cart.  If a line with the same SKU (and no special
   * overrides) already exists, its quantity is incremented instead.
   */
  | {
      type: "ADD_ITEM";
      payload: {
        product: Product;
        quantity?: number;                     // defaults to 1
        overridePriceInCents?: number | null;  // null = use product price
        lineDiscount?: Discount | null;
        notes?: string;
      };
    }

  /** Remove an entire line from the cart regardless of quantity. */
  | { type: "REMOVE_ITEM"; payload: { lineId: string } }

  /** Set the quantity of a specific line.  qty ≤ 0 removes the line. */
  | { type: "SET_QUANTITY"; payload: { lineId: string; quantity: number } }

  /** Increment or decrement a line's quantity by `delta`. */
  | { type: "ADJUST_QUANTITY"; payload: { lineId: string; delta: number } }

  /** Apply or replace a per-line discount. null removes the discount. */
  | { type: "SET_LINE_DISCOUNT"; payload: { lineId: string; discount: Discount | null } }

  /** Override the unit price on a line (manager price match / override). */
  | { type: "SET_LINE_PRICE"; payload: { lineId: string; priceInCents: number | null } }

  /** Mark a line item's age as verified by the cashier. */
  | { type: "VERIFY_AGE"; payload: { lineId: string } }

  /** Verify ALL age-restricted lines in one action (scan-all flow). */
  | { type: "VERIFY_ALL_AGES" }

  /** Apply or replace an order-level discount. */
  | { type: "SET_ORDER_DISCOUNT"; payload: { discount: Discount | null } }

  /** Update the tax rate (e.g. switching between in-store / delivery). */
  | { type: "SET_TAX_RATE"; payload: { taxRate: number } }

  /**
   * Finalise the transaction: lock the cart, record payment details,
   * generate the receipt snapshot, and set status to "completed".
   */
  | {
      type: "CHECKOUT";
      payload: {
        paymentMethod: PaymentMethod;
        tenderedInCents?: number;
        subtotalInCents: number;
        discountInCents: number;
        taxInCents: number;
        totalInCents: number;
      };
    }

  /** Void / cancel the current transaction. */
  | { type: "VOID_TRANSACTION" }

  /**
   * Park the current transaction so another can be started.
   * A full POS would store held transactions in a list; this mock
   * simply sets status to "held".
   */
  | { type: "HOLD_TRANSACTION" }

  /** Clear the cart and start a brand-new transaction. */
  | { type: "NEW_TRANSACTION" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generates a simple unique ID (replace with uuid in production). */
const generateId = (): string =>
  Math.random().toString(36).slice(2, 10).toUpperCase();

/** Default tax rate: 8.875% (NYC example — override via SET_TAX_RATE). */
const DEFAULT_TAX_RATE = 0.08875;

const createFreshTransaction = (): CartState => ({
  transactionId: generateId(),
  lineItems: [],
  orderDiscount: null,
  taxRate: DEFAULT_TAX_RATE,
  allAgesVerified: false,
  status: "open",
  openedAt: new Date().toISOString(),
  paymentMethod: null,
  tenderedInCents: null,
  receipt: null,
});

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function cartReducer(state: CartState, action: CartAction): CartState {

  // Guard: most mutations only allowed while the transaction is open
  const isOpen = state.status === "open";

  switch (action.type) {

    case "ADD_ITEM": {
      if (!isOpen) return state;

      const {
        product,
        quantity = 1,
        overridePriceInCents = null,
        lineDiscount = null,
        notes = "",
      } = action.payload;

      // Check if an identical line already exists (same SKU, same price, no
      // special overrides, no special notes) — if so, just increment qty.
      const existingIndex = state.lineItems.findIndex(
        (li) =>
          li.product.sku === product.sku &&
          li.overridePriceInCents === overridePriceInCents &&
          li.lineDiscount === null &&
          lineDiscount === null &&
          li.notes === notes
      );

      if (existingIndex !== -1) {
        // Merge: increment quantity on the existing line
        const updatedLines = [...state.lineItems];
        updatedLines[existingIndex] = {
          ...updatedLines[existingIndex],
          quantity: updatedLines[existingIndex].quantity + quantity,
        };
        return { ...state, lineItems: updatedLines };
      }

      // New line
      const newLine: CartLineItem = {
        lineId: generateId(),
        product,
        quantity,
        overridePriceInCents,
        lineDiscount,
        notes,
        // Auto-verify age if the product doesn't require it
        ageVerified: !product.requiresAgeVerification,
      };

      return {
        ...state,
        lineItems: [...state.lineItems, newLine],
        allAgesVerified: false, // recalculate via selector
      };
    }

    case "REMOVE_ITEM": {
      if (!isOpen) return state;
      return {
        ...state,
        lineItems: state.lineItems.filter(
          (li) => li.lineId !== action.payload.lineId
        ),
      };
    }

    case "SET_QUANTITY": {
      if (!isOpen) return state;
      const { lineId, quantity } = action.payload;

      if (quantity <= 0) {
        // Treat as removal
        return {
          ...state,
          lineItems: state.lineItems.filter((li) => li.lineId !== lineId),
        };
      }

      return {
        ...state,
        lineItems: state.lineItems.map((li) =>
          li.lineId === lineId ? { ...li, quantity } : li
        ),
      };
    }

    case "ADJUST_QUANTITY": {
      if (!isOpen) return state;
      const { lineId, delta } = action.payload;
      const line = state.lineItems.find((li) => li.lineId === lineId);
      if (!line) return state;

      const newQty = line.quantity + delta;
      if (newQty <= 0) {
        return {
          ...state,
          lineItems: state.lineItems.filter((li) => li.lineId !== lineId),
        };
      }
      return {
        ...state,
        lineItems: state.lineItems.map((li) =>
          li.lineId === lineId ? { ...li, quantity: newQty } : li
        ),
      };
    }

    case "SET_LINE_DISCOUNT": {
      if (!isOpen) return state;
      return {
        ...state,
        lineItems: state.lineItems.map((li) =>
          li.lineId === action.payload.lineId
            ? { ...li, lineDiscount: action.payload.discount }
            : li
        ),
      };
    }

    case "SET_LINE_PRICE": {
      if (!isOpen) return state;
      return {
        ...state,
        lineItems: state.lineItems.map((li) =>
          li.lineId === action.payload.lineId
            ? { ...li, overridePriceInCents: action.payload.priceInCents }
            : li
        ),
      };
    }

    case "VERIFY_AGE": {
      if (!isOpen) return state;
      const updatedLines = state.lineItems.map((li) =>
        li.lineId === action.payload.lineId ? { ...li, ageVerified: true } : li
      );
      const allAgesVerified = updatedLines.every((li) => li.ageVerified);
      return { ...state, lineItems: updatedLines, allAgesVerified };
    }

    case "VERIFY_ALL_AGES": {
      if (!isOpen) return state;
      return {
        ...state,
        lineItems: state.lineItems.map((li) => ({ ...li, ageVerified: true })),
        allAgesVerified: true,
      };
    }

    case "SET_ORDER_DISCOUNT": {
      if (!isOpen) return state;
      return { ...state, orderDiscount: action.payload.discount };
    }

    case "SET_TAX_RATE": {
      return { ...state, taxRate: action.payload.taxRate };
    }

    case "CHECKOUT": {
      if (!isOpen) return state;

      const {
        paymentMethod,
        tenderedInCents,
        subtotalInCents,
        discountInCents,
        taxInCents,
        totalInCents,
      } = action.payload;

      const changeInCents =
        paymentMethod === "cash" && tenderedInCents != null
          ? Math.max(0, tenderedInCents - totalInCents)
          : null;

      const receipt: CompletedReceipt = {
        transactionId: state.transactionId,
        lineItems: state.lineItems,
        subtotalInCents,
        discountInCents,
        taxInCents,
        totalInCents,
        paymentMethod,
        tenderedInCents: tenderedInCents ?? null,
        changeInCents,
        completedAt: new Date().toISOString(),
      };

      return {
        ...state,
        status: "completed",
        paymentMethod,
        tenderedInCents: tenderedInCents ?? null,
        receipt,
      };
    }

    case "VOID_TRANSACTION":
      return { ...state, status: "voided" };

    case "HOLD_TRANSACTION":
      return { ...state, status: "held" };

    case "NEW_TRANSACTION":
      return createFreshTransaction();

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Derived Calculation Helpers (pure functions — easy to unit test)
// ---------------------------------------------------------------------------

/**
 * Calculates the effective unit price for a line item.
 * Honours overrides first, then falls back to product.priceInCents.
 */
export const effectiveUnitPrice = (line: CartLineItem): number =>
  line.overridePriceInCents ?? line.product.priceInCents;

/**
 * Calculates the pre-discount total for a single line.
 */
export const lineSubtotal = (line: CartLineItem): number =>
  effectiveUnitPrice(line) * line.quantity;

/**
 * Calculates the discount amount for a single line (in cents).
 */
export const lineDiscountAmount = (line: CartLineItem): number => {
  if (!line.lineDiscount) return 0;
  const sub = lineSubtotal(line);
  return line.lineDiscount.type === "percent"
    ? Math.round(sub * (line.lineDiscount.discountValue / 100))
    : Math.min(sub, line.lineDiscount.discountValue);
};

/**
 * Net total for a single line after its discount.
 */
export const lineTotal = (line: CartLineItem): number =>
  lineSubtotal(line) - lineDiscountAmount(line);

/**
 * Calculates the full order discount amount given the current subtotal.
 */
export const orderDiscountAmount = (
  discount: Discount | null,
  subtotalInCents: number
): number => {
  if (!discount) return 0;
  return discount.type === "percent"
    ? Math.round(subtotalInCents * (discount.discountValue / 100))
    : Math.min(subtotalInCents, discount.discountValue);
};

// ---------------------------------------------------------------------------
// Context Definition
// ---------------------------------------------------------------------------

interface CartContextValue {
  // ----- State -----
  transactionId: string;
  lineItems: CartLineItem[];
  orderDiscount: Discount | null;
  taxRate: number;
  allAgesVerified: boolean;
  status: TransactionStatus;
  paymentMethod: PaymentMethod | null;
  tenderedInCents: number | null;
  receipt: CompletedReceipt | null;

  // ----- Memoised Totals -----
  /** Sum of all line totals (post line-discounts, pre order-discount). */
  subtotalInCents: number;
  /** Total discount amount from the order-level discount only. */
  orderDiscountAmountInCents: number;
  /** Tax calculated on (subtotal − orderDiscount). */
  taxInCents: number;
  /** Final amount due. */
  totalInCents: number;
  /** Number of line items in the cart. */
  itemCount: number;
  /** True when all age-restricted lines have been verified. */
  canCheckout: boolean;

  // ----- Actions -----
  addItem: (
    product: Product,
    options?: {
      quantity?: number;
      overridePriceInCents?: number | null;
      lineDiscount?: Discount | null;
      notes?: string;
    }
  ) => void;
  removeItem: (lineId: string) => void;
  setQuantity: (lineId: string, quantity: number) => void;
  adjustQuantity: (lineId: string, delta: number) => void;
  setLineDiscount: (lineId: string, discount: Discount | null) => void;
  setLinePrice: (lineId: string, priceInCents: number | null) => void;
  verifyAge: (lineId: string) => void;
  verifyAllAges: () => void;
  setOrderDiscount: (discount: Discount | null) => void;
  setTaxRate: (rate: number) => void;
  /**
   * Complete the transaction.
   * The caller is responsible for:
   *   1. Calling this to finalise the cart.
   *   2. Calling inventory.adjustStock() for each line item separately.
   */
  checkout: (
    paymentMethod: PaymentMethod,
    tenderedInCents?: number
  ) => void;
  voidTransaction: () => void;
  holdTransaction: () => void;
  newTransaction: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider Component
// ---------------------------------------------------------------------------

interface CartProviderProps {
  children: ReactNode;
  /** Override default tax rate (useful for different store locations). */
  taxRate?: number;
}

export function CartProvider({ children, taxRate }: CartProviderProps) {
  const seed = createFreshTransaction();
  if (taxRate !== undefined) seed.taxRate = taxRate;

  const [state, dispatch] = useReducer(cartReducer, seed);

  // --- Memoised totals -------------------------------------------------------

  const subtotalInCents = useMemo(
    () => state.lineItems.reduce((sum, li) => sum + lineTotal(li), 0),
    [state.lineItems]
  );

  const orderDiscountAmountInCents = useMemo(
    () => orderDiscountAmount(state.orderDiscount, subtotalInCents),
    [state.orderDiscount, subtotalInCents]
  );

  const taxableAmount = subtotalInCents - orderDiscountAmountInCents;

  const taxInCents = useMemo(
    () => Math.round(taxableAmount * state.taxRate),
    [taxableAmount, state.taxRate]
  );

  const totalInCents = taxableAmount + taxInCents;

  const itemCount = useMemo(
    () => state.lineItems.reduce((n, li) => n + li.quantity, 0),
    [state.lineItems]
  );

  /**
   * The cashier can only proceed to payment when:
   *   1. There is at least one item in the cart.
   *   2. All age-restricted items have been verified.
   *   3. The transaction is still open (not voided/held/completed).
   */
  const canCheckout =
    itemCount > 0 &&
    state.allAgesVerified &&
    state.status === "open";

  // --- Stable action callbacks ------------------------------------------------

  const addItem = useCallback(
    (
      product: Product,
      options: {
        quantity?: number;
        overridePriceInCents?: number | null;
        lineDiscount?: Discount | null;
        notes?: string;
      } = {}
    ) => {
      dispatch({
        type: "ADD_ITEM",
        payload: { product, ...options },
      });
    },
    []
  );

  const removeItem = useCallback((lineId: string) => {
    dispatch({ type: "REMOVE_ITEM", payload: { lineId } });
  }, []);

  const setQuantity = useCallback((lineId: string, quantity: number) => {
    dispatch({ type: "SET_QUANTITY", payload: { lineId, quantity } });
  }, []);

  const adjustQuantity = useCallback((lineId: string, delta: number) => {
    dispatch({ type: "ADJUST_QUANTITY", payload: { lineId, delta } });
  }, []);

  const setLineDiscount = useCallback(
    (lineId: string, discount: Discount | null) => {
      dispatch({ type: "SET_LINE_DISCOUNT", payload: { lineId, discount } });
    },
    []
  );

  const setLinePrice = useCallback(
    (lineId: string, priceInCents: number | null) => {
      dispatch({ type: "SET_LINE_PRICE", payload: { lineId, priceInCents } });
    },
    []
  );

  const verifyAge = useCallback((lineId: string) => {
    dispatch({ type: "VERIFY_AGE", payload: { lineId } });
  }, []);

  const verifyAllAges = useCallback(() => {
    dispatch({ type: "VERIFY_ALL_AGES" });
  }, []);

  const setOrderDiscount = useCallback((discount: Discount | null) => {
    dispatch({ type: "SET_ORDER_DISCOUNT", payload: { discount } });
  }, []);

  const setTaxRate = useCallback((rate: number) => {
    dispatch({ type: "SET_TAX_RATE", payload: { taxRate: rate } });
  }, []);

  const checkout = useCallback(
    (paymentMethod: PaymentMethod, tenderedInCents?: number) => {
      dispatch({
        type: "CHECKOUT",
        payload: {
          paymentMethod,
          tenderedInCents,
          subtotalInCents,
          discountInCents: orderDiscountAmountInCents,
          taxInCents,
          totalInCents,
        },
      });
    },
    [subtotalInCents, orderDiscountAmountInCents, taxInCents, totalInCents]
  );

  const voidTransaction = useCallback(() => {
    dispatch({ type: "VOID_TRANSACTION" });
  }, []);

  const holdTransaction = useCallback(() => {
    dispatch({ type: "HOLD_TRANSACTION" });
  }, []);

  const newTransaction = useCallback(() => {
    dispatch({ type: "NEW_TRANSACTION" });
  }, []);

  // --- Context value ---------------------------------------------------------

  const value = useMemo<CartContextValue>(
    () => ({
      transactionId: state.transactionId,
      lineItems: state.lineItems,
      orderDiscount: state.orderDiscount,
      taxRate: state.taxRate,
      allAgesVerified: state.allAgesVerified,
      status: state.status,
      paymentMethod: state.paymentMethod,
      tenderedInCents: state.tenderedInCents,
      receipt: state.receipt,
      subtotalInCents,
      orderDiscountAmountInCents,
      taxInCents,
      totalInCents,
      itemCount,
      canCheckout,
      addItem,
      removeItem,
      setQuantity,
      adjustQuantity,
      setLineDiscount,
      setLinePrice,
      verifyAge,
      verifyAllAges,
      setOrderDiscount,
      setTaxRate,
      checkout,
      voidTransaction,
      holdTransaction,
      newTransaction,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, subtotalInCents, orderDiscountAmountInCents, taxInCents, totalInCents, itemCount, canCheckout]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

// ---------------------------------------------------------------------------
// Consumer Hook
// ---------------------------------------------------------------------------

/**
 * `useCart` — primary hook for accessing cart state and actions.
 *
 * Must be called inside a <CartProvider> tree.
 *
 * @example
 *   const { lineItems, totalInCents, addItem, checkout } = useCart();
 */
export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) {
    throw new Error(
      "[useCart] must be called inside a <CartProvider>. " +
      "Wrap your POS route or app root with <CartProvider>."
    );
  }
  return ctx;
}
