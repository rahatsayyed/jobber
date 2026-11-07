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
