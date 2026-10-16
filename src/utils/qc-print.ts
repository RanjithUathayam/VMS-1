/**
 * Builds the printable Final Inspection Report as a standalone HTML document, laid out after the
 * "FI REPORT" + "DEFECT PHOTO" sheets of docs/QC_Checking_Sample.xlsx.
 * Used for the on-screen preview (iframe srcdoc), Print and browser "Save as PDF".
 * Every value is HTML-escaped — the result is safe to place in an iframe.
 */
import { QcInspection, QcPhoto, QcDefectLine, DefectCategory } from '../models/qc.model';
import { mergeDefects } from './qc-rules';

// Report letterhead, as printed on the sample sheet. Update here if it should differ per unit.
export const QC_COMPANY_HEADER = {
    name: 'B AND B TEXTILE',
    subtitle: '(A UNIT OF ENES TEXTILE MILL)',
    address: ['ATTAYAMPALAYAM, GANAGA PURAM', 'CHITHODE, ERODE-638102'],
};

const esc = (v: unknown): string =>
    String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const fmtDate = (v: unknown): string => {
    if (!v) return '';
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) return String(v);
    return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};
/** Tailwind classes for status / result badges on the QC screens. */
export function qcStatusClass(status: string | null | undefined): string {
    switch (status) {
        case 'APPROVED': return 'bg-emerald-100 text-emerald-800';
        case 'SUBMITTED': return 'bg-sky-100 text-sky-800';
        case 'REJECTED': return 'bg-rose-100 text-rose-800';
        default: return 'bg-slate-100 text-slate-700';
    }
}
export function qcResultClass(result: string | null | undefined): string {
    switch (result) {
        case 'PASS': return 'bg-emerald-600 text-white';
        case 'FAIL': return 'bg-rose-600 text-white';
        case 'DEROGATION': return 'bg-lime-600 text-white';
        default: return 'bg-slate-200 text-slate-600';
    }
}

const fmtDateTime = (v: unknown): string => {
    if (!v) return '';
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : `${fmtDate(v)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const num = (v: unknown) => (v === null || v === undefined || v === '' || Number(v) === 0 ? '' : esc(v));

/** PASS / FAIL style choice cells: the selected option is filled, like the coloured cell in the sheet. */
const choice = (options: string[], selected: string | null | undefined) =>
    options.map(o => `<td class="opt ${o === selected ? `sel sel-${o.toLowerCase()}` : ''}">${o === selected ? '&#10004; ' : ''}${esc(o)}</td>`).join('');

const resultChip = (r: string | null | undefined) =>
    r ? `<span class="chip chip-${esc(r.toLowerCase())}">${esc(r)}</span>` : '<span class="muted">—</span>';

function defectTable(title: string, rows: QcDefectLine[], total: { major: number; minor: number }) {
    const body = rows.map(d => `<tr><td class="dname">${esc(d.defectName)}</td><td class="n">${num(d.majorQty)}</td><td class="n">${num(d.minorQty)}</td></tr>`).join('');
    return `
      <table class="grid defects">
        <thead><tr><th>${esc(title)}</th><th class="n">MAJOR</th><th class="n">MINOR</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><th>TOTAL</th><th class="n">${total.major}</th><th class="n">${total.minor}</th></tr></tfoot>
      </table>`;
}

export function buildQcReportHtml(
    r: QcInspection,
    master: Array<{ category: DefectCategory; defectName: string }>,
    photos: QcPhoto[] = [],
): string {
    const lines = mergeDefects(master, r.defects || []);
    const byCat = (c: DefectCategory) => lines.filter(d => d.category === c);
    const tot = (c: DefectCategory) => byCat(c).reduce((a, d) => ({ major: a.major + (Number(d.majorQty) || 0), minor: a.minor + (Number(d.minorQty) || 0) }), { major: 0, minor: 0 });
    const stitching = byCat('STITCHING');
    const half = Math.ceil(stitching.length / 2);
    const stA = stitching.slice(0, half), stB = stitching.slice(half);
    const totA = stA.reduce((a, d) => ({ major: a.major + (Number(d.majorQty) || 0), minor: a.minor + (Number(d.minorQty) || 0) }), { major: 0, minor: 0 });
    const totB = stB.reduce((a, d) => ({ major: a.major + (Number(d.majorQty) || 0), minor: a.minor + (Number(d.minorQty) || 0) }), { major: 0, minor: 0 });

    const sizeCount = String(r.sizes || '').split(',').map(s => s.trim()).filter(Boolean).length;
    const watermark = r.status === 'APPROVED' ? '' : `<div class="status-band status-${esc(r.status.toLowerCase())}">${esc(r.status)}${r.status === 'REJECTED' && r.approvalRemarks ? ' — ' + esc(r.approvalRemarks) : ''}</div>`;

    const photoPage = photos.length ? `
      <section class="page-break">
        <div class="title">DEFECT IMAGE — ${esc(r.reportNo)}</div>
        <div class="photos">
          ${photos.map(p => `<figure><figcaption>${esc(p.caption)}</figcaption>${p.dataUrl ? `<img src="${esc(p.dataUrl)}" alt="${esc(p.caption)}">` : ''}</figure>`).join('')}
        </div>
      </section>` : '';

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(r.reportNo)} — Final Inspection Report</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10.5px; color: #111; margin: 0; padding: 12px; background: #fff; }
  .title { text-align: center; font-weight: 700; font-size: 15px; letter-spacing: .5px; border: 1.5px solid #111; padding: 6px; background: #e8edf7; }
  table { width: 100%; border-collapse: collapse; }
  .grid td, .grid th { border: 1px solid #111; padding: 3px 5px; vertical-align: top; }
  .grid th { background: #f1f3f7; text-align: left; font-weight: 700; }
  .lbl { font-weight: 700; background: #f8f9fb; white-space: nowrap; width: 1%; }
  .n { text-align: center; width: 46px; }
  .company { font-weight: 700; line-height: 1.35; }
  .company .sub { font-weight: 400; }
  .opt { text-align: center; font-weight: 700; color: #555; width: 70px; }
  .sel { color: #fff; }
  .sel-pass { background: #16a34a; } .sel-fail { background: #dc2626; } .sel-derogation { background: #65a30d; }
  .row-gap { height: 6px; }
  .defects-wrap { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0; align-items: start; }
  .defects-wrap .grid { border-left: none; }
  .defects td.dname { white-space: normal; }
  .defects tfoot th { background: #e8edf7; }
  .chip { display: inline-block; padding: 1px 7px; border-radius: 9px; font-weight: 700; font-size: 10px; color: #fff; }
  .chip-pass { background: #16a34a; } .chip-fail { background: #dc2626; } .chip-derogation { background: #65a30d; }
  .muted { color: #777; }
  .aql td { text-align: center; }
  .aql td.l { text-align: left; }
  .text { min-height: 34px; white-space: pre-wrap; }
  .sign td { text-align: center; height: 44px; vertical-align: bottom; }
  .sign th { text-align: center; }
  .status-band { margin: 6px 0; padding: 5px 8px; font-weight: 700; text-align: center; border: 1px dashed #92400e; color: #92400e; background: #fef3c7; }
  .status-band.status-rejected { border-color: #991b1b; color: #991b1b; background: #fee2e2; }
  .meta { display: flex; justify-content: space-between; font-size: 9.5px; color: #444; margin: 4px 0; }
  .warn { color: #b45309; font-weight: 700; }
  .page-break { page-break-before: always; margin-top: 18px; }
  .photos { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 8px; }
  .photos figure { margin: 0; border: 1px solid #111; break-inside: avoid; }
  .photos figcaption { font-weight: 700; font-size: 9.5px; padding: 3px 5px; border-bottom: 1px solid #111; background: #f1f3f7; min-height: 28px; }
  .photos img { width: 100%; height: 190px; object-fit: contain; display: block; background: #fafafa; }
  @media print { body { padding: 0; } .status-band { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .sel, .chip, .grid th, .title, .lbl { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head>
<body>
  <div class="title">FINAL INSPECTION REPORT</div>
  <div class="meta"><span>Report No: <b>${esc(r.reportNo)}</b>${r.docNum ? ` &nbsp;|&nbsp; ${esc(r.docType || 'Doc')}: <b>${esc(r.docNum)}</b>` : ''}</span>
    <span>Status: <b>${esc(r.status)}</b>${r.approvedBy ? ` &nbsp;|&nbsp; ${r.status === 'APPROVED' ? 'Approved' : 'Reviewed'} by ${esc(r.approvedBy)} on ${esc(fmtDateTime(r.approvedAt))}` : ''}</span></div>
  ${watermark}

  <table class="grid">
    <tr>
      <td rowspan="4" class="company" style="width:28%">${esc(QC_COMPANY_HEADER.name)}<br><span class="sub">${esc(QC_COMPANY_HEADER.subtitle)}<br>${QC_COMPANY_HEADER.address.map(esc).join('<br>')}</span></td>
      <td class="lbl">SUPPLIER NAME</td><td>${esc(r.supplierName)}</td>
      <td class="lbl">DC NO</td><td>${esc(r.dcNo)}</td>
      <td class="lbl">ORDER QTY</td><td>${esc(r.orderQty)}</td>
    </tr>
    <tr>
      <td class="lbl">BRAND NAME</td><td>${esc(r.brandName)}</td>
      <td class="lbl">STYLE NAME</td><td>${esc(r.styleName)}</td>
      <td class="lbl">LOT QTY</td><td>${esc(r.lotQty)}</td>
    </tr>
    <tr>
      <td class="lbl">COLOUR</td><td>${esc(r.colours)}</td>
      <td class="lbl">NO OF SIZE</td><td>${sizeCount ? `${sizeCount} — ` : ''}${esc(r.sizes)}</td>
      <td class="lbl">INS. QTY</td><td>${esc(r.inspectedQty)}</td>
    </tr>
    <tr>
      <td class="lbl">INSPECTION</td><td>${esc(r.inspectionType)}</td>
      <td class="lbl">INCH / CM</td><td>${esc(r.measurementUnit)}</td>
      <td class="lbl">DATE</td><td>${esc(fmtDate(r.inspectionDate))}</td>
    </tr>
  </table>

  <div class="row-gap"></div>
  <table class="grid">
    <tr>
      <td class="lbl">MEASUREMENT AUDIT</td>${choice(['PASS', 'FAIL'], r.measurementResult)}
      <td class="lbl">PACKING AUDIT</td>${choice(['PASS', 'FAIL'], r.packingResult)}
    </tr>
    <tr>
      <td colspan="3"><b>COMMENTS :</b> ${esc(r.measurementComments)}</td>
      <td colspan="3"><b>COMMENTS :</b> ${esc(r.packingComments)}</td>
    </tr>
  </table>

  <div class="row-gap"></div>
  <div class="defects-wrap">
    ${defectTable('STITCHING DEFECTS', stA, totA)}
    ${defectTable('STITCHING DEFECTS', stB, totB)}
    ${defectTable('APPEARANCE DEFECTS', byCat('APPEARANCE'), tot('APPEARANCE'))}
  </div>

  <div class="row-gap"></div>
  <table class="grid aql">
    <tr><th colspan="6">AQL — LEVEL ${esc(r.inspectionLevel)} &nbsp;·&nbsp; CODE LETTER ${esc(r.codeLetter || '—')} &nbsp;·&nbsp; SAMPLE SIZE ${esc(r.sampleSize ?? '—')}
      ${r.sampleSize && r.inspectedQty && r.inspectedQty < r.sampleSize ? ` &nbsp;<span class="warn">(INSPECTED ${esc(r.inspectedQty)} &lt; REQUIRED ${esc(r.sampleSize)})</span>` : ''}</th></tr>
    <tr><th></th><th class="n">AQL</th><th class="n">FOUND</th><th class="n">ACCEPT (Ac)</th><th class="n">REJECT (Re)</th><th>RESULT</th></tr>
    <tr><td class="l lbl">MAJOR</td><td>${esc(r.aqlMajor)}</td><td><b>${esc(r.totalMajor)}</b></td><td>${esc(r.majorAc ?? '—')}</td><td>${esc(r.majorRe ?? '—')}</td><td>${resultChip(r.majorResult)}</td></tr>
    <tr><td class="l lbl">MINOR</td><td>${esc(r.aqlMinor)}</td><td><b>${esc(r.totalMinor)}</b></td><td>${esc(r.minorAc ?? '—')}</td><td>${esc(r.minorRe ?? '—')}</td><td>${resultChip(r.minorResult)}</td></tr>
  </table>

  <div class="row-gap"></div>
  <table class="grid">
    <tr><td><b>FAULT DESCRIPTION :</b><div class="text">${esc(r.faultDescription)}</div></td></tr>
    <tr><td><b>COMMENTS :</b><div class="text">${esc(r.defectComments)}</div></td></tr>
  </table>

  <div class="row-gap"></div>
  <table class="grid">
    <tr>
      <td class="lbl">SYSTEM RESULT</td><td>${resultChip(r.systemResult)}</td>
      <td class="lbl">FINAL RESULT</td>${choice(['PASS', 'FAIL', 'DEROGATION'], r.finalResult)}
    </tr>
    <tr><td colspan="6"><b>REMARKS :</b> ${esc(r.finalRemarks)}</td></tr>
  </table>

  <div class="row-gap"></div>
  <table class="grid sign">
    <tr><th>QC</th><th>UNIT INCHARGE</th><th>MERCHANDISER</th><th>AMQC</th><th>GM</th></tr>
    <tr><td>${esc(r.inspectorName)}</td><td>${esc(r.unitIncharge)}</td><td>${esc(r.merchandiser)}</td><td>${esc(r.amqc)}</td><td>${esc(r.gm)}</td></tr>
  </table>
  ${r.approvalRemarks && r.status === 'APPROVED' ? `<div class="meta"><span><b>Approval remarks:</b> ${esc(r.approvalRemarks)}</span></div>` : ''}
  <div class="meta"><span>Prepared by ${esc(r.createdBy)} on ${esc(fmtDateTime(r.createdAt))}${r.submittedBy ? ` · Submitted by ${esc(r.submittedBy)} on ${esc(fmtDateTime(r.submittedAt))}` : ''}</span></div>
  ${photoPage}
</body></html>`;
}
