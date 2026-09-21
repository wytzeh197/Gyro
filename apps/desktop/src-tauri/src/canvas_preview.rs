//! A dedicated, unprivileged origin for generated Canvas UI. No filesystem
//! paths, native commands, or network proxy are exposed by this protocol.
const RUNTIME: &str = include_str!("../../public/canvas-runtime.html");
const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

pub fn response(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let allowed = request.method() == tauri::http::Method::GET && request.uri().path() == "/";
    tauri::http::Response::builder()
        .status(if allowed { 200 } else { 404 })
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", CSP)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(if allowed {
            RUNTIME.as_bytes().to_vec()
        } else {
            Vec::new()
        })
        .expect("static Canvas response headers are valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canvas_origin_serves_only_the_isolated_runtime() {
        let response = response(
            tauri::http::Request::builder()
                .uri("/")
                .body(vec![])
                .unwrap(),
        );
        assert_eq!(response.status(), 200);
        assert!(response.headers()["Content-Security-Policy"]
            .to_str()
            .unwrap()
            .contains("sandbox allow-scripts"));
        assert!(!CSP.contains("allow-same-origin"));
        assert!(String::from_utf8_lossy(response.body()).contains("event.source !== parent"));
        for (method, path) in [("GET", "/etc/passwd"), ("POST", "/")] {
            let rejected = super::response(
                tauri::http::Request::builder()
                    .method(method)
                    .uri(path)
                    .body(vec![])
                    .unwrap(),
            );
            assert_eq!(rejected.status(), 404);
            assert!(rejected.body().is_empty());
        }
    }
}
