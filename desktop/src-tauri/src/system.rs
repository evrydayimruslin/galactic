use url::Url;

const ALLOWED_AUTH_HOSTS: &[&str] = &[
    "ultralight-api.rgn4jz429m.workers.dev",
    "ultralight-api-staging.rgn4jz429m.workers.dev",
    "localhost",
    "127.0.0.1",
];

fn validate_auth_login_url(parsed: &Url) -> Result<(), String> {
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("unsupported auth url scheme: {}", other)),
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "auth url is missing a host".to_string())?;
    if !ALLOWED_AUTH_HOSTS.contains(&host) {
        return Err(format!("unsupported auth host: {}", host));
    }

    if parsed.path() != "/auth/login" {
        return Err(format!("unsupported auth path: {}", parsed.path()));
    }

    Ok(())
}

fn is_allowed_auth_redirect_target(parsed: &Url) -> bool {
    matches!(parsed.scheme(), "https")
        && parsed.path() == "/auth/v1/authorize"
        && parsed.host_str().map(|host| host.ends_with(".supabase.co")).unwrap_or(false)
}

async fn resolve_auth_redirect_target(parsed: &Url) -> Result<Url, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|err| format!("failed to create auth preflight client: {}", err))?;

    let response = client
        .get(parsed.as_ref())
        .send()
        .await
        .map_err(|err| format!("failed to preflight auth redirect: {}", err))?;

    if !response.status().is_redirection() {
        return Err(format!(
            "auth login did not return a redirect (status {})",
            response.status()
        ));
    }

    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .ok_or_else(|| "auth login redirect was missing a Location header".to_string())?
        .to_str()
        .map_err(|err| format!("auth login redirect Location was invalid: {}", err))?;

    let resolved = parsed
        .join(location)
        .map_err(|err| format!("failed to resolve auth redirect target: {}", err))?;

    if !is_allowed_auth_redirect_target(&resolved) {
        return Err(format!("unexpected auth redirect target: {}", resolved));
    }

    Ok(resolved)
}

#[tauri::command]
pub async fn open_auth_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|err| format!("invalid auth url: {}", err))?;
    validate_auth_login_url(&parsed)?;

    let resolved = resolve_auth_redirect_target(&parsed).await?;

    webbrowser::open(resolved.as_ref())
        .map(|_| ())
        .map_err(|err| format!("failed to open auth url in system browser: {}", err))
}
