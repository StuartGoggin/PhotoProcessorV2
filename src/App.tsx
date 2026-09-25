import { useEffect, useRef, useState } from "react";
import type { Page } from "./types";
import { useJobsMonitor } from "./hooks";
import { JobsPanel } from "./components";
import Import from "./pages/Import";
import StagingExplorer from "./pages/StagingExplorer";
import VideoStudio from "./pages/VideoStudio";
import { readPanelSize, type JobsView } from "./utils/jobsView";
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
  { id: "stagingexplorer", label: "Video Timeline", icon: "🎬" },
  { id: "videostudio", label: "Video Studio", icon: "🎞️" },
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
  const [sidebarWidth, setSidebarWidth] = useState(() => readPanelSize(APP_SIDEBAR_PREFS_KEY, 208, 180, 420));
  const [menuOpen, setMenuOpen] = useState(false);
  const [jobsView, setJobsView] = useState<JobsView>("active");
  const [jobsNavigation, setJobsNavigation] = useState(0);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const { importJobs, processJobs, studioJobs, loading, error } = useJobsMonitor(true, 500);
  function openJobs(view: JobsView = "active") {
    setJobsView(view);
    setJobsNavigation((value) => value + 1);
    setPage("jobs");
    setMenuOpen(false);
  }

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
    function onMouseMove(event: PointerEvent) {
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

    window.addEventListener("pointermove", onMouseMove);
    window.addEventListener("pointerup", onMouseUp);
    window.addEventListener("pointercancel", onMouseUp);
    return () => {
      window.removeEventListener("pointermove", onMouseMove);
      window.removeEventListener("pointerup", onMouseUp);
      window.removeEventListener("pointercancel", onMouseUp);
    };
  }, []);

  function onSidebarResizeStart(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
  }

  const pageContent: Record<Page, React.ReactNode> = {
    import: <Import />,
    stagingexplorer: <StagingExplorer />,
    videostudio: null,
    nameevents: <NameEvents />,
    cleanup: <Cleanup />,
    jobs: <Jobs key={jobsNavigation} initialView={jobsView} />,
    postprocess: <PostProcess onOpenJobs={() => openJobs()} />,
    review: <Review />,
    transfer: <Transfer />,
    faceidentify: <FaceIdentify onOpenJobs={() => openJobs()} />,
    settings: <Settings />,
    logs: <Logs />,
  };

  return (
    <div className="app-root flex flex-col overflow-hidden bg-surface-900">
      <header className="app-mobile-header">
        <button ref={menuButtonRef} className="btn-secondary" aria-controls="app-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? "Close menu" : "☰ Menu"}</button>
        <span className="font-semibold truncate">{NAV_ITEMS.find((item) => item.id === page)?.label}</span>
        <span className="text-xs text-gray-400">PhotoGoGo</span>
      </header>
      {/* Main content area (sidebar + page content) */}
      <div ref={appShellRef} className={`app-shell flex flex-1 min-h-0 min-w-0 overflow-hidden ${menuOpen ? "menu-open" : ""}`}>
        {/* Sidebar */}
        <aside id="app-navigation" className="app-sidebar bg-surface-800 border-r border-surface-600 flex flex-col" onKeyDown={(event) => { if (event.key === "Escape") { setMenuOpen(false); menuButtonRef.current?.focus(); } }}>
          <div className="px-4 py-5 border-b border-surface-600">
            <h1 className="text-lg font-bold text-white tracking-tight">PhotoGoGo</h1>
            <div className="mt-1 text-xs text-gray-400 select-text" aria-label="Application version and build">
              <p>Version {__APP_BUILD__.version}</p>
              <p className="mt-1 text-[10px] leading-relaxed break-all" title={`Built ${__APP_BUILD__.builtAt} (UTC)`}>
                Build {__APP_BUILD__.buildId}
              </p>
            </div>
          </div>
          <nav className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1" aria-label="Main navigation">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                onClick={() => { setPage(item.id); if (item.id === "jobs") setJobsView("active"); setMenuOpen(false); }}
                aria-current={page === item.id ? "page" : undefined}
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
          onPointerDown={onSidebarResizeStart}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            setSidebarWidth((value) => event.key === "Home" ? 180 : event.key === "End" ? 420 : Math.max(180, Math.min(420, value + (event.key === "ArrowRight" ? 16 : -16))));
          }}
          title="Drag to resize menu"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize navigation"
          aria-valuemin={180}
          aria-valuemax={420}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
        />

        {/* Page content */}
        <main id="app-main" className="app-main flex-1 min-w-0 min-h-0 overflow-auto bg-surface-900">
          <div hidden={page !== "videostudio"}><VideoStudio jobs={studioJobs} onOpenJobs={() => openJobs()} /></div>
          {pageContent[page]}
        </main>
      </div>

      {/* Jobs panel (bottom frame) */}
      <JobsPanel importJobs={importJobs} processJobs={processJobs} studioJobs={studioJobs} loading={loading} error={error} onOpenJobs={openJobs} preferCollapsed={page === "videostudio"} />
    </div>
  );
}
