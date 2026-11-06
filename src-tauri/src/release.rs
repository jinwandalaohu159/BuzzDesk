// Which URLs count as BuzzDesk's GitHub releases. The webview hands us these
// URLs (from the GitHub API response), so they are parsed and checked
// structurally: a plain prefix test on the raw string can be bypassed with
// `..` segments, which URL parsers (and so the HTTP client) resolve away.
use url::Url;

const REPO_PATH: &str = "/jinwandalaohu159/BuzzDesk";
pub const LATEST_RELEASE_URL: &str = "https://github.com/jinwandalaohu159/BuzzDesk/releases/latest";

// A release page: https://github.com/<repo>/releases[/...].
pub fn validate_release_page(raw: &str) -> Result<Url, String> {
    let url = parse_github_url(raw)?;
    let releases = format!("{REPO_PATH}/releases");
    let path = url.path();
    if path == releases || path.starts_with(&format!("{releases}/")) {
        Ok(url)
    } else {
        Err("unsupported update release url".to_string())
    }
}

// A release asset: https://github.com/<repo>/releases/download/<tag>/<file>.
pub fn validate_installer_url(raw: &str) -> Result<Url, String> {
    let url = parse_github_url(raw)?;
    if url.path().starts_with(&format!("{REPO_PATH}/releases/download/")) {
        Ok(url)
    } else {
        Err("unsupported update installer url".to_string())
    }
}

// GitHub serves release assets by redirecting to its download CDN.
pub fn is_trusted_download_host(url: &str) -> bool {
    Url::parse(url)
        .ok()
        .filter(|url| url.scheme() == "https")
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "github.com" || host.ends_with(".githubusercontent.com"))
}

fn parse_github_url(raw: &str) -> Result<Url, String> {
    // Reject dot segments outright (plain or percent-encoded) rather than rely
    // on how they would be resolved.
    let lower = raw.to_ascii_lowercase();
    if lower.contains("..") || lower.contains("%2e") || lower.contains('\\') {
        return Err("unsupported update url".to_string());
    }

    let url = Url::parse(raw).map_err(|_| "invalid update url".to_string())?;
    let trusted = url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    if trusted {
        Ok(url)
    } else {
        Err("unsupported update url".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_this_repositorys_releases() {
        assert!(validate_release_page(LATEST_RELEASE_URL).is_ok());
        assert!(validate_release_page("https://github.com/jinwandalaohu159/BuzzDesk/releases/tag/v0.1.5").is_ok());
        assert!(validate_installer_url(
            "https://github.com/jinwandalaohu159/BuzzDesk/releases/download/v0.1.5/BuzzDesk_0.1.5_x64-setup.exe"
        )
        .is_ok());
    }

    #[test]
    fn rejects_lookalikes_and_traversal() {
        for url in [
            "https://github.com/jinwandalaohu159/BuzzDesk/releases/../../../evil/x/releases/download/v/setup.exe",
            "https://github.com/jinwandalaohu159/BuzzDesk/releases/%2e%2e/%2E%2E/evil/releases/download/v/a.exe",
            "https://github.com/jinwandalaohu159/BuzzDeskEvil/releases/download/v/a.exe",
            "https://github.com.evil.com/jinwandalaohu159/BuzzDesk/releases/download/v/a.exe",
            "http://github.com/jinwandalaohu159/BuzzDesk/releases/download/v/a.exe",
            "https://user@github.com/jinwandalaohu159/BuzzDesk/releases/download/v/a.exe",
            "https://github.com:8443/jinwandalaohu159/BuzzDesk/releases/download/v/a.exe",
            "https://github.com/jinwandalaohu159/BuzzDesk/issues",
        ] {
            assert!(validate_installer_url(url).is_err(), "{url}");
        }
        assert!(validate_release_page("https://github.com/jinwandalaohu159/BuzzDesk/releasesX").is_err());
    }

    #[test]
    fn trusts_only_github_download_hosts() {
        assert!(is_trusted_download_host("https://objects.githubusercontent.com/abc"));
        assert!(is_trusted_download_host("https://release-assets.githubusercontent.com/abc"));
        assert!(!is_trusted_download_host("https://githubusercontent.com.evil.net/abc"));
        assert!(!is_trusted_download_host("http://objects.githubusercontent.com/abc"));
    }
}
