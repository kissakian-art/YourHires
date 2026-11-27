use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

// Holds the bundled Node backend process so we can terminate it on app exit.
struct Sidecar(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(Sidecar(Mutex::new(None)))
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Only the packaged (release) app launches the bundled server + embedded DB.
      // In `tauri dev` the developer runs the server separately (npm run dev).
      #[cfg(not(debug_assertions))]
      {
        if let Err(e) = spawn_backend(&app.handle()) {
          eprintln!("[YourHires] failed to start bundled server: {e}");
        }
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while running tauri application")
    .run(|app_handle, event| {
      // Ensure the bundled server (and its embedded MariaDB) is stopped with the app.
      if let tauri::RunEvent::Exit = event {
        if let Some(state) = app_handle.try_state::<Sidecar>() {
          if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.as_mut() {
              let _ = child.kill();
            }
          }
        }
      }
    });
}

// Spawn the bundled Node server (desktop entry) with the embedded-DB env, pointing
// data/backups at a writable per-user location. Resources are shipped under
// <resource_dir>/payload by tauri.conf.json `bundle.resources`.
// Tauri's resource_dir() on Windows returns an extended-length "\\?\" verbatim
// path, which Node's module resolver and many tools mishandle. Strip it so the
// paths we hand to node.exe / mysqld are plain (e.g. D:\...).
#[cfg(not(debug_assertions))]
fn strip_verbatim(p: std::path::PathBuf) -> std::path::PathBuf {
  let s = p.to_string_lossy();
  match s.strip_prefix(r"\\?\") {
    Some(rest) => std::path::PathBuf::from(rest.to_string()),
    None => p,
  }
}

#[cfg(not(debug_assertions))]
fn spawn_backend(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
  let resource = strip_verbatim(app.path().resource_dir()?);
  let payload = resource.join("payload");
  let node = payload.join("node").join("node.exe");
  let entry = payload.join("server").join("dist").join("desktop.js");
  let server_dir = payload.join("server");
  let mariadb = payload.join("mariadb");

  let appdata = strip_verbatim(app.path().app_data_dir()?);
  std::fs::create_dir_all(&appdata).ok();

  let mut cmd = Command::new(&node);
  cmd
    .arg(&entry)
    .current_dir(&server_dir)
    .env("EMBEDDED_DB", "true")
    .env("MARIADB_HOME", &mariadb)
    .env("YH_DATA_DIR", &appdata)
    .env("DB_DATA_DIR", appdata.join("data"))
    .env("DB_PORT", "3307")
    .env("PORT", "20090");

  // Don't flash a console window for the background Node process.
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }

  let child = cmd.spawn()?;
  if let Some(state) = app.try_state::<Sidecar>() {
    *state.0.lock().unwrap() = Some(child);
  }
  Ok(())
}
