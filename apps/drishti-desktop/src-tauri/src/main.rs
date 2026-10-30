// Hide the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use tauri::{Manager, WebviewBuilder, WebviewUrl};

/// What the web app is told after a browser panel's view is opened.
#[derive(serde::Serialize)]
struct BrowserInfo {
    /// the folder unpacked browser extensions are loaded from (Windows only; elsewhere extensions are not supported by the webview)
    extensions_dir: String,
    /// how many folders in it hold a manifest.json
    extensions: usize,
}

/// Opens a browser panel's view: a second webview over the panel, with its own profile folder (cookies, logins) and, on Windows, the unpacked browser
/// extensions found in `<app data>/extensions` (WebView2 needs extension support switched on when the view is created, which only Rust can do). The label
/// must be a browser panel's and the address http or https. Moving, resizing, showing, hiding and closing are done from the web app.
#[tauri::command]
async fn browser_open(app: tauri::AppHandle, window: tauri::Window, label: String, url: String, x: f64, y: f64, width: f64, height: f64) -> Result<BrowserInfo, String> {
    if !label.starts_with("browser-") {
        return Err("not a browser panel".into());
    }
    let target: tauri::Url = url.parse().map_err(|_| "not a web address".to_string())?;
    if target.scheme() != "http" && target.scheme() != "https" {
        return Err("only http and https addresses can be opened".into());
    }
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let extensions_dir = data.join("extensions");
    fs::create_dir_all(&extensions_dir).map_err(|e| e.to_string())?;
    let extensions = fs::read_dir(&extensions_dir)
        .map(|d| d.filter_map(Result::ok).filter(|e| e.path().join("manifest.json").is_file()).count())
        .unwrap_or(0);
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target)).data_directory(data.join("browser-profile"));
    #[cfg(windows)]
    let builder = builder.browser_extensions_enabled(true).extensions_path(&extensions_dir);
    window
        .add_child(builder, tauri::LogicalPosition::new(x, y), tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    Ok(BrowserInfo { extensions_dir: extensions_dir.to_string_lossy().into_owned(), extensions })
}

/// Drives the page of a browser panel (the child webviews the web app creates with labels `browser-…`): back, forward, reload, or go to a web address.
/// Nothing else can be done with it: the label must be a browser panel's, the action one of four, the address http or https, and the scripts are fixed here.
#[tauri::command]
fn browser_action(app: tauri::AppHandle, label: String, action: String, url: Option<String>) -> Result<(), String> {
    if !label.starts_with("browser-") {
        return Err("not a browser panel".into());
    }
    let webview = app.get_webview(&label).ok_or("that browser panel is not open")?;
    match action.as_str() {
        "back" => webview.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => webview.eval("history.forward()").map_err(|e| e.to_string()),
        "reload" => webview.eval("location.reload()").map_err(|e| e.to_string()),
        "go" => {
            let target: tauri::Url = url.ok_or("no address")?.parse().map_err(|_| "not a web address".to_string())?;
            if target.scheme() != "http" && target.scheme() != "https" {
                return Err("only http and https addresses can be opened".into());
            }
            webview.navigate(target).map_err(|e| e.to_string())
        }
        _ => Err("unknown action".into()),
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![browser_open, browser_action])
        .run(tauri::generate_context!())
        .expect("error while running Divya Drishti");
}
