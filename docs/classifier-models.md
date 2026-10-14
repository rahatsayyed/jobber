# Classifier models

This page covers the prompt-injection classifier that Jobber runs over untrusted text (job postings, reply mail) before a model sees it. It lists the model profiles in `config/classifier-models.json`, their licences, and how to switch or add one. It is a plain summary of what the model cards and licence files say. It is not legal advice; read the licence files yourself.

## 1. What the classifier is for

The classifier scores untrusted text for injection attempts (instructions aimed at an AI reader). The input gate blocks text scoring at or above the profile's fitted threshold. It is one layer of defence next to the code gates; it is a probabilistic filter, not a proof.

Rules that matter in practice:

- **Exactly one classifier per process.** `CLASSIFIER_MODEL` picks the profile and it loads once. There is no fallback chain. Changing profile needs a restart of every MCP server and session that loaded the old one.
- **`CLASSIFIER_MODEL` unset fails closed.** There is no implicit default; `resolveProfile` and the selector refuse with a message listing the known profile ids.
- **The shipped default is not fully pinned yet.** Some files carry only a sha1 or no hash until the owner runs `npm run models -- pin <id>`. The loader refuses until the model is pinned.
- **An unfitted profile is refused in send paths.** It only runs, at a placeholder threshold of 0.5, in dry runs (`JOBBER_DRY_RUN=1`). Fit it with `npm run classifier:fit` first.
- **A gated profile is never fetched** by this project.
- **Downloads** come only from `huggingface.co` / `hf.co` hosts (including subdomains), over https, at the pinned revision, with no token.

## 2. Profiles

| | `protectai-deberta-v3-base-v2` (default) | `llama-prompt-guard-2-22m` |
|---|---|---|
| Licence | Apache-2.0, https://www.apache.org/licenses/LICENSE-2.0 | Llama 4 Community License, https://www.llama.com/llama4/license/ |
| Gated | no | yes, manual approval |
| Fetchable by `models fetch` | yes | no |
| Size | about 738 MB model (fp32 ONNX), about 750 MB in total | placeholder in config (sizes are 0); depends on your export |
| Languages | English only (`en`) | en, fr, de, hi, it, pt, es, th (22M quality lower than 86M) |
| Detects | prompt injection | prompt injection and jailbreak style attacks (per the Meta card) |
| Does not detect | jailbreaks; not meant for system prompts (false positives) | n/a until you supply and evaluate your export |
| Source | https://huggingface.co/protectai/deberta-v3-base-prompt-injection-v2 | https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-22M (no ONNX upstream) |
| Pinned revision | `90c9989b1a342275dd0d1a95aad283c04e075671` | placeholder `0123456789abcdef0123456789abcdef01234567`, replace with the commit you exported from |

The Prompt Guard 2 entry is a stub: `fetch` rejects the placeholder revision and `doctor` flags it.

## 3. Licence summary

Summary of what the cards and licence files say. Not legal advice. Read the licence files yourself.

- **protectai-deberta-v3-base-v2, Apache-2.0.** Keep the licence text and notices. This project does not redistribute weights; each user downloads them. `npm run models -- fetch` prints the attribution line: "Model by ProtectAI ..., based on microsoft/deberta-v3-base, licensed under Apache-2.0." The repo `LICENSE` is downloaded with the model. The licences of the training datasets behind it were not checked.
- **llama-prompt-guard-2-22m, Llama 4 Community License.** You request access with your own Hugging Face account and export or obtain the ONNX yourself. Display "Built with Llama" as the licence requires. Weights are not redistributed or fetched by this project. Read the licence for terms beyond this summary.

## 4. How to switch

Manual route (works today):

1. `npm run models -- list` shows the profiles and their state.
2. Ungated profile: `npm run models -- fetch <id>` (asks before downloading; `--yes` skips the prompt). Gated profile: follow its `manual_steps` in the config and place the files in `models/<id>/`.
3. `npm run models -- pin <id>` records sha256 for the files on disk. Review the diff of `config/classifier-models.json` before committing it.
4. Set `CLASSIFIER_MODEL=<id>` in `.env`.
5. `npm run classifier:fit -- --profile <id> --write` fits and stores the threshold for that profile. Thresholds are per profile and are not carried over.
6. `npm run doctor` checks the selected profile, its hashes, the fit and a smoke inference (`classifier_model`, `classifier_smoke`).
7. Restart the MCP servers and sessions; the model loads once per process.

Guided route: `npm run setup -- --step classifier` does steps 2 to 4 for you. It shows the licence, attribution, limitations and size, downloads only after you answer yes (ungated profiles), verifies the files, runs a smoke inference (benign must score below 0.5, an injection at or above 0.5) and then writes `CLASSIFIER_MODEL` to `.env`. It never pins files for you: if it reports unpinned files, run `npm run models -- pin <id>` and review the registry diff, then rerun the step. Gated or owner-supplied profiles are never fetched and the step never asks for a token. The step does not fit a threshold; run step 5 afterwards (sends are refused until a fit exists, dry runs work).

## 5. Adding a profile

Copy an existing object under `profiles` in `config/classifier-models.json` and set:

- `id` (same as the key), `title`, `gated`, `fetchable`, `repo`, `revision`.
- `licence` with `id`, `name`, `url`, `attribution`, `redistribution`; plus `limitations` and `languages`.
- `files`: for each `remote` path, the `local` name, `role` (`model`, `tokenizer`, `config`, `licence`, `extra`), `size`, and `sha256` / `git_blob_sha1`.
- `labels`, `malicious_label`, `max_tokens`, `stride`, `max_chunks`, `special_tokens`, `inputs`, `output`, and `fit: { "threshold": null }`.

Why `revision` must be a full commit hash: a branch or tag can move, so the same name could later serve different weights. A commit hash makes the download reproducible and lets the pinned hashes mean something.

Reading sizes and hashes: open `https://huggingface.co/api/models/<repo>?blobs=true`. Each file entry has `size`, `blobId` (the git blob sha1) and, for LFS files, `lfs.sha256`. Non-LFS files have no sha256 there; `models pin` computes it from the downloaded file. Fit the new profile before any send path uses it.

## 6. Known limits

- The default is English only and does not detect jailbreaks. Arabic or Hindi injections in Gulf postings are not covered by it.
- The upstream ProtectAI repo is archived; no fixes are expected.
- Vendor metrics are on the vendor's prompt mix, not on job postings. Only the held-out fit on the owner's corpus counts, and that corpus is small until extended.
- Memory (about 1 GB expected for the fp32 base model) and latency are unmeasured; the 500 ms p95 target may be missed on a small VPS.
- Redirects are followed only to allowlisted Hugging Face hosts. A CDN on another host is refused with a message naming it; widening the allowlist is a code change.
- Tokenizer loading and the ONNX input names (`input_ids`, `attention_mask`) are unverified until the first real model load.
- Non-LFS files are sha1-pinned only until `models pin` runs.
- A fit is bound only to the model file's sha256, not to the other scoring-relevant profile fields (max_tokens, stride, max_chunks, special_tokens, labels, inputs/output, tokenizer and config digests). After changing any of them the owner must refit; the loader does not detect it.
- Dry run is the env var `JOBBER_DRY_RUN=1` alone, and nothing in `src` makes such a process non-sending. Never set `JOBBER_DRY_RUN=1` in a process that can send; the unfitted-at-0.5 path is only as safe as that.
