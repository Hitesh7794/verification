# `client-bootstrap/` — operator-laptop install bundle

This directory builds the **single-command install bundle** IT runs on
each operator laptop. The bundle takes a fresh Windows machine from
"no software" to "browser opens with the portal homepage and all three
vendor daemons listening on `:8030`, `:8031`, and `:4443`/`:8090`".

```
client-bootstrap/
└── windows/       → VerificationPortalClient-<ver>-windows.zip
```

Operator laptops are Windows in every deployment we run today. Linux
support (which used to live under `client-bootstrap/linux/`) was
retired in Aug 2026 — no field deployment ever used it and the vendor
biometric SDKs (MorFin, Marvis, ACPL) are all Windows-first, with the
iris SDK now being Windows-only for its supported native path. See
[`windows/README.md`](./windows/README.md) for build + install details
and [`../IRIS_NOTES.md`](../IRIS_NOTES.md) for the iris story.

## Why a bundle and not an APT/`winget` repo?

Operator centres often have unreliable internet, and IT is typically
handed a USB stick, not a managed deployment pipeline. A self-contained
bundle that installs in one command from a thumb drive is the lowest-
friction install story.

For a future fleet-managed deployment (Intune / SCCM) the same
`install.ps1` runs as a custom-action MSI wrapper — the script is the
source of truth.
