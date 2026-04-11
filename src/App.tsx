import { useEffect, useRef, useState } from "react";
import type { Page } from "./types";
import { useJobsMonitor } from "./hooks";
import { JobsPanel } from "./components";
import Import from "./pages/Import";
import StagingExplorer from "./pages/StagingExplorer";
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
  { id: "stagingexplorer", label: "Staging Explorer", icon: "🗂️" },
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

const APP_SIDEBAR_PREFS_KEY = "photogogo.appSidebar.width.v1";

export default function App() {
  const [page, setPage] = useState<Page>("import");
  const [sidebarWidth, setSidebarWidth] = useState(208);
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const { importJobs, processJobs, loading } = useJobsMonitor(true, 500);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(APP_SIDEBAR_PREFS_KEY);
      if (!raw) {
        return;
      }
      const parsed = Number(raw);
      if (!Number.isNaN(parsed)) {
        setSidebarWidth(Math.max(180, Math.min(420, parsed)));
      }
    } catch {
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(APP_SIDEBAR_PREFS_KEY, String(sidebarWidth));
    } catch {
    }
  }, [sidebarWidth]);

  useEffect(() => {
    if (!appShellRef.current) {
      return;
    }
    appShellRef.current.style.setProperty("--app-sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);

  useEffect(() => {
    function onMouseMove(event: MouseEvent) {
      const activeResize = sidebarResizeRef.current;
      if (!activeResize) {
        return;
      }

      const delta = event.clientX - activeResize.startX;
      setSidebarWidth(Math.max(180, Math.min(420, activeResize.startWidth + delta)));
    }

    function onMouseUp() {
      sidebarResizeRef.current = null;
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  function onSidebarResizeStart(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    sidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
  }

  const pageContent: Record<Page, React.ReactNode> = {
    import: <Import />,
    stagingexplorer: <StagingExplorer />,
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
      <div ref={appShellRef} className="app-shell flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="app-sidebar bg-surface-800 border-r border-surface-600 flex flex-col">
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

        <div
          className="app-sidebar-resizer"
          onMouseDown={onSidebarResizeStart}
          title="Drag to resize menu"
          role="separator"
          aria-orientation="vertical"
        />

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
