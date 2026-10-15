# Dashboard exposure guide

The dashboard is a small web page for the Jobber agent. This guide says how to reach it
safely and what to avoid. Start with the default and only change it if you must.

## 1. The default: this machine only

`npm run web` listens on `127.0.0.1` (the loopback address). Only programs on the same
computer can reach it. On a laptop, use it as is.

- Do not open the port in a firewall or router.
- Never set `WEB_BIND` to the any-address. The server refuses a non-loopback bind unless
  `WEB_ALLOW_REMOTE_BIND=true` is also set; do not set that either.
- To reach it from a phone or another computer, use one of the four options in section 3.

## 2. Sign-in is mandatory

Every exposure needs sign-in. `WEB_AUTH_MODE` picks one of three modes. `token` is the default.

| Mode | What protects the page | Network use | Where it works |
|---|---|---|---|
| `token` | A long random access token you hold. Only its SHA-256 hash is stored, in `.dashboard/auth.sqlite`. | None | Loopback, or behind a TLS proxy (a non-loopback bind also needs `WEB_ALLOW_REMOTE_BIND=true`) |
| `google_desktop` | One allowed Google account, through the Desktop OAuth client you already made for Gmail. | Google | Loopback only |
| `oidc` | One allowed account through a Web OAuth client (`WEB_OIDC_*`, Google by default). | Provider | Loopback, or behind a TLS proxy |

If `WEB_AUTH_MODE` is unset and both `WEB_OIDC_CLIENT_ID` and `WEB_OIDC_CLIENT_SECRET` are set,
the mode resolves to `oidc` and `npm run doctor` warns on every doctor run until `WEB_AUTH_MODE`
is set. Existing OIDC installs need to do nothing, or can set `WEB_AUTH_MODE=oidc` explicitly to
silence the warning.

The server remembers the mode it last ran in. The first start only records it. When a later
start runs in a different mode, every session is revoked and a `mode_changed` audit row is
written (mode names only), so a sign-in from the old mode never carries over.

### Token mode

- `npm run dashboard -- token` creates the token and prints it once. It exits with code 3 if a
  token already exists. `npm run web` prints nothing secret. Setup runs `token` for you.
- Open `http://127.0.0.1:<port>/` with `#token=<token>` appended (the part after `#` never
  leaves the browser), or paste the token into the login form. The page sends it with a POST to
  `/auth/token`. A `?token=` query string does not sign you in, on purpose.
- The token is not stored anywhere in readable form: not in `.env`, not in the database. Only the
  hash is kept. Do not paste it into chat, tickets or screenshots.
- `npm run dashboard -- rotate` replaces the token and revokes every session. Run it if you
  lose the token or think it leaked.
- It listens on loopback by default. A non-loopback request is accepted only when a TLS proxy
  you control marked it https: set `WEB_TRUST_PROXY=true` and `WEB_ALLOWED_HOSTS`, and, if the
  server binds a non-loopback address, also `WEB_ALLOW_REMOTE_BIND=true`. Plain http
  from another machine is refused, because the token would cross the network in clear text.
- Sessions are revoked on `rotate` and when a mode switch is detected at start.
- The SSH tunnel keeps working unchanged: the page still sees loopback.
- Sessions, CSRF, the idle and absolute limits and the failed-login throttle are the same in all
  three modes.

### Google desktop mode (unverified)

- Reuses the Desktop OAuth client from the Gmail setup. It needs an allowed account:
  `DASHBOARD_ALLOWED_EMAIL` or `npm run dashboard -- allow <email>`. The keys file comes from
  `WEB_GOOGLE_KEYS_PATH`, else `GMAIL_OAUTH_PATH`.
- Loopback only. The server rejects `WEB_TRUST_PROXY=true` in this mode.
- `WEB_GOOGLE_REDIRECT_SHAPE` is `callback` (`/auth/callback`) or `root` (`/`).
- Unverified: whether Google accepts a loopback redirect from this client has not been checked
  against live Google. `npm run dashboard -- google-url` prints the sign-in URL so you can test
  it. If `callback` is refused with `redirect_uri_mismatch`, set the shape to `root` and try
  again.
- Fallback order if it is refused: `root` shape, then `oidc` with a dedicated Web client, then
  `token`.

### OIDC mode

- One allowed account, checked through OpenID Connect (Google by default, `WEB_OIDC_ISSUER`).
- The redirect URI registered at the provider must equal `WEB_OIDC_REDIRECT_URI` in `.env`
  exactly: `https://<your hostname>/auth/callback`, or `http://127.0.0.1:8787/auth/callback`
  for localhost only.

### Status and recovery

- `npm run dashboard -- status` shows the mode, the account (when the mode uses one) and the
  token state. `npm run dashboard -- audit` lists recent sign-ins.
- Lost token: run `npm run dashboard -- rotate` on the machine.
- Google or OIDC account changed or lost: run `npm run dashboard -- allow <email>` with the new
  email on the machine. The next successful sign-in pins the new account. There is no web page
  for this on purpose.

## 3. Options

All four keep the dashboard process on `127.0.0.1`. Set the env keys in `.env` and restart
`npm run web`. Behind a proxy all three modes work except `google_desktop`, which is loopback
only. So with Tailscale `serve` or a tunnel, use `token` or `oidc`.

### Tailscale (use `serve`, not `funnel`)

1. Install Tailscale on the machine and on your phone, same tailnet.
2. Run `tailscale serve --bg 8787`. This gives HTTPS inside your tailnet only.
   Avoid `tailscale funnel`: it publishes the page to the whole internet.
3. Set `WEB_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net` and `WEB_TRUST_PROXY=true`.
4. Modes: `token` or `oidc` (not `google_desktop`). For `oidc`, register
   `https://<machine>.<tailnet>.ts.net/auth/callback` and set `WEB_OIDC_REDIRECT_URI` to it.

Protects: only devices in your tailnet can connect, with HTTPS. Does not protect: a device of
yours that is already in the tailnet and compromised. Open risk for `oidc` (unverified): Google
may reject a `ts.net` redirect URI. This must be tried live. If it is refused, use `token`, the
SSH tunnel, or a real domain through Cloudflare Tunnel.

### Cloudflare Tunnel

1. Create a tunnel to `http://127.0.0.1:8787` with `cloudflared tunnel` and map a hostname you own.
2. Optionally put Cloudflare Access in front as an extra gate.
3. Set `WEB_ALLOWED_HOSTS=<your hostname>` and `WEB_TRUST_PROXY=true`.
4. Modes: `token` or `oidc` (not `google_desktop`). For `oidc`, register
   `https://<your hostname>/auth/callback` and set `WEB_OIDC_REDIRECT_URI` to it.

Protects: HTTPS and no open inbound port. Does not protect: the page is reachable from the
internet, so only the sign-in stands in the way (unless you add Access).

### Reverse proxy with TLS

Use a proxy you control on the same machine. Caddy gets certificates automatically:

```
dash.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy sets `X-Forwarded-For` and `X-Forwarded-Proto` itself. For nginx, redirect HTTP to
HTTPS and set the headers yourself:

```
server {
    listen 443 ssl;
    server_name dash.example.com;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
server { listen 80; server_name dash.example.com; return 301 https://$host$request_uri; }
```

Set `WEB_ALLOWED_HOSTS=dash.example.com` and `WEB_TRUST_PROXY=true`. Modes: `token` or `oidc`
(not `google_desktop`); for `oidc` also set
`WEB_OIDC_REDIRECT_URI=https://dash.example.com/auth/callback`. Never expose plain http.

Protects: HTTPS. Does not protect: public reachability; you must keep the proxy patched.

### SSH tunnel

For a server: `ssh -L 8787:127.0.0.1:8787 host`, then open `http://127.0.0.1:8787`.
Modes: all three work, because the page sees loopback. For `oidc` keep
`WEB_OIDC_REDIRECT_URI=http://127.0.0.1:8787/auth/callback` (allowed for loopback).
Leave `WEB_TRUST_PROXY=false`.

Protects: nothing is exposed; SSH keys gate access. Does not protect: the laptop end of the tunnel.

## 4. Checklist

- HTTPS only (except the loopback URI).
- `WEB_TRUST_PROXY=true` only behind a proxy you control.
- `WEB_AUTH_MODE` matches what you intend (`npm run doctor` shows the active mode).
- The token was not pasted into chat, tickets or screenshots; if it was, run
  `npm run dashboard -- rotate`.
- For `oidc`: redirect URI identical at the provider and in `.env`.
- For Google modes: OAuth consent screen in testing mode with only you as test user.
- Keep `WEB_CHAT_ENABLED=false` unless you need the chat box, and keep its permission set `read_only`.
- Run `npm run doctor`.
- Review sign-ins with `npm run dashboard -- audit`.
- Back up `.dashboard/auth.sqlite` only encrypted.

## 5. What it shows

The dashboard shows company contacts, email addresses, recruiter names, outreach drafts and
conversation state. That is personal data about you and other people. A page like that should
not sit on the public internet by default: one misconfiguration or a leaked token or Google
session would expose it. Prefer the tailnet or an SSH tunnel.
