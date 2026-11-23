import type { ReactNode } from "react";
import { isMeasured, jobStatusLabel, type JobProgressDisplay } from "../utils/jobProgress";
import "./JobProgressCard.css";

const glyphs = { photo: "◩", video: "▶", cloud: "☁", check: "✓", folder: "▰", scan: "◎", trash: "×" };

function JobEndpoint({ endpoint }: { endpoint: JobProgressDisplay["source"] }) {
  return <div className="job-flow-endpoint">
    <span className="job-flow-icon" data-icon={endpoint.icon}>
      {endpoint.icon === "sd" ? <><i /><i /><i /><i /><i /><b>SD</b></>
        : endpoint.icon === "drive" ? <><i /><i /><i /></> : glyphs[endpoint.icon]}
    </span>
    <span>{endpoint.label}</span>
  </div>;
}

export default function JobProgressCard({ display, compact = false, actions }: { display: JobProgressDisplay; compact?: boolean; actions?: ReactNode }) {
  const facts = display.facts.filter(([, value]) => value != null && value !== "" && (typeof value !== "number" || isMeasured(value)));
  const status = jobStatusLabel(display.status);
  const phase = display.phase?.trim();
  return <section
    className={"job-flow" + (compact ? " job-flow-compact" : "")}
    aria-label={display.title + " progress"}
    data-status={display.status}
    data-verified={display.verified ?? false}
  >
    <div className="job-flow-graphic" data-active={display.moving} aria-hidden="true">
      <JobEndpoint endpoint={display.source} />
      <div className="job-flow-stream"><span /><span /><span /><span /><span /></div>
      <JobEndpoint endpoint={display.target} />
    </div>
    <div className="job-flow-metrics">
      <div className="job-flow-heading">
        <div className="min-w-0">
          <h3>{display.title}</h3>
          {display.subject && <p className="job-flow-subject" title={display.subject}>{display.subject}</p>}
        </div>
        <div className="job-flow-heading-actions">
          <span className="job-flow-status">{status}</span>
          {actions}
        </div>
      </div>
      {phase && phase.toLowerCase() !== status.toLowerCase() && <p className="job-flow-phase" role={compact ? undefined : "status"}>{phase}</p>}
      {display.meters.map(meter => {
        const known = isMeasured(meter.value) && isMeasured(meter.total) && meter.total > 0;
        const value = known ? Math.min(meter.value!, meter.total!) : undefined;
        const detail = meter.detail ?? (known
          ? meter.value!.toLocaleString() + " / " + meter.total!.toLocaleString()
          : isMeasured(meter.value) && meter.value > 0 ? meter.value.toLocaleString() : undefined);
        if (!known && !display.moving && !detail) return null;
        return <div className="job-flow-meter" key={meter.label}>
          <div><span>{meter.label}</span>{detail && <span>{detail}</span>}</div>
          {(known || display.moving) && <progress aria-label={meter.name || meter.label} max={known ? meter.total : undefined} value={value} />}
        </div>;
      })}
      {facts.length > 0 && <dl className="job-flow-facts">{facts.map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd>{typeof value === "number" ? value.toLocaleString() : value}</dd></div>,
      )}</dl>}
      {display.currentItem && <p className="job-flow-current" title={display.currentItem}>{display.currentItem}</p>}
      {display.note && <p className="job-flow-note">{display.note}</p>}
    </div>
  </section>;
}
