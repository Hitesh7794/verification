# Standard Operating Procedure
## Innovatiview Verification Portal

| **Document ID** | SOP-VP-001 | **Version** | 1.0 |
|---|---|---|---|
| **Document owner** | Head of Platform | **Approved by** | Head of Platform · Compliance |
| **Classification** | Internal | **Distribution** | All engagement teams |

---

## Contents

1. Policy
2. Purpose
3. Scope
4. Responsibilities
5. Definitions
6. Procedure
7. Effectiveness Criteria
8. Records
9. Escalation
10. Compliance and Handover
11. Approvals

---

## 1.0 Policy

Innovatiview represents the Verification Portal to prospective
customers in a way that protects prospect data, sets accurate
expectations of the product, and hands over cleanly to the Platform
team once a contract is signed. This engagement work sits ahead of
live operation and is distinct from it.

---

## 2.0 Purpose

This SOP standardises how the team engages with prospective
customers so that:

- Every prospect gets the same quality of demo and technical
  discovery regardless of who runs the session.
- Every pilot / proof-of-concept is scoped, delivered, and closed
  out on a defined timeline.
- Every won deal transitions to the Platform team with the same
  package of prospect context, sign-offs, and configuration.
- No prospect commitment is made that cannot be delivered by the
  Platform team post-close.

---

## 3.0 Scope

This SOP applies to:

- All prospect engagement for the Innovatiview Verification Portal —
  exam-board sales cycles, institute-level pilots, RFP responses.
- All staff running a technical or commercial conversation with a
  prospect.
- The full lifecycle from initial qualification through post-close
  handover to the Platform team.

---

## 4.0 Responsibilities

| Role | Primary responsibility |
|---|---|
| **Engagement Lead** | Owns this SOP. Approves demo environments, pilot scoping, and post-close handover. |
| **Solutions Engineer** | Runs technical demos, discovery sessions, and pilot setup on the sandbox environment. First technical contact for the prospect. |
| **Account Executive** | Owns the commercial relationship. Coordinates timing of demos, pilots, and legal review. Signs off on any commitment made to the prospect. |
| **Platform Team** | Receives the post-close handover. Not involved before handover except when consulted for a technical question the Solutions Engineer cannot answer. |
| **Compliance** | Signs off on any data-handling commitment made to the prospect and on the pilot-close disposal step. |

Detailed decision authority is captured in § 11 (Approvals matrix).

---

## 5.0 Definitions

| Term | Meaning |
|---|---|
| **Prospect** | An exam board or institute engaged in a sales conversation, before a contract is signed. |
| **Sandbox** | A demo-and-pilot Data Plane the Solutions Engineer uses to show the product live. Fully isolated from production. |
| **Pilot / POC** | A time-boxed evaluation where the prospect runs real (or synthetic) candidates through the Verification Portal on the sandbox. |
| **Discovery** | The structured technical conversation that captures the prospect's exam scale, biometric requirements, KYC review preference, and integration constraints. |
| **Discovery Pack** | The written summary of the discovery session — the artefact handed to the Platform team at post-close handover. |
| **Handover** | The formal transition from the engagement team to the Platform team once a contract is signed. |
| **Exam board** | The customer type that runs verifications for its own examinations — e.g. NTA, SSC, UPSC. |
| **Institute** | A university or college that enrols candidates through an exam board on the Verification Portal. |
| **Review mode** | The KYC review rule chosen at exam-board level: Admin (Innovatiview reviews), Client (the board reviews), Both (both, in sequence). |
| **Verification agent** | The end-user on exam day who scans candidates and runs biometric matches. |
| **Wallet** | The prepaid balance model that debits per candidate lookup and per biometric match. Relevant to commercial framing. |

---

## 6.0 Procedure

The engagement workflow has six standard stages. Each stage is a
self-contained subsection with prerequisites, steps, and outcome
criteria.

### 6.1 Prospect qualification

**Prerequisites**

- Inbound lead or Account Executive introduction has landed.
- Basic prospect context: organisation name, scale of examinations,
  geography.

**Procedure**

| Step | Actor | Action |
|---|---|---|
| 1 | Account Executive | Records the lead in the CRM and forwards the summary to the Solutions Engineer. |
| 2 | Solutions Engineer | Reviews the summary; drafts three qualifying questions covering annual exam volume, current identity-verification method, and preferred KYC review model. |
| 3 | Account Executive | Runs the qualification call. Captures answers and any regulatory or procurement constraints. |
| 4 | Solutions Engineer | Records a Go / No-Go recommendation in the CRM opportunity. |
| 5 | Account Executive | Decides whether to progress to Discovery (§ 6.2) or close as unqualified with a written reason. |

**Outcome**

- CRM opportunity is either progressed to Discovery or closed with a
  documented reason.

---

### 6.2 Discovery and demo

**Prerequisites**

- Prospect is Qualified.
- Demo slot is booked with named attendees.

**Procedure**

| Step | Actor | Action |
|---|---|---|
| 1 | Solutions Engineer | Refreshes the sandbox with a clean dataset (see § 6.3 Prerequisites). |
| 2 | Solutions Engineer | Runs the standard demo flow: institute registration → KYC review → verification-agent enrolment → live candidate verification (face + fingerprint). |
| 3 | Solutions Engineer | Runs the discovery questionnaire covering: annual exam count, candidate count per exam, biometric requirements (face / fingerprint / iris), KYC review preference, integration touchpoints, data-residency requirements. |
| 4 | Account Executive | Captures commercial signals: budget, decision timeline, competing options. |
| 5 | Solutions Engineer | Writes the Discovery Pack summarising both the technical and commercial answers, and uploads it to the CRM opportunity within one business day. |

**Outcome**

- Discovery Pack is filed in the CRM.
- The prospect has seen a working end-to-end demo and can articulate
  the product's fit for their use case.

---

### 6.3 Pilot / POC provisioning

**Prerequisites**

- Discovery Pack is filed.
- Mutually agreed pilot scope (candidate count, duration, success
  criteria) is captured in a Pilot Agreement, signed by the
  prospect and countersigned by the Engagement Lead.
- Compliance has signed off on any prospect-supplied data that will
  land on the sandbox.

**Procedure**

| Step | Actor | Action |
|---|---|---|
| 1 | Solutions Engineer | Creates a pilot workspace on the sandbox Data Plane. Uses the standard pilot template so no bespoke changes are needed. |
| 2 | Solutions Engineer | Registers the prospect as a Pilot institute; walks their point-of-contact through the KYC flow live. |
| 3 | Solutions Engineer | Enrols a small set of pilot verification agents nominated by the prospect. |
| 4 | Solutions Engineer | Runs a joint smoke test with the prospect: one full candidate verification end-to-end. |
| 5 | Solutions Engineer | Hands over the pilot access details and a written pilot brief (dates, success criteria, support contact, disposal date). |

**Outcome**

- Pilot is live on the sandbox with a fixed start and end date.
- The prospect can run pilot candidates without further engagement-team
  intervention.

---

### 6.4 Pilot support

**Prerequisites**

- Pilot is live (§ 6.3).

**Procedure**

| Step | Actor | Action |
|---|---|---|
| 1 | Solutions Engineer | Checks the pilot dashboard weekly; captures throughput, match-rate, wallet consumption. |
| 2 | Solutions Engineer | Runs a mid-pilot review call to surface friction points and confirm the success criteria are on track. |
| 3 | Solutions Engineer | Escalates any technical blocker to the Platform team through the internal engagement channel. Never gives the prospect a Platform-team contact directly. |
| 4 | Account Executive | Maintains the commercial conversation in parallel: pricing questions, contract terms, procurement paperwork. |

**Outcome**

- Pilot progresses to a Close call with either a Go decision or a
  documented reason to walk away.

---

### 6.5 Pilot close and disposal

**Prerequisites**

- Pilot end date reached (or a decision made to end it early).

**Procedure**

| Step | Actor | Action |
|---|---|---|
| 1 | Solutions Engineer | Convenes the Close call with the prospect. Reviews results against the Pilot Agreement's success criteria. |
| 2 | Account Executive | Captures the decision: Go (progress to contract), Extend (revise the agreement), or Close (no fit). |
| 3 | Solutions Engineer | On any outcome, disables all pilot agents and removes the pilot institute from the sandbox within five business days of the Close call. |
| 4 | Compliance | Confirms that all prospect-supplied data (KYC documents, candidate photos, personal identifiers) has been purged from the sandbox and its object storage. |
| 5 | Solutions Engineer | Files the Close Report on the CRM opportunity, including the disposal confirmation. |

**Outcome**

- The pilot is fully wound down.
- No prospect data remains on the sandbox after Compliance sign-off.

---

### 6.6 Post-close handover

**Prerequisites**

- Signed contract is in place.
- Kick-off date agreed with the prospect (now the client).

**Procedure**

| Step | Actor | Action |
|---|---|---|
| 1 | Account Executive | Notifies the Platform team's intake contact that a new client is ready for onboarding. |
| 2 | Solutions Engineer | Prepares the Handover Pack: Discovery Pack, Pilot Agreement, Close Report, agreed KYC review mode, agreed data-residency scope, verification-window commitments, wallet pricing, any bespoke terms. |
| 3 | Solutions Engineer + Platform Team | Runs a handover call. Walks the Platform team through every entry in the Handover Pack. |
| 4 | Engagement Lead | Signs off the handover in the CRM. |
| 5 | Platform Team | Assumes responsibility. All future technical execution is theirs; the engagement team exits the working thread. |

**Outcome**

- The client is transitioned from a engagement opportunity to a
  Platform-team engagement.
- engagement role narrows to the post-sale relationship touchpoints
  (quarterly reviews, expansion) that fall under Account Management.

---

## 7.0 Effectiveness Criteria

The following metrics track SOP effectiveness. Engagement Lead
reviews them monthly; deviations trigger a coaching or process
review.

| Metric | Target | Data source |
|---|---|---|
| Qualified-to-Demo conversion | ≥ 70 % | CRM opportunity stages |
| Discovery Pack filed within 1 business day of demo | ≥ 95 % | CRM audit |
| Pilot-to-signed-contract conversion | ≥ 40 % | CRM opportunity stages |
| Pilot disposal completed within 5 business days of Close call | 100 % | Compliance log |
| Handover Pack completeness (spot check) | 100 % of fields populated | Quarterly Engagement Lead review |
| Prospect satisfaction (post-demo survey) | ≥ 4.2 / 5 | Post-demo survey |
| Prospect data purged after pilot close | 100 % | Compliance sign-off |

---

## 8.0 Records

The following records are generated by executing this SOP.

| Record | Where kept | Retention |
|---|---|---|
| CRM opportunity + stage history | CRM | 7 years post-close |
| Discovery Pack | CRM opportunity attachment | 7 years |
| Pilot Agreement (signed) | Contract repository | 10 years |
| Pilot dashboard snapshots | Shared drive | 5 years |
| Close Report | CRM opportunity attachment | 7 years |
| Compliance disposal sign-off | Compliance ledger | 10 years |
| Handover Pack | CRM opportunity attachment + shared with Platform team | 7 years |

---

## 9.0 Escalation

| Situation | First contact | If unresolved in |
|---|---|---|
| Prospect asks for a commitment outside standard terms | Solutions Engineer | Same day → Account Executive → Engagement Lead |
| Technical question the Solutions Engineer cannot answer | Solutions Engineer | 1 business day → Platform team via internal engagement channel |
| Prospect reports a defect on the sandbox | Solutions Engineer | Same day → Platform team |
| Pilot slipping the agreed end date | Solutions Engineer | 3 business days → Account Executive + Engagement Lead |
| Suspected data-handling concern raised by prospect | Solutions Engineer | Immediate → Compliance + Engagement Lead |
| Bespoke commercial ask (custom pricing, custom feature commit) | Account Executive | Same day → Engagement Lead |

Any escalation is logged on the CRM opportunity even if resolved
before reaching the next level.

---

## 10.0 Compliance and Handover

- No prospect-supplied data may be moved from the sandbox to any
  other environment. If a prospect requests it, the request is
  escalated to Compliance.
- No promise about the platform's technical behaviour is made to a
  prospect unless it is verifiable in a live demo or explicitly
  agreed with the Platform team in advance.
- Every pilot ends with a Compliance sign-off that prospect data has
  been purged from the sandbox.
- The Handover Pack is the single source of truth for post-close
  configuration. Anything not in the Handover Pack is not a
  commitment.

Quarterly, Engagement Lead and Compliance jointly review a random
sample of five closed opportunities to confirm each ended with a
proper disposal and a complete Handover Pack (or a documented reason
for its absence). Findings feed the next leadership review.

---

## 11.0 Approvals Matrix

| Action | Approver |
|---|---|
| Progress a Qualified prospect to Discovery | Account Executive |
| Book a demo on the sandbox | Solutions Engineer |
| Provision a Pilot | Engagement Lead + Compliance |
| Any bespoke commercial commitment to a prospect | Engagement Lead |
| Any bespoke technical commitment to a prospect | Engagement Lead + Platform Team |
| Extend a pilot past its agreed end date | Engagement Lead |
| Close a prospect as No Fit | Account Executive |
| Sign off the Handover Pack | Engagement Lead |
| Amend this SOP | Owner + all Approvers listed on the cover |

---

*Document control*: The electronic copy under `docs/sop/` in the
platform repository is the authoritative version. Printed copies are
uncontrolled and expire on the date of printing. Any proposed change
must be submitted through a change request tagged `sop-vp` and
approved by the Owner and Approvers listed on the cover.

*End of SOP-VP-001 v1.0.*
