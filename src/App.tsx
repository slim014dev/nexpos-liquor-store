import { useState } from "react";
import POSLayout from "./components/layout/POSLayout";
import POSScreen from "./components/pos/POSScreen";
import InventoryPanel from "./components/inventory/InventoryPanel";
import { ToastProvider } from "./components/ui/Toast";

export type AppView = "pos" | "inventory";

export default function App() {
  const [view, setView] = useState<AppView>("pos");

  return (
    <ToastProvider>
      <POSLayout view={view} onViewChange={setView}>
        {view === "pos"       ? <POSScreen />      : null}
        {view === "inventory" ? <InventoryPanel /> : null}
      </POSLayout>
    </ToastProvider>
  );
}
