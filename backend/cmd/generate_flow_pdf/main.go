package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jung-kurt/gofpdf"
)

var pdfTR func(string) string

func tr(s string) string {
	if pdfTR == nil {
		return s
	}
	return pdfTR(s)
}

func main() {
	pdf := gofpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(10, 10, 10)
	pdf.SetAutoPageBreak(false, 0)
	pdfTR = pdf.UnicodeTranslatorFromDescriptor("")

	// ==========================================
	// PAGE 1: Architecture Overview & Phases 1-2
	// ==========================================
	pdf.AddPage()
	drawPageBackground(pdf)
	drawHeader(pdf, "UNIVERSITY & EXAM SUBSCRIPTION WORKFLOW", "End-to-End Governance, Scoped Client Review & Dual-Mode Subscription Architecture")

	// Executive Summary Box
	drawExecSummary(pdf, 36)

	// Phase 1: University Registration & Superadmin Approval
	drawPhase1(pdf, 66)

	// Phase 2: Exam Subscription & Scoped Reviewer Routing
	drawPhase2(pdf, 154)

	drawFooter(pdf, 1, 2)

	// ==========================================
	// PAGE 2: Phase 3 Approval Modes & Phase 4 Execution
	// ==========================================
	pdf.AddPage()
	drawPageBackground(pdf)
	drawHeader(pdf, "APPROVAL MODES & VENUE EXECUTION", "Dual-Mode Approval Engine, RBAC Scoping, and Operator Venue Verification")

	// Phase 3: Dual-Mode Approval Engine
	drawPhase3(pdf, 36)

	// Phase 4: Venue Execution & Center Operators
	drawPhase4(pdf, 142)

	// RBAC Matrix
	drawRBACMatrix(pdf, 202)

	drawFooter(pdf, 2, 2)

	// Save PDF
	outPath := filepath.Join("..", "..", "University_Exam_Subscription_Flow.pdf")
	if len(os.Args) > 1 {
		outPath = os.Args[1]
	}
	err := pdf.OutputFileAndClose(outPath)
	if err != nil {
		fmt.Printf("Error generating PDF: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("PDF successfully created at: %s\n", outPath)
}

func drawPageBackground(pdf *gofpdf.Fpdf) {
	// Crisp outer frame
	pdf.SetDrawColor(226, 232, 240)
	pdf.SetLineWidth(0.5)
	pdf.Rect(8, 8, 194, 281, "D")

	// Top accent bar
	pdf.SetFillColor(15, 23, 42) // Slate 900
	pdf.Rect(8, 8, 194, 2, "F")
}

func drawHeader(pdf *gofpdf.Fpdf, title, subtitle string) {
	// Top Header Container
	pdf.SetFillColor(248, 250, 252) // Slate 50
	pdf.SetDrawColor(203, 213, 225) // Slate 300
	pdf.SetLineWidth(0.4)
	pdf.RoundedRect(10, 12, 190, 20, 2, "1234", "DF")

	// Title
	pdf.SetFont("Arial", "B", 13)
	pdf.SetTextColor(15, 23, 42)
	pdf.SetXY(14, 15)
	pdf.CellFormat(140, 6, tr(title), "", 0, "L", false, 0, "")

	// Status badge
	pdf.SetFillColor(217, 249, 157) // Lime 200
	pdf.SetDrawColor(163, 230, 53)  // Lime 400
	pdf.SetTextColor(26, 46, 5)     // Lime 950
	pdf.SetFont("Arial", "B", 7.5)
	pdf.RoundedRect(162, 15.5, 34, 5.5, 1.5, "1234", "DF")
	pdf.SetXY(162, 15.5)
	pdf.CellFormat(34, 5.5, tr("ACTIVE ARCHITECTURE"), "", 0, "C", false, 0, "")

	// Subtitle
	pdf.SetFont("Arial", "", 8.5)
	pdf.SetTextColor(71, 85, 105)
	pdf.SetXY(14, 22.5)
	pdf.CellFormat(182, 5, tr(subtitle), "", 0, "L", false, 0, "")
}

func drawExecSummary(pdf *gofpdf.Fpdf, y float64) {
	pdf.SetFillColor(254, 243, 199) // Amber 100
	pdf.SetDrawColor(245, 158, 11)  // Amber 500
	pdf.SetLineWidth(0.5)
	pdf.RoundedRect(10, y, 190, 26, 2, "1234", "DF")

	pdf.SetFont("Arial", "B", 9.5)
	pdf.SetTextColor(120, 53, 15) // Amber 900
	pdf.SetXY(14, y+3)
	pdf.CellFormat(182, 5, tr("EXECUTIVE SUMMARY & CORE LIFECYCLE PIPELINE"), "", 0, "L", false, 0, "")

	// 4-Stage Horizontal Process Indicators
	steps := []struct {
		num  string
		head string
		desc string
	}{
		{"1", "Registration", "Admin registers KYC"},
		{"2", "Superadmin", "Approves University"},
		{"3", "Scoped Request", "Client Reviewer Inbox"},
		{"4", "Dual Approval", "Per-Exam or Blanket"},
	}

	w := 43.5
	for i, st := range steps {
		sx := 14.0 + float64(i)*(w+2.0)
		sy := y + 9.5

		pdf.SetFillColor(255, 255, 255)
		pdf.SetDrawColor(217, 119, 6)
		pdf.SetLineWidth(0.3)
		pdf.RoundedRect(sx, sy, w, 13.5, 1.5, "1234", "DF")

		// Circle number
		pdf.SetFillColor(180, 83, 9)
		pdf.SetTextColor(255, 255, 255)
		pdf.SetFont("Arial", "B", 7.5)
		pdf.Circle(sx+5, sy+6.5, 3.2, "F")
		pdf.SetXY(sx+2, sy+4)
		pdf.CellFormat(6, 5, st.num, "", 0, "C", false, 0, "")

		// Text
		pdf.SetFont("Arial", "B", 8)
		pdf.SetTextColor(15, 23, 42)
		pdf.SetXY(sx+10, sy+2.5)
		pdf.CellFormat(w-11, 4.5, tr(st.head), "", 0, "L", false, 0, "")

		pdf.SetFont("Arial", "", 6.8)
		pdf.SetTextColor(100, 116, 139)
		pdf.SetXY(sx+10, sy+7)
		pdf.CellFormat(w-11, 4, tr(st.desc), "", 0, "L", false, 0, "")
	}
}

func drawPhase1(pdf *gofpdf.Fpdf, y float64) {
	// Section Container
	pdf.SetFillColor(255, 255, 255)
	pdf.SetDrawColor(203, 213, 225)
	pdf.SetLineWidth(0.4)
	pdf.RoundedRect(10, y, 190, 84, 2, "1234", "DF")

	// Section Header
	pdf.SetFillColor(241, 245, 249)
	pdf.RoundedRect(10, y, 190, 8, 2, "12", "F")
	pdf.SetFont("Arial", "B", 9)
	pdf.SetTextColor(15, 23, 42)
	pdf.SetXY(14, y+1.5)
	pdf.CellFormat(180, 5, tr("PHASE 1: UNIVERSITY REGISTRATION & SUPERADMIN ACCREDITATION"), "", 0, "L", false, 0, "")

	// Step 1: Self Registration Box
	boxY := y + 12
	drawStepBox(pdf, 14, boxY, 52, 66, "1. University Registration", "Public Portal (/register)", []string{
		"• University Admin fills form",
		"• Institutional Type (College /",
		"  University / Custom Other)",
		"• AISHE code, PAN, Address",
		"• Head Email & Mobile OTPs",
		"• Uploads proof documents",
		"• Status: 'submitted'",
	}, 59, 130, 246) // Blue

	// Arrow 1
	drawArrow(pdf, 67, boxY+30, 73, boxY+30)

	// Step 2: Superadmin Review Box
	drawStepBox(pdf, 74, boxY, 56, 66, "2. Superadmin Vetting", "Platform Governance", []string{
		"• Appears in Global Queue",
		"• Superadmin verifies KYC",
		"• Cross-checks PAN & AISHE",
		"• Decision Branch:",
		"   [REJECT] -> Notifies admin",
		"   [APPROVE] -> Provisions Tenant",
		"• Status: 'approved'",
	}, 168, 85, 247) // Purple

	// Arrow 2
	drawArrow(pdf, 131, boxY+30, 137, boxY+30)

	// Step 3: Activation & Tenant Setup
	drawStepBox(pdf, 138, boxY, 58, 66, "3. Tenant Activation", "University Admin Active", []string{
		"• Organization tenant created",
		"• Magic Link sent to Head Email",
		"• Admin configures password",
		"• University Admin logs into",
		"  Admin Portal (/admin)",
		"• Ready to browse Exam Catalog",
		"• RBAC Role: 'admin'",
	}, 16, 185, 129) // Emerald
}

func drawPhase2(pdf *gofpdf.Fpdf, y float64) {
	// Section Container
	pdf.SetFillColor(255, 255, 255)
	pdf.SetDrawColor(203, 213, 225)
	pdf.SetLineWidth(0.4)
	pdf.RoundedRect(10, y, 190, 84, 2, "1234", "DF")

	// Section Header
	pdf.SetFillColor(241, 245, 249)
	pdf.RoundedRect(10, y, 190, 8, 2, "12", "F")
	pdf.SetFont("Arial", "B", 9)
	pdf.SetTextColor(15, 23, 42)
	pdf.SetXY(14, y+1.5)
	pdf.CellFormat(180, 5, tr("PHASE 2: EXAM SUBSCRIPTION REQUEST & CLIENT-SCOPED ROUTING"), "", 0, "L", false, 0, "")

	boxY := y + 12

	// Left: Exam Catalog Request
	drawStepBox(pdf, 14, boxY, 54, 66, "1. Exam Subscription Request", "University Admin Portal", []string{
		"• University browses catalog",
		"• Selects desired Exam(s)",
		"• e.g. 'NEET UG 2026' (NTA)",
		"  or 'State CET 2026' (State)",
		"• Submits subscription request",
		"• Creates pending subscription",
		"• Status: 'pending_review'",
	}, 14, 165, 233) // Sky

	// Middle: Security & Scoping Engine
	drawStepBox(pdf, 72, boxY, 56, 66, "2. Scoped Routing Engine", "Client Security Boundary", []string{
		"• System inspects Exam.ClientID",
		"• Enforces strict data scoping",
		"• Routes ONLY to Reviewer(s)",
		"  assigned to that Client",
		"• Prevents cross-client leaks",
		"• Exam Client A -> Reviewer A",
		"• Exam Client B -> Reviewer B",
	}, 234, 88, 12) // Orange

	// Arrow from Left to Middle
	drawArrow(pdf, 69, boxY+30, 71, boxY+30)

	// Right: Scoped Inboxes (Split visual)
	pdf.SetFillColor(248, 250, 252)
	pdf.SetDrawColor(203, 213, 225)
	pdf.RoundedRect(132, boxY, 64, 66, 1.5, "1234", "DF")

	pdf.SetFont("Arial", "B", 8)
	pdf.SetTextColor(15, 23, 42)
	pdf.SetXY(134, boxY+2)
	pdf.CellFormat(60, 4, tr("3. Isolated Reviewer Inboxes"), "", 0, "C", false, 0, "")

	// Client A Reviewer Box
	pdf.SetFillColor(238, 242, 255) // Indigo tint
	pdf.SetDrawColor(129, 140, 248)
	pdf.RoundedRect(135, boxY+7, 58, 26, 1.2, "1234", "DF")
	pdf.SetFont("Arial", "B", 7.5)
	pdf.SetTextColor(67, 56, 202)
	pdf.SetXY(137, boxY+8)
	pdf.CellFormat(54, 3.5, tr("Reviewer: Client A (e.g. NTA)"), "", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "", 6.5)
	pdf.SetTextColor(71, 85, 105)
	pdf.SetXY(137, boxY+12)
	pdf.MultiCell(54, 3.2, tr("• SEES: Requests for Client A exams only\n• BLIND TO: Client B exams/institutes"), "", "L", false)

	// Client B Reviewer Box
	pdf.SetFillColor(254, 242, 242) // Rose tint
	pdf.SetDrawColor(248, 113, 113)
	pdf.RoundedRect(135, boxY+36, 58, 26, 1.2, "1234", "DF")
	pdf.SetFont("Arial", "B", 7.5)
	pdf.SetTextColor(153, 27, 27)
	pdf.SetXY(137, boxY+37)
	pdf.CellFormat(54, 3.5, tr("Reviewer: Client B (State Board)"), "", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "", 6.5)
	pdf.SetTextColor(71, 85, 105)
	pdf.SetXY(137, boxY+41)
	pdf.MultiCell(54, 3.2, tr("• SEES: Requests for Client B exams only\n• BLIND TO: Client A exams/institutes"), "", "L", false)

	// Arrow from Middle to Right
	drawArrow(pdf, 129, boxY+30, 131, boxY+30)
}

func drawPhase3(pdf *gofpdf.Fpdf, y float64) {
	// Section Container
	pdf.SetFillColor(255, 255, 255)
	pdf.SetDrawColor(203, 213, 225)
	pdf.SetLineWidth(0.4)
	pdf.RoundedRect(10, y, 190, 102, 2, "1234", "DF")

	// Section Header
	pdf.SetFillColor(241, 245, 249)
	pdf.RoundedRect(10, y, 190, 8, 2, "12", "F")
	pdf.SetFont("Arial", "B", 9)
	pdf.SetTextColor(15, 23, 42)
	pdf.SetXY(14, y+1.5)
	pdf.CellFormat(180, 5, tr("PHASE 3: DUAL-MODE CLIENT REVIEWER DECISION ENGINE"), "", 0, "L", false, 0, "")

	// Sub-explanation
	pdf.SetFont("Arial", "I", 7.5)
	pdf.SetTextColor(71, 85, 105)
	pdf.SetXY(14, y+9)
	pdf.CellFormat(182, 4, tr("When the Client Reviewer inspects a request, they can choose between two flexible approval options based on board policy:"), "", 0, "L", false, 0, "")

	// Option A Card: Per-Exam Approval
	cardY := y + 14
	pdf.SetFillColor(240, 249, 255) // Sky 50
	pdf.SetDrawColor(56, 189, 248)  // Sky 400
	pdf.SetLineWidth(0.4)
	pdf.RoundedRect(14, cardY, 88, 83, 2, "1234", "DF")

	// Badge
	pdf.SetFillColor(14, 165, 233)
	pdf.SetTextColor(255, 255, 255)
	pdf.SetFont("Arial", "B", 8)
	pdf.RoundedRect(17, cardY+3, 82, 6, 1, "1234", "F")
	pdf.SetXY(17, cardY+3)
	pdf.CellFormat(82, 6, tr("OPTION A: PER-EXAM APPROVAL"), "", 0, "C", false, 0, "")

	drawOptionPoints(pdf, 17, cardY+11, 82, []string{
		"[Scope]: Granular / Single Exam",
		"[Action]: Approves ONLY the specific requested exam.",
		"[DB Update]: Inserts row into 'organization_exam_subscriptions' for this single exam_id.",
		"[Subsequent Exams]: If university later wants another exam under the same client, it triggers a NEW approval request.",
		"[Ideal For]: Specific trial runs, guest universities, or sensitive exams requiring individual clearance.",
		"[Reviewer Control]: High scrutiny per individual exam.",
	})

	// Option B Card: Blanket All-Exams Approval
	pdf.SetFillColor(236, 253, 245) // Emerald 50
	pdf.SetDrawColor(52, 211, 153)  // Emerald 400
	pdf.SetLineWidth(0.4)
	pdf.RoundedRect(106, cardY, 90, 83, 2, "1234", "DF")

	// Badge
	pdf.SetFillColor(16, 185, 129)
	pdf.SetTextColor(255, 255, 255)
	pdf.SetFont("Arial", "B", 8)
	pdf.RoundedRect(109, cardY+3, 84, 6, 1, "1234", "F")
	pdf.SetXY(109, cardY+3)
	pdf.CellFormat(84, 6, tr("OPTION B: BLANKET ALL-EXAMS APPROVAL"), "", 0, "C", false, 0, "")

	drawOptionPoints(pdf, 109, cardY+11, 84, []string{
		"[Scope]: Client-Wide Umbrella Approval",
		"[Action]: Approves the requested exam AND grants auto-access to ALL current & future exams under this Client.",
		"[DB Update]: Sets client-level approval flag ('client_organization_approvals' or auto-subscribes all client exams).",
		"[Subsequent Exams]: University can immediately subscribe to any other exam under this client with ZERO re-approval.",
		"[Ideal For]: Trusted accredited partner universities, recurring national examination cycles.",
		"[Reviewer Control]: Fast, one-click onboarding.",
	})
}

func drawOptionPoints(pdf *gofpdf.Fpdf, x, y, w float64, pts []string) {
	cy := y
	for _, p := range pts {
		parts := strings.SplitN(p, ": ", 2)
		if len(parts) == 2 {
			pdf.SetFont("Arial", "B", 7.2)
			pdf.SetTextColor(15, 23, 42)
			pdf.SetXY(x, cy)
			pdf.CellFormat(w, 4, tr(parts[0]+":"), "", 0, "L", false, 0, "")
			cy += 3.8

			pdf.SetFont("Arial", "", 6.8)
			pdf.SetTextColor(51, 65, 85)
			pdf.SetXY(x+2, cy)
			pdf.MultiCell(w-2, 3.2, tr(parts[1]), "", "L", false)
			cy += 7.2
		}
	}
}

func drawPhase4(pdf *gofpdf.Fpdf, y float64) {
	// Section Container
	pdf.SetFillColor(255, 255, 255)
	pdf.SetDrawColor(203, 213, 225)
	pdf.SetLineWidth(0.4)
	pdf.RoundedRect(10, y, 190, 56, 2, "1234", "DF")

	// Section Header
	pdf.SetFillColor(241, 245, 249)
	pdf.RoundedRect(10, y, 190, 8, 2, "12", "F")
	pdf.SetFont("Arial", "B", 9)
	pdf.SetTextColor(15, 23, 42)
	pdf.SetXY(14, y+1.5)
	pdf.CellFormat(180, 5, tr("PHASE 4: VENUE VERIFICATION & OPERATOR ASSIGNMENT"), "", 0, "L", false, 0, "")

	boxY := y + 11

	drawStepBox(pdf, 14, boxY, 54, 40, "1. Subscription Active", "Exam Unlocked", []string{
		"• Exam unlocked in University Admin",
		"• Candidate rosters & schedules",
		"  become accessible",
		"• Biometric thresholds loaded",
	}, 16, 185, 129)

	drawArrow(pdf, 69, boxY+18, 73, boxY+18)

	drawStepBox(pdf, 75, boxY, 56, 40, "2. Assign Center Operators", "Admin Operator Provisioning", []string{
		"• Admin provisions Operators",
		"• Links Operator to Venue Centres",
		"• Maps Operator to approved Exam",
		"• Writes to 'operator_exams'",
	}, 99, 102, 241)

	drawArrow(pdf, 132, boxY+18, 136, boxY+18)

	drawStepBox(pdf, 138, boxY, 58, 40, "3. Live Venue Verification", "Operator Test Center App", []string{
		"• Operators log in on Venue Laptops",
		"• Perform 1:1 Face, Fingerprint, Iris",
		"• Live comparison with TrustView/Luxand",
		"• Printable verified admit slips",
	}, 217, 119, 6)
}

func drawRBACMatrix(pdf *gofpdf.Fpdf, y float64) {
	// Table Container
	pdf.SetFillColor(255, 255, 255)
	pdf.SetDrawColor(203, 213, 225)
	pdf.SetLineWidth(0.4)
	pdf.RoundedRect(10, y, 190, 68, 2, "1234", "DF")

	// Header
	pdf.SetFillColor(241, 245, 249)
	pdf.RoundedRect(10, y, 190, 7, 2, "12", "F")
	pdf.SetFont("Arial", "B", 8.5)
	pdf.SetTextColor(15, 23, 42)
	pdf.SetXY(14, y+1.2)
	pdf.CellFormat(180, 5, tr("SECURITY & RBAC GOVERNANCE MATRIX"), "", 0, "L", false, 0, "")

	// Table Header Row
	ty := y + 8
	pdf.SetFillColor(15, 23, 42) // Navy header
	pdf.SetTextColor(255, 255, 255)
	pdf.SetFont("Arial", "B", 7.5)
	pdf.Rect(12, ty, 186, 6, "F")

	pdf.SetXY(14, ty+1)
	pdf.CellFormat(30, 4, tr("Role"), "", 0, "L", false, 0, "")
	pdf.CellFormat(40, 4, tr("Scope & Hierarchy"), "", 0, "L", false, 0, "")
	pdf.CellFormat(70, 4, tr("Permissions & Responsibilities"), "", 0, "L", false, 0, "")
	pdf.CellFormat(46, 4, tr("Visibility Isolation"), "", 0, "L", false, 0, "")

	rows := []struct {
		role  string
		scope string
		perms string
		vis   string
	}{
		{
			"Superadmin",
			"Platform Global",
			"Approve/Reject University KYC, create clients, system settings.",
			"Full platform visibility.",
		},
		{
			"Client Reviewer",
			"Client-Scoped (e.g. NTA)",
			"Approve/Reject Exam Subscriptions (Per-Exam or Blanket All-Exams).",
			"STRICT: Only requests for own client's exams.",
		},
		{
			"University Admin",
			"Organization Tenant",
			"Self-registration, request exam subscriptions, assign operators.",
			"Only own organization's exams & operators.",
		},
		{
			"Center Operator",
			"Assigned Centres/Exams",
			"Perform live Face/FP/Iris biometric candidate verification.",
			"Only assigned candidates at assigned centre.",
		},
	}

	rowY := ty + 6
	for i, r := range rows {
		if i%2 == 0 {
			pdf.SetFillColor(248, 250, 252)
		} else {
			pdf.SetFillColor(255, 255, 255)
		}
		pdf.Rect(12, rowY, 186, 12.5, "F")
		pdf.SetDrawColor(226, 232, 240)
		pdf.Line(12, rowY+12.5, 198, rowY+12.5)

		pdf.SetFont("Arial", "B", 7.5)
		pdf.SetTextColor(15, 23, 42)
		pdf.SetXY(14, rowY+1.5)
		pdf.CellFormat(30, 4, tr(r.role), "", 0, "L", false, 0, "")

		pdf.SetFont("Arial", "", 6.8)
		pdf.SetTextColor(51, 65, 85)
		pdf.SetXY(44, rowY+1.5)
		pdf.CellFormat(40, 4, tr(r.scope), "", 0, "L", false, 0, "")

		pdf.SetXY(84, rowY+1.5)
		pdf.MultiCell(68, 3.2, tr(r.perms), "", "L", false)

		pdf.SetXY(154, rowY+1.5)
		pdf.MultiCell(42, 3.2, tr(r.vis), "", "L", false)

		rowY += 12.5
	}
}

func drawStepBox(pdf *gofpdf.Fpdf, x, y, w, h float64, title, subtitle string, lines []string, r, g, b int) {
	pdf.SetFillColor(255, 255, 255)
	pdf.SetDrawColor(r, g, b)
	pdf.SetLineWidth(0.4)
	pdf.RoundedRect(x, y, w, h, 1.5, "1234", "DF")

	// Top Title banner
	pdf.SetFillColor(r, g, b)
	pdf.RoundedRect(x, y, w, 6.5, 1.5, "12", "F")
	pdf.SetFont("Arial", "B", 7.5)
	pdf.SetTextColor(255, 255, 255)
	pdf.SetXY(x+1, y+1)
	pdf.CellFormat(w-2, 4.5, tr(title), "", 0, "C", false, 0, "")

	// Subtitle
	pdf.SetFont("Arial", "I", 6.2)
	pdf.SetTextColor(100, 116, 139)
	pdf.SetXY(x+2, y+7.5)
	pdf.CellFormat(w-4, 3.5, tr(subtitle), "", 0, "C", false, 0, "")

	// Separator line
	pdf.SetDrawColor(226, 232, 240)
	pdf.Line(x+2, y+11.5, x+w-2, y+11.5)

	// Content lines
	pdf.SetFont("Arial", "", 6.6)
	pdf.SetTextColor(30, 41, 59)
	cy := y + 13
	for _, l := range lines {
		pdf.SetXY(x+2, cy)
		pdf.CellFormat(w-4, 3.4, tr(l), "", 0, "L", false, 0, "")
		cy += 3.6
	}
}

func drawArrow(pdf *gofpdf.Fpdf, x1, y1, x2, y2 float64) {
	pdf.SetDrawColor(100, 116, 139)
	pdf.SetLineWidth(0.6)
	pdf.Line(x1, y1, x2, y2)

	// Arrow head
	pdf.SetFillColor(100, 116, 139)
	pdf.Polygon([]gofpdf.PointType{
		{X: x2, Y: y2},
		{X: x2 - 2, Y: y2 - 1.5},
		{X: x2 - 2, Y: y2 + 1.5},
	}, "F")
}

func drawFooter(pdf *gofpdf.Fpdf, page, total int) {
	pdf.SetFont("Arial", "", 7)
	pdf.SetTextColor(148, 163, 184)
	pdf.SetXY(10, 282)
	pdf.CellFormat(100, 4, tr(fmt.Sprintf("Biometric Verification Platform Architecture | Generated: %s", time.Now().Format("02 Jan 2006"))), "", 0, "L", false, 0, "")

	pdf.SetXY(140, 282)
	pdf.CellFormat(60, 4, tr(fmt.Sprintf("Page %d of %d", page, total)), "", 0, "R", false, 0, "")
}
