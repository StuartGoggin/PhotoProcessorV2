import { useEffect, useMemo, useRef, useState } from "react";
import { lightboxCommands, lightboxCropCommands, shortcutFor } from "../utils/lightboxCommands";

interface Props { onClose: () => void }
const controlKeys = [
  { name: "★ + next", id: "rate-1-next", file: "one-star-next.svg" },
  { name: "★★ + next", id: "rate-2-next", file: "two-stars-next.svg" },
  { name: "★★★ + next", id: "rate-3-next", file: "three-stars-next.svg" },
  { name: "Trash + next", id: "trash-next", file: "trash-next.svg" },
  { name: "Select + next", id: "select-active-next", file: "select-next.svg" },
  { name: "Skip / next", id: "next", file: "skip.svg" },
];

export default function LightboxHelp({ onClose }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const [tab, setTab] = useState<"keys" | "controller" | "crop">("keys");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape" || event.key === "F1") { event.preventDefault(); event.stopPropagation(); if (!event.repeat) onCloseRef.current(); }
      else if (event.key === "Tab") {
        const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], select:not(:disabled), [tabindex="0"]') ?? [])].filter(node => node.getClientRects().length > 0);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {event.preventDefault(); last?.focus();}
        else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {event.preventDefault(); first?.focus();}
      }
    }
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      if (previous?.isConnected && !previous.matches(":disabled")) previous.focus();
      else document.querySelector<HTMLElement>(".review-layout button:not(:disabled)")?.focus();
    };
  }, []);
  const commands = tab === "crop" ? lightboxCropCommands : lightboxCommands;
  const filtered = useMemo(() => commands.filter(command => `${command.label} ${command.group} ${command.keys.join(" ")}`.toLowerCase().includes(query.toLowerCase().trim())), [commands, query]);
  const groups = [...new Set(filtered.map(command => command.group))];
  return <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="lightbox-help-heading" tabIndex={-1}
    className="fixed inset-0 z-[70] flex flex-col bg-surface-900 text-gray-200 outline-none" data-testid="lightbox-help">
    <header className="shrink-0 border-b border-surface-600 px-4 sm:px-7 py-4 flex items-start justify-between gap-4">
      <div><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-cyan-300">Photo Lightbox</p><h2 id="lightbox-help-heading" className="text-xl sm:text-2xl font-semibold text-white mt-1">Keyboard &amp; Controller Help</h2><p className="text-xs text-gray-400 mt-1">Your current photo stays open. Commands apply only in the Lightbox.</p></div>
      <button ref={close} type="button" className="btn-secondary min-h-11" onClick={onClose}>Close help <kbd className="ml-2 text-xs text-gray-400">Esc</kbd></button>
    </header>
    <nav className="shrink-0 px-4 sm:px-7 pt-3 flex gap-2 flex-wrap" aria-label="Lightbox help sections">{([
      ["keys", "Keyboard keymap"], ["controller", "AJAZZ AKP03E"], ["crop", "Crop editor"],
    ] as const).map(([id, label]) => <button type="button" key={id} className={`px-4 min-h-11 rounded-lg text-sm border ${tab === id ? "border-cyan-500 bg-cyan-950/60 text-cyan-100" : "border-surface-600 bg-surface-800 text-gray-300"}`} aria-pressed={tab === id} onClick={() => {setTab(id); setQuery("");}}>{label}</button>)}</nav>
    <main className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-7 py-5">
      <div className="max-w-5xl mx-auto space-y-5">
        {tab === "controller" ? <>
          <div className="rounded-xl border border-cyan-700/60 bg-cyan-950/20 px-4 py-3 text-sm text-cyan-100"><strong>Use the AJAZZ software’s Hotkey action.</strong><p className="text-xs text-gray-300 mt-1">Assign each button and dial direction to the key shown below. Keep PhotoGoGo in the foreground and the Lightbox open. The button artwork and setup reference are supplied with the release; they are not a vendor-import profile.</p></div>
          <section aria-labelledby="akp03e-buttons-heading"><h3 id="akp03e-buttons-heading" className="text-lg font-semibold text-white">Main review page</h3><p className="text-xs text-gray-400 mt-1 mb-3">Rate, select or mark trash and then advance only after a successful save. “Select + next” sets the active panel’s Google Photos selection on.</p>
            <div className="grid grid-cols-3 gap-2 sm:gap-3 max-w-xl mx-auto" aria-label="AKP03E six-button layout">{controlKeys.map(control => <div key={control.file} className="rounded-xl border border-surface-600 bg-surface-800 p-2 sm:p-3 text-center">
              <img className="w-20 h-20 sm:w-24 sm:h-24 mx-auto rounded-lg" src={`/controller/ajazz-akp03e/${control.file}`} alt="" />
              <strong className="block text-xs sm:text-sm text-white mt-2">{control.name}</strong><kbd className="inline-block mt-1 text-[10px] sm:text-xs text-cyan-200">{shortcutFor(control.id)}</kbd>
            </div>)}</div>
          </section>
          <section aria-labelledby="akp03e-dials-heading"><h3 id="akp03e-dials-heading" className="text-lg font-semibold text-white">Dial assignments</h3><div className="overflow-x-auto mt-2"><table className="w-full text-xs sm:text-sm text-left"><thead className="text-gray-400"><tr><th className="p-2">Dial</th><th className="p-2">Turn left / right</th><th className="p-2">Press</th></tr></thead><tbody>
            <tr className="border-t border-surface-600"><th className="p-2">1 · Photos</th><td className="p-2">Previous / next · <kbd>{shortcutFor("previous")} / {shortcutFor("next")}</kbd></td><td className="p-2">Original / cropped · <kbd>{shortcutFor("crop-version")}</kbd></td></tr>
            <tr className="border-t border-surface-600"><th className="p-2">2 · Zoom</th><td className="p-2">Zoom out / in · <kbd>{shortcutFor("zoom-out")} / {shortcutFor("zoom-in")}</kbd></td><td className="p-2">Fit image · <kbd>{shortcutFor("fit")}</kbd></td></tr>
            <tr className="border-t border-surface-600"><th className="p-2">3 · Version</th><td className="p-2">Previous / next panel · <kbd>{shortcutFor("panel-previous")} / {shortcutFor("panel-next")}</kbd></td><td className="p-2">Toggle active selection · <kbd>{shortcutFor("select-active")}</kbd></td></tr>
          </tbody></table></div><p className="mt-2 text-xs text-gray-400">Dial hotkey and press options depend on your installed AJAZZ software. This mapping does not change its drivers or firmware.</p></section>
          <section className="rounded-xl border border-surface-600 bg-surface-800 px-4 py-3 space-y-2 text-xs text-gray-300"><h3 className="font-semibold text-white text-sm">Confirm the target on screen</h3><p>The cyan Active border identifies the Original, B&amp;W or Enhanced panel that A and G affect. In cropped view, those actions target the cropped versions. Missing versions are not silently substituted.</p><p>Static controller labels do not mirror saved checkmarks. Check the Lightbox’s selected/saving/saved state. Rating and Google Photos favourite are separate controls.</p><p>For a second controller page, assign Q / W / E to the three exact-version selections and Shift+Q / Shift+W / Shift+E to their favourites.</p></section>
        </> : <>
          <label className="block text-xs text-gray-400 space-y-1"><span>Find a command or shortcut</span><input type="search" className="input-field w-full min-h-11" value={query} onChange={event => setQuery(event.target.value)} placeholder="Try rating, Google Photos, crop or zoom" /></label>
          {tab === "crop" && <p className="rounded-lg border border-surface-600 p-3 text-sm text-gray-300">The crop editor owns these keys while it is open. Its fields retain normal typing and arrow-key behaviour. Enter only activates a focused button; Ctrl+Enter deliberately applies the crop.</p>}
          {groups.map(group => <section key={group} aria-label={`${group} shortcuts`}><h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-200 mb-2">{group}</h3><div className="rounded-xl border border-surface-600 bg-surface-800 overflow-hidden"><table className="w-full text-left text-xs sm:text-sm"><tbody>{filtered.filter(command => command.group === group).map(command => <tr key={command.id} className="border-b last:border-b-0 border-surface-600"><td className="px-3 py-3 text-gray-200">{command.label}</td><td className="px-3 py-3 text-right w-[38%]">{command.keys.map(key => <kbd key={key} className="inline-block rounded border border-surface-500 bg-surface-900 px-2 py-1 text-xs text-cyan-100 ml-1 my-0.5">{key}</kbd>)}</td></tr>)}</tbody></table></div></section>)}
          {!filtered.length && <p role="status" className="text-gray-400">No commands match that search.</p>}
          <section className="rounded-xl border border-surface-600 p-4 text-xs text-gray-400 space-y-2"><h3 className="font-semibold text-gray-200 text-sm">Review without surprises</h3><p>Typing, menus, the file tree and modal editors keep their own keyboard behaviour. File-tree arrows move focus; Enter or Space opens the focused photo.</p><p>Hold navigation or zoom keys to repeat them. Ratings, selections, trash and other state changes run once per press. A failed save keeps the current photo open.</p><p>Use Tab and Shift+Tab to reach controls. Space toggles a focused checkbox, and Enter activates a focused button. Fit means fit to the current panel, not original-source pixel magnification.</p></section>
        </>}
      </div>
    </main>
    <footer className="shrink-0 px-4 sm:px-7 py-3 border-t border-surface-600 text-xs text-gray-400">F1 or ? opens this help from the Lightbox · Esc returns to your photo · No upload starts from a selection shortcut</footer>
  </div>;
}
