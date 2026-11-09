import { useLayoutEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { useControllerSurface } from "../controller/useControllerSurface";
import { guideMessage } from "../utils/userGuide";
import "./userGuide.css";

export default function UserGuide({ chapter, onClose, background }: {chapter: string; onClose: () => void; background: HTMLElement | null}) {
  const dialog = useRef<HTMLDialogElement>(null), frame = useRef<HTMLIFrameElement>(null), close = useRef<HTMLButtonElement>(null);
  const closeLatest = useRef(onClose); closeLatest.current = onClose;
  const [attempt, setAttempt] = useState(0), [ready, setReady] = useState(false), [error, setError] = useState("");
  const target = /^(top|ch-(0[1-9]|1[0-8]))$/.test(chapter) ? chapter : "top";
  useControllerSurface({id: "user-guide", title: "Reading user guide", contextKey: "guide:" + target,
    priority: 10000, keys: [], dials: [], sideButtons: [], execute: () => {}});

  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const wasInert = background?.inert ?? false;
    if (background) background.inert = true;
    const element = dialog.current;
    element?.showModal(); close.current?.focus();
    function keys(event: KeyboardEvent) {
      // Do not let global photo/snapshot handlers observe reader keys. Native Tab and button defaults still work.
      event.stopImmediatePropagation();
      if (event.key === "Escape") {event.preventDefault(); if (!event.repeat) closeLatest.current();}
      else if (!(event.target instanceof Node) || !element?.contains(event.target)) event.preventDefault();
    }
    window.addEventListener("keydown", keys, true);
    window.addEventListener("keyup", keys, true);
    return () => {
      window.removeEventListener("keydown", keys, true); window.removeEventListener("keyup", keys, true);
      element?.close();
      if (background) background.inert = wasInert;
      if (previous?.isConnected) previous.focus({preventScroll: true});
    };
  }, [background]);

  useLayoutEffect(() => {
    setReady(false); setError("");
    const timer = window.setTimeout(() => setError("The local guide did not finish opening. Retry, or return to your work."), 12000);
    function message(event: MessageEvent) {
      // Sandbox origins are opaque ("null"); the exact live frame is the sender identity.
      if (event.source !== frame.current?.contentWindow) return;
      const value = guideMessage(event.data);
      if (!value) return;
      if (value.type === "ready") {clearTimeout(timer); setReady(true); setError("");}
      else if (value.type === "close") closeLatest.current();
      else if (value.type === "focus-return") close.current?.focus();
      else if (value.type === "external") void open(value.url).catch(() => setError("The reference could not open in your browser. Your guide and work remain available."));
    }
    window.addEventListener("message", message);
    return () => {clearTimeout(timer); window.removeEventListener("message", message);};
  }, [attempt]);

  return <dialog ref={dialog} className="user-guide-dialog" aria-labelledby="user-guide-title" onCancel={event => {event.preventDefault(); onClose();}}>
    <header className="user-guide-bar">
      <div><h2 id="user-guide-title">PhotoGoGo User Guide</h2><p>Included with your app · available offline</p></div>
      <button ref={close} type="button" onClick={onClose}>Return to your work <span aria-hidden="true">×</span></button>
    </header>
    {(!ready || error) && <div className="user-guide-status" role="status">{error || "Opening guide…"}{error && <button type="button" onClick={() => setAttempt(value => value+1)}>Retry guide</button>}</div>}
    <iframe ref={frame} key={attempt} title="PhotoGoGo User Guide" src={`${new URL("help/user-guide.html", document.baseURI).href}?embedded=1&attempt=${attempt}#${target}`} sandbox="allow-scripts allow-modals" referrerPolicy="no-referrer" />
  </dialog>;
}
