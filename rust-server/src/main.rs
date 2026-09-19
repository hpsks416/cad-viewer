//! RoboMaster 3D 查看器本地服务（Rust 版）。
//!
//! 替代原 Python `server.py`：静态文件服务 + JSON API（清单 / 状态 / 批量转换）。
//! 重型 CAD 流水线（OCP 解析 STEP、Blender 转 glb、中文名翻译）仍由 `tools/*.py`
//! 完成，本服务通过调用 `python tools/build.py` 编排，因此运行时仍需一个安装了
//! ctranslate2 / sentencepiece 的 Python 3.10+。

use axum::{
    extract::State,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Command, sync::Arc};

/// 仓库根目录（rust-server 的上一级）。
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("rust-server must live inside the repo")
        .to_path_buf()
}

#[derive(Clone)]
struct AppState {
    root: Arc<PathBuf>,
}

fn read_json(path: &std::path::Path) -> Value {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    }
}

fn write_json(path: &std::path::Path, value: &Value) -> std::io::Result<()> {
    let s = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    std::fs::write(path, s)
}

fn mime_for(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// 极简 percent-decode（仅路径用，保留 `+` 为字面加号）。
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 静态文件服务：把请求路径安全地映射到仓库内的文件。
async fn static_handler(State(st): State<AppState>, uri: Uri) -> Response {
    let raw = uri.path();
    let path = if raw == "/" { "/index.html" } else { raw };
    let rel = percent_decode(path.trim_start_matches('/'));

    let mut full = (*st.root).clone();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return (StatusCode::FORBIDDEN, "forbidden").into_response();
        }
        full.push(seg);
    }

    if !full.starts_with(&*st.root) || !full.is_file() {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }

    match std::fs::read(&full) {
        Ok(bytes) => {
            let body = axum::body::Body::from(bytes);
            match Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime_for(&full))
                .header(header::CACHE_CONTROL, "no-store")
                .body(body)
            {
                Ok(r) => r,
                Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal").into_response(),
            }
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn get_manifest(State(st): State<AppState>) -> Json<Value> {
    let v = read_json(&st.root.join("models").join("manifest.json"));
    if v.get("models").is_some() {
        Json(v)
    } else {
        Json(json!({"title": "RoboMaster 作品", "models": []}))
    }
}

async fn get_state(State(st): State<AppState>) -> Json<Value> {
    Json(read_json(&st.root.join("user_state.json")))
}

async fn post_state(State(st): State<AppState>, Json(body): Json<Value>) -> Json<Value> {
    let p = st.root.join("user_state.json");
    let tmp = st.root.join("user_state.json.tmp");
    if write_json(&tmp, &body).is_ok() {
        let _ = std::fs::rename(&tmp, &p);
    }
    Json(json!({"ok": true}))
}

/// GET /api/files —— 列出 assets/export/ 下所有 STL/STEP 及命名/转换状态。
async fn get_files(State(st): State<AppState>) -> Json<Value> {
    let export = st.root.join("assets").join("export");
    let naming = read_json(&st.root.join("assets").join("naming-map.json"));

    let mut files: Vec<Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&export) {
        for e in entries.flatten() {
            let fname = e.file_name().to_string_lossy().into_owned();
            let lower = fname.to_lowercase();
            let is_step = lower.ends_with(".step") || lower.ends_with(".stp");
            let is_stl = lower.ends_with(".stl");
            if !is_step && !is_stl {
                continue;
            }

            let rec = naming.get(fname.as_str()).cloned().unwrap_or_else(|| json!({}));
            let slug = rec.get("slug").and_then(|v| v.as_str()).map(String::from);
            let name = rec.get("name").and_then(|v| v.as_str()).map(String::from);
            let translation = rec
                .get("translation")
                .and_then(|v| v.as_str())
                .map(String::from);

            let (has_glb, glb) = match &slug {
                Some(s) => {
                    let rel = format!("models/{s}.glb");
                    (st.root.join(&rel).exists(), Some(rel))
                }
                None => (false, None),
            };
            let preview = slug.as_ref().and_then(|s| {
                let rel = format!("work/previews/{s}.png");
                st.root.join(&rel).exists().then_some(rel)
            });
            let joints = slug.as_ref().and_then(|s| {
                let rel = format!("models/{s}.joints.json");
                st.root.join(&rel).exists().then_some(rel)
            });

            files.push(json!({
                "filename": fname,
                "type": if is_step { "step" } else { "stl" },
                "slug": slug,
                "name": name,
                "translation": translation,
                "has_glb": has_glb,
                "glb": glb,
                "preview": preview,
                "joints": joints,
            }));
        }
    }
    files.sort_by(|a, b| {
        let af = a["filename"].as_str().unwrap_or("").to_lowercase();
        let bf = b["filename"].as_str().unwrap_or("").to_lowercase();
        af.cmp(&bf)
    });
    Json(json!({"files": files}))
}

/// POST /api/build —— 调用 Python 流水线转换指定文件，再回读 manifest。
async fn post_build(
    State(st): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let files: Vec<String> = body
        .get("files")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let preview = body.get("preview").and_then(|v| v.as_bool()).unwrap_or(true);

    let python = std::env::var("CAD_VIEWER_PYTHON").unwrap_or_else(|_| "python".to_string());
    let script = st.root.join("tools").join("build.py");

    let mut cmd = Command::new(&python);
    cmd.arg(&script);
    if !files.is_empty() {
        let list = serde_json::to_string(&files).unwrap_or_else(|_| "[]".to_string());
        cmd.arg("--files").arg(list);
    }
    if !preview {
        cmd.arg("--no-preview");
    }
    cmd.current_dir(&*st.root);

    let output = cmd.output().map_err(|e| {
        eprintln!("build spawn failed: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    if !output.status.success() {
        let mut msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if msg.is_empty() {
            msg = String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
        return Ok(Json(json!({"ok": false, "error": msg})));
    }

    let manifest = read_json(&st.root.join("models").join("manifest.json"));
    let models = manifest.get("models").cloned().unwrap_or_else(|| json!([]));

    let results: Vec<Value> = files
        .iter()
        .map(|f| {
            let ok = models
                .as_array()
                .and_then(|arr| {
                    arr.iter().find(|m| {
                        m.get("source").and_then(|s| s.as_str()) == Some(f.as_str())
                    })
                })
                .and_then(|m| m.get("glb").and_then(|g| g.as_str()))
                .is_some();
            json!({"filename": f, "ok": ok})
        })
        .collect();

    Ok(Json(json!({"ok": true, "models": models, "results": results})))
}

#[tokio::main]
async fn main() {
    let root = repo_root();
    let state = AppState { root: Arc::new(root) };

    let app = Router::new()
        .route("/api/files", get(get_files))
        .route("/api/manifest", get(get_manifest))
        .route("/api/state", get(get_state).post(post_state))
        .route("/api/build", post(post_build))
        .fallback(static_handler)
        .with_state(state);

    let addr = "127.0.0.1:8123";
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("无法监听 {addr}: {e}"));
    println!("服务已启动：http://{addr}/ （Ctrl+C 停止）");
    axum::serve(listener, app).await.unwrap();
}