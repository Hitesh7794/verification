# Open Issues — Tech Lead Review

5 things blocking further progress. Each needs a decision; the project
is built to flex to whichever option you pick.

---

### 1. Operator-laptop OS — Linux or Windows?

We currently have **Mantra's Linux SDK** for fingerprint
(`MorfinAuth_Linux_Web_SDK`). If operators use Windows laptops, we
need to ask Mantra for the Windows equivalent (`.msi`). The web app
itself works on either — only the local SDK installer changes.

**Decision needed:** target Linux, Windows, or both?

---

### 2. SDK install model on operator PCs

Browsers cannot talk to USB devices, so a small native daemon must be
installed on each operator laptop. Options:

- **A.** IT pre-images all PCs before exam day (zero operator effort)
- **B.** Login page has a "Set up this PC" button; operator double-clicks the downloaded file once (~30 s, no admin)
- **C.** Drop fingerprint/iris entirely → pure web app, face-only via webcam (weaker identity assurance)

**Decision needed:** A, B, or C? Drives whether we ship a `.deb`/`.msi` or a self-service `.AppImage`/`.exe`.

---

### 3. DNS name for the server

The EC2 box (`13.201.188.54`) has no domain pointed at it yet. We
need one because:
- TLS via Let's Encrypt requires a real DNS name
- Browser webcam access (`getUserMedia`) only works over HTTPS

Anything works: `verify.example.com`, `neet.something.in`, free
DuckDNS, etc.

**Decision needed:** which DNS name?

---

### 4. Match score threshold (calibration)

Mantra's SDK returns a `MatchScore` but doesn't publish the range or
recommended threshold. We've defaulted to **60** as a placeholder —
it's a guess, not a calibrated value. Real-world calibration needs
~20 sample captures against known matches/non-matches once we have a
device in hand.

**Decision needed:** OK to launch with 60 and tune later, or block
on calibration?

---

### 5. Iris 1:1 matching is officially undocumented

The `MatchImage` method exists inside Mantra's iris JAR (we verified
by reading the bytecode) but isn't in their published PDF. We've
written the wrapper assuming it's production-grade, but should confirm
with Mantra. Specifically: score range, recommended threshold,
whether the score is per-eye or combined.

**Decision needed:** OK to email Mantra (`servico@mantratec.com`) for
written confirmation? Same email can also ask about Windows SDK (#1).

---

Full architectural context is in
[`CONTEXT.md`](./CONTEXT.md); the longer question list is in
[`TECH_LEAD_QUESTIONS.md`](./TECH_LEAD_QUESTIONS.md).
