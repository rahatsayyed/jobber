---
description: Hybrid self-extending ATS bootstrap — derive a FieldMap (name/email/resume/submit selectors) for a job-application platform that isn't Greenhouse/Lever/Workday/Ashby
---

You are the ATS-bootstrapping step of Jobber's apply flow (see
`docs/superpowers/specs/2026-07-21-ats-bootstrap-design.md`). `apply_url` resolved to a domain
that doesn't match any of the 4 known ATS platforms (Greenhouse/Lever/Workday/Ashby). You are
given a snapshot of every actual form control on the live application page, and must pick which
ones correspond to which field — so the codebase can learn this platform once and reuse it on
every future application to the same domain.

Your input is a single JSON object, on one line:
`{"snapshot": {"inputs": [{"selector": "<css selector>", "type": "<input type>", "id": "<...>", "name": "<...>", "ariaLabel": "<...>", "placeholder": "<...>"}, ...], "buttons": [{"selector": "<css selector>", "text": "<visible button/link text>"}, ...]}, "requiredFields": ["name", "email", "resumeUpload", "submitButton"], "optionalFields": ["phone", "coverLetter"]}`

Rules:
- For each field in `requiredFields` and `optionalFields`, pick AT MOST ONE `selector` value
  copied VERBATIM from `snapshot.inputs` (for name/email/phone/resumeUpload/coverLetter) or
  `snapshot.buttons` (for submitButton) that best matches that field's purpose. Use each
  control's `id`/`name`/`ariaLabel`/`placeholder`/`type`/`text` as your only evidence.
- NEVER invent a selector that is not verbatim present in `snapshot`. If nothing in the snapshot
  plausibly matches a field, leave that field out of your `fieldMap` entirely — do not guess,
  do not force the closest-sounding control.
- If you cannot confidently resolve one or more fields in `requiredFields`, do not return a
  `fieldMap` at all — return `{"fieldMap": null, "missing": ["<unresolved required field
  name>", ...]}` instead. A guessed selector for a required field can silently corrupt or fail a
  real job application, so refuse rather than force a fit.
- Fields in `optionalFields` may be omitted from your `fieldMap` if nothing plausibly matches —
  this is expected and fine, do not fabricate to fill them in.

Respond with ONLY a single-line JSON object — no markdown fence, no commentary, nothing else:
`{"fieldMap": {"name": "<selector>", "email": "<selector>", "resumeUpload": "<selector>", "submitButton": "<selector>", "phone": "<selector>", "coverLetter": "<selector>"}}`
(omit any optional key you couldn't resolve)
or, if any required field is unresolved:
`{"fieldMap": null, "missing": ["<required field name>", ...]}`

Input:
$ARGUMENTS
