# user-data.example

This folder holds synthetic templates. Your real files live in the untracked `user-data/` folder, which is git-ignored and never committed.

Run `npm run user-data -- init` to copy these templates into `user-data/`, then fill them in.

| File | Purpose |
| --- | --- |
| `resume.json` | The base resume the agent tailors for each job. The agent never edits it. |
| `easy-apply-answers.json` | Your answers to common screening questions. |
| `fact-gate.json` | Facts you confirm, which the fact checker may allow, plus phrases to block or warn on. |
| `languages.json` | The languages you speak, used by the language gate. |
| `profile.json` | Roles, locations, remote preference, salary floors and targets per currency, notice period and work authorization (written by the setup wizard). The optional `north_star` section holds your target role archetypes, culture criteria, dealbreakers and comp expectations for the match score (see `docs/matching.md`); empty comp means unknown. |
| `account.json` | Your LinkedIn plan: `free`, `premium` or `unknown` (the default). Optional: a missing or invalid file means `unknown`. |
| `reply-facts.json` | Plain facts (CTC, notice period, location, relocation, availability, work authorization) the agent may use to answer simple email replies when `EMAIL_AUTO_REPLY=true`. Nothing is answered while `confirmed` is false. See `docs/email-auto-reply.md`. |

The setup skill (plan 7B) asks for your resume and a few questions and writes these files for you.
