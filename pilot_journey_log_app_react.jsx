"use client";

import React, { useEffect, useMemo, useState } from "react";
import { jsPDF } from "jspdf"; // use core jsPDF only (no autotable)
import { Plus, Trash2, Download, Upload, Clock, Eraser, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// ========================
// Pilot Journey Log — Simple V2 (JavaScript version)
// ========================
// Columns: Load , T/O , L/D , FLT/T (auto), BLK/T (manual), FOB (lbs), F/B (lbs), PAX, LDG, F/UP, REMARKS
// Features:
// - Ferry row is optional; use "Add Ferry Row" to insert one
// - Start with no rows; add rows via buttons
// - Add Load Row button always after last row
// - Clear button per row; Delete available for all rows (including FERRY)
// - "Now" buttons for T/O & L/D
// - Header (PILOT, DZ, REG, DATE) above Totals & Duty
// - Totals card shows Flights, PAX, LDG, FLT/T + FOB (Start)/(last)
// - Duty fields independent (DUTY START/END → PILOT DUTY TIME)
// - CSV import/export
// - LocalStorage persistence
// - Close Flight → locks sheet + shows banner; Print & Download PDF appear when closed

/** @typedef {Object} SimpleLogEntry
 *  @property {string} id
 *  @property {string} Load
 *  @property {string} ["T/O"]
 *  @property {string} ["L/D"]
 *  @property {string} ["FLT/T"]
 *  @property {string} ["BLK/T"]
 *  @property {string} FOB
 *  @property {string} ["F/B"]
 *  @property {number|string} PAX
 *  @property {number|string} LDG
 *  @property {string} ["F/UP"]
 *  @property {string} REMARKS
 */

const COLS = [
  "Load", "T/O", "L/D", "FLT/T", "BLK/T", "FOB", "F/B", "PAX", "LDG", "F/UP", "REMARKS",
];

const LS_KEY = "pilotJourneyLog.simple.v2";
const LS_META_KEY = "pilotJourneyLog.simple.v2.meta";
const FERRY_ID = "ferry-row-fixed"; // optional ferry row id

function uid() { return Math.random().toString(36).slice(2, 10); }

function hmToMinutes(hm) {
  if (!hm) return 0;
  const m = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h * 60 + min;
}

function minutesToHM(mins) {
  const a = Math.max(0, mins | 0);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return h.toString().padStart(2, "0") + ":" + m.toString().padStart(2, "0");
}

function calcBlock(to, ld) {
  if (!to || !ld) return "";
  const start = hmToMinutes(to);
  let end = hmToMinutes(ld);
  if (!start || !end) return "";
  if (end < start) end += 24 * 60; // crossed midnight
  return minutesToHM(end - start);
}

function calcDuty(start, end) {
  if (!start || !end) return "";
  let s = hmToMinutes(start);
  let e = hmToMinutes(end);
  if (!s || !e) return "";
  if (e < s) e += 24 * 60;
  return minutesToHM(e - s);
}

function nowHHMM() {
  const d = new Date();
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return h + ":" + m;
}

function makeInitialRows() {
  // start empty; user can add Ferry or Load rows
  return [];
}

// Compute next sequential load number (skips FERRY, ignores non-numeric Load values)
/** @param {SimpleLogEntry[]} all */
function nextLoadNumber(all) {
  const nums = (all || [])
    .filter(x => x && x.id !== FERRY_ID)
    .map(x => Number(String(x.Load).trim()))
    .filter(n => Number.isFinite(n));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

// Remove legacy seeded 1..19 blank rows (and drop a blank ferry) on load (migration)
/** @param {SimpleLogEntry[]} rows */
function migrateSavedRows(rows) {
  if (!Array.isArray(rows)) return [];
  if (rows.length === 0) return [];
  // Drop ANY pre-existing ferry row so the sheet always starts without one.
  const withoutFerry = rows.filter(r => r && r.id !== FERRY_ID);
  // Also strip legacy seeded 1..19 all-blank rows (old template)
  const isBlankRow = (r) => (
    r["T/O"] === "" && r["L/D"] === "" && r["FLT/T"] === "" && r["BLK/T"] === "" && r.FOB === "" && r["F/B"] === "" && r.PAX === "" && r.LDG === "" && r["F/UP"] === "" && r.REMARKS === ""
  );
  const allBlankNumbered = withoutFerry.length > 0 && withoutFerry.every(r => {
    const n = Number(String(r.Load));
    return Number.isFinite(n) && n >= 1 && n <= 19 && isBlankRow(r);
  });
  if (allBlankNumbered) return [];
  return withoutFerry;
}

/** @param {SimpleLogEntry} row */
function clearEntry(row) {
  return { ...row, "T/O": "", "L/D": "", "FLT/T": "", /* BLK/T manual */ "BLK/T": row["BLK/T"], FOB: "", "F/B": "", PAX: "", LDG: "", "F/UP": "", REMARKS: "" };
}

// Build the printable HTML (pure string) so we can test it and print via iframe (no popups)
function buildPrintHTML(meta, rowsForPrint) {
  const style = [
    '<style>',
    'body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; font-size:12px;}',
    'h1{font-size:18px;margin:0 0 8px 0}',
    'table{width:100%;border-collapse:collapse}',
    'th,td{border:1px solid #000;padding:4px;text-align:left}',
    '.meta{margin:8px 0 12px 0;display:flex;gap:12px;flex-wrap:wrap}',
    '.meta div{padding:6px 8px;border:1px solid #ccc;border-radius:8px}',
    '</style>'
  ].join("");
  const header = '<h1>Pilot Journey Log — Simple (V2)</h1>';
  const metaBlock = [
    '<div class="meta">',
    '<div><strong>PILOT:</strong> ' + (meta.pilot || '') + '</div>',
    '<div><strong>DZ:</strong> ' + (meta.dz || '') + '</div>',
    '<div><strong>REG:</strong> ' + (meta.reg || '') + '</div>',
    '<div><strong>DATE:</strong> ' + (meta.date || '') + '</div>',
    '<div><strong>Flights:</strong> ' + meta.totals.flights + '</div>',
    '<div><strong>PAX:</strong> ' + meta.totals.pax + '</div>',
    '<div><strong>LDG:</strong> ' + meta.totals.ldg + '</div>',
    '<div><strong>FLT/T:</strong> ' + meta.totals.flt + '</div>',
    '<div><strong>FOB (Start):</strong> ' + (meta.fobStart || '') + ' lbs</div>',
    '<div><strong>FOB (End):</strong> ' + (meta.lastFOB || '') + ' lbs</div>',
    '</div>'
  ].join("");
  const headRow = '<thead><tr>' + COLS.map(function(c){ return '<th>' + c + '</th>'; }).join("") + '</tr></thead>';
  const bodyRows = '<tbody>' + rowsForPrint.map(function(r){ return '<tr>' + COLS.map(function(c){ return '<td>' + ((r)[c] ?? '') + '</td>'; }).join("") + '</tr>'; }).join("") + '</tbody>';
  return '<!doctype html><html><head><meta charset="utf-8"/>' + style + '</head><body>' + header + metaBlock + '<table>' + headRow + bodyRows + '</table></body></html>';
}

// Prepare matrix for PDF (no autotable plugin)
function buildPdfMatrix(meta, rowsForPdf) {
  const head = [COLS];
  const body = rowsForPdf.map(r => COLS.map(c => String((r)[c] ?? "")));
  const metaLines = [
    'PILOT: ' + (meta.pilot || ''),
    'DZ: ' + (meta.dz || ''),
    'REG: ' + (meta.reg || ''),
    'DATE: ' + (meta.date || ''),
    'Flights: ' + meta.totals.flights,
    'PAX: ' + meta.totals.pax,
    'LDG: ' + meta.totals.ldg,
    'FLT/T: ' + meta.totals.flt,
    'FOB (Start): ' + (meta.fobStart || '') + ' lbs',
    'FOB (End): ' + (meta.lastFOB || '') + ' lbs'
  ];
  return { head, body, metaLines };
}

function downloadPDF(meta, rowsForPdf) {
  const { head, body, metaLines } = buildPdfMatrix(meta, rowsForPdf);
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const marginX = 40;
  const marginY = 40;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const usableW = pageW - marginX * 2;
  const rowH = 18; // table row height
  let y = marginY;

  // Title
  doc.setFontSize(16);
  doc.text("Pilot Journey Log — Simple (V2)", marginX, y);
  y += 18;

  // Meta block
  doc.setFontSize(10);
  const lineH = 14;
  metaLines.forEach(line => { doc.text(line, marginX, y); y += lineH; });
  y += 6;

  // Compute column widths based on text widths
  doc.setFontSize(8);
  const pad = 6; // horizontal padding per cell
  const widths = new Array(COLS.length).fill(0);
  const measure = (txt) => doc.getTextWidth(String(txt));
  head[0].forEach((h, i) => { widths[i] = Math.max(widths[i], measure(h) + pad); });
  body.forEach(row => row.forEach((cell, i) => { widths[i] = Math.max(widths[i], measure(cell) + pad); }));
  const totalW = widths.reduce((a, b) => a + b, 0);
  const scale = totalW > usableW ? (usableW / totalW) : 1;
  const colW = widths.map(w => w * scale);

  // Draw header row
  let x = marginX;
  doc.setDrawColor(0);
  doc.setLineWidth(0.5);
  head[0].forEach((text, i) => {
    doc.rect(x, y, colW[i], rowH);
    doc.text(String(text), x + 3, y + 12);
    x += colW[i];
  });
  y += rowH;

  // Draw body rows with pagination
  body.forEach(row => {
    if (y + rowH > pageH - marginY) {
      doc.addPage();
      y = marginY;
      // redraw header on new page
      let xh = marginX;
      head[0].forEach((text, i) => {
        doc.rect(xh, y, colW[i], rowH);
        doc.text(String(text), xh + 3, y + 12);
        xh += colW[i];
      });
      y += rowH;
    }
    let xc = marginX;
    row.forEach((cell, i) => {
      doc.rect(xc, y, colW[i], rowH);
      const txt = String(cell);
      // simple clip: truncate long text
      let shown = txt;
      const maxW = colW[i] - 6;
      while (doc.getTextWidth(shown) > maxW && shown.length > 0) {
        shown = shown.slice(0, -1);
      }
      doc.text(shown, xc + 3, y + 12);
      xc += colW[i];
    });
    y += rowH;
  });

  const nameBits = [meta.date || "", meta.reg || "", meta.pilot || ""].filter(Boolean).join("_").split(' ').join('-');
  const filename = nameBits ? ('pilot_journey_log_' + nameBits + '.pdf') : 'pilot_journey_log.pdf';
  doc.save(filename);
}

// --- Self-tests (console) ---
function runSelfTests() {
  const tests = []; // { name, got, expected, pass }
  const push = function(name, got, expected){ tests.push({ name, got, expected, pass: JSON.stringify(got) === JSON.stringify(expected) }); };
  push("hmToMinutes 01:30", hmToMinutes("01:30"), 90);
  push("hmToMinutes bad", hmToMinutes("xx"), 0);
  push("minutesToHM 90", minutesToHM(90), "01:30");
  push("calcBlock 10:10→11:40", calcBlock("10:10", "11:40"), "01:30");
  push("calcBlock midnight", calcBlock("23:30", "00:10"), "00:40");
  push("calcDuty 07:15→18:05", calcDuty("07:15", "18:05"), "10:50");
  push("calcDuty midnight", calcDuty("22:00", "06:00"), "08:00");
  const span = calcBlock("09:00", "09:45");
  push("T/O→L/D → FLT/T", span, "00:45");
  // extra tests
  push("calcBlock missing input", calcBlock("", "09:45"), "");
  // nextLoadNumber tests
  const tmp = [ { id: "a", Load: "1" }, { id: "b", Load: "2" } ];
  push("nextLoadNumber [1,2] → 3", nextLoadNumber(tmp), 3);
  push("nextLoadNumber [] → 1", nextLoadNumber([]), 1);
  // new edge cases
  push("nextLoadNumber ignores FERRY", nextLoadNumber([{ id: FERRY_ID, Load: "FERRY" }]), 1);
  push("nextLoadNumber skips non-numeric", nextLoadNumber([{ id: "x", Load: "FERRY" }, { id: "y", Load: "7" }]), 8);
  const htmlTest = buildPrintHTML({ pilot: '', dz: '', reg: '', date: '', totals: { flights: 0, pax: 0, ldg: 0, flt: '00:00' }, fobStart: '', lastFOB: '' }, []);
  push("buildPrintHTML basic", htmlTest.indexOf('<table>') >= 0, true);
  push("buildPrintHTML columns", COLS.every(function(c){ return htmlTest.indexOf('<th>' + c + '</th>') >= 0; }), true);
  const pdfMat = buildPdfMatrix({ pilot: 'P', dz: 'DZ', reg: 'A6-XXX', date: '2025-01-01', totals: { flights: 2, pax: 10, ldg: 2, flt: '01:20' }, fobStart: '500', lastFOB: '300' }, [{ Load: '1' }, { Load: '2' }]);
  push("buildPdfMatrix head size", pdfMat.head[0].length, COLS.length);
  push("buildPdfMatrix body rows", pdfMat.body.length, 2);
  const result = tests.filter(function(t){return t.pass;}).length + "/" + tests.length + " tests passed";
  // eslint-disable-next-line no-console
  console.log("[Simple V2]", result, tests);
}

export default function PilotJourneyLogSimpleV2() {
  /** @type {SimpleLogEntry[]} */
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState("");
  const [dutyStart, setDutyStart] = useState("");
  const [dutyEnd, setDutyEnd] = useState("");

  // Header
  const [pilot, setPilot] = useState("");
  const [dz, setDz] = useState("");
  const [reg, setReg] = useState("");
  const [date, setDate] = useState("");
  const [fobStart, setFobStart] = useState(""); // manual FOB (Start) for the day
  
  // Lifecycle
  const [isClosed, setIsClosed] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const migrated = migrateSavedRows(parsed);
        setRows(migrated);
        if (JSON.stringify(parsed) !== JSON.stringify(migrated)) {
          localStorage.setItem(LS_KEY, JSON.stringify(migrated));
        }
      }
      else {
        const seeded = makeInitialRows();
        setRows(seeded);
        localStorage.setItem(LS_KEY, JSON.stringify(seeded));
      }
    } catch {
      const seeded = makeInitialRows();
      setRows(seeded);
      localStorage.setItem(LS_KEY, JSON.stringify(seeded));
    }
    try {
      const metaRaw = localStorage.getItem(LS_META_KEY);
      if (metaRaw) {
        const meta = JSON.parse(metaRaw);
        setPilot(meta.pilot || "");
        setDz(meta.dz || "");
        setReg(meta.reg || "");
        setDate(meta.date || "");
        setFobStart(meta.fobStart || "");
        setIsClosed(!!meta.isClosed);
      }
    } catch {}
    runSelfTests();
  }, []);

  useEffect(() => { localStorage.setItem(LS_KEY, JSON.stringify(rows)); }, [rows]);
  useEffect(() => { localStorage.setItem(LS_META_KEY, JSON.stringify({ pilot, dz, reg, date, isClosed, fobStart })); }, [pilot, dz, reg, date, isClosed, fobStart]);

  const pilotDuty = useMemo(() => calcDuty(dutyStart, dutyEnd), [dutyStart, dutyEnd]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => COLS.some((c) => String((r)[c] ?? "").toLowerCase().includes(q)));
  }, [rows, search]);

  // When FOB (Start) is set, copy it into the first flight row FOB if it's empty
  // Priority: first load row; if no loads exist yet, seed Ferry's FOB
  useEffect(() => {
    if (!fobStart) return;
    setRows((prev) => {
      const loads = prev.filter(r => r.id !== FERRY_ID);
      const hasLoads = loads.length > 0;
      const ferry = prev.find(r => r.id === FERRY_ID);
      let changed = false;
      const targetId = hasLoads ? loads[0].id : (ferry ? ferry.id : null);
      if (!targetId) return prev;
      const next = prev.map(r => {
        if (r.id === targetId) {
          const cur = String(r.FOB ?? "");
          if (cur === "") { changed = true; return { ...r, FOB: fobStart }; }
        }
        return r;
      });
      return changed ? next : prev;
    });
  }, [fobStart]);

  const ferryRow = filtered.find(r => r.id === FERRY_ID); // may be undefined
  const otherRows = filtered.filter(r => r.id !== FERRY_ID);

  const totals = useMemo(() => {
    const pax = otherRows.reduce((a, r) => a + (typeof r.PAX === "number" ? r.PAX : 0), 0) + (ferryRow && typeof ferryRow.PAX === "number" ? ferryRow.PAX : 0);
    const ldg = otherRows.reduce((a, r) => a + (typeof r.LDG === "number" ? r.LDG : 0), 0) + (ferryRow && typeof ferryRow.LDG === "number" ? ferryRow.LDG : 0);
    const totalMins = (ferryRow ? hmToMinutes(String(ferryRow["FLT/T"])) : 0) + otherRows.reduce((a, r) => a + hmToMinutes(String(r["FLT/T"])) , 0);
    return { pax, ldg, flt: minutesToHM(totalMins), flights: filtered.length };
  }, [filtered, ferryRow, otherRows]);

  // Mirror single FOB value from the last non-ferry load row (by current sheet order)
  const lastFOB = useMemo(() => {
    const loads = rows.filter(r => r.id !== FERRY_ID);
    if (loads.length === 0) return "";
    const v = String((loads[loads.length - 1])["FOB"] ?? "").trim();
    return v;
  }, [rows]);

  function addRow() {
    if (isClosed) return;
    setRows((r) => {
      const idxFerry = r.findIndex(x => x.id === FERRY_ID);
      const hasLoads = r.some(x => x.id !== FERRY_ID);
      const newRow = { id: uid(), Load: String(nextLoadNumber(r)), "T/O": "", "L/D": "", "FLT/T": "", "BLK/T": "", FOB: hasLoads ? "" : (fobStart || ""), "F/B": "", PAX: "", LDG: "", "F/UP": "", REMARKS: "" };
      if (idxFerry >= 0) { const copy = [...r]; copy.splice(idxFerry + 1, 0, newRow); return copy; }
      return [...r, newRow];
    });
  }

  function addFerryRow() {
    if (isClosed) return;
    setRows((r) => {
      if (r.some(x => x.id === FERRY_ID)) return r; // already present
      // Seed ferry FOB with FOB (Start) if provided
      const ferry = { id: FERRY_ID, Load: "FERRY", "T/O": "", "L/D": "", "FLT/T": "", "BLK/T": "", FOB: (fobStart || ""), "F/B": "", PAX: "", LDG: "", "F/UP": "", REMARKS: "" };
      return [ferry, ...r];
    });
  }

  function updateRow(id, key, value) {
    if (isClosed) return;
    setRows((prev) => prev.map((row) => {
      if (row.id !== id) return row;
      const next = { ...row, [key]: key === "PAX" || key === "LDG" ? (value === "" ? "" : Number(value)) : value };
      if ((key === "T/O" || key === "L/D") && (next["T/O"] || next["L/D"])) {
        const span = calcBlock(String(next["T/O"] || ""), String(next["L/D"] || ""));
        next["FLT/T"] = span || ""; // BLK/T stays manual
      }
      return next;
    }));
  }

  function setNow(id, key) { if (isClosed) return; updateRow(id, key, nowHHMM()); }
  function deleteRow(id) { if (isClosed) return; setRows((r) => r.filter((x) => x.id !== id)); }
  function clearRow(id) { if (isClosed) return; setRows((prev) => prev.map((row) => (row.id === id ? clearEntry(row) : row))); }

  function exportCSV() {
    const header = COLS.join(",");
    const body = rows.map((row) => COLS.map((c) => (row)[c] ?? "").toString()).join("\n");
    const csv = header + "\n" + body;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "pilot_journey_log_simple_v2.csv"; a.click(); URL.revokeObjectURL(url);
  }

  function importCSV(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return;
      const header = lines[0].split(",");
      const ok = COLS.every((c, i) => (header[i] ? header[i].trim() : "") === c);
      if (!ok) { alert("CSV header mismatch. Expected: " + COLS.join(", ")); return; }
      /** @type {SimpleLogEntry[]} */
      const imported = lines.slice(1).map((line) => {
        const cells = line.split(",");
        const obj = { id: uid() };
        COLS.forEach((c, i) => {
          const v = cells[i] ?? "";
          if (c === "PAX" || c === "LDG") obj[c] = v === "" ? "" : Number(v); else obj[c] = v;
        });
        const span = calcBlock(obj["T/O"], obj["L/D"]);
        if (!obj["FLT/T"]) obj["FLT/T"] = span; // BLK/T remains as-is
        if (obj.Load === "FERRY") obj.id = FERRY_ID;
        return /** @type {SimpleLogEntry} */(obj);
      });
      setRows(() => imported); // replace whole sheet
    };
    reader.readAsText(file);
  }

  function closeFlight() { setIsClosed(true); localStorage.setItem(LS_META_KEY, JSON.stringify({ pilot, dz, reg, date, isClosed: true, fobStart })); }

  function printPDF() {
    // Prefer iframe-based print to avoid popup blockers
    const html = buildPrintHTML({ pilot, dz, reg, date, totals, fobStart, lastFOB }, rows);
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow && iframe.contentWindow.document;
    if (!doc) {
      // Fallback to popup if iframe not accessible
      const win = window.open("", "_blank");
      if (win) {
        win.document.write(html);
        win.document.close();
        win.focus();
        try { win.print(); } catch {}
        try { win.close(); } catch {}
      } else {
        alert('Unable to open print preview. Please allow popups and try again.');
      }
      return;
    }
    doc.open();
    doc.write(html);
    doc.close();
    const w = iframe.contentWindow;
    setTimeout(() => {
      try { w.focus(); w.print(); } catch {}
      setTimeout(() => { try { document.body.removeChild(iframe); } catch {} }, 500);
    }, 250);
  }

  function newFlight() {
    // Start a fresh, unlocked sheet. Keep header fields; reset rows; clear isClosed.
    const fresh = makeInitialRows();
    setRows(fresh);
    setIsClosed(false);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(fresh));
      localStorage.setItem(LS_META_KEY, JSON.stringify({ pilot, dz, reg, date, isClosed: false, fobStart }));
    } catch {}
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Pilot Journey Log — Simple (V2)</h1>
          <p className="text-sm text-muted-foreground">Ferry optional • Add Ferry Row • Add Load Row • FOB/F/B in lbs • Now buttons • CSV • Local storage</p>
        </div>
        <div className="flex gap-2">
          {isClosed && (
            <Button onClick={newFlight}>
              <Plus className="h-4 w-4 mr-1" /> New Flight
            </Button>
          )}
          <Button variant="secondary" onClick={exportCSV}><Download className="h-4 w-4 mr-1"/> Export CSV</Button>
          <label className="inline-flex items-center">
            <input type="file" accept=".csv" className="hidden" onChange={(e) => e.target.files && importCSV(e.target.files[0])} />
            <Button variant="outline"><Upload className="h-4 w-4 mr-1"/> Import CSV</Button>
          </label>
        </div>
      </header>

      {isClosed && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 text-amber-900 p-3">
          <div className="font-medium">Flight Closed</div>
          <div className="text-sm">Entries are locked. Use <span className="font-medium">Print PDF</span> at the bottom to generate a printable copy, or Export CSV from the header.</div>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Quick Search</CardTitle>
          <CardDescription>Search across all fields</CardDescription>
        </CardHeader>
        <CardContent>
          <Input placeholder="Type to filter…" value={search} onChange={(e) => setSearch(e.target.value)} disabled={isClosed} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Pilot / Flight Header</CardTitle>
          <CardDescription>Applies to this sheet; not per-row.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-9 gap-3">
            <div className="md:col-span-2 p-3 rounded-2xl bg-muted/50 border">
              <div className="text-xs text-muted-foreground">PILOT</div>
              <Input placeholder="Name" value={pilot} onChange={(e)=>setPilot(e.target.value)} disabled={isClosed} />
            </div>
            <div className="md:col-span-2 p-3 rounded-2xl bg-muted/50 border">
              <div className="text-xs text-muted-foreground">DZ</div>
              <Input placeholder="Drop Zone" value={dz} onChange={(e)=>setDz(e.target.value)} disabled={isClosed} />
            </div>
            <div className="md:col-span-2 p-3 rounded-2xl bg-muted/50 border">
              <div className="text-xs text-muted-foreground">REG</div>
              <Input placeholder="Registration" value={reg} onChange={(e)=>setReg(e.target.value)} disabled={isClosed} />
            </div>
            <div className="md:col-span-2 p-3 rounded-2xl bg-muted/50 border">
              <div className="text-xs text-muted-foreground">DATE</div>
              <Input type="date" placeholder="YYYY-MM-DD" value={date} onChange={(e)=>setDate(e.target.value)} disabled={isClosed} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Totals & Duty</CardTitle>
          <CardDescription>Live totals + pilot duty time (independent)</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-8 gap-3">
            <Stat label="Flights" value={totals.flights} />
            <Stat label="PAX" value={totals.pax} />
            <Stat label="LDG" value={totals.ldg} />
            <Stat label="FLT/T" value={totals.flt} />
            <div className="p-3 rounded-2xl bg-muted/50 border">
              <div className="text-xs text-muted-foreground">DUTY START</div>
              <Input placeholder="HH:MM" value={dutyStart} onChange={(e) => setDutyStart(e.target.value)} />
            </div>
            <div className="p-3 rounded-2xl bg-muted/50 border">
              <div className="text-xs text-muted-foreground">DUTY END</div>
              <Input placeholder="HH:MM" value={dutyEnd} onChange={(e) => setDutyEnd(e.target.value)} />
            </div>
            <Stat label="PILOT DUTY TIME" value={pilotDuty || "--:--"} />
            <div className="hidden md:block md:col-span-8" />
            <div className="p-3 rounded-2xl bg-muted/50 border md:col-span-2">
              <div className="text-xs text-muted-foreground">FOB (Start) lbs</div>
              <Input type="number" placeholder="lbs" value={fobStart} onChange={(e) => setFobStart(e.target.value)} />
            </div>
            <div className="md:col-span-2"><Stat label="FOB (End)" value={lastFOB || "--"} /></div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Entries</CardTitle>
          <CardDescription>{filtered.length} result(s)</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                {COLS.map((c) => (
                  <th key={c} className="py-2 pr-3 font-medium">
                    {c}
                    {(c === "FOB" || c === "F/B") && (
                      <span className="text-xs text-muted-foreground"> (lbs)</span>
                    )}
                  </th>
                ))}
                <th className="py-2 pr-3"/>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} className="border-b hover:bg-muted/30">
                  {COLS.map((c) => (
                    <td key={c} className="py-2 pr-3">
                      {c === "Load" ? (
                        row.id === FERRY_ID ? (
                          <Input value="FERRY" disabled />
                        ) : (
                          <Input value={row.Load} disabled />
                        )
                      ) : c === "T/O" || c === "L/D" ? (
                        <div className="flex items-center gap-2">
                          <CellInput value={(row)[c] ?? ""} type="text" placeholder="HH:MM" onChange={(v) => updateRow(row.id, c, v)} disabled={isClosed} />
                          <Button variant="outline" size="sm" onClick={() => setNow(row.id, c)} title="Set to now" disabled={isClosed}>
                            <Clock className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : c === "FOB" || c === "F/B" ? (
                        <CellInput value={(row)[c] ?? ""} type="number" placeholder="lbs" onChange={(v) => updateRow(row.id, c, v)} disabled={isClosed} />
                      ) : c === "PAX" || c === "LDG" ? (
                        <CellInput value={(row)[c] ?? ""} type="number" placeholder="0" onChange={(v) => updateRow(row.id, c, v)} disabled={isClosed} />
                      ) : (
                        <CellInput value={(row)[c] ?? ""} type="text" placeholder="" onChange={(v) => updateRow(row.id, c, v)} disabled={isClosed} />
                      )}
                    </td>
                  ))}
                  <td className="py-2 pr-3">
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => clearRow(row.id)} disabled={isClosed}><Eraser className="h-4 w-4" /></Button>
                      <Button variant="destructive" size="sm" onClick={() => deleteRow(row.id)} disabled={isClosed}><Trash2 className="h-4 w-4"/></Button>
                    </div>
                  </td>
                </tr>
              ))}

              <tr>
                <td colSpan={COLS.length + 1} className="py-2 pr-3">
                  {!isClosed ? (
                    <div className="flex gap-2">
                      {!rows.some(r => r.id === FERRY_ID) && (
                        <Button variant="outline" onClick={addFerryRow}><Plus className="h-4 w-4 mr-1"/> Add Ferry Row</Button>
                      )}
                      <Button onClick={addRow}><Plus className="h-4 w-4 mr-1"/> Add Load Row</Button>
                      <Button variant="secondary" onClick={closeFlight}><Printer className="h-4 w-4 mr-1"/> Close Flight</Button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Button variant="secondary" onClick={printPDF}><Printer className="h-4 w-4 mr-1"/> Print</Button>
                      <Button onClick={() => downloadPDF({ pilot, dz, reg, date, totals, fobStart, lastFOB }, rows)}><Download className="h-4 w-4 mr-1"/> Download PDF</Button>
                    </div>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function CellInput({ value, onChange, type = "text", placeholder = "", disabled = false }) {
  return (
    <Input value={value} type={type} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
  );
}

function Stat({ label, value }) {
  return (
    <div className="p-3 rounded-2xl bg-muted/50 border">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
