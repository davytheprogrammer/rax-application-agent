# Security and privacy

Kito is an autonomous local agent with broad access. Understand the boundary before using it with sensitive applications.

## What Kito can access and send

- It can read files your Linux user can read, write application-related text files, and run shell commands requested by the agent. Command output and runtime are bounded, but there is no per-command approval gate.
- It controls a dedicated Chrome profile. Form saves, uploads, and submissions can send data to the application site and its API or storage providers without another click.
- It sends relevant local text, application context, and compressed Chrome screenshots to the configured Meta Muse API. The curator sends answer drafts and supporting context to its configured model.
- It stores application records, screenshots, reusable knowledge, and browser login state locally under `KITO_DATA_DIR` or `~/.local/share/kito`.

Use a dedicated OS account or carefully chosen local files if you need a narrower filesystem boundary. Do not put passwords or API keys in reusable knowledge. The project `.gitignore` excludes `.env`, local browser state, records, and common personal document formats; inspect `git status` before publishing a fork.

## Untrusted pages and documents

Website text and local documents can contain instructions written by someone other than the user. Kito's model instructions tell it to treat that content as task data and to reject requests for unrelated files, secrets, or commands. This is a model-level defense, not an OS sandbox. Contributions that improve isolation or constrain tool access are welcome.

## Submission evidence

A click, network request, or reset form does not prove receipt. Kito records a successful submission only after it sees an exact confirmation phrase or identifier on the current page and saves a screenshot. A site may record a backend row without showing a success page; Kito should report the observed backend result and the missing on-page evidence separately.

## Reporting vulnerabilities

Please use GitHub's private vulnerability reporting for this repository when available. Do not post secrets, tokens, private application records, or proof of concept data from real applicants in a public issue.
