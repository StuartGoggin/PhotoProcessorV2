import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import NameEvents from "../pages/NameEvents";
import type { EventNamingContext, EventNamingResult, NamingDay } from "../types/eventNaming";
import { folderEventTarget, namedEventPath, namingRootKey, type FolderEventTarget } from "../utils/eventNamingContext";
import "../components/EventNaming.css";

type Anchor = { element: HTMLElement; path: string };
type Menu = Anchor & { x: number; y: number; target?: FolderEventTarget; error?: string };
type Session = Anchor & { context: EventNamingContext };

function restoreFocus(anchor: Anchor) {
  requestAnimationFrame(() => {
    const row = [...document.querySelectorAll<HTMLElement>("[data-event-folder]")].find(node => node.dataset.eventFolder === anchor.path);
    const target = anchor.element.isConnected ? anchor.element : row;
    target?.focus({ preventScroll: true });
  });
}

function FolderEventMenu({ menu, close, choose }: { menu: Menu; close: (restore?: boolean) => void; choose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(menu.x, innerWidth - rect.width - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(menu.y, innerHeight - rect.height - 8))}px`;
    (node.querySelector<HTMLElement>('button:not(:disabled)') ?? node).focus();
  }, [menu]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target)) close(false); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [close]);
  return <div ref={panel} className="event-folder-menu" role="menu" aria-label="Event actions" tabIndex={-1}
    onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); close(); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); panel.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus(); }
    }}>
    <div className="event-folder-menu-label">{menu.target?.target || menu.path || "Staging"}</div>
    <button type="button" role="menuitem" disabled={!menu.target} onClick={choose}>{menu.target?.label || (menu.error ? "Event naming unavailable" : "Finding event…")}</button>
    {menu.error && <p role="status">{menu.error}</p>}
  </div>;
}

function EventNamingDialog({ session, close, finished, beforeApply }: {
  session: Session; close: () => void; finished: (result: EventNamingResult) => Promise<void>; beforeApply: () => void | Promise<void>;
}) {
  const backdrop = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null);
  const active = useRef(false), finishing = useRef(false);
  const [locked, setLocked] = useState(false), [refreshing, setRefreshing] = useState(false), [error, setError] = useState("");
  const activity = useCallback((value: boolean) => { active.current = value; setLocked(value); }, []);
  const finish = useCallback(async (result: EventNamingResult) => {
    finishing.current = true; setRefreshing(true);
    try { await finished(result); }
    catch (reason) { setError(`Naming finished, but this view could not refresh: ${String(reason)}. Refresh it before continuing.`); }
    finally { finishing.current = false; setRefreshing(false); }
  }, [finished]);
  useLayoutEffect(() => {
    const saved = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== backdrop.current)
      .map(node => ({ node, inert: node.inert }));
    saved.forEach(({ node }) => { node.inert = true; });
    panel.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    return () => saved.forEach(({ node, inert }) => { node.inert = inert; });
  }, []);
  const requestClose = () => { if (!active.current && !finishing.current) close(); };
  return <div ref={backdrop} className="event-naming-backdrop" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); requestClose(); }
    if (event.key === "Tab") {
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button,input,select,textarea,summary,[tabindex]') ?? [])]
        .filter(node => !node.matches(':disabled,[tabindex="-1"]') && node.checkVisibility() && node.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); panel.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <section ref={panel} role="dialog" aria-modal="true" aria-label="Event naming" tabIndex={-1} className="event-naming-drawer">
      <div className="event-naming-drawer-heading"><div><strong>{session.context.dayPath ? "Name or edit event" : "Name events within"}</strong><p>{session.context.dayPath || session.context.relativePath || session.context.root}</p></div>
        <button type="button" aria-label="Close event editor" className="btn-secondary" disabled={locked || refreshing} onClick={requestClose}>Close</button></div>
      {(locked || refreshing) && <p className="event-naming-progress" role="status">{refreshing ? "Refreshing the originating view…" : "Naming activity is in progress. Use the job controls below; close when it finishes."}</p>}
      {error && <p role="alert" className="event-naming-progress">{error}</p>}
      <NameEvents context={session.context} onFinished={finish} onActivityChange={activity} beforeApply={beforeApply} />
    </section>
  </div>;
}

/** One contextual entry point; the full editor owns review, jobs and safeguards. */
export function useEventNaming(root: string, onFinished: (result: EventNamingResult) => void | Promise<void>, beforeApply?: () => void | Promise<void>) {
  const [menu, setMenu] = useState<Menu | null>(null), [session, setSession] = useState<Session | null>(null);
  const generation = useRef(0), alive = useRef(true), currentRoot = useRef(root), currentSession = useRef(session);
  const callback = useRef(onFinished);
  const applyGuard = useRef(beforeApply); applyGuard.current = beforeApply;
  const checkApply = useCallback(() => applyGuard.current?.(), []);
  currentRoot.current = root; currentSession.current = session; callback.current = onFinished;
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => { generation.current++; setMenu(null); setSession(null); }, [root]);
  const closeMenu = useCallback((restore = true) => { generation.current++; setMenu(current => { if (restore && current) restoreFocus(current); return null; }); }, []);
  const open = async (path: string, element: HTMLElement, point?: { x: number; y: number }, direct = false) => {
    if (!root || currentSession.current) return;
    const request = ++generation.current, originalRoot = root, rect = element.getBoundingClientRect();
    const anchor = { path, element, x: point?.x ?? rect.left + 20, y: point?.y ?? rect.bottom };
    setMenu(anchor);
    try {
      const days = await invoke<NamingDay[]>("list_event_day_directories", { stagingDir: originalRoot });
      if (!alive.current || request !== generation.current || namingRootKey(originalRoot) !== namingRootKey(currentRoot.current)) return;
      const target = folderEventTarget(originalRoot, path, days);
      if (direct) { setMenu(null); setSession({ ...anchor, context: target.context }); }
      else setMenu({ ...anchor, target });
    } catch (reason) {
      if (alive.current && request === generation.current && namingRootKey(originalRoot) === namingRootKey(currentRoot.current)) setMenu({ ...anchor, error: String(reason) });
    }
  };
  const finish = useCallback(async (result: EventNamingResult) => {
    const captured = currentSession.current;
    if (!alive.current || !captured || namingRootKey(result.root) !== namingRootKey(currentRoot.current)) return;
    const request = generation.current;
    await callback.current(result);
    if (!alive.current || request !== generation.current || currentSession.current !== captured) return;
    setSession({ ...captured, path: namedEventPath(captured.path, result) });
  }, []);
  const close = () => { const anchor = currentSession.current; generation.current++; setSession(null); if (anchor) restoreFocus(anchor); };
  return {
    isOpen: !!menu || !!session,
    openMenu: (path: string, element: HTMLElement, point?: { x: number; y: number }) => void open(path, element, point),
    openEditor: (path: string, element: HTMLElement) => void open(path, element, undefined, true),
    layer: typeof document === "undefined" ? null : createPortal(<>{menu && <FolderEventMenu menu={menu} close={closeMenu} choose={() => {
      if (menu.target) { setMenu(null); setSession({ ...menu, context: menu.target.context }); }
    }} />}{session && <EventNamingDialog key={JSON.stringify(session.context)} session={session} close={close} finished={finish} beforeApply={checkApply} />}</>, document.body),
  };
}
