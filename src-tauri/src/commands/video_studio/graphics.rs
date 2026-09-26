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
    if !g.styled_titles || c.title.trim().is_empty() || c.title_seconds <= 0. { return String::new(); }
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
    if cards.is_empty() && !titles { None } else {
        Some(json!([1,[t.font,t.palette,t.accent.to_uppercase(),t.position,t.opacity],g.styled_titles,cards]))
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
    let result = wrap(&card.result, if card.template == "result" { 32 } else { 46 });
    let subtitle = wrap(&card.subtitle, 64);
    let mut top = if heading.is_empty() { 32. } else { 72. };
    let table_result = if card.template == "table" && !result.is_empty() { result.lines().count() as f64 * 40. + 16. } else { 0. };
    top += table_result;
    let column_width = 1656. / card.columns.len().max(1) as f64;
    let cell_columns = ((column_width-24.)/22.).floor() as usize;
    let header_columns = ((column_width-24.)/20.).floor() as usize;
    let row_heights: Vec<f64> = card.rows.iter().map(|r| r.iter().map(|v| wrap(v,cell_columns).lines().count()).max().unwrap_or(1) as f64*28.+16.).map(|h|h.max(72.)).collect();
    let header_height = (card.columns.iter().map(|v|wrap(v,header_columns).lines().count()).max().unwrap_or(1) as f64*26.+18.).max(66.);
    let body = if card.template == "table" { header_height + row_heights.iter().sum::<f64>() }
        else { result.lines().count().max(1) as f64 * if card.template == "line" { 42. } else { 58. } };
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
pub(super) fn title_filter(p: &Project, work: &Path, title: &str, subtitle: &str, prefix: &str, frames: Option<(u64,u64)>) -> Result<String,String> {
    filter(p, work, &Scorecard { enabled: true, template: "result".into(), heading: String::new(), result: title.into(),
        subtitle: subtitle.into(), columns: vec![], rows: vec![], timing: "clipStart".into(),seconds: 6.,start: 0. }, prefix, frames)
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
            if p.opening_title_mode == "none" || p.title.is_empty() || p.title_seconds <= 0. { return Err("The opening title is hidden".into()); }
            p.opening_title_mode == "card"
        } else {
            let c = c.ok_or("Choose a clip for this preview")?;
            if target == "scorecard" {
                let s = c.scorecard.as_ref().filter(|s| s.enabled).ok_or("Enable this scorecard first")?;
                timing(&settings(p), s).0 == "separateCard"
            } else {
                if c.title.is_empty() || c.title_seconds <= 0. { return Err("The clip title is hidden".into()); }
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
            let (title, subtitle) = if target == "opening" { (p.title.as_str(), p.subtitle.as_str()) }
                else { (c.ok_or("Missing clip")?.title.as_str(), "") };
            if settings(p).styled_titles { title_filter(p,&work,title,subtitle,"preview",None)? }
            else {
                fs::copy("C:/Windows/Fonts/arial.ttf",work.join("font.ttf")).map_err(|e|e.to_string())?;
                text_asset(&work,"preview-title.txt",&wrap_title(title,if target == "opening" { 28 } else { 44 }))?;
                if target == "opening" {
                    text_asset(&work,"preview-subtitle.txt",&wrap_title(subtitle,44))?;
                    format!("{},{}",drawtext("preview-title.txt",p.width/32,"h*0.5-text_h-30",None),drawtext("preview-subtitle.txt",p.width/48,"h*0.5+30",None))
                } else { drawtext("preview-title.txt",p.width/48,"h-text_h-40",None) }
            }
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
