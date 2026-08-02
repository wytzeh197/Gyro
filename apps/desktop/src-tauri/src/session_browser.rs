//! Session-scoped embedded browser (child WKWebView) for the chat rail.
//!
//! One child webview per chat session, positioned over the React rail host.
//! The injected agent captures console/network and exposes DOM read/interaction
//! tools via `eval` + the `gyro-bridge` custom URI scheme.

use gyro_core::security::redact_secrets;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Runtime, WebviewUrl};
use uuid::Uuid;

const MAX_CONSOLE_ENTRIES: usize = 100;
const MAX_NETWORK_ENTRIES: usize = 100;
const MAX_ENTRY_CHARS: usize = 2_000;
const MAX_TREE_CHARS: usize = 48_000;
const MAX_FIND_RESULTS: usize = 40;
const AGENT_CALL_TIMEOUT: Duration = Duration::from_secs(8);
const MAIN_WINDOW_LABEL: &str = "main";
const BRIDGE_SCHEME: &str = "gyro-bridge";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBrowserOpenRequest {
    pub session_id: String,
    pub workspace_key: String,
    pub url: String,
    #[serde(default)]
    pub bounds: Option<SessionBrowserBounds>,
    #[serde(default)]
    pub visible: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBrowserSnapshot {
    pub session_id: String,
    pub workspace_key: String,
    pub resource_id: String,
    pub url: String,
    pub title: String,
    pub visible: bool,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsoleEntry {
    pub kind: String,
    pub message: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub line: Option<i64>,
    #[serde(default)]
    pub column: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNetworkEntry {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub status: Option<i64>,
    #[serde(default)]
    pub ok: Option<bool>,
    #[serde(default)]
    pub resource_type: Option<String>,
}

struct PendingAgentCall {
    sender: mpsc::Sender<Result<Value, String>>,
}

struct SessionBrowserSlot {
    session_id: String,
    workspace_key: String,
    resource_id: String,
    webview_label: String,
    bridge_nonce: String,
    url: String,
    title: String,
    visible: bool,
    approved_origins: HashSet<String>,
    console: VecDeque<BrowserConsoleEntry>,
    network: VecDeque<BrowserNetworkEntry>,
    pending: HashMap<String, PendingAgentCall>,
}

#[derive(Default)]
pub struct SessionBrowserManager {
    inner: Mutex<HashMap<String, SessionBrowserSlot>>,
}

impl SessionBrowserManager {
    fn with_slot_mut<R>(
        &self,
        session_id: &str,
        f: impl FnOnce(&mut SessionBrowserSlot) -> R,
    ) -> Result<R, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "session browser state is unavailable".to_string())?;
        let slot = guard
            .get_mut(session_id)
            .ok_or_else(|| "this chat has no open browser".to_string())?;
        Ok(f(slot))
    }

    fn snapshot_locked(slot: &SessionBrowserSlot) -> SessionBrowserSnapshot {
        SessionBrowserSnapshot {
            session_id: slot.session_id.clone(),
            workspace_key: slot.workspace_key.clone(),
            resource_id: slot.resource_id.clone(),
            url: slot.url.clone(),
            title: slot.title.clone(),
            visible: slot.visible,
            label: slot.webview_label.clone(),
        }
    }

    pub fn get_snapshot(&self, session_id: &str) -> Result<Option<SessionBrowserSnapshot>, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "session browser state is unavailable".to_string())?;
        Ok(guard.get(session_id).map(Self::snapshot_locked))
    }

    pub fn take_resource_id(&self, session_id: &str) -> Result<Option<String>, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "session browser state is unavailable".to_string())?;
        Ok(guard.get(session_id).map(|slot| slot.resource_id.clone()))
    }

    pub fn require_owned(
        &self,
        session_id: &str,
        workspace_key: &str,
    ) -> Result<SessionBrowserSnapshot, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "session browser state is unavailable".to_string())?;
        let slot = guard
            .get(session_id)
            .ok_or_else(|| "this chat has no open browser".to_string())?;
        if slot.workspace_key != workspace_key || slot.session_id != session_id {
            return Err("browser resource ownership changed".into());
        }
        Ok(Self::snapshot_locked(slot))
    }

    pub fn is_origin_approved(&self, session_id: &str, origin: &str) -> Result<bool, String> {
        self.with_slot_mut(session_id, |slot| slot.approved_origins.contains(origin))
    }

    pub fn approve_origin(&self, session_id: &str, origin: &str) -> Result<(), String> {
        self.with_slot_mut(session_id, |slot| {
            slot.approved_origins.insert(origin.to_string());
        })
    }

    pub fn console_entries(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<BrowserConsoleEntry>, String> {
        self.with_slot_mut(session_id, |slot| {
            slot.console
                .iter()
                .rev()
                .take(limit.max(1).min(MAX_CONSOLE_ENTRIES))
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        })
    }

    pub fn network_entries(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<BrowserNetworkEntry>, String> {
        self.with_slot_mut(session_id, |slot| {
            slot.network
                .iter()
                .rev()
                .take(limit.max(1).min(MAX_NETWORK_ENTRIES))
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        })
    }

    fn push_console(&self, session_id: &str, entry: BrowserConsoleEntry) {
        let _ = self.with_slot_mut(session_id, |slot| {
            if slot.console.len() >= MAX_CONSOLE_ENTRIES {
                slot.console.pop_front();
            }
            slot.console.push_back(entry);
        });
    }

    fn push_network(&self, session_id: &str, entry: BrowserNetworkEntry) {
        let _ = self.with_slot_mut(session_id, |slot| {
            if slot.network.len() >= MAX_NETWORK_ENTRIES {
                slot.network.pop_front();
            }
            slot.network.push_back(entry);
        });
    }

    fn resolve_pending(&self, session_id: &str, call_id: &str, result: Result<Value, String>) {
        let sender = self
            .with_slot_mut(session_id, |slot| slot.pending.remove(call_id))
            .ok()
            .flatten();
        if let Some(pending) = sender {
            let _ = pending.sender.send(result);
        }
    }

    fn register_pending(
        &self,
        session_id: &str,
        call_id: String,
        sender: mpsc::Sender<Result<Value, String>>,
    ) -> Result<(), String> {
        self.with_slot_mut(session_id, |slot| {
            slot.pending.insert(call_id, PendingAgentCall { sender });
        })
    }

    fn webview_label_for(&self, session_id: &str) -> Result<String, String> {
        self.with_slot_mut(session_id, |slot| slot.webview_label.clone())
    }

    fn bridge_nonce_for(&self, session_id: &str) -> Result<String, String> {
        self.with_slot_mut(session_id, |slot| slot.bridge_nonce.clone())
    }

    fn set_url(&self, session_id: &str, url: &str) -> Result<(), String> {
        self.with_slot_mut(session_id, |slot| {
            slot.url = url.to_string();
        })
    }

    fn set_title(&self, session_id: &str, title: &str) -> Result<(), String> {
        self.with_slot_mut(session_id, |slot| {
            slot.title = title.to_string();
        })
    }

    fn set_visible_flag(&self, session_id: &str, visible: bool) -> Result<(), String> {
        self.with_slot_mut(session_id, |slot| {
            slot.visible = visible;
        })
    }

    fn remove_slot(&self, session_id: &str) -> Result<Option<SessionBrowserSlot>, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "session browser state is unavailable".to_string())?;
        Ok(guard.remove(session_id))
    }
}

pub fn browser_url_is_navigable(url: &url::Url) -> bool {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host().is_none()
    {
        return false;
    }
    true
}

pub fn browser_url_is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

pub fn parse_navigable_url(raw: &str) -> Result<url::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("url is required".into());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = url::Url::parse(&candidate).map_err(|_| "invalid browser URL".to_string())?;
    if !browser_url_is_navigable(&url) {
        return Err("browser URLs must be credential-free http or https with a host".into());
    }
    Ok(url)
}

fn truncate_chars(value: &str, max: usize) -> String {
    let mut out = String::new();
    for (index, ch) in value.chars().enumerate() {
        if index >= max {
            break;
        }
        out.push(ch);
    }
    out
}

fn sanitize_text(value: &str) -> String {
    truncate_chars(&redact_secrets(value.trim()), MAX_ENTRY_CHARS)
}

fn agent_initialization_script(bridge_nonce: &str) -> String {
    let nonce = serde_json::to_string(bridge_nonce).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function() {{
  if (window.__gyroBrowserAgentInstalled) return;
  window.__gyroBrowserAgentInstalled = true;
  const BRIDGE_NONCE = {nonce};
  const MAX_CONSOLE = {MAX_CONSOLE_ENTRIES};
  const MAX_NETWORK = {MAX_NETWORK_ENTRIES};
  const MAX_MSG = {MAX_ENTRY_CHARS};
  const consoleBuf = [];
  const networkBuf = [];
  let refCounter = 0;
  const refMap = new Map();

  const textOf = (value) => {{
    try {{
      if (value instanceof Error) return value.message || value.name || "Error";
      if (typeof value === "string") return value;
      const encoded = JSON.stringify(value);
      return encoded === undefined ? String(value) : encoded;
    }} catch (_) {{
      return String(value);
    }}
  }};

  const postBridge = (payload) => {{
    try {{
      const body = JSON.stringify(Object.assign({{ nonce: BRIDGE_NONCE }}, payload));
      fetch("gyro-bridge://call", {{
        method: "POST",
        headers: {{ "content-type": "application/json" }},
        body,
        mode: "cors",
        credentials: "omit",
        keepalive: true,
      }}).catch(() => {{}});
    }} catch (_) {{}}
  }};

  const pushConsole = (kind, values, source, line, column) => {{
    const message = values.map(textOf).join(" ").slice(0, MAX_MSG);
    if (!message) return;
    const entry = {{
      kind,
      message,
      source: typeof source === "string" ? source : null,
      line: Number.isFinite(line) ? line : null,
      column: Number.isFinite(column) ? column : null,
    }};
    if (consoleBuf.length >= MAX_CONSOLE) consoleBuf.shift();
    consoleBuf.push(entry);
    postBridge({{ kind: "console", entry }});
  }};

  const original = {{
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }};
  console.log = (...v) => {{ pushConsole("log", v); original.log(...v); }};
  console.info = (...v) => {{ pushConsole("info", v); original.info(...v); }};
  console.warn = (...v) => {{ pushConsole("warn", v); original.warn(...v); }};
  console.error = (...v) => {{ pushConsole("console-error", v); original.error(...v); }};
  console.debug = (...v) => {{ pushConsole("debug", v); original.debug(...v); }};
  addEventListener("error", (event) => {{
    pushConsole("page-error", [event.message || "Page error"], event.filename, event.lineno, event.colno);
  }}, true);
  addEventListener("unhandledrejection", (event) => {{
    pushConsole("unhandled-rejection", [event.reason || "Unhandled promise rejection"]);
  }}, true);

  const recordNetwork = (entry) => {{
    if (networkBuf.length >= MAX_NETWORK) networkBuf.shift();
    networkBuf.push(entry);
    postBridge({{ kind: "network", entry }});
  }};

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {{
    const method = (init && init.method) || (input && input.method) || "GET";
    let url = "";
    try {{
      url = typeof input === "string" ? input : (input && input.url) || String(input);
    }} catch (_) {{
      url = "unknown";
    }}
    try {{
      const response = await originalFetch(input, init);
      recordNetwork({{
        method: String(method).toUpperCase(),
        url: String(url).slice(0, MAX_MSG),
        status: response.status,
        ok: response.ok,
        resourceType: "fetch",
      }});
      return response;
    }} catch (error) {{
      recordNetwork({{
        method: String(method).toUpperCase(),
        url: String(url).slice(0, MAX_MSG),
        status: null,
        ok: false,
        resourceType: "fetch",
      }});
      throw error;
    }}
  }};

  const XO = window.XMLHttpRequest;
  if (XO) {{
    const open = XO.prototype.open;
    const send = XO.prototype.send;
    XO.prototype.open = function(method, url) {{
      this.__gyroMethod = method;
      this.__gyroUrl = url;
      return open.apply(this, arguments);
    }};
    XO.prototype.send = function() {{
      this.addEventListener("loadend", () => {{
        recordNetwork({{
          method: String(this.__gyroMethod || "GET").toUpperCase(),
          url: String(this.__gyroUrl || "").slice(0, MAX_MSG),
          status: this.status || null,
          ok: this.status >= 200 && this.status < 400,
          resourceType: "xhr",
        }});
      }});
      return send.apply(this, arguments);
    }};
  }}

  const isVisible = (el) => {{
    if (!el || el.nodeType !== 1) return false;
    const style = window.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {{
      return false;
    }}
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }};

  const roleOf = (el) => {{
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {{
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }}
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "img") return "img";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    return tag;
  }};

  const nameOf = (el) => {{
    const labelled = el.getAttribute("aria-label")
      || el.getAttribute("alt")
      || el.getAttribute("title")
      || el.getAttribute("placeholder")
      || "";
    if (labelled) return labelled.trim().slice(0, 120);
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return text.slice(0, 120);
  }};

  const isCredentialField = (el) => {{
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag !== "input") return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    const name = ((el.getAttribute("name") || "") + " " + (el.getAttribute("autocomplete") || "") + " " + (el.getAttribute("id") || "")).toLowerCase();
    return /password|passwd|pwd|one-time|otp|totp|2fa|credit.?card|cc-number|cvc|cvv|ssn/.test(name);
  }};

  const assignRef = (el) => {{
    if (!el || el.__gyroRef) return el.__gyroRef;
    refCounter += 1;
    const ref = "ref_" + refCounter;
    el.__gyroRef = ref;
    refMap.set(ref, el);
    return ref;
  }};

  const resolveRef = (ref) => {{
    if (!ref || typeof ref !== "string") return null;
    const el = refMap.get(ref);
    if (el && el.isConnected) return el;
    refMap.delete(ref);
    return null;
  }};

  const serializeTree = (root, depth, maxDepth, budget) => {{
    if (!root || depth > maxDepth || budget.left <= 0) return null;
    if (root.nodeType === 3) {{
      const text = (root.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) return null;
      budget.left -= text.length;
      return {{ type: "text", text: text.slice(0, 200) }};
    }}
    if (root.nodeType !== 1) return null;
    const el = root;
    if (!isVisible(el) && depth > 0) return null;
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "svg") return null;
    const ref = assignRef(el);
    const node = {{
      ref,
      role: roleOf(el),
      name: nameOf(el),
      tag,
      children: [],
    }};
    if (el.getAttribute("href")) node.href = String(el.getAttribute("href")).slice(0, 200);
    if (el.getAttribute("type")) node.inputType = el.getAttribute("type");
    if (el.getAttribute("value") != null && tag === "input") {{
      node.value = isCredentialField(el) ? "[redacted-credential]" : String(el.value || "").slice(0, 120);
    }}
    budget.left -= 64;
    if (depth >= maxDepth) return node;
    const children = el.childNodes;
    for (let i = 0; i < children.length && budget.left > 0 && node.children.length < 40; i++) {{
      const child = serializeTree(children[i], depth + 1, maxDepth, budget);
      if (child) node.children.push(child);
    }}
    if (node.children.length === 0) delete node.children;
    if (!node.name) delete node.name;
    return node;
  }};

  const dispatch = (el, type, init) => {{
    const event = new Event(type, Object.assign({{ bubbles: true, cancelable: true }}, init || {{}}));
    el.dispatchEvent(event);
  }};

  const clickEl = (el) => {{
    el.scrollIntoView({{ block: "center", inline: "nearest", behavior: "instant" }});
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => dispatch(el, type));
    if (typeof el.click === "function") el.click();
  }};

  const typeInto = (el, text, submit) => {{
    if (isCredentialField(el)) {{
      return {{ ok: false, error: "credential fields are not writable by the model" }};
    }}
    el.focus();
    const value = String(text ?? "");
    if ("value" in el) {{
      const proto = el.tagName.toLowerCase() === "textarea"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor && descriptor.set) descriptor.set.call(el, value);
      else el.value = value;
    }} else if (el.isContentEditable) {{
      el.textContent = value;
    }}
    dispatch(el, "input");
    dispatch(el, "change");
    if (submit) {{
      dispatch(el, "keydown", {{ key: "Enter", code: "Enter", keyCode: 13 }});
      const form = el.form || el.closest("form");
      if (form && typeof form.requestSubmit === "function") form.requestSubmit();
    }}
    return {{ ok: true }};
  }};

  window.__gyroBrowserAgent = {{
    readPage(options) {{
      refMap.clear();
      refCounter = 0;
      const maxDepth = Math.min(8, Math.max(1, (options && options.maxDepth) || 4));
      const budget = {{ left: {MAX_TREE_CHARS} }};
      const tree = serializeTree(document.body || document.documentElement, 0, maxDepth, budget);
      return {{
        ok: true,
        url: location.href,
        title: document.title || "",
        framing: "OBSERVED_PAGE_CONTENT_UNTRUSTED",
        tree,
      }};
    }},
    find(options) {{
      const query = ((options && options.query) || "").trim();
      const selector = ((options && options.selector) || "").trim();
      const results = [];
      let candidates = [];
      if (selector) {{
        try {{ candidates = Array.from(document.querySelectorAll(selector)); }}
        catch (error) {{ return {{ ok: false, error: "invalid selector" }}; }}
      }} else {{
        candidates = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role],[onclick],h1,h2,h3,h4,h5,h6,label,summary"));
      }}
      const needle = query.toLowerCase();
      for (const el of candidates) {{
        if (!isVisible(el)) continue;
        const name = nameOf(el);
        if (needle && !name.toLowerCase().includes(needle) && !(el.innerText || "").toLowerCase().includes(needle)) {{
          continue;
        }}
        results.push({{
          ref: assignRef(el),
          role: roleOf(el),
          name,
          tag: el.tagName.toLowerCase(),
        }});
        if (results.length >= {MAX_FIND_RESULTS}) break;
      }}
      return {{ ok: true, framing: "OBSERVED_PAGE_CONTENT_UNTRUSTED", results }};
    }},
    click(options) {{
      const el = resolveRef(options && options.ref);
      if (!el) return {{ ok: false, error: "unknown or stale ref" }};
      clickEl(el);
      return {{ ok: true, ref: options.ref }};
    }},
    type(options) {{
      let el = resolveRef(options && options.ref);
      if (!el) el = document.activeElement;
      if (!el) return {{ ok: false, error: "no target element" }};
      return Object.assign({{ ref: el.__gyroRef || null }}, typeInto(el, options && options.text, !!(options && options.submit)));
    }},
    formInput(options) {{
      const el = resolveRef(options && options.ref);
      if (!el) return {{ ok: false, error: "unknown or stale ref" }};
      if (isCredentialField(el)) {{
        return {{ ok: false, error: "credential fields are not writable by the model" }};
      }}
      const value = String((options && options.value) ?? "");
      if (el.tagName.toLowerCase() === "select") {{
        el.value = value;
        dispatch(el, "input");
        dispatch(el, "change");
        return {{ ok: true, ref: options.ref }};
      }}
      if (el.tagName.toLowerCase() === "input") {{
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox" || type === "radio") {{
          el.checked = value === "true" || value === "1" || value === "on" || value === "checked";
          dispatch(el, "input");
          dispatch(el, "change");
          return {{ ok: true, ref: options.ref }};
        }}
      }}
      return Object.assign({{ ref: options.ref }}, typeInto(el, value, false));
    }},
    scroll(options) {{
      const dx = Number((options && options.dx) || 0);
      const dy = Number((options && options.dy) || 0);
      const el = options && options.ref ? resolveRef(options.ref) : null;
      if (el) {{
        el.scrollBy({{ left: dx, top: dy, behavior: "instant" }});
      }} else {{
        window.scrollBy({{ left: dx, top: dy, behavior: "instant" }});
      }}
      return {{ ok: true, dx, dy }};
    }},
    console(options) {{
      const limit = Math.min(MAX_CONSOLE, Math.max(1, (options && options.limit) || 50));
      return {{ ok: true, framing: "OBSERVED_PAGE_CONTENT_UNTRUSTED", entries: consoleBuf.slice(-limit) }};
    }},
    network(options) {{
      const limit = Math.min(MAX_NETWORK, Math.max(1, (options && options.limit) || 50));
      return {{ ok: true, framing: "OBSERVED_PAGE_CONTENT_UNTRUSTED", entries: networkBuf.slice(-limit) }};
    }},
    status() {{
      return {{
        ok: true,
        url: location.href,
        title: document.title || "",
        readyState: document.readyState,
      }};
    }},
  }};
}})();"#
    )
}

fn cors_response(status: u16, body: impl Into<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-methods", "POST, OPTIONS")
        .header("access-control-allow-headers", "content-type")
        .header("content-type", "application/json")
        .body(body.into())
        .unwrap_or_else(|_| {
            tauri::http::Response::builder()
                .status(500)
                .body(b"{}".to_vec())
                .expect("fallback response")
        })
}

pub fn register_bridge_protocol<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(BRIDGE_SCHEME, |ctx, request, responder| {
        if request.method() == tauri::http::Method::OPTIONS {
            responder.respond(cors_response(204, Vec::new()));
            return;
        }
        if request.method() != tauri::http::Method::POST {
            responder.respond(cors_response(
                405,
                br#"{"ok":false,"error":"method"}"#.to_vec(),
            ));
            return;
        }
        let app = ctx.app_handle().clone();
        let body = request.into_body();
        std::thread::spawn(move || {
            let result = handle_bridge_body(&app, &body);
            match result {
                Ok(()) => responder.respond(cors_response(200, br#"{"ok":true}"#.to_vec())),
                Err(error) => {
                    let payload = serde_json::json!({ "ok": false, "error": error });
                    responder.respond(cors_response(
                        400,
                        serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec()),
                    ));
                }
            }
        });
    })
}

fn handle_bridge_body<R: Runtime>(app: &AppHandle<R>, body: &[u8]) -> Result<(), String> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| "invalid bridge payload".to_string())?;
    let nonce = value
        .get("nonce")
        .and_then(Value::as_str)
        .ok_or_else(|| "bridge nonce missing".to_string())?;
    let manager = app.state::<SessionBrowserManager>();
    let session_id = {
        let guard = manager
            .inner
            .lock()
            .map_err(|_| "session browser state is unavailable".to_string())?;
        guard
            .values()
            .find(|slot| slot.bridge_nonce == nonce)
            .map(|slot| slot.session_id.clone())
            .ok_or_else(|| "unknown bridge nonce".to_string())?
    };

    let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "console" => {
            if let Some(entry) = value.get("entry") {
                let message = entry
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                manager.push_console(
                    &session_id,
                    BrowserConsoleEntry {
                        kind: entry
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or("log")
                            .to_string(),
                        message: sanitize_text(&message),
                        source: entry
                            .get("source")
                            .and_then(Value::as_str)
                            .map(sanitize_text),
                        line: entry.get("line").and_then(Value::as_i64),
                        column: entry.get("column").and_then(Value::as_i64),
                    },
                );
            }
        }
        "network" => {
            if let Some(entry) = value.get("entry") {
                manager.push_network(
                    &session_id,
                    BrowserNetworkEntry {
                        method: entry
                            .get("method")
                            .and_then(Value::as_str)
                            .unwrap_or("GET")
                            .to_string(),
                        url: sanitize_text(entry.get("url").and_then(Value::as_str).unwrap_or("")),
                        status: entry.get("status").and_then(Value::as_i64),
                        ok: entry.get("ok").and_then(Value::as_bool),
                        resource_type: entry
                            .get("resourceType")
                            .and_then(Value::as_str)
                            .map(|value| value.to_string()),
                    },
                );
            }
        }
        "result" => {
            let call_id = value
                .get("callId")
                .and_then(Value::as_str)
                .ok_or_else(|| "callId missing".to_string())?;
            if let Some(error) = value.get("error").and_then(Value::as_str) {
                manager.resolve_pending(&session_id, call_id, Err(error.to_string()));
            } else {
                let result = value.get("result").cloned().unwrap_or(Value::Null);
                manager.resolve_pending(&session_id, call_id, Ok(result));
            }
        }
        "title" => {
            if let Some(title) = value.get("title").and_then(Value::as_str) {
                let _ = manager.set_title(&session_id, &sanitize_text(title));
            }
            if let Some(url) = value.get("url").and_then(Value::as_str) {
                let _ = manager.set_url(&session_id, url);
            }
        }
        _ => {}
    }
    let _ = app.emit(
        "session-browser-event",
        serde_json::json!({ "sessionId": session_id, "kind": kind }),
    );
    Ok(())
}

fn get_main_window<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::Window<R>, String> {
    app.get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window is not available".to_string())
}

fn apply_bounds<R: Runtime>(
    webview: &tauri::Webview<R>,
    bounds: &SessionBrowserBounds,
) -> Result<(), String> {
    if bounds.width < 1.0 || bounds.height < 1.0 {
        let _ = webview.hide();
        return Ok(());
    }
    webview
        .set_bounds(Rect {
            position: LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0)).into(),
            size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into(),
        })
        .map_err(|error| format!("could not position browser webview: {error}"))?;
    Ok(())
}

pub fn open_session_browser<R: Runtime>(
    app: &AppHandle<R>,
    request: SessionBrowserOpenRequest,
) -> Result<SessionBrowserSnapshot, String> {
    let url = parse_navigable_url(&request.url)?;
    let origin = url.origin().ascii_serialization();
    let manager = app.state::<SessionBrowserManager>();

    if let Ok(Some(existing)) = manager.get_snapshot(&request.session_id) {
        if existing.workspace_key != request.workspace_key {
            return Err("browser resource ownership changed".into());
        }
        let label = manager.webview_label_for(&request.session_id)?;
        if let Some(webview) = app.get_webview(&label) {
            webview
                .navigate(url.clone())
                .map_err(|error| format!("could not navigate browser: {error}"))?;
            if let Some(bounds) = request.bounds.as_ref() {
                apply_bounds(&webview, bounds)?;
            }
            let visible = request.visible.unwrap_or(true);
            if visible {
                let _ = webview.show();
            } else {
                let _ = webview.hide();
            }
            manager.set_url(&request.session_id, url.as_str())?;
            manager.set_visible_flag(&request.session_id, visible)?;
            let _ = manager.approve_origin(&request.session_id, &origin);
            return manager
                .get_snapshot(&request.session_id)?
                .ok_or_else(|| "browser disappeared during open".to_string());
        }
    }

    let session_id = request.session_id.clone();
    let resource_id = Uuid::new_v4().to_string();
    let bridge_nonce = Uuid::new_v4().to_string();
    let webview_label = format!("session-browser-{}", session_id.replace('-', ""));
    let script = agent_initialization_script(&bridge_nonce);

    // Close any stale webview with the same label.
    if let Some(existing) = app.get_webview(&webview_label) {
        let _ = existing.close();
    }

    let window = get_main_window(app)?;
    let session_for_title = session_id.clone();
    let app_for_title = app.clone();
    let bounds = request.bounds.clone().unwrap_or(SessionBrowserBounds {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    });
    let visible = request
        .visible
        .unwrap_or(bounds.width >= 2.0 && bounds.height >= 2.0);

    let builder = tauri::WebviewBuilder::new(&webview_label, WebviewUrl::External(url.clone()))
        .initialization_script(script)
        .incognito(true)
        .devtools(false)
        .on_navigation(|nav_url| browser_url_is_navigable(nav_url))
        .on_document_title_changed(move |_webview, title| {
            let manager = app_for_title.state::<SessionBrowserManager>();
            let _ = manager.set_title(&session_for_title, &sanitize_text(&title));
            let _ = app_for_title.emit(
                "session-browser-event",
                serde_json::json!({
                    "sessionId": session_for_title,
                    "kind": "title",
                    "title": sanitize_text(&title),
                }),
            );
        });

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0)),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|error| format!("could not create session browser webview: {error}"))?;

    if !visible {
        let _ = webview.hide();
    }

    let mut approved = HashSet::new();
    approved.insert(origin);

    let mut guard = manager
        .inner
        .lock()
        .map_err(|_| "session browser state is unavailable".to_string())?;
    guard.insert(
        session_id.clone(),
        SessionBrowserSlot {
            session_id: session_id.clone(),
            workspace_key: request.workspace_key.clone(),
            resource_id,
            webview_label: webview_label.clone(),
            bridge_nonce,
            url: url.to_string(),
            title: String::new(),
            visible,
            approved_origins: approved,
            console: VecDeque::new(),
            network: VecDeque::new(),
            pending: HashMap::new(),
        },
    );
    let snapshot = guard
        .get(&session_id)
        .map(SessionBrowserManager::snapshot_locked)
        .expect("just inserted");
    Ok(snapshot)
}

pub fn set_session_browser_bounds<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    bounds: SessionBrowserBounds,
) -> Result<(), String> {
    let manager = app.state::<SessionBrowserManager>();
    let label = manager.webview_label_for(session_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    apply_bounds(&webview, &bounds)?;
    if bounds.width >= 2.0 && bounds.height >= 2.0 {
        manager.set_visible_flag(session_id, true)?;
        let _ = webview.show();
    }
    Ok(())
}

pub fn set_session_browser_visible<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    visible: bool,
) -> Result<(), String> {
    let manager = app.state::<SessionBrowserManager>();
    let label = manager.webview_label_for(session_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    if visible {
        webview
            .show()
            .map_err(|error| format!("could not show browser: {error}"))?;
    } else {
        webview
            .hide()
            .map_err(|error| format!("could not hide browser: {error}"))?;
    }
    manager.set_visible_flag(session_id, visible)?;
    Ok(())
}

pub fn navigate_session_browser<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    raw_url: &str,
) -> Result<SessionBrowserSnapshot, String> {
    let url = parse_navigable_url(raw_url)?;
    let manager = app.state::<SessionBrowserManager>();
    let label = manager.webview_label_for(session_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    webview
        .navigate(url.clone())
        .map_err(|error| format!("could not navigate browser: {error}"))?;
    manager.set_url(session_id, url.as_str())?;
    let _ = manager.approve_origin(session_id, &url.origin().ascii_serialization());
    manager
        .get_snapshot(session_id)?
        .ok_or_else(|| "browser disappeared during navigate".to_string())
}

pub fn reload_session_browser<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<SessionBrowserSnapshot, String> {
    let manager = app.state::<SessionBrowserManager>();
    let label = manager.webview_label_for(session_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    webview
        .reload()
        .map_err(|error| format!("could not reload browser: {error}"))?;
    manager
        .get_snapshot(session_id)?
        .ok_or_else(|| "browser disappeared during reload".to_string())
}

pub fn history_session_browser<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    direction: &str,
) -> Result<SessionBrowserSnapshot, String> {
    let delta = match direction {
        "back" => -1,
        "forward" => 1,
        _ => return Err("direction must be back or forward".into()),
    };
    let manager = app.state::<SessionBrowserManager>();
    let label = manager.webview_label_for(session_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    webview
        .eval(format!("window.history.go({delta});"))
        .map_err(|error| format!("could not move browser history: {error}"))?;
    // Best-effort URL refresh after history navigation.
    let _ = call_agent(app, session_id, "status", serde_json::json!({}));
    manager
        .get_snapshot(session_id)?
        .ok_or_else(|| "browser disappeared during history navigation".to_string())
}

pub fn close_session_browser<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<(), String> {
    let manager = app.state::<SessionBrowserManager>();
    if let Some(slot) = manager.remove_slot(session_id)? {
        if let Some(webview) = app.get_webview(&slot.webview_label) {
            let _ = webview.close();
        }
    }
    Ok(())
}

pub fn call_agent<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    method: &str,
    args: Value,
) -> Result<Value, String> {
    let manager = app.state::<SessionBrowserManager>();
    let label = manager.webview_label_for(session_id)?;
    let nonce = manager.bridge_nonce_for(session_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;

    let call_id = Uuid::new_v4().to_string();
    let (sender, receiver) = mpsc::channel();
    manager.register_pending(session_id, call_id.clone(), sender)?;

    let method_json = serde_json::to_string(method).map_err(|error| error.to_string())?;
    let args_json = serde_json::to_string(&args).map_err(|error| error.to_string())?;
    let call_id_json = serde_json::to_string(&call_id).map_err(|error| error.to_string())?;
    let nonce_json = serde_json::to_string(&nonce).map_err(|error| error.to_string())?;

    let script = format!(
        r#"(function() {{
  const callId = {call_id_json};
  const nonce = {nonce_json};
  const method = {method_json};
  const args = {args_json};
  const post = (payload) => {{
    try {{
      fetch("gyro-bridge://call", {{
        method: "POST",
        headers: {{ "content-type": "application/json" }},
        body: JSON.stringify(Object.assign({{ nonce }}, payload)),
        mode: "cors",
        credentials: "omit",
      }}).catch(() => {{}});
    }} catch (_) {{}}
  }};
  try {{
    const agent = window.__gyroBrowserAgent;
    if (!agent || typeof agent[method] !== "function") {{
      post({{ kind: "result", callId, error: "browser agent is not ready" }});
      return;
    }}
    const result = agent[method](args);
    Promise.resolve(result).then(
      (value) => post({{ kind: "result", callId, result: value }}),
      (error) => post({{ kind: "result", callId, error: String(error && error.message || error) }})
    );
  }} catch (error) {{
    post({{ kind: "result", callId, error: String(error && error.message || error) }});
  }}
}})();"#
    );

    webview
        .eval(script)
        .map_err(|error| format!("could not run browser agent: {error}"))?;

    let result = receiver
        .recv_timeout(AGENT_CALL_TIMEOUT)
        .map_err(|_| "browser agent call timed out".to_string())?;
    let value = result?;
    sanitize_agent_result(value)
}

fn sanitize_agent_result(value: Value) -> Result<Value, String> {
    fn walk(value: Value) -> Value {
        match value {
            Value::String(text) => Value::String(sanitize_text(&text)),
            Value::Array(items) => Value::Array(items.into_iter().map(walk).collect()),
            Value::Object(map) => {
                let mut out = serde_json::Map::new();
                for (key, child) in map {
                    out.insert(key, walk(child));
                }
                Value::Object(out)
            }
            other => other,
        }
    }
    let sanitized = walk(value);
    let encoded = serde_json::to_vec(&sanitized).map_err(|error| error.to_string())?;
    if encoded.len() > gyro_core::MAX_CAPABILITY_RESULT_BYTES {
        return Err("browser agent result exceeded the capability size limit".into());
    }
    Ok(sanitized)
}

pub fn capture_session_browser_png<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<Vec<u8>, String> {
    let manager = app.state::<SessionBrowserManager>();
    let label = manager.webview_label_for(session_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;

    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = mpsc::channel();
        webview
            .with_webview(move |platform| unsafe {
                use block2::RcBlock;
                use objc2::runtime::AnyObject;
                use objc2_app_kit::{
                    NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
                };
                use objc2_foundation::{NSDictionary, NSError};
                use objc2_web_kit::WKWebView;

                let view: &WKWebView = &*platform.inner().cast();
                let completion = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                    let snapshot = (|| {
                        let image = image.as_ref().ok_or_else(|| {
                            "native browser snapshot returned no image".to_string()
                        })?;
                        let tiff = image.TIFFRepresentation().ok_or_else(|| {
                            "native browser snapshot could not be encoded".to_string()
                        })?;
                        let bitmap =
                            NSBitmapImageRep::imageRepWithData(&tiff).ok_or_else(|| {
                                "native browser snapshot could not create a bitmap".to_string()
                            })?;
                        let properties =
                            NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
                        let png = bitmap
                            .representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &properties,
                            )
                            .ok_or_else(|| {
                                "native browser snapshot could not create PNG data".to_string()
                            })?;
                        Ok::<Vec<u8>, String>(png.to_vec())
                    })();
                    let _ = sender.send(snapshot);
                });
                view.takeSnapshotWithConfiguration_completionHandler(None, &completion);
            })
            .map_err(|error| format!("could not request native browser snapshot: {error}"))?;

        receiver
            .recv_timeout(Duration::from_secs(8))
            .map_err(|_| "native browser screenshot timed out".to_string())?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, session_id, webview);
        Err("browser screenshots are currently available on macOS only".into())
    }
}

// --- Tauri commands -------------------------------------------------------

#[tauri::command]
pub async fn session_browser_open(
    app: AppHandle,
    request: SessionBrowserOpenRequest,
) -> Result<SessionBrowserSnapshot, String> {
    open_session_browser(&app, request)
}

#[tauri::command]
pub async fn session_browser_set_bounds(
    app: AppHandle,
    session_id: String,
    bounds: SessionBrowserBounds,
) -> Result<(), String> {
    set_session_browser_bounds(&app, &session_id, bounds)
}

#[tauri::command]
pub async fn session_browser_set_visible(
    app: AppHandle,
    session_id: String,
    visible: bool,
) -> Result<(), String> {
    set_session_browser_visible(&app, &session_id, visible)
}

#[tauri::command]
pub async fn session_browser_navigate(
    app: AppHandle,
    session_id: String,
    url: String,
) -> Result<SessionBrowserSnapshot, String> {
    navigate_session_browser(&app, &session_id, &url)
}

#[tauri::command]
pub async fn session_browser_reload(
    app: AppHandle,
    session_id: String,
) -> Result<SessionBrowserSnapshot, String> {
    reload_session_browser(&app, &session_id)
}

#[tauri::command]
pub async fn session_browser_history(
    app: AppHandle,
    session_id: String,
    direction: String,
) -> Result<SessionBrowserSnapshot, String> {
    history_session_browser(&app, &session_id, &direction)
}

#[tauri::command]
pub async fn session_browser_close(app: AppHandle, session_id: String) -> Result<(), String> {
    close_session_browser(&app, &session_id)
}

#[tauri::command]
pub async fn session_browser_snapshot(
    app: AppHandle,
    session_id: String,
) -> Result<Option<SessionBrowserSnapshot>, String> {
    app.state::<SessionBrowserManager>()
        .get_snapshot(&session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigable_urls_accept_public_https_and_reject_credentials() {
        assert!(browser_url_is_navigable(
            &url::Url::parse("https://example.com/path").unwrap()
        ));
        assert!(browser_url_is_navigable(
            &url::Url::parse("http://127.0.0.1:3000").unwrap()
        ));
        assert!(!browser_url_is_navigable(
            &url::Url::parse("https://user:pass@example.com").unwrap()
        ));
        assert!(!browser_url_is_navigable(
            &url::Url::parse("file:///tmp/x").unwrap()
        ));
        assert!(!browser_url_is_loopback(
            &url::Url::parse("https://example.com").unwrap()
        ));
        assert!(browser_url_is_loopback(
            &url::Url::parse("http://localhost:5173").unwrap()
        ));
    }

    #[test]
    fn agent_script_installs_bridge_and_tools() {
        let script = agent_initialization_script("test-nonce");
        assert!(script.contains("gyro-bridge://call"));
        assert!(script.contains("__gyroBrowserAgent"));
        assert!(script.contains("readPage"));
        assert!(script.contains("credential fields"));
        assert!(script.contains("OBSERVED_PAGE_CONTENT_UNTRUSTED"));
    }
}
