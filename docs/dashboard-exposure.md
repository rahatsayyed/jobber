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

Every exposure needs sign-in. There is one allowed account, checked through OpenID Connect
(Google by default, `WEB_OIDC_ISSUER`).

- Change the account only on the machine: `npm run dashboard -- allow <email>`.
  There is no web page for this on purpose.
- `npm run dashboard -- status` shows the current account, `npm run dashboard -- audit`
  lists recent sign-ins.
- Recovery: if your Google email changes or the account is lost, run the `allow` command
  again with the new email on the machine. The next successful sign-in pins the new account.
- The redirect URI registered at the provider must equal `WEB_OIDC_REDIRECT_URI` in `.env`
  exactly: `https://<your hostname>/auth/callback`, or `http://127.0.0.1:8787/auth/callback`
  for localhost only.

## 3. Options

All four keep the dashboard process on `127.0.0.1`. Set the env keys in `.env` and restart
`npm run web`.

### Tailscale (use `serve`, not `funnel`)

1. Install Tailscale on the machine and on your phone, same tailnet.
2. Run `tailscale serve --bg 8787`. This gives HTTPS inside your tailnet only.
   Avoid `tailscale funnel`: it publishes the page to the whole internet.
3. Register `https://<machine>.<tailnet>.ts.net/auth/callback` as the redirect URI.
4. Set `WEB_OIDC_REDIRECT_URI` to the same value, `WEB_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net`
   and `WEB_TRUST_PROXY=true`.

Protects: only devices in your tailnet can connect, with HTTPS. Does not protect: a device of
yours that is already in the tailnet and compromised. Open risk (unverified): Google may reject
a `ts.net` redirect URI. This must be tried live. If it is refused, use the SSH tunnel or a
real domain through Cloudflare Tunnel.

### Cloudflare Tunnel

1. Create a tunnel to `http://127.0.0.1:8787` with `cloudflared tunnel` and map a hostname you own.
2. Optionally put Cloudflare Access in front as an extra gate.
3. Register `https://<your hostname>/auth/callback`; set `WEB_OIDC_REDIRECT_URI` to it,
   `WEB_ALLOWED_HOSTS=<your hostname>` and `WEB_TRUST_PROXY=true`.

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

Set `WEB_ALLOWED_HOSTS=dash.example.com`, `WEB_TRUST_PROXY=true` and
`WEB_OIDC_REDIRECT_URI=https://dash.example.com/auth/callback`. Never expose plain http.

Protects: HTTPS. Does not protect: public reachability; you must keep the proxy patched.

### SSH tunnel

For a server: `ssh -L 8787:127.0.0.1:8787 host`, then open `http://127.0.0.1:8787`.
Keep `WEB_OIDC_REDIRECT_URI=http://127.0.0.1:8787/auth/callback` (allowed for loopback).
Leave `WEB_TRUST_PROXY=false`.

Protects: nothing is exposed; SSH keys gate access. Does not protect: the laptop end of the tunnel.

## 4. Checklist

- HTTPS only (except the loopback URI).
- `WEB_TRUST_PROXY=true` only behind a proxy you control.
- Redirect URI identical at the provider and in `.env`.
- OAuth consent screen in testing mode with only you as test user.
- Keep `WEB_CHAT_ENABLED=false` unless you need the chat box, and keep its permission set `read_only`.
- Run `npm run doctor`.
- Review sign-ins with `npm run dashboard -- audit`.
- Back up `.dashboard/auth.sqlite` only encrypted.

## 5. What it shows

The dashboard shows company contacts, email addresses, recruiter names, outreach drafts and
conversation state. That is personal data about you and other people. A page like that should
not sit on the public internet by default: one misconfiguration or stolen Google session would
expose it. Prefer the tailnet or an SSH tunnel.
