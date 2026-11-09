//! Readable, non-executing HTML extraction for web research.
//! Page metadata and links are observations, never trusted instructions.
use super::WebFetchPage;
use crate::security::redact_secrets;
use dom_query::Document;
use serde::Serialize;
use std::collections::HashSet;
use url::Url;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadableDocument {
    pub title: Option<String>,
    pub published_at: Option<String>,
    pub modified_at: Option<String>,
    pub canonical_url: Option<String>,
    pub rendering_may_be_required: bool,
    pub text: String,
}

fn bounded(value: &str, limit: usize) -> String {
    // Decode entities/normalize first, then redact: encoded secrets must not leak.
    redact_secrets(&value.split_whitespace().collect::<Vec<_>>().join(" "))
        .chars()
        .take(limit)
        .collect()
}

fn safe_link(base: &Url, value: &str) -> Option<String> {
    let url = base.join(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.as_str().len() > 2048
    {
        return None;
    }
    Some(redact_secrets(url.as_str()))
}

/// Returns None for non-HTML, preserving plain text, JSON and feeds exactly.
/// This is an HTML parser, not a browser: no scripts, resources or links run.
pub fn extract(page: &WebFetchPage) -> Option<ReadableDocument> {
    let essence = page
        .content_type
        .as_deref()
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(essence.as_str(), "text/html" | "application/xhtml+xml") {
        return None;
    }
    let base = Url::parse(&page.final_url).ok()?;
    let doc = Document::from(page.text.as_str());
    let meta = |selector: &str| {
        doc.select(selector)
            .first()
            .attr("content")
            .map(|v| bounded(&v, 400))
            .filter(|v| !v.is_empty())
    };
    let title = meta("meta[property='og:title']").or_else(|| {
        let title = bounded(&doc.select("title").text(), 400);
        (!title.is_empty()).then_some(title)
    });
    let published_at = meta("meta[property='article:published_time'], meta[name='date'], meta[itemprop='datePublished']");
    let modified_at = meta("meta[property='article:modified_time'], meta[itemprop='dateModified']");
    let canonical_url = doc
        .select("link[rel='canonical']")
        .first()
        .attr("href")
        .and_then(|value| safe_link(&base, &value));

    // Keep article headers (often the title/date) but remove non-content and
    // explicit hidden nodes before extracting text or links.
    doc.select("script, style, noscript, template, svg, canvas, iframe, form, button, input, textarea, select, nav, [role='navigation'], [hidden], [aria-hidden='true']").remove();
    let mut root = doc.select("main, [role='main']").first();
    if !root.exists() || root.text().trim().is_empty() {
        root = doc.select("article").first();
    }
    if !root.exists() || root.text().trim().is_empty() {
        doc.select("body > header, body > footer, aside").remove();
        root = doc.select("body");
    }
    let body = root.formatted_text().to_string();
    // Sparse HTML may be an app shell or challenge. This is a hint, not a
    // claim that rendering will work or that a release does not exist.
    let rendering_may_be_required = body.chars().filter(|c| !c.is_whitespace()).count() < 160;
    let mut text = redact_secrets(&body);
    let mut seen = HashSet::new();
    let mut links = Vec::new();
    for link in root.select("a[href]").iter() {
        let label = bounded(&link.text(), 160);
        let Some(href) = link.attr("href") else {
            continue;
        };
        if label.is_empty() || href.starts_with('#') {
            continue;
        }
        let Some(url) = safe_link(&base, &href) else {
            continue;
        };
        if seen.insert(url.clone()) {
            links.push(format!("- {label}: {url}"));
        }
        if links.len() == 40 {
            break;
        }
    }
    if !links.is_empty() {
        text.push_str("\n\nLinks (up to 40 unique destinations):\n");
        text.push_str(&links.join("\n"));
    }
    Some(ReadableDocument {
        title,
        published_at,
        modified_at,
        canonical_url,
        rendering_may_be_required,
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(html: &str) -> WebFetchPage {
        WebFetchPage {
            status: 200,
            requested_url: "https://vendor.example/news".into(),
            final_url: "https://vendor.example/news/release/".into(),
            content_type: Some("text/html; charset=utf-8".into()),
            bytes: html.len(),
            truncated: false,
            text: html.into(),
        }
    }

    #[test]
    fn release_blog_keeps_evidence_dates_and_resolved_links_without_chrome() {
        let html = r#"<html><head><title>Release &amp; notes</title>
            <meta property="article:published_time" content="2026-11-08">
            <meta property="article:modified_time" content="2026-11-09">
            <link rel="canonical" href="/news/release/"></head><body>
            <nav>Pricing Menu</nav><main><article><header><h1>Model release</h1></header>
            <p>A model with longer context.</p><a href="../../docs/model">Model docs</a>
            <a href="https://other.example/card">Model card</a>
            <script>hiddenPayload()</script><style>unwantedCss</style>
            <div hidden>Hidden copy</div></article></main></body></html>"#;
        let result = extract(&page(html)).unwrap();
        assert_eq!(result.title.as_deref(), Some("Release & notes"));
        assert_eq!(result.published_at.as_deref(), Some("2026-11-08"));
        assert_eq!(result.modified_at.as_deref(), Some("2026-11-09"));
        assert_eq!(
            result.canonical_url.as_deref(),
            Some("https://vendor.example/news/release/")
        );
        assert!(result.text.contains("Model release"));
        assert!(result.text.contains("https://vendor.example/docs/model"));
        assert!(result.text.contains("https://other.example/card"));
        for omitted in [
            "Pricing Menu",
            "hiddenPayload",
            "unwantedCss",
            "Hidden copy",
        ] {
            assert!(!result.text.contains(omitted), "{omitted}");
        }
    }

    #[test]
    fn documentation_tables_and_multiple_release_cards_survive() {
        let result = extract(&page(
            r#"<nav>Account</nav><main><article><h2>Release A</h2>
            <p>Available in API.</p></article><article><h2>Release B</h2>
            <table><tr><th>Context</th><td>128K</td></tr></table></article></main>"#,
        ))
        .unwrap();
        for expected in ["Release A", "Release B", "Context", "128K"] {
            assert!(result.text.contains(expected), "{expected}");
        }
        assert!(!result.text.contains("Account"));
    }

    #[test]
    fn unstructured_index_retains_discovery_links_and_limits_duplicates() {
        let result = extract(&page(
            r#"<body><header>Menu</header><div>News
            <a href="/release">Release</a><a href="/release">Duplicate</a>
            <a href="javascript:alert(1)">JS</a><a href="mailto:a@example.com">Mail</a>
            <a href="https://user:private@example.com/">Credential link</a>
            </div><footer>Footer</footer></body>"#,
        ))
        .unwrap();
        assert!(result.text.contains("https://vendor.example/release"));
        assert_eq!(
            result
                .text
                .matches("https://vendor.example/release")
                .count(),
            1
        );
        for omitted in ["javascript:", "mailto:", "user:private", "Menu", "Footer"] {
            assert!(!result.text.contains(omitted), "{omitted}");
        }
    }

    #[test]
    fn app_shell_and_challenge_are_not_release_evidence() {
        for html in [
            "<body><div id='root'></div><script>render()</script></body>",
            "<body><h1>Verify you are human</h1></body>",
        ] {
            assert!(extract(&page(html)).unwrap().rendering_may_be_required);
        }
    }

    #[test]
    fn entity_encoded_secrets_are_redacted_after_parsing() {
        let result = extract(&page(
            "<main><p>OPENAI_API_KEY&#61;sk-test-secret-value-1234567890</p></main>",
        ))
        .unwrap();
        assert!(!result.text.contains("sk-test-secret-value"));
    }

    #[test]
    fn plain_text_json_and_feeds_are_not_html_parsed() {
        for kind in ["text/plain", "application/json", "application/rss+xml"] {
            let mut source = page("{ \"message\": \"<main>literal</main>\" }");
            source.content_type = Some(kind.into());
            assert!(extract(&source).is_none());
        }
    }

    #[test]
    fn malformed_truncated_html_still_yields_available_evidence() {
        let mut source = page("<main><h1>New model</h1><p>Available today &amp; rolling");
        source.truncated = true;
        assert!(extract(&source)
            .unwrap()
            .text
            .contains("Available today & rolling"));
    }
}
