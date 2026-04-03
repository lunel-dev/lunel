mod protocol;
mod session;

use protocol::{Command, Event};
use session::TerminalSession;
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

fn emit(event: &Event) {
    let json = serde_json::to_string(event).unwrap();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "{}", json);
    let _ = out.flush();
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC")
            .unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

fn main() {
    if let Some(arg1) = std::env::args().nth(1) {
        if arg1 == "--version" || arg1 == "-V" {
            println!("{}", env!("CARGO_PKG_VERSION"));
            return;
        }
    }

    // Shared session map
    let sessions: Arc<Mutex<HashMap<String, TerminalSession>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Condvar to wake render thread immediately when data arrives
    let render_notify = Arc::new((Mutex::new(false), Condvar::new()));

    // Render thread — wakes on dirty, rate-limited at ~24 FPS
    let sessions_render = Arc::clone(&sessions);
    let notify_render = Arc::clone(&render_notify);
    thread::spawn(move || {
        let min_frame = Duration::from_millis(42);
        let idle_timeout = Duration::from_millis(100);
        let mut last_frame = Instant::now();

        loop {
            // Wait until notified or timeout (for exit checks)
            {
                let (lock, cvar) = &*notify_render;
                let mut notified = lock.lock().unwrap();
                if !*notified {
                    let result = cvar.wait_timeout(notified, idle_timeout).unwrap();
                    notified = result.0;
                }
                *notified = false;
            }

            // Rate limit: ensure at least ~42ms between frames (~24 FPS)
            let elapsed = last_frame.elapsed();
            if elapsed < min_frame {
                thread::sleep(min_frame - elapsed);
            }

            let mut to_remove = Vec::new();
            let sessions = sessions_render.lock().unwrap();

            for (id, session) in sessions.iter() {
                // Check for exit first
                if session.exited.load(Ordering::Relaxed) {
                    if session.dirty.swap(false, Ordering::Relaxed) {
                        emit(&session.snapshot());
                    }
                    let code = session.exit_code().unwrap_or(-1);
                    emit(&Event::Exit {
                        id: id.clone(),
                        code,
                    });
                    to_remove.push(id.clone());
                    continue;
                }

                // Emit state if dirty
                if session.dirty.swap(false, Ordering::Relaxed) {
                    emit(&session.snapshot());
                }
            }

            drop(sessions);
            last_frame = Instant::now();

            if !to_remove.is_empty() {
                let mut sessions = sessions_render.lock().unwrap();
                for id in to_remove {
                    sessions.remove(&id);
                }
            }
        }
    });

    // Stdin command reader — main thread
    let stdin = io::stdin();
    let reader = stdin.lock();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        if line.trim().is_empty() {
            continue;
        }

        let cmd: Command = match serde_json::from_str(&line) {
            Ok(c) => c,
            Err(e) => {
                emit(&Event::Error {
                    id: "unknown".to_string(),
                    message: format!("Invalid command: {}", e),
                });
                continue;
            }
        };

        match cmd {
            Command::Spawn {
                id,
                shell,
                cols,
                rows,
            } => {
                let shell = shell.unwrap_or_else(default_shell);

                match TerminalSession::spawn(
                    id.clone(),
                    &shell,
                    cols,
                    rows,
                    Arc::clone(&render_notify),
                ) {
                    Ok(session) => {
                        sessions.lock().unwrap().insert(id.clone(), session);
                        emit(&Event::Spawned { id });
                    }
                    Err(e) => {
                        emit(&Event::Error { id, message: e });
                    }
                }
            }
            Command::Write { id, data } => {
                let sessions = sessions.lock().unwrap();
                if let Some(session) = sessions.get(&id) {
                    if let Err(e) = session.write(&data) {
                        emit(&Event::Error { id, message: e });
                    }
                } else {
                    emit(&Event::Error {
                        id,
                        message: "Terminal not found".to_string(),
                    });
                }
            }
            Command::Resize { id, cols, rows } => {
                let sessions = sessions.lock().unwrap();
                if let Some(session) = sessions.get(&id) {
                    if let Err(e) = session.resize(cols, rows) {
                        emit(&Event::Error { id, message: e });
                    }
                } else {
                    emit(&Event::Error {
                        id,
                        message: "Terminal not found".to_string(),
                    });
                }
            }
            Command::Kill { id } => {
                let sessions = sessions.lock().unwrap();
                if let Some(session) = sessions.get(&id) {
                    if let Err(e) = session.kill() {
                        emit(&Event::Error { id, message: e });
                    }
                } else {
                    emit(&Event::Error {
                        id,
                        message: "Terminal not found".to_string(),
                    });
                }
            }
            Command::Scroll { id, offset } => {
                let sessions = sessions.lock().unwrap();
                if let Some(session) = sessions.get(&id) {
                    session.set_scroll_offset(offset);
                    // Wake render thread to send scrolled frame immediately
                    let (lock, cvar) = &*render_notify;
                    *lock.lock().unwrap() = true;
                    cvar.notify_one();
                } else {
                    emit(&Event::Error {
                        id,
                        message: "Terminal not found".to_string(),
                    });
                }
            }
        }
    }
}
