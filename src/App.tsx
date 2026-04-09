import { useState } from "react";
import type { Page } from "./types";
import { useJobsMonitor } from "./hooks";
import { JobsPanel } from "./components";
import Import from "./pages/Import";
import NameEvents from "./pages/NameEvents";
import Cleanup from "./pages/Cleanup";
import Jobs from "./pages/Jobs";
import PostProcess from "./pages/PostProcess";
import Review from "./pages/Review";
import Transfer from "./pages/Transfer";
import FaceIdentify from "./pages/FaceIdentify";
import Settings from "./pages/Settings";
import Logs from "./pages/Logs";

const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
  { id: "import",      label: "Import",       icon: "📥" },
  { id: "nameevents",  label: "Name Events",  icon: "🏷️" },
  { id: "postprocess", label: "Post Process",  icon: "⚙️" },
  { id: "review",      label: "Review",        icon: "🖼️" },
  { id: "transfer",    label: "Transfer",      icon: "📤" },
  { id: "faceidentify",label: "Face Identify", icon: "👤" },
  { id: "settings",    label: "Settings",      icon: "⚙️" },
  { id: "jobs",        label: "Jobs",         icon: "🧵" },
  { id: "cleanup",     label: "Cleanup",      icon: "🧹" },
  { id: "logs",        label: "Logs",          icon: "📜" },
];

export default function App() {
  const [page, setPage] = useState<Page>("import");
  const { importJobs, processJobs, loading } = useJobsMonitor(true, 500);

  const pageContent: Record<Page, React.ReactNode> = {
    import: <Import />,
    nameevents: <NameEvents />,
    cleanup: <Cleanup />,
    jobs: <Jobs />,
    postprocess: <PostProcess onOpenJobs={() => setPage("jobs")} />,
    review: <Review />,
    transfer: <Transfer />,
    faceidentify: <FaceIdentify onOpenJobs={() => setPage("jobs")} />,
    settings: <Settings />,
    logs: <Logs />,
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-surface-900">
      {/* Main content area (sidebar + page content) */}
      <div className="flex flex-1 overflow-hidden">
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

        {/* Page content */}
        <main className="flex-1 overflow-auto bg-surface-900">
          {pageContent[page]}
        </main>
      </div>

      {/* Jobs panel (bottom frame) */}
      <JobsPanel importJobs={importJobs} processJobs={processJobs} loading={loading} />
    </div>
  );
}
