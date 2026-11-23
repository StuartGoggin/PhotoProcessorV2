import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./SdArchiveLibrary.css";

interface Spine { name: string; card: string; dateHint: string | null }
interface Shelf { books: Spine[]; skipped: number }
interface Photo { index: number; name: string; relative: string }
interface BookPage { revision: string; card: string; archiveDate: string; total: number; offset: number; photos: Photo[] }
interface PhotoRange { first: string; last: string; estimated: boolean; undated: number }
interface RequestedImage { index: number; large: boolean }
interface Preview { uri?: string; error?: string }

const pageSize = 48;
const pictureKey = ({ index, large }: RequestedImage) => String(index) + (large ? ":page" : ":thumb");

function dateLabel(value: string) {
  return new Date(value + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function rangeLabel(range: PhotoRange) {
  if (range.first === range.last) return dateLabel(range.first);
  if (range.first.slice(0, 7) === range.last.slice(0, 7)) {
    return Number(range.first.slice(8)) + "–" + dateLabel(range.last);
  }
  return dateLabel(range.first) + " – " + dateLabel(range.last);
}

function usePreviews(name: string, revision: string | undefined, wanted: RequestedImage[]) {
  const [images, setImages] = useState<Map<string, Preview>>(() => new Map());
  const pending = useRef(new Set<string>());
  useEffect(() => {
    if (!revision) return;
    for (const request of wanted) {
      if (pending.current.size >= 2) break;
      const key = pictureKey(request);
      if (images.has(key) || pending.current.has(key)) continue;
      pending.current.add(key);
      const save = (value: Preview) => {
        pending.current.delete(key);
        setImages(current => {
          const result = new Map(current).set(key, value);
          if (result.size > 48) {
            // Keep the active spread and strip even under fast navigation.
            const visible = new Set(wanted.map(pictureKey));
            const eviction = Array.from(result.keys()).find(old => !visible.has(old));
            if (eviction) result.delete(eviction);
          }
          return result;
        });
      };
      void invoke<string>("sd_archive_library_preview", { name, revision, ...request })
        .then(data => save({ uri: "data:image/jpeg;base64," + data }))
        .catch(reason => save({ error: String(reason) }));
    }
  }, [name, revision, wanted, images]);
  return {
    get: (index: number, large: boolean) => images.get(pictureKey({ index, large })),
    retry: (index: number, large: boolean) => setImages(current => {
      const next = new Map(current);
      next.delete(pictureKey({ index, large }));
      return next;
    }),
  };
}

function PreviewImage({ photo, preview }: { photo: Photo; preview: Preview | undefined }) {
  if (preview?.uri) return <img src={preview.uri} alt={photo.name} draggable={false} />;
  return <span className="sd-lib-photo-placeholder" title={preview?.error}>{preview?.error ? "Preview unavailable" : "Loading photo…"}</span>;
}

function EnlargedPhoto({ photo, preview, retry, close }: {
  photo: Photo; preview: Preview | undefined; retry: () => void; close: () => void;
}) {
  const modal = useRef<HTMLDialogElement>(null);
  const title = useRef("sd-lib-enlarged-photo");
  useEffect(() => { modal.current?.showModal(); }, []);
  return <dialog ref={modal} onClose={close} aria-labelledby={title.current} className="sd-lib-lightbox">
    <header><h3 id={title.current}>{photo.name}</h3><button className="btn-secondary" onClick={() => modal.current?.close()}>Close photo</button></header>
    <div className="sd-lib-lightbox-image"><PreviewImage photo={photo} preview={preview} /></div>
    {preview?.error && <div className="sd-lib-lightbox-error"><p role="alert">{preview.error}</p><button className="btn-secondary" onClick={retry}>Retry preview</button></div>}
  </dialog>;
}

function Reader({ book, dates, close }: { book: Spine; dates: PhotoRange | null | undefined; close: () => void }) {
  const [page, setPage] = useState<BookPage | null>(null);
  const [first, setFirst] = useState(0);
  const [zoom, setZoom] = useState<Photo | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const revision = useRef<string>();
  const offset = Math.floor(first / pageSize) * pageSize;
  const openPage = page?.offset === offset ? page : null;
  const total = page?.total ?? 0;

  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    let current = true;
    setError("");
    void invoke<BookPage>("sd_archive_library_page", { name: book.name, offset, revision: revision.current ?? null })
      .then(result => {
        if (!current) return;
        revision.current = result.revision;
        setPage(result);
      })
      .catch(reason => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, [book.name, offset, attempt]);

  const photos = useMemo(() => openPage?.photos.filter(photo => photo.index >= first && photo.index < first + 2) ?? [], [openPage, first]);
  const strip = useMemo(() => {
    if (!openPage) return [];
    const local = Math.max(0, Math.min(first - offset - 3, openPage.photos.length - 8));
    return openPage.photos.slice(local, local + 8);
  }, [openPage, first, offset]);
  const wanted = useMemo(() => [
    ...photos.map(photo => ({ index: photo.index, large: true })),
    ...strip.filter(photo => !photos.some(pagePhoto => pagePhoto.index === photo.index)).map(photo => ({ index: photo.index, large: false })),
  ], [photos, strip]);
  const previews = usePreviews(book.name, page?.revision, wanted);
  const turn = (amount: number) => setFirst(value => Math.max(0, Math.min(Math.floor((total - 1) / 2) * 2, value + amount)));

  return <section className="sd-lib-reader" aria-label="Open archive book" onKeyDown={event => {
    if (zoom || event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof HTMLInputElement)) return;
    if (event.key === "ArrowLeft" && total) { event.preventDefault(); turn(-2); }
    if (event.key === "ArrowRight" && total) { event.preventDefault(); turn(2); }
  }}>
    <header className="sd-lib-reader-header">
      <button type="button" className="btn-secondary" onClick={close}>Back to shelf</button>
      <div><h2 ref={heading} tabIndex={-1}>{book.name}</h2>
        <p>{page ? [dates ? rangeLabel(dates) : "Archive date " + dateLabel(page.archiveDate), "Card " + page.card, total.toLocaleString() + (total === 1 ? " photo" : " photos")].filter(Boolean).join(" · ") : "Opening archive…"}</p>
      </div>
    </header>
    {error && <div className="sd-lib-feedback" role="alert"><p>{error}</p><button className="btn-secondary" onClick={() => setAttempt(value => value + 1)}>Retry page</button></div>}
    {!error && !openPage && <p className="sd-lib-feedback" role="status">Reading photo list…</p>}
    {!error && openPage && total === 0 && <p className="sd-lib-feedback">This archive contains no photos.</p>}
    {total > 0 && <>
      <nav className="sd-lib-page-nav" aria-label="Book pages">
        <button className="btn-secondary" onClick={() => turn(-2)} disabled={first === 0} aria-label="Previous spread">← Previous</button>
        <span aria-live="polite">{first + 1}{first + 1 < total ? "–" + (first + 2) : ""} of {total.toLocaleString()}</span>
        <button className="btn-secondary" onClick={() => turn(2)} disabled={first + 2 >= total} aria-label="Next spread">Next →</button>
      </nav>
      <section className="sd-lib-spread" aria-label="Photo spread" aria-busy={!openPage}>
        {photos.map(photo => <figure key={photo.index}>
          <button className="sd-lib-page-photo" aria-label={"Enlarge " + photo.name} title={photo.relative} onClick={() => setZoom(photo)}>
            <PreviewImage photo={photo} preview={previews.get(photo.index, true)} />
          </button>
          <figcaption>{photo.name}{photo.name.toLowerCase().endsWith(".cr3") && <span> · Camera preview</span>}</figcaption>
        </figure>)}
      </section>
      {strip.length > 0 && <div className="sd-lib-strip" role="group" aria-label="Jump to a photo">
        {strip.map(photo => <button key={photo.index} aria-label={"Go to " + photo.name}
          aria-pressed={photo.index === first || photo.index === first + 1}
          onClick={() => setFirst(photo.index - photo.index % 2)}>
          <PreviewImage photo={photo} preview={previews.get(photo.index, false) ?? previews.get(photo.index, true)} />
        </button>)}
      </div>}
      {total > 8 && <label className="sd-lib-slider">Jump to spread
        <input type="range" min={1} max={Math.ceil(total / 2)} value={first / 2 + 1} onChange={event => setFirst((Number(event.target.value) - 1) * 2)} />
      </label>}
    </>}
    {zoom && <EnlargedPhoto photo={zoom} preview={previews.get(zoom.index, true)}
      retry={() => previews.retry(zoom.index, true)} close={() => setZoom(null)} />}
  </section>;
}

export default function SdArchiveLibrary() {
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [current, setCurrent] = useState<Spine | null>(null);
  const [error, setError] = useState("");
  const [load, setLoad] = useState(0);
  const [dates, setDates] = useState<Map<string, PhotoRange | null | "error">>(() => new Map());
  const cachedDates = useRef(dates);
  const requests = useRef(new Map<string, Promise<PhotoRange | null | "error">>());
  const returnFocus = useRef<string>();
  const shelfElement = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setError("");
    setShelf(null);
    setDates(new Map());
    cachedDates.current = new Map();
    requests.current = new Map();
    void invoke<Shelf>("list_sd_archive_library")
      .then(result => { if (active) setShelf(result); })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [load]);

  useEffect(() => {
    if (!shelf || current) return;
    let active = true;
    const pending = requests.current;
    void (async () => {
      for (const book of shelf.books) {
        if (!active) break;
        if (cachedDates.current.has(book.name)) continue;
        let request = pending.get(book.name);
        if (!request) {
          request = invoke<PhotoRange | null>("sd_archive_library_date_range", { name: book.name }).catch(() => "error" as const);
          pending.set(book.name, request);
        }
        const range = await request;
        if (!active) break;
        cachedDates.current = new Map(cachedDates.current).set(book.name, range);
        setDates(cachedDates.current);
        pending.delete(book.name);
      }
    })();
    return () => { active = false; };
  }, [shelf, current]);

  useEffect(() => {
    if (current || !returnFocus.current) return;
    const target = Array.from(shelfElement.current?.querySelectorAll("button[data-book]") ?? [])
      .find(node => (node as HTMLButtonElement).dataset.book === returnFocus.current) as HTMLButtonElement | undefined;
    target?.focus();
    returnFocus.current = undefined;
  }, [current]);

  const currentDates = current ? dates.get(current.name) : undefined;
  if (current) return <Reader key={current.name} book={current} dates={currentDates === "error" ? null : currentDates} close={() => setCurrent(null)} />;
  return <section className="sd-lib-shelf-section" aria-labelledby="sd-lib-title">
    <header className="sd-lib-shelf-header">
      <div><h2 id="sd-lib-title">Repository Library</h2><p>Open an archived card to browse its photos.</p></div>
      <button className="btn-secondary" onClick={() => setLoad(value => value + 1)}>Refresh library</button>
    </header>
    {error ? <p className="sd-lib-feedback" role="alert">{error}</p> : !shelf ? <p className="sd-lib-feedback" role="status">Opening repository…</p> : <>
      {shelf.skipped > 0 && <p className="sd-lib-feedback" role="status">Some archive folders couldn’t be read. Check the repository and refresh.</p>}
      {!shelf.books.length && <p className="sd-lib-feedback">Completed card archives will appear here.</p>}
      <div className="sd-lib-shelf" ref={shelfElement}>
        {shelf.books.map((book, index) => {
          const range = dates.get(book.name);
          return <button type="button" key={book.name} data-book={book.name} data-cloth={index % 5}
            title={book.dateHint ? book.name + " · Archive date " + dateLabel(book.dateHint) : book.name} aria-label={"Open archive " + book.name} aria-describedby={"sd-lib-book-date-" + index} className="sd-lib-spine" onClick={() => {
              returnFocus.current = book.name;
              setCurrent(book);
            }}>
            <span id={"sd-lib-book-date-" + index} className="sd-lib-spine-date">{range === undefined ? "Finding photo dates…" : range === "error"
              ? "Dates unavailable" : range ? rangeLabel(range) : "No dated photos"}</span>
            {range && range !== "error" && (range.estimated || range.undated > 0) && <span className="sd-lib-spine-note">
              {range.estimated ? "Estimated" : ""}{range.estimated && range.undated ? " · " : ""}{range.undated ? range.undated + " undated" : ""}
            </span>}
            <span className="sd-lib-spine-card" title={book.name}>{book.card}</span>
          </button>;
        })}
      </div>
    </>}
  </section>;
}
