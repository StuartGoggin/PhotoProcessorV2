import { useEffect, useRef, useState } from "react";
import { controllerKeyPreview } from "../controller/artwork";
import { controllerRuntime, type ControllerRuntime } from "../controller/runtime";
import { useControllerStatus } from "../controller/useControllerSurface";

const phaseLabel: Record<string, string> = {
  disabled: "Released", searching: "Looking for AKP03E", "taking-over": "Taking control…",
  connected: "Connected", error: "Needs attention", disconnected: "Reconnecting…",
};

/** Automatic mode and an honest live mirror, without a vendor scene editor. */
export default function ControllerPanel({ runtime = controllerRuntime() }: { runtime?: ControllerRuntime }) {
  const state = useControllerStatus(runtime);
  const [open, setOpen] = useState(false);
  const [brightness, setBrightness] = useState(state.status.brightness);
  const trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null);
  useEffect(() => runtime.start(), [runtime]);
  useEffect(() => { setBrightness(state.status.brightness); }, [state.status.brightness]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    function key(event: KeyboardEvent) {
      // Keep browser/button/range defaults, while suspending page shortcuts.
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      if (event.key === "Tab") {
        const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') || [])].filter(node => node.getClientRects().length > 0);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    }
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); (previous?.isConnected ? previous : trigger.current)?.focus(); };
  }, [open]);
  const connected = state.status.enabled && state.status.phase === "connected";
  const inactive = !connected || state.actionBusy || state.configuring;
  function saveBrightness() { if (brightness !== state.status.brightness) void runtime.configure(state.status.enabled, brightness); }
  return <>
    <button ref={trigger} type="button" aria-label="AKP03E controller" aria-haspopup="dialog" aria-expanded={open}
      className="w-full rounded-lg border border-surface-600 px-3 py-2 text-left hover:bg-surface-700 focus-visible:ring-2 focus-visible:ring-cyan-400" onClick={() => setOpen(true)}>
      <span className="flex items-center gap-2 text-xs font-semibold text-gray-200"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${connected ? "bg-cyan-300" : state.status.phase === "error" ? "bg-rose-400" : "bg-slate-500"}`} />AKP03E controller</span>
      <span className="block mt-1 text-[11px] text-gray-400">{phaseLabel[state.status.phase] || state.status.phase}</span>
    </button>
    {open && <div className="fixed inset-0 z-[90] bg-black/75 p-3 sm:p-6 flex items-center justify-center" onPointerDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div ref={dialog} data-controller-mirror-dialog role="dialog" aria-modal="true" aria-labelledby="akp-controller-heading" tabIndex={-1} className="w-full max-w-4xl max-h-full overflow-y-auto rounded-2xl border border-slate-600 bg-surface-900 text-gray-200 shadow-2xl outline-none">
        <header className="flex items-start justify-between gap-4 p-4 sm:p-6 border-b border-surface-600">
          <div><p className="text-[10px] uppercase tracking-[.22em] font-semibold text-cyan-300">PhotoGoGo · direct control</p><h2 id="akp-controller-heading" className="text-xl font-semibold text-white mt-1">Your AKP03E, ready to work</h2><p className="text-xs text-gray-400 mt-2">Layouts follow the page you are using. No scenes or button assignments to configure.</p></div>
          <button ref={close} type="button" className="btn-secondary min-h-11 shrink-0" onClick={() => setOpen(false)}>Close <span className="text-xs text-gray-400 ml-1">Esc</span></button>
        </header>
        <div className="p-4 sm:p-6 space-y-5">
          <section className="rounded-xl border border-surface-600 bg-surface-800 p-4 space-y-3" aria-label="Controller connection">
            <div className="flex flex-wrap justify-between gap-3 items-center"><div><strong className="text-sm text-cyan-100">{phaseLabel[state.status.phase] || state.status.phase}</strong><p className="text-xs text-gray-400 mt-1" role="status">{state.status.message}</p>{state.status.device && <p className="text-[11px] text-gray-500 mt-1">{state.status.device}</p>}{state.status.lastInput && <p className="text-[11px] text-cyan-200 mt-1" aria-label="Last controller input">Last control: {state.status.lastInput}</p>}</div>
              <div className="flex gap-2"><button type="button" className="btn-secondary min-h-10 text-xs" disabled={state.configuring} onClick={() => void runtime.configure(true)}>Connect / retry</button><button type="button" className="btn-secondary min-h-10 text-xs" disabled={state.configuring || !state.status.enabled} onClick={() => void runtime.configure(false)}>Release controller</button></div></div>
            <label className="flex items-center gap-3 min-h-11 text-sm"><input type="checkbox" className="h-5 w-5 accent-cyan-400" checked={state.status.enabled} disabled={state.configuring} onChange={event => void runtime.configure(event.target.checked)} />Use automatically while PhotoGoGo is running</label>
            <p className="text-xs text-gray-400">Taking control stops the recognised AJAZZ controller app. After releasing or closing PhotoGoGo, restart AJAZZ yourself when needed.</p>
            {state.status.vendorStopped && <p className="text-xs text-amber-200">AJAZZ was stopped for this PhotoGoGo session. Its saved profiles are retained.</p>}
            <label className="flex items-center gap-3 flex-wrap text-xs text-gray-300"><span>Display brightness</span><input aria-label="Controller display brightness" type="range" min="5" max="100" step="5" value={brightness} disabled={state.configuring} onChange={event => setBrightness(Number(event.target.value))} onPointerUp={saveBrightness} onKeyUp={saveBrightness} onBlur={saveBrightness} className="accent-cyan-300 flex-1 min-w-28" /><output className="w-9 text-right">{brightness}%</output></label>
          </section>
          {(state.error || state.status.error) && <p role="alert" className="rounded-lg border border-rose-700 bg-rose-950/30 p-3 text-sm text-rose-200">{state.error || state.status.error}</p>}
          {state.notice && <p role="status" className="rounded-lg border border-cyan-800 bg-cyan-950/20 p-3 text-xs text-cyan-100">{state.notice}</p>}
          <section aria-label="Live controller layout" className="rounded-xl border border-surface-600 p-4 sm:p-5 bg-gradient-to-br from-slate-900 to-surface-800">
            <div className="flex justify-between gap-3 items-baseline mb-4"><h3 className="text-sm font-semibold text-white">{state.surface?.title || "Open a PhotoGoGo page"}</h3><span className="text-[10px] tracking-widest uppercase text-cyan-300">{state.actionBusy ? "Working" : connected ? "Live mirror" : "Layout preview"}</span></div>
            <div className="grid grid-cols-3 gap-2 sm:gap-4 max-w-lg mx-auto" aria-label="Six display buttons">
              {Array.from({ length: 6 }, (_, index) => {
                const key = state.surface?.keys[index] || { id: "", label: "Unavailable", enabled: false };
                return <button type="button" key={index} aria-label={`Controller key ${index + 1}: ${key.label}`} aria-pressed={!!key.active} disabled={inactive || !key.enabled} onClick={() => runtime.mirror("key", index, 1)} title={key.enabled ? key.label : "Unavailable in the current context"} className="rounded-xl p-1.5 sm:p-2 border border-slate-700 bg-black/35 enabled:hover:border-cyan-400 enabled:focus-visible:ring-2 enabled:focus-visible:ring-cyan-400 disabled:cursor-default">
                  <img className="w-full max-w-28 mx-auto aspect-square rounded-lg" src={controllerKeyPreview(key)} alt="" draggable={false} />
                  <span className="sr-only">{key.detail}</span>
                </button>;
              })}
            </div>
            <div className="grid sm:grid-cols-3 gap-3 mt-5" aria-label="Three rotary controls">{(state.surface?.dials || []).map((dial, index) => <div key={index} className="rounded-lg border border-slate-700 bg-black/20 p-3 text-center"><strong className="block text-xs text-gray-200 mb-2">{index + 1} · {dial.label}</strong><div className="flex justify-center gap-1"><button type="button" aria-label={`Dial ${index + 1} left`} disabled={inactive || dial.enabled === false || !dial.left} className="btn-secondary text-xs px-3 min-h-9" onClick={() => runtime.mirror("dial", index, -1)}>↶</button><button type="button" aria-label={`Dial ${index + 1} press`} disabled={inactive || dial.enabled === false || !dial.press} className="btn-secondary text-xs px-3 min-h-9" onClick={() => runtime.mirror("dial", index, 0)}>Press</button><button type="button" aria-label={`Dial ${index + 1} right`} disabled={inactive || dial.enabled === false || !dial.right} className="btn-secondary text-xs px-3 min-h-9" onClick={() => runtime.mirror("dial", index, 1)}>↷</button></div></div>)}</div>
            <div className="flex gap-2 flex-wrap justify-center mt-3" aria-label="Three side buttons">{(state.surface?.sideButtons || []).map((button, index) => <button type="button" key={index} disabled={inactive || button.enabled === false || !button.id} className="btn-secondary text-xs min-h-10" onClick={() => runtime.mirror("side", index, 1)}>{button.label}</button>)}</div>
            <p className="text-[11px] text-gray-400 text-center mt-4">Available mirror controls perform the same PhotoGoGo actions as the physical controller. Saving and unavailable states follow the current page.</p>
          </section>
        </div>
      </div>
    </div>}
  </>;
}
