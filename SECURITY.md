# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository
(private vulnerability reporting). Do not open a public issue, pull request
or discussion for a suspected vulnerability.

A useful report says what an attacker can do, what they need first (a link,
an account, a position on the network), and the steps to show it. A proof of
concept against your own local instance is welcome; please do not test
against instances you do not run.

This is a one-person project. Expect an acknowledgement within a week; a fix
lands as an ordinary commit on `main`, and the advisory is published once a
fixed release exists.

## What is in scope

- The code in this repository: the web app, the reconcile loop, the mail
  path, and both deployment targets under `deploy/`.
- Published container images and Worker bundles built from it.

Especially interesting: anything that lets someone act as another person
(answer, sign in, or see a private event), read another group's data, use the
instance to send mail to arbitrary addresses, or get a token or event content
into a log.

## What is not

- Instances run by other people. Report to whoever runs them.
- Denial of service by raw volume, and missing hardening headers with no
  demonstrated impact.
- Findings in development-only dependencies that never reach a published
  artifact.

## Supported versions

Only the latest published release. There are no long-term branches.
