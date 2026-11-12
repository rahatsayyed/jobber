# Email auto reply

Audience: owner
Last verified against: 3ae3b11
Source files: src/outreach/emailReplyClass.ts, src/outreach/emailReplies.ts, src/outreach/replyFacts.ts, src/outreach/emailReplyFlags.ts, src/followups.ts, src/scheduler/mailDrip.ts, src/scheduler/replyCheck.ts, user-data.example/reply-facts.json

Recruiters often write back with a plain question: current CTC, expected CTC, notice period, location. With this feature on, the agent answers those plain questions by email on its own, and tells you on Telegram what it sent. Everything else comes to you. It ships OFF.

## What it answers, and what it never answers

It answers only plain facts you wrote yourself in `user-data/reply-facts.json`: current CTC, expected CTC, notice period, current location, relocation, when you can join, work authorization. Questions in Hinglish (for example "current ctc kya hai", "expected ctc bataiye") are understood too; the answer is always in English.

It never answers, and sends you a loud Telegram notice (topic `inbox`, "needs you") instead, when the mail:

- asks for a date, a time or a slot, or invites you to an interview or a meeting;
- has a test, an assessment, a form or a link that asks you to do something;
- asks for a document, a resume, a certificate, an ID or any attachment, or has an attachment;
- asks for references;
- asks for a phone number or a call;
- is an offer or a rejection (a rejection is recorded, not answered);
- asks for personal data, or talks about negotiating pay;
- mixes a plain question with ANY owner-only part (then the whole mail comes to you);
- contains instruction-like text aimed at the agent, is long, or is anything the agent is not sure about.

It also never answers when the sender is not a verified contact, the job already has an outcome, the sender rejected or bounced before, you already have an open item in that thread, or a newer message arrived in the thread. At most 3 automatic replies go out in one Gmail thread.

An ask whose field in `reply-facts.json` is empty is never guessed: the mail comes to you.

## "Closed for now": the one polite reply that needs no facts

When a recruiter only says there is no opening right now ("the openings are on hold", "no vacancy at the moment", "we are not hiring right now", "the position is filled", "we will keep your profile on file", "will consider your profile if something opens up") and asks nothing, the agent sends ONE short warm thank-you (fixed text in `buildClosingText`, signed with your name from `user-data/resume.json`, subject `Re: <their subject>`). It says thanks, that you understand, and that you would be glad to stay in touch. It holds no question, no number, no claim, no link, no attachment and no promise, so it does not need `reply-facts.json`. It passes the same gates as every reply: style, fact and output gate, one reply per incoming mail, at most 3 per thread, the verified sender only, send window, quiet hours, kill switch, halts, dry run and `EMAIL_AUTO_REPLY`.

Rules (in `looksClosedForNow`, `src/outreach/emailReplyClass.ts`):

- It never triggers for an interview, a time or slot, an offer, a test, a document, a call, a link that asks for action, any question or ask, instruction-like text, an attachment, a bounce or an automated sender. All those stay with you ("needs you").
- A hard rejection of the person ("we regret", "not selected", "not a good fit", "decided not to move forward", "other candidates", "unsuccessful") is NOT closed for now. It stays recorded and shown to you, and gets no reply. Decision: a thank-you to a personal rejection is not worth the risk; only "the opening is on hold or filled, your profile stays on file" gets the warm reply.
- After it, silence for that job and company. Code (any `EMAIL_AUTO_REPLY` state, right at the reply check): the job's pending follow-ups end, queued email, connect and apply rows get status `skipped` with the reason `closed_for_now` (rows already sent, sending or submitted are never touched), and every known person of that company on LinkedIn, Naukri and Wellfound is paused (`contact_state.paused_reason = closed_for_now`), so no connect, DM or follow-up is armed. A reply from the recruiter is already on file, so `blockedJobIds` blocks follow-ups, and the one nudge never applies to such a job. The job outcome is NOT recorded: the usual proposal (`/checkreplies`) is the only way, auto-record stays off.

## Telegram notice wording

Every reply notice starts with the company and the sender, for example `Agent42 Labs (hello@agent42labs.com) · reply`, then the subject, the job, a one-line gist of what they said (max 200 characters, quoted), `Why:` in plain words (only when you are needed or the agent sent no answer) and one line on what the agent did or will do (`Agent: The agent will send a short thank-you in the next mail tick`) or what you must do (`You: Needs your answer: reply in Gmail yourself`).

## Every mail that needs you is on the dashboard Inbox

Until now an email reply that needed you was announced once on Telegram and never reached the dashboard (only the LinkedIn, Naukri and Wellfound operators wrote Inbox rows). Now each mail with `needs_you = 1` also becomes one Inbox card (platform `email`, one card per Gmail thread, group "Replies and needs you", severity CRITICAL, `escalateOwnerReplies` in `src/outreach/emailEscalations.ts`, run right after every reply check, whatever the auto reply flag says). A mail the agent answered or only recorded is not a card.

## When you answer by hand in Gmail or on your phone

The reply check reads `-in:sent`, so it could not see your own answers. Now `reply-watcher` also searches `in:sent newer_than:30d`, reads the messages that are not one of our recorded sends and passes them to `db.triage_replies` as `sent`. Code (`src/outreach/ownerHandled.ts`) keeps a message only when it is in a Gmail thread we sent into, its id is not one of our own cold emails, follow-ups or automatic replies, and it is dated after our last send in that thread (an undated one counts, to fail closed). It is stored in `owner_handled`. From then on that job gets no automated email, follow-up, nudge or automatic reply, its drafted and approved follow-ups and any approved automatic reply of the thread are cancelled. Known limit: an answer you wrote from Gmail before our last send in the thread is not seen, and only the last 30 days of Sent mail (50 hits per check) are searched.

## Turn it on

1. Run `npm run user-data -- init` if `user-data/reply-facts.json` does not exist yet (it copies the template and never overwrites).
2. Open `user-data/reply-facts.json` and fill the values. Each one is a short phrase on one line, written by you: no link, no `@`, no long dash. Example: `"current_ctc": "12 LPA fixed"`, `"notice_period": "30 days"`, `"available_from": "within 30 days"` (it is read after "I am available to join"). Leave a value empty to never answer that question.
3. Check every value, then set `"confirmed": true`. While `confirmed` is not `true`, nothing is answered, and you get one notice an hour that says so.
4. Set `EMAIL_AUTO_REPLY=true` in `.env` (by hand; the agent and the dashboard never set it) and restart the scheduler.

The numbers you write are allowed in the fact gate for these replies only. They are not added to the cold email rules.

## How it works

1. The reply check (every `REPLY_CHECK_EVERY_MIN`, default 60) reads Gmail. Code classifies each new reply with fixed word lists (no model).
2. For a safe question, code builds the reply from templates and your facts, runs the style, fact and output gates, and stores it (table `email_replies`, one reply per incoming message, ever).
3. The mail drip lane sends it: inside the send window, outside quiet hours, one per run, before cold emails and follow-ups. It needs a clean, fresh mailbox check, room under the daily send counter, and the claim step right before sending. A reply is sent to the verified sender only, in the same Gmail thread, with no attachment.
4. You get a silent Telegram notice (`inbox`) with the full address, the subject, what was answered and the exact text. If something changed before sending (for example a newer message), nothing is sent and you get a loud "answer by hand" notice.

Replies sent today show in `/limits` and in the `/drip` status. Dry run records and sends nothing. The kill switch, halts and usage backoff stop it like any other email.

## Cancel a reply before it goes out

```
npm run email-replies -- list                 # drafted, approved, sending and failed replies
npm run email-replies -- show <id>            # the full text
npm run email-replies -- skip <id>            # never send it
npm run email-replies -- resolve <id> sent    # a stuck "sending" row, after you checked Gmail Sent
```

A reply that is stuck in `sending` (a run ended without confirming) is never sent again by itself. You get a notice; check Gmail Sent, then `resolve` it.

## Optional: one nudge

`EMAIL_REPLY_NUDGE=true` (also set by hand, also off by default) allows ONE nudge when the agent answered a recruiter and the recruiter then stayed silent for `EMAIL_REPLY_NUDGE_DAYS` (default 3, 1 to 30). It uses the normal follow-up path: the follow-up drafter writes it, the fact gate checks it, and the claim needs a clean mailbox check and a clean check of that thread, under the shared daily send counter.

This is the only exception to the rule that a job with a reply on file gets no follow-up (Safety rule 10). It applies only when the recruiter's one mail was answered by our own automatic reply and nothing came after: no outcome, no bounce, no owner-only mail in the thread, no reply to another job from the same address. Every other condition of rule 10 stays. At most one nudge per thread.

Safety rule 10 in `CLAUDE.md` carries this exception since 2026-11-07 (written at the owner's request). Both `EMAIL_AUTO_REPLY` and `EMAIL_REPLY_NUDGE` are on by default and off only with the word `false`; nothing is answered until `user-data/reply-facts.json` is confirmed.

## Not verified live

Classifier word lists were tested on written phrasings, not on your real mail. The Gmail `send_email` call with `threadId` was not run against a real mailbox. `inReplyTo` is not used (Gmail MCP does not expose the RFC Message-ID), so threading relies on `threadId` and the `Re:` subject. Read the first few automatic replies in Gmail Sent yourself.

## Claude improves the wording (revise step)

The code still drafts the reply from your facts, but it no longer goes out exactly as the template wrote it. Before the claim, `mail-operator` (REPLY MODE) reads the draft with `db.get_email_reply_for_revision` and may store a better wording with `db.revise_email_reply`. Then the normal claim sends exactly the stored text. The Telegram notice of a sent reply shows the exact text and says "Wording: improved by Claude inside the code gates" when it was revised. The original code draft is kept in `email_replies.draft_body` (see it with `npm run email-replies -- show <id>` or in SQLite); `revisions` counts the rewrites.

What Claude sees: the draft, which asks were made, YOUR fact values for those asks only, and a short cleaned excerpt (max 600 characters) of the recruiter's mail, labelled untrusted. It has no Gmail read tool.

What Claude may change: typos and grammar in the fact wording, politeness and tone, sentence order, a short greeting and closing, how the answer reads.

What Claude may never change (code checks every point on the new text, a failure keeps the code draft): the asked fact values (each must stay exactly as in your file), adding a fact that was not asked, any number that is not one of the asked values, links, email addresses, phone numbers, markdown or lists, non-English text, anything over 700 characters, promises or mentions of calls, meetings, dates, attachments or resume. It also re-runs the style rules, the fact gate with your reply facts and the output gate. At most 2 accepted rewrites per reply, only while the reply is still `approved` and `EMAIL_AUTO_REPLY` is not `false`.

Fallback: if a rewrite is refused, or the draft was already fine, the code draft is sent unchanged. A refusal never blocks the send. The claim, the recipient check, the daily counter and every other gate are unchanged.
