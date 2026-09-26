//! Finishing graphics never enter the stabilisation cache. Preview and export
//! share this compositor; all user strings are literal text assets, not filters.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme { pub font: String, pub palette: String, pub accent: String, pub position: String, pub opacity: u8 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u8, pub theme: Theme, pub styled_titles: bool,
    pub scorecard_timing: String, pub scorecard_seconds: f64, pub scorecard_start: f64,
}
impl Default for Settings {
    fn default() -> Self { Self { version: 1, theme: Theme { font: "segoe".into(), palette: "midnight".into(),
        accent: "#D5B46B".into(), position: "bottom".into(), opacity: 88 }, styled_titles: false,
        scorecard_timing: "clipEnd".into(), scorecard_seconds: 6., scorecard_start: 0. } }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scorecard {
    pub enabled: bool, pub template: String, pub heading: String, pub result: String, pub subtitle: String,
    pub columns: Vec<String>, pub rows: Vec<Vec<String>>, pub timing: String, pub seconds: f64, pub start: f64,
}
fn settings(p: &Project) -> Settings { p.graphics.clone().unwrap_or_default() }
fn timing<'a>(g: &'a Settings, s: &'a Scorecard) -> (&'a str, f64, f64) {
    if s.timing == "inherit" { (&g.scorecard_timing, g.scorecard_seconds, g.scorecard_start) }
    else { (&s.timing, s.seconds, s.start) }
}
fn valid_timing(t: &str, seconds: f64, start: f64) -> bool {
    ["clipEnd", "afterReplays", "separateCard", "clipStart", "custom"].contains(&t)
        && seconds.is_finite() && (1.0..=30.0).contains(&seconds) && start.is_finite() && (0.0..=86400.0).contains(&start)
}
fn bounded_text(s: &str, max: usize) -> bool { s.chars().count() <= max && !s.chars().any(char::is_control) }
pub(super) fn validate(p: &Project) -> Result<(), String> {
    if !bounded_text(&p.title_heading, 60) || p.clips.iter().any(|c| !bounded_text(&c.title_heading, 60) || !bounded_text(&c.title_subtitle, 110)) {
        return Err("Title headings must be at most 60 characters and clip subtitles at most 110, without control characters".into());
    }
    let g = settings(p); let t = &g.theme;
    if g.version != 1 || !["segoe", "georgia", "trebuchet"].contains(&t.font.as_str())
        || !["midnight", "ivory", "slate"].contains(&t.palette.as_str())
        || !["top", "bottom"].contains(&t.position.as_str()) || t.opacity > 100
        || t.accent.len() != 7 || !t.accent.starts_with('#') || !t.accent[1..].bytes().all(|b| b.is_ascii_hexdigit())
        || !valid_timing(&g.scorecard_timing, g.scorecard_seconds, g.scorecard_start) {
        return Err("Invalid project graphics style or timing".into());
    }
    for c in &p.clips {
        if let Some(s) = &c.scorecard {
            let (at, seconds, start) = timing(&g, s);
            if !["line", "result", "table"].contains(&s.template.as_str())
                || !valid_timing(at, seconds, start) || !s.seconds.is_finite() || !(1.0..=30.0).contains(&s.seconds)
                || !s.start.is_finite() || !(0.0..=86400.0).contains(&s.start)
                || !bounded_text(&s.heading, 60) || !bounded_text(&s.result, 90) || !bounded_text(&s.subtitle, 120)
                || s.columns.is_empty() || s.columns.len() > 5 || s.rows.is_empty() || s.rows.len() > 8
                || s.columns.iter().any(|v| !bounded_text(v, 24))
                || s.rows.iter().any(|r| r.len() != s.columns.len() || r.iter().any(|v| !bounded_text(v, 24))) {
                return Err(format!("Invalid scorecard in {}: use 1–5 columns, 1–8 rows and bounded plain text", c.chapter));
            }
            if c.include && s.enabled && at == "custom" && start >= c.duration {
                return Err(format!("Scorecard start must be inside {}", c.chapter));
            }
        }
    }
    Ok(())
}
pub(super) fn title_style_key(p: &Project, c: &Clip) -> String {
    let g = settings(p); let t = g.theme;
    if c.title.trim().is_empty() || c.title_seconds <= 0. { return String::new(); }
    let heading = c.title_heading.trim(); let subtitle = c.title_subtitle.trim();
    if !heading.is_empty() || !subtitle.is_empty() {
        return json!([2, if g.styled_titles { json!([t.font,t.palette,t.accent.to_uppercase(),t.position,t.opacity]) } else { Value::Null }, heading, subtitle]).to_string();
    }
    if !g.styled_titles { return String::new(); }
    json!([1,t.font,t.palette,t.accent.to_uppercase(),t.position,t.opacity]).to_string()
}
pub(super) fn recipe(p: &Project) -> Option<Value> {
    let g = settings(p); let t = &g.theme;
    let cards: Vec<_> = p.clips.iter().filter(|c| c.include).filter_map(|c| c.scorecard.as_ref().filter(|s| s.enabled).map(|s| {
        let (at, seconds, start) = timing(&g, s);
        json!([c.id,s.template,s.heading,s.result,s.subtitle,
          if s.template == "table" { json!(s.columns) } else { json!([]) },
          if s.template == "table" { json!(s.rows) } else { json!([]) },at,seconds,start])
    })).collect();
    let titles = g.styled_titles && (p.clips.iter().any(|c| c.include && !c.title.trim().is_empty())
        || (p.opening_title_mode != "none" && (!p.title.trim().is_empty() || !p.subtitle.trim().is_empty())));
    let opening_heading = if p.opening_title_mode != "none" && !p.title.trim().is_empty() && p.title_seconds > 0. { p.title_heading.trim() } else { "" };
    let title_lines: Vec<_> = p.clips.iter().filter(|c| c.include && !c.title.trim().is_empty() && c.title_seconds > 0.)
        .filter(|c| !c.title_heading.trim().is_empty() || !c.title_subtitle.trim().is_empty())
        .map(|c| json!([c.id,c.title_heading.trim(),c.title_subtitle.trim()])).collect();
    if cards.is_empty() && !titles && opening_heading.is_empty() && title_lines.is_empty() { None } else {
        let mut value = json!([1,[t.font,t.palette,t.accent.to_uppercase(),t.position,t.opacity],g.styled_titles,cards]);
        if !opening_heading.is_empty() || !title_lines.is_empty() {
            value[0] = json!(2); value.as_array_mut().unwrap().push(json!([opening_heading,title_lines]));
        }
        Some(value)
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Window { pub start: u64, pub end: u64, pub extra_frames: u64 }
pub(super) fn window(p: &Project, c: &Clip, main: u64, total: u64) -> Result<Option<Window>, String> {
    let Some(s) = c.scorecard.as_ref().filter(|s| s.enabled) else { return Ok(None) };
    let g = settings(p); let (at, seconds, start) = timing(&g, s);
    let frames = (seconds * f64::from(p.fps)).round() as u64;
    if at == "separateCard" { return Ok(Some(Window { start: total, end: total.checked_add(frames).ok_or("Scorecard timeline overflow")?, extra_frames: frames })); }
    let limit = if at == "afterReplays" { total } else { main };
    let start = match at { "clipStart" => 0, "custom" => (start * f64::from(p.fps)).round() as u64, _ => limit.saturating_sub(frames) };
    if start >= limit { return Err(format!("Scorecard starts beyond measured footage in {}", c.chapter)); }
    Ok(Some(Window { start, end: start.saturating_add(frames).min(limit), extra_frames: 0 }))
}
pub(super) fn extra_seconds(p: &Project, c: &Clip) -> f64 {
    let g = settings(p);
    c.scorecard.as_ref().filter(|s| s.enabled).map(|s| {
        let (at, seconds, _) = timing(&g, s); if at == "separateCard" { (seconds * p.fps as f64).round() / p.fps as f64 } else { 0. }
    }).unwrap_or(0.)
}

fn fonts(work: &Path, theme: &Theme) -> Result<(), String> {
    let (regular, bold) = match theme.font.as_str() {
        "georgia" => ("georgia.ttf", "georgiab.ttf"), "trebuchet" => ("trebuc.ttf", "trebucbd.ttf"),
        "segoe" => ("segoeui.ttf", "segoeuib.ttf"), _ => return Err("Unsupported graphics font".into()),
    };
    for (source, destination) in [(regular, "graphics-regular.ttf"), (bold, "graphics-bold.ttf")] {
        fs::copy(Path::new("C:/Windows/Fonts").join(source), work.join(destination))
            .map_err(|_| format!("The selected graphics font is not installed: {source}"))?;
    }
    Ok(())
}

struct Drawing<'a> { work: &'a Path, prefix: &'a str, filters: Vec<String>, scale: f64, offset_x: f64, enable: String, index: usize }
impl Drawing<'_> {
    fn rect(&mut self, x: f64, y: f64, w: f64, h: f64, colour: &str) {
        let s = self.scale;
        // drawbox truncates subpixel dimensions; zero means the full input
        // extent, not an invisible line. Never emit a dimension below one pixel.
        self.filters.push(format!("drawbox=x={:.2}:y={:.2}:w={:.2}:h={:.2}:color={colour}:t=fill{}", x*s+self.offset_x,y*s,(w*s).max(1.),(h*s).max(1.),self.enable));
    }
    fn text(&mut self, text: &str, x: f64, y: f64, size: f64, colour: &str, bold: bool) -> Result<(), String> {
        if text.is_empty() { return Ok(()); }
        let filename = format!("{}-{}.txt", self.prefix, self.index); self.index += 1;
        text_asset(self.work, &filename, text)?;
        let font = if bold { "graphics-bold.ttf" } else { "graphics-regular.ttf" };
        self.filters.push(format!("drawtext=fontfile={font}:textfile={filename}:expansion=none:fontsize={:.2}:fontcolor={colour}:x={:.2}:y={:.2}:line_spacing={:.2}{}",
            size*self.scale, x*self.scale+self.offset_x,y*self.scale,6.*self.scale,self.enable));
        Ok(())
    }
}
fn wrap(text: &str, columns: usize) -> String {
    // Conservative per-em widths keep even wide characters inside their cell;
    // preserve every character, including long names without spaces.
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    wrap_title(&clean, columns)
}
pub(super) fn filter(p: &Project, work: &Path, card: &Scorecard, prefix: &str, frames: Option<(u64,u64)>) -> Result<String,String> {
    filter_with_title_spacing(p, work, card, prefix, frames, false)
}
fn filter_with_title_spacing(p: &Project, work: &Path, card: &Scorecard, prefix: &str, frames: Option<(u64,u64)>, optional_title_lines: bool) -> Result<String,String> {
    let g = settings(p); fonts(work, &g.theme)?;
    let (panel, ink, muted, stripe) = match g.theme.palette.as_str() {
        "ivory" => ("0xF5F1E8","0x142033","0x46515F","0x142033@0.07"),
        "slate" => ("0x253648","0xF8FAFC","0xCBD5E1","white@0.05"),
        _ => ("0x101827","0xF8FAFC","0xBBC6D6","white@0.05"),
    };
    let accent = format!("0x{}", &g.theme.accent[1..]);
    let enable = frames.map(|(a,b)| format!(":enable='gte(n,{a})*lt(n,{b})'" )).unwrap_or_default();
    let mut d = Drawing { work, prefix, filters: vec![], scale: p.width as f64 / 1920., offset_x: 0., enable, index: 0 };
    let heading = wrap(&card.heading, 60);
    let result = wrap(&card.result, if card.template == "result" { if optional_title_lines { 30 } else { 32 } } else { 46 });
    let subtitle = wrap(&card.subtitle, 64);
    let mut top = if heading.is_empty() { 32. } else { 72. };
    let table_result = if card.template == "table" && !result.is_empty() { result.lines().count() as f64 * 40. + 16. } else { 0. };
    top += table_result;
    let column_width = 1656. / card.columns.len().max(1) as f64;
    let cell_columns = ((column_width-24.)/22.).floor() as usize;
    let header_columns = ((column_width-24.)/20.).floor() as usize;
    let row_heights: Vec<f64> = card.rows.iter().map(|r| r.iter().map(|v| wrap(v,cell_columns).lines().count()).max().unwrap_or(1) as f64*28.+16.).map(|h|h.max(72.)).collect();
    let header_height = (card.columns.iter().map(|v|wrap(v,header_columns).lines().count()).max().unwrap_or(1) as f64*26.+18.).max(66.);
    // The new v2 optional-title layout reserves font line advance as well as
    // glyph height. Keep historical v1 title and scorecard geometry unchanged.
    let result_lines = result.lines().count().max(1);
    let body = if card.template == "table" { header_height + row_heights.iter().sum::<f64>() }
        else { result_lines as f64 * if card.template == "line" { 42. } else if optional_title_lines && result_lines > 1 { 80. } else { 58. } };
    let foot = if subtitle.is_empty() { 28. } else { subtitle.lines().count() as f64 * 30. + 36. };
    let height = top + body + foot;
    // Dense tables shrink as a whole only when needed; no rows or characters
    // are dropped, and every cell remains inside its measured line box.
    let fit = (952./height).min(1.);
    d.offset_x = (1920.-1920.*fit)/2.*d.scale;
    d.scale *= fit;
    let y = if g.theme.position == "top" { 64./fit } else { (1080.-64.)/fit-height };
    d.rect(96., y+8., 1728., height, "black@0.16");
    d.rect(96., y, 1728., height, &format!("{panel}@{:.2}", g.theme.opacity as f64/100.));
    d.rect(96., y, 6., height, &accent);
    d.text(&heading, 132., y+26., 24., &accent, true)?;
    if card.template == "table" {
        d.text(&result, 132., y+top-table_result, 32., ink, true)?;
        for (col, label) in card.columns.iter().enumerate() {
            d.text(&wrap(label, header_columns), 132.+col as f64*column_width, y+top, 20., muted, true)?;
        }
        d.rect(132., y+top+header_height-12., 1656., 1., &format!("{accent}@0.55"));
        let mut ry = y+top+header_height;
        for (row, cells) in card.rows.iter().enumerate() {
            if row % 2 == 0 { d.rect(120., ry-8., 1680., row_heights[row]-2., stripe); }
            for (col, value) in cells.iter().enumerate() {
                d.text(&wrap(value, cell_columns), 132.+col as f64*column_width, ry,
                    22., if col == 0 { &accent } else { ink }, col == 0)?;
            }
            ry += row_heights[row];
        }
    } else {
        d.text(&result, 132., y+top, if card.template == "line" { 34. } else { 48. }, ink, true)?;
    }
    d.text(&subtitle, 132., y+top+body+12., 24., muted, false)?;
    Ok(d.filters.join(","))
}
// Preview and every export path share content, literal text handling and layout.
// None selects the project opening title; Some selects a clip's three lines.
pub(super) fn title_filter(p: &Project, work: &Path, clip: Option<&Clip>, prefix: &str, frames: Option<(u64,u64)>) -> Result<String,String> {
    let (title, heading, subtitle) = clip.map(|c| (c.title.as_str(), c.title_heading.trim(), c.title_subtitle.trim()))
        .unwrap_or((&p.title, p.title_heading.trim(), &p.subtitle));
    if settings(p).styled_titles {
        return filter_with_title_spacing(p, work, &Scorecard { enabled: true, template: "result".into(), heading: heading.into(), result: title.into(),
            subtitle: subtitle.into(), columns: vec![], rows: vec![], timing: "clipStart".into(),seconds: 6.,start: 0. }, prefix, frames,
            !heading.is_empty() || (clip.is_some() && !subtitle.is_empty()));
    }
    if !work.join("font.ttf").exists() { fs::copy("C:/Windows/Fonts/arial.ttf", work.join("font.ttf")).map_err(|e| e.to_string())?; }
    let opening = clip.is_none();
    let main = wrap_title(title, if opening { 28 } else { 44 });
    let sub = wrap_title(subtitle, 44); let upper = wrap_title(heading, 60);
    let main_file = format!("{prefix}-main.txt"); let sub_file = format!("{prefix}-subtitle.txt");
    text_asset(work, &main_file, &main)?; text_asset(work, &sub_file, &sub)?;
    let duration = frames.map(|(_,end)| end as f64 / p.fps as f64);
    // Blank new fields retain the historical legacy drawing geometry exactly.
    if heading.is_empty() && (opening || subtitle.is_empty()) {
        return Ok(if opening { format!("{},{}", drawtext(&main_file,p.width/32,"h*0.5-text_h-30",duration),drawtext(&sub_file,p.width/48,"h*0.5+30",duration)) }
            else { drawtext(&main_file,p.width/48,"h-text_h-40",duration) });
    }
    let heading_file = format!("{prefix}-heading.txt"); text_asset(work, &heading_file, &upper)?;
    let gap = p.width as f64 / 80.;
    let lines = [(&upper, &heading_file, p.width/64), (&main, &main_file, if opening {p.width/32} else {p.width/48}), (&sub, &sub_file, p.width/48)];
    let visible: Vec<_> = lines.iter().filter(|(text,_,_)| !text.is_empty()).collect();
    let height = visible.iter().map(|(text,_,size)| text.lines().count() as f64 * *size as f64 * 1.3).sum::<f64>() + gap * visible.len().saturating_sub(1) as f64;
    let mut y = if opening { (p.height as f64-height)/2. } else { p.height as f64-height-40. };
    let mut filters = vec![];
    for (text,file,size) in visible {
        filters.push(drawtext(file,*size,&format!("{y:.2}"),duration));
        y += text.lines().count() as f64 * *size as f64 * 1.3 + gap;
    }
    Ok(filters.join(","))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn composite(ff: &Path, p: &Project, c: &Clip, encoder_name: &str, input: &Path, work: &Path,
    id: &str, index: usize, frames: u64, window: Window) -> Result<PathBuf,String> {
    let card = c.scorecard.as_ref().ok_or("Missing scorecard")?;
    let prefix = format!("score-{index}");
    let standalone = window.extra_frames > 0;
    let filter = filter(p, work, card, &prefix, if standalone { None } else { Some((window.start,window.end)) })?;
    let output = work.join(format!("{prefix}.mp4"));
    let count = if standalone { window.extra_frames } else { frames };
    let seconds = count as f64 / p.fps as f64;
    let mut args: Vec<String> = if standalone {
        vec!["-f".into(),"lavfi".into(),"-i".into(),format!("color=c=0x0B1322:s={}x{}:r={}",p.width,p.height,p.fps),
             "-f".into(),"lavfi".into(),"-i".into(),"anullsrc=r=48000:cl=stereo".into(),"-t".into(),seconds.to_string()]
    } else { vec!["-i".into(),input.to_string_lossy().into_owned()] };
    args.extend(["-map".into(),"0:v:0".into(),"-map".into(),if standalone { "1:a:0".into() } else { "0:a:0".into() },
        "-map_chapters".into(),"-1".into(),"-vf".into(),filter]);
    args.extend(encoder(p, encoder_name));
    if !standalone { args.extend(["-c:a".into(),"copy".into()]); }
    args.extend(["-frames:v".into(),count.to_string(),output.to_string_lossy().into_owned()]);
    run(ff,p,args,work,id,&format!("Finishing scorecard: {} (stabilised footage retained)",c.chapter),seconds,85.,2.)?;
    let info = inspect(ff, &output)?;
    verify_output(&info,p,seconds)?;
    if delivery::frame_count(&info)? != count { return Err("Scorecard composition changed the planned frame count".into()); }
    Ok(output)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsPreview { data_url: String, background: String, at_seconds: f64 }
static PREVIEW: Mutex<()> = Mutex::new(());

#[tauri::command]
pub async fn studio_graphics_preview(staging_dir: String, project: Project, clip_id: Option<String>, target: String) -> Result<GraphicsPreview,String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = PREVIEW.try_lock().map_err(|_| "Another graphics preview is still being prepared")?;
        super::validate(&project)?;
        if !["scorecard","clipTitle","opening"].contains(&target.as_str()) { return Err("Unknown graphics preview target".into()); }
        let p = &project;
        let c = if target == "opening" { p.clips.iter().find(|c| c.include) }
            else { p.clips.iter().find(|c| Some(&c.id) == clip_id.as_ref()) };
        let standalone = if target == "opening" {
            if p.opening_title_mode == "none" || p.title.trim().is_empty() || p.title_seconds <= 0. { return Err("The opening title is hidden".into()); }
            p.opening_title_mode == "card"
        } else {
            let c = c.ok_or("Choose a clip for this preview")?;
            if target == "scorecard" {
                let s = c.scorecard.as_ref().filter(|s| s.enabled).ok_or("Enable this scorecard first")?;
                timing(&settings(p), s).0 == "separateCard"
            } else {
                if c.title.trim().is_empty() || c.title_seconds <= 0. { return Err("The clip title is hidden".into()); }
                false
            }
        };
        let ff = detect_ffmpeg_capabilities()?.binary;
        let work = std::env::temp_dir().join(format!("photogogo-graphics-{}-{}",std::process::id(),chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()));
        fs::create_dir(&work).map_err(|e|e.to_string())?;
        struct Cleanup(PathBuf);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let _cleanup = Cleanup(work.clone());
        let mut at_seconds = 0.;
        let mut background = "Standalone card".to_string();
        let mut args: Vec<String> = ["-v","error","-nostdin","-threads","1","-filter_threads","1"].map(String::from).into();
        if standalone {
            args.extend(["-f".into(),"lavfi".into(),"-i".into(),format!("color=c=0x0B1322:s={}x{}:r={}",p.width,p.height,p.fps)]);
        } else {
            let c = c.ok_or("Add a clip to preview the opening overlay")?;
            let mut path = source(Path::new(&staging_dir), &c.path)?;
            let mut main = (duration(&inspect(&ff, &path)?)? * p.fps as f64).round() as u64;
            let mut total = main;
            background = "Original footage illustration — not yet stabilised".into();
            // Never render or stabilise footage for this action. Only verified
            // existing scorecard backgrounds may replace the source illustration.
            if target == "scorecard" {
                if let Some(r) = &c.rendered {
                    if recovery::verify_clip(&ff,p,c,r,&staging_dir).is_ok() {
                        path = PathBuf::from(&r.path); let info = inspect(&ff,&path)?;
                        total = delivery::frame_count(&info)?;
                        main = delivery::clip_chapters(&info,c,p.fps,total)?[0].1;
                        background = "Verified stabilised clip".into();
                    }
                }
                if let Some(w) = window(p,c,main,total)? { at_seconds = ((w.start + w.end - 1) / 2) as f64 / p.fps as f64; }
            } else {
                let seconds = if target == "opening" { p.title_seconds } else { c.title_seconds };
                let visible_frames = ((seconds * p.fps as f64).ceil() as u64).min(main);
                let frame = ((0.5 * p.fps as f64).floor() as u64).min(visible_frames.saturating_sub(1));
                at_seconds = frame as f64 / p.fps as f64;
            }
            args.extend(["-ss".into(),at_seconds.to_string(),"-i".into(),path.to_string_lossy().into_owned()]);
        }
        let graphic = if target == "scorecard" {
            filter(p,&work,c.and_then(|c| c.scorecard.as_ref()).ok_or("Missing scorecard")?,"preview",None)?
        } else {
            title_filter(p, &work, if target == "opening" { None } else { Some(c.ok_or("Missing clip")?) }, "preview", None)?
        };
        let filters = format!("scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2,setsar=1,{graphic}",p.width,p.height,p.width,p.height);
        args.extend(["-vf".into(),filters,"-frames:v".into(),"1".into(),"-an".into(),"-c:v".into(),"png".into(),"-threads".into(),"1".into(),"-f".into(),"image2pipe".into(),"pipe:1".into()]);
        let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
        let out = super::super::process::command_output_limited_in(&ff,&refs,23_000_000,Duration::from_secs(30),Some(&work))?;
        if !out.status.success() || !out.stdout.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(format!("Graphics preview failed: {}",String::from_utf8_lossy(&out.stderr)));
        }
        Ok(GraphicsPreview { data_url: format!("data:image/png;base64,{}",crate::utils::base64_encode(&out.stdout)),background,at_seconds })
    }).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png_bytes(data: &str) -> Vec<u8> {
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut bits = 0u32; let mut count = 0u32; let mut out = vec![];
        for byte in data.split(',').nth(1).unwrap().bytes().take_while(|b| *b != b'=') {
            bits = (bits << 6) | alphabet.iter().position(|b| *b == byte).unwrap() as u32;
            count += 6;
            if count >= 8 { count -= 8; out.push((bits >> count) as u8); }
        }
        out
    }
    #[tokio::test]
    #[ignore = "bounded native heading preview"]
    async fn studio_optional_heading_preview() {
        let p = super::super::tests::project(Path::new("."));
        let root = std::env::var_os("PHOTOGOGO_STUDIO_TEST_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
            .join(format!("heading-preview-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.mp4"); let ff = detect_ffmpeg_capabilities().unwrap().binary;
        let generated = command(&ff).args(["-v","error","-f","lavfi","-i","color=c=0x0B1322:s=320x180:r=25","-t","2","-c:v","libx264"]).arg(&source).output().unwrap();
        assert!(generated.status.success());
        for target in ["opening", "clipTitle"] {
            let mut hidden = p.clone(); hidden.title = "   ".into(); hidden.title_heading = "Must stay hidden".into();
            hidden.clips[0].title = "   ".into(); hidden.clips[0].title_heading = "Must stay hidden".into();
            let error = studio_graphics_preview(".".into(), hidden, Some("one".into()), target.into()).await.err().unwrap();
            assert!(error.contains("title is hidden"), "Whitespace main text should hide {target}: {error}");
        }
        for styled in [false, true] {
            let mut value = serde_json::to_value(&p).unwrap();
            value["graphics"] = serde_json::to_value(Settings { styled_titles: styled, ..Settings::default() }).unwrap();
            let original: Project = serde_json::from_value(value.clone()).unwrap();
            let blank = studio_graphics_preview(".".into(), original, None, "opening".into()).await.unwrap();
            value["titleHeading"] = json!("SYDNEY: rider's 100% %{literal} \\ final");
            let edited: Project = serde_json::from_value(value).unwrap();
            let heading = studio_graphics_preview(".".into(), edited, None, "opening".into()).await.unwrap();
            assert!(blank.data_url != heading.data_url, "custom heading must change native pixels, styled={styled}");
            if let Ok(folder) = std::env::var("PHOTOGOGO_GRAPHICS_PREVIEW_DIR") {
                fs::write(Path::new(&folder).join(format!("heading-styled-{styled}.png")), png_bytes(&heading.data_url)).unwrap();
            }
            let mut clip_project = p.clone(); clip_project.graphics = Some(Settings { styled_titles: styled, ..Settings::default() });
            clip_project.clips[0].path = source.to_string_lossy().into_owned();
            let original_clip = studio_graphics_preview(root.to_string_lossy().into_owned(), clip_project.clone(), Some("one".into()), "clipTitle".into()).await.unwrap();
            clip_project.clips[0].title_heading = "CHAMPIONSHIP ROUND ONE".into();
            clip_project.clips[0].title_subtitle = "72 points · First place".into();
            let edited_clip = studio_graphics_preview(root.to_string_lossy().into_owned(), clip_project.clone(), Some("one".into()), "clipTitle".into()).await.unwrap();
            assert!(original_clip.data_url != edited_clip.data_url);
            if let Ok(folder) = std::env::var("PHOTOGOGO_GRAPHICS_PREVIEW_DIR") {
                fs::write(Path::new(&folder).join(format!("clip-heading-styled-{styled}.png")), png_bytes(&edited_clip.data_url)).unwrap();
                clip_project.clips[0].title = "W".repeat(100); clip_project.clips[0].title_heading = "W".repeat(60); clip_project.clips[0].title_subtitle = "W".repeat(110);
                let wrapped = studio_graphics_preview(root.to_string_lossy().into_owned(), clip_project.clone(), Some("one".into()), "clipTitle".into()).await.unwrap();
                fs::write(Path::new(&folder).join(format!("clip-wrapped-styled-{styled}.png")), png_bytes(&wrapped.data_url)).unwrap();
                if styled {
                    for font in ["segoe","georgia","trebuchet"] {
                        clip_project.graphics.as_mut().unwrap().theme.font = font.into();
                        let frame = studio_graphics_preview(root.to_string_lossy().into_owned(), clip_project.clone(), Some("one".into()), "clipTitle".into()).await.unwrap();
                        let pixels = image::load_from_memory(&png_bytes(&frame.data_url)).unwrap().to_rgb8();
                        let main_bottom = pixels.enumerate_pixels().filter(|(_,_,p)|p[0]>235 && p[1]>235 && p[2]>235).map(|(_,y,_)|y).max().unwrap();
                        let main_right = pixels.enumerate_pixels().filter(|(_,_,p)|p[0]>235 && p[1]>235 && p[2]>235).map(|(x,_,_)|x).max().unwrap();
                        let subtitle_top = pixels.enumerate_pixels().filter(|(_,_,p)| (170..=205).contains(&p[0]) && (180..=215).contains(&p[1]) && (195..=235).contains(&p[2]) && p[2]>p[1]+8 && p[1]>p[0]+6).map(|(_,y,_)|y).min().unwrap();
                        assert!(subtitle_top > main_bottom + 3,"{font} subtitle overlaps wrapped title: {main_bottom} / {subtitle_top}");
                        assert!(main_right < pixels.width()*94/100,"{font} title escapes panel safe area");
                        fs::write(Path::new(&folder).join(format!("clip-wrapped-{font}.png")), png_bytes(&frame.data_url)).unwrap();
                    }
                }
            }
        }
    }
    #[test]
    fn studio_optional_title_saved_project_contract() {
        let root = std::env::temp_dir().join(format!("studio-title-fields-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir_all(&root).unwrap();
        let p = super::super::tests::project(&root);
        let mut legacy = serde_json::to_value(&p).unwrap();
        legacy.as_object_mut().unwrap().remove("titleHeading");
        legacy["clips"][0].as_object_mut().unwrap().remove("titleHeading");
        legacy["clips"][0].as_object_mut().unwrap().remove("titleSubtitle");
        let path = root.join("legacy.json"); fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let loaded = studio_load_project(path.to_string_lossy().into_owned()).unwrap();
        assert!(loaded.title_heading.is_empty() && loaded.clips[0].title_heading.is_empty() && loaded.clips[0].title_subtitle.is_empty());
        let mut edited = loaded; edited.title_heading = "Event".into();
        edited.clips[0].title_heading = "Round one".into(); edited.clips[0].title_subtitle = "72 points".into();
        let saved = root.join("edited.json"); studio_save_project(saved.to_string_lossy().into_owned(), edited.clone()).unwrap();
        let roundtrip = studio_load_project(saved.to_string_lossy().into_owned()).unwrap();
        assert_eq!(roundtrip.title_heading,"Event"); assert_eq!(roundtrip.clips[0].title_heading,"Round one"); assert_eq!(roundtrip.clips[0].title_subtitle,"72 points");
        for (index, field, bad) in [(0,"titleHeading","x".repeat(61)),(1,"titleHeading","bad\nline".into()),(2,"titleSubtitle","x".repeat(111))] {
            let mut invalid = serde_json::to_value(&edited).unwrap(); invalid["clips"][0][field] = json!(bad);
            let rejected = root.join(format!("invalid-{index}.json"));
            assert!(studio_save_project(rejected.to_string_lossy().into_owned(), serde_json::from_value(invalid).unwrap()).is_err());
            assert!(!rejected.exists(),"invalid text must not create a saved project");
        }
    }
    #[tokio::test]
    #[ignore = "bounded native one-frame compositor preview"]
    async fn studio_graphics_preview_uses_native_compositor() {
        let mut p = super::super::tests::project(Path::new("."));
        p.graphics = Some(Settings { styled_titles: true, ..Settings::default() });
        p.title = "SUMMER CHAMPIONSHIP".into(); p.subtitle = "Precision. Partnership. Performance.".into();
        let preview = studio_graphics_preview(".".into(), p.clone(), None, "opening".into()).await.unwrap();
        assert!(preview.data_url.starts_with("data:image/png;base64,iVBOR"));
        assert_eq!(preview.background, "Standalone card");
        assert_eq!(preview.at_seconds, 0.);
        if let Ok(folder) = std::env::var("PHOTOGOGO_GRAPHICS_PREVIEW_DIR") {
            fs::write(Path::new(&folder).join("opening.json"),serde_json::to_vec(&preview).unwrap()).unwrap();
        }
        p.clips[0].scorecard = Some(Scorecard { enabled: true, template: "table".into(), heading: "FINAL CLASSIFICATION".into(),
            result: "SUMMER CHAMPIONSHIP · RESULTS".into(), subtitle: "Official scores · Thank you to all riders and volunteers".into(),
            columns: vec!["Place".into(),"Rider".into(),"Horse".into(),"Penalty".into(),"Points".into()],
            rows: (1..=8).map(|i|vec![i.to_string(),"Alexandra W. Wellington".into(),"WWWWWWWWWWWWWWWWWWWWWWWW".into(),"A AAAAAAAAAAAAAAAAA BBBB".into(),"72.500".into()]).collect(),
            timing: "separateCard".into(),seconds: 6.,start: 0. });
        for font in ["segoe","georgia","trebuchet"] {
            p.graphics.as_mut().unwrap().theme.font = font.into();
            let table = studio_graphics_preview(".".into(),p.clone(),Some("one".into()),"scorecard".into()).await.unwrap();
            assert!(table.data_url.starts_with("data:image/png;base64,iVBOR"));
            let frame = image::load_from_memory(&png_bytes(&table.data_url)).unwrap().to_rgb8();
            let safe_area = frame.get_pixel(frame.width()/2,frame.height()-1).0;
            assert!(safe_area[0] < 40 && safe_area[1] < 45 && safe_area[2] < 60,
                "Table divider leaked beyond the panel into the bottom safe area: {safe_area:?}");
            if let Ok(folder) = std::env::var("PHOTOGOGO_GRAPHICS_PREVIEW_DIR") {
                fs::write(Path::new(&folder).join(format!("table-{font}.json")),serde_json::to_vec(&table).unwrap()).unwrap();
            }
        }
        let source_root = std::env::var_os("PHOTOGOGO_STUDIO_TEST_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
            .join(format!("short-title-preview-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir_all(&source_root).unwrap();
        let ff = detect_ffmpeg_capabilities().unwrap().binary;
        let source_path = source_root.join("short.mp4");
        let generated = command(&ff).args(["-v","error","-f","lavfi","-i","color=c=blue:s=320x180:r=25","-t","1","-c:v","libx264"])
            .arg(&source_path).output().unwrap();
        assert!(generated.status.success());
        p.clips[0].path = source_path.to_string_lossy().into_owned();
        p.clips[0].title_seconds = 0.1; p.title_seconds = 0.1; p.opening_title_mode = "overlay".into();
        for target in ["clipTitle","opening"] {
            let short = studio_graphics_preview(source_root.to_string_lossy().into_owned(),p.clone(),Some("one".into()),target.into()).await.unwrap();
            assert!(short.at_seconds < 0.1,"Preview shows an expired {target} at {} seconds",short.at_seconds);
            assert!((short.at_seconds * p.fps as f64).fract().abs() < 0.00001,"Preview time is not frame-aligned");
        }
        p.graphics.as_mut().unwrap().theme.accent = "#ff0000,drawtext=secret".into();
        assert!(studio_graphics_preview(".".into(), p, None, "opening".into()).await.is_err());
    }
}
