# Jobber Next dashboard

This is the Next.js App Router replacement for the legacy static dashboard.
The existing Jobber server remains responsible for sessions, CSRF, auth, input
validation, safety gates, data redaction, rate limits, and all operational writes.

## Run locally

1. Start the existing Jobber server with `npm run web` at the repository root.
2. Copy `.env.example` to `.env.local` and set `JOBBER_API_ORIGIN` to that server.
3. Run `npm run dev` in this directory.

The browser talks only to Next. Its `app/api` and `app/auth` route handlers
forward requests to the protected server without parsing action bodies.
