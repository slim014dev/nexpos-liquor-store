// =============================================================================
// AppProviders.tsx
// =============================================================================
// Composes all top-level context providers into a single wrapper component.
//
// Usage — wrap your POS router/app root:
//
//   import { AppProviders } from "./AppProviders";
//
//   function App() {
//     return (
//       <AppProviders>
//         <POSRouter />
//       </AppProviders>
//     );
//   }
//
// Provider order matters:
//   InventoryProvider → outermost: product data exists before cart is aware
//   CartProvider      → innermost: can safely reference inventory if needed
// =============================================================================

import React, { type ReactNode } from "react";
import { InventoryProvider } from "./InventoryContext";
import { CartProvider } from "./CartContext";

interface AppProvidersProps {
  children: ReactNode;
  /** Optional tax rate override (defaults to 8.875% inside CartProvider). */
  taxRate?: number;
}

export function AppProviders({ children, taxRate }: AppProvidersProps) {
  return (
    <InventoryProvider>
      <CartProvider taxRate={taxRate}>
        {children}
      </CartProvider>
    </InventoryProvider>
  );
}
