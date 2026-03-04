import { useState } from "react";
import type { Page } from "./types";
import Import from "./pages/Import";
import PostProcess from "./pages/PostProcess";
import Review from "./pages/Review";
import TidyUp from "./pages/TidyUp";
import Transfer from "./pages/Transfer";
import Settings from "./pages/Settings";

const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
  { id: "import",      label: "Import",       icon: "📥" },
  { id: "postprocess", label: "Post Process",  icon: "⚙️" },
  { id: "review",      label: "Review",        icon: "🖼️" },
  { id: "tidyup",      label: "Tidy Up",       icon: "🗑️" },
  { id: "transfer",    label: "Transfer",      icon: "📤" },
  { id: "settings",    label: "Settings",      icon: "⚙️" },
];

const PAGE_MAP: Record<Page, React.ReactNode> = {
  import:      <Import />,
  postprocess: <PostProcess />,
  review:      <Review />,
  tidyup:      <TidyUp />,
  transfer:    <Transfer />,
  settings:    <Settings />,
};

export default function App() {
  const [page, setPage] = useState<Page>("import");

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-52 flex-shrink-0 bg-surface-800 border-r border-surface-600 flex flex-col">
        <div className="px-4 py-5 border-b border-surface-600">
          <h1 className="text-lg font-bold text-white tracking-tight">PhotoGoGo</h1>
          <p className="text-xs text-gray-500 mt-0.5">v2.0</p>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              className={`nav-item w-full text-left ${page === item.id ? "active" : ""}`}
            >
              <span className="text-lg leading-none">{item.icon}</span>
              <span className="text-sm font-medium">{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-surface-900">
        {PAGE_MAP[page]}
      </main>
    </div>
  );
}
