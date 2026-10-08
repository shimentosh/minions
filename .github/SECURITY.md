# Security policy

Minions stores people's most sensitive data. We take every report seriously.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub:
**[Report a vulnerability](https://github.com/shimentosh/minions/security/advisories/new)**
(Security tab → Report a vulnerability).

Please include:

- what an attacker can do, and which component (web app, API, extension, desktop, core crypto);
- steps to reproduce, or a proof of concept;
- the commit or version you tested.

We aim to acknowledge reports within **3 days**, to share an assessment within **10 days**,
and to credit you in the advisory once a fix is released, unless you prefer to stay anonymous.

## Scope

In scope: anything that lets someone read or change vault data they should not, bypass
authentication, 2FA, locking or rate limits, recover keys or plaintext from the server,
database, logs or backups, or make the extension fill credentials on the wrong site.

Known, documented limits are listed in [THREAT_MODEL.md](../THREAT_MODEL.md) under
*Residual risks*; reports that improve on them are welcome.

## Supported versions

Only the latest commit on `main` receives security fixes.

## Good faith

We will not pursue legal action for research done in good faith: test only against your
own installation and accounts, do not access other people's data, and give us reasonable
time to fix the issue before disclosure.
