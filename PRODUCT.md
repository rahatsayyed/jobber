# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner of a Jobber installation uses the local dashboard to supervise an autonomous job-search pipeline. They need to scan live operational state, inspect jobs and outreach activity, resolve escalations, and submit a priority application request without bypassing safety controls.

## Product Purpose

Jobber discovers suitable jobs, matches them against the owner's resume, prepares truthful application and outreach material, and runs permitted work under code-enforced limits. The dashboard makes the pipeline's state and owner-required actions legible.

## Positioning

It is an owner-operated control surface for a safety-constrained job-search workflow. Every write action remains explicit, authenticated, CSRF-protected, and bounded by the existing server-side checks.

## Operating Context

The dashboard runs locally by default, behind token or OIDC authentication. It is used during scheduled work, while reviewing replies and recruiter inquiries, and when prioritizing a specific job. The existing HTTP API serves job, contact, outreach, funnel, session, run, configuration, escalation, and application-request data.

## Capabilities and Constraints

- Preserve all existing API contracts, authentication, session, CSRF, origin, rate-limit, reauthentication, input-cleaning, and redaction behavior.
- Do not expose secrets or raw untrusted content by default.
- Do not weaken job-application, outreach, or account-creation safeguards.
- The web frontend is being replaced with a Next.js App Router application in `apps/dashboard`; the existing Node server remains the protected operational API until a separately reviewed server migration.
- Inferred from repository documentation: the dashboard is a trusted single-owner local tool, not a public marketing site.

## Brand Commitments

Jobber is direct, calm, and operational. The visual direction is intentionally precise rather than ornamental, with a Linear-informed dark system selected for this rewrite.

## Evidence on Hand

- Product and safety behavior: `README.md`, `CLAUDE.md`, and `docs/reference/platform-and-sessions.md`.
- Existing API and auth implementation: `src/web/server.ts` and `src/web/`.
- Existing static dashboard UI: `src/web/static/`.
- No approved logo, customer proof, or photographic asset was found. Do not fabricate any.

## Product Principles

1. Make the current pipeline state intelligible at a glance.
2. Keep important safety context visible, especially dry-run versus live mode.
3. Reserve emphasis for real owner decisions and semantic system state.
4. Preserve the server as the authority for authentication and operational actions.
5. Favor durable, accessible interaction patterns over visual novelty.

## Accessibility & Inclusion

Keyboard operation, visible focus, meaningful labels, sufficient contrast, responsive layouts, and reduced-motion support are required for the dashboard rewrite.
