// Run: npm test   (from backend/)  — uses Node's built-in test runner, no extra dependencies.
const test = require('node:test');
const assert = require('node:assert/strict');
const { planFor, codeLetterFor } = require('../utils/aql');
const { evaluateInspection, validateInspection, allowedFinalResults } = require('../utils/qcRules');

// The FI REPORT in docs/QC_Checking_Sample.xlsx, transcribed cell-for-cell.
// NOTE: the sheet's hand-typed total D20 = 4, but the only filled cell in column D is D11 = 3.
const SAMPLE_DEFECTS = [
    { category: 'STITCHING', defectName: 'OPEN CHAIN STITCH', majorQty: 1, minorQty: 3 },
    { category: 'STITCHING', defectName: 'OPEN SEAM', majorQty: 1, minorQty: 0 },
    { category: 'STITCHING', defectName: 'HOLE & DAMAGE', majorQty: 1, minorQty: 0 },
    { category: 'STITCHING', defectName: 'YELLOW STAIN', majorQty: 1, minorQty: 0 },
    { category: 'STITCHING', defectName: 'UNTRIMMED THREAD', majorQty: 0, minorQty: 3 },
    { category: 'STITCHING', defectName: 'PLEAT', majorQty: 0, minorQty: 1 },
    { category: 'APPEARANCE', defectName: 'SHADE VARIATION', majorQty: 1, minorQty: 0 },
    { category: 'APPEARANCE', defectName: 'BARTACK MISSING', majorQty: 1, minorQty: 0 },
];
const SAMPLE = {
    supplierName: 'SB CREATION', brandName: 'PRIMA CLUB', styleName: 'RADO', colours: 'TR3218901,TR3618902',
    dcNo: '82383', sizes: '28,30,32,34,36,38,40', orderQty: 2829, lotQty: 2829, inspectedQty: 36,
    inspectionDate: '2026-09-30', inspectionType: 'FINAL', measurementUnit: 'INCH',
    inspectionLevel: 'I', aqlMajor: 4.0, aqlMinor: 6.5,
    measurementResult: 'PASS', measurementComments: 'MEASUREMENTS ARE FOUND WITHIN TOLERANCE OK',
    packingResult: 'PASS',
    faultDescription: 'SIDE SEAM CHAIN STITCH OPEN, SIDE SEAM FABRIC OPEN AT SECURE STITCH, ...',
    finalResult: 'DEROGATION',
    finalRemarks: 'GOODS ARE FOUND MAJOR DEFECTS BUT CONSIDERED TO PASS AS DEROGATION',
    inspectorName: 'RAMESH V',
    defects: SAMPLE_DEFECTS,
};

test('code letters follow the sheet table', () => {
    assert.equal(codeLetterFor(2829, 'I'), 'H');
    assert.equal(codeLetterFor(2829, 'II'), 'K');
    assert.equal(codeLetterFor(8, 'I'), 'A');
    assert.equal(codeLetterFor(9, 'II'), 'B');
    assert.equal(codeLetterFor(500001, 'III'), 'R');
    assert.equal(codeLetterFor(150, 'S4'), 'D');
    assert.equal(codeLetterFor(0, 'I'), null);
    assert.equal(codeLetterFor(100, 'X'), null);
});

test('plans match the sheet single-sampling table, including arrows', () => {
    assert.deepEqual(planFor(2829, 'I', 4.0), { codeLetter: 'H', planLetter: 'H', sampleSize: 50, ac: 5, re: 6, fullInspection: false });
    assert.deepEqual(planFor(2829, 'I', 6.5), { codeLetter: 'H', planLetter: 'H', sampleSize: 50, ac: 7, re: 8, fullInspection: false });
    assert.deepEqual(planFor(2829, 'II', 2.5), { codeLetter: 'K', planLetter: 'K', sampleSize: 125, ac: 7, re: 8, fullInspection: false });
    // ↓ arrow: lot 51–90 level II = E, AQL 2.5 → use F (n=20, 1/2)
    assert.deepEqual(planFor(60, 'II', 2.5), { codeLetter: 'E', planLetter: 'F', sampleSize: 20, ac: 1, re: 2, fullInspection: false });
    // ↑ arrow: code D, AQL 2.5 → use C (n=5, 0/1)
    assert.deepEqual(planFor(30, 'II', 2.5), { codeLetter: 'D', planLetter: 'C', sampleSize: 5, ac: 0, re: 1, fullInspection: false });
    // ↑ at bottom of column: code R, AQL 6.5 → 21/22 at L (n=200)
    assert.deepEqual(planFor(600000, 'III', 6.5), { codeLetter: 'R', planLetter: 'L', sampleSize: 200, ac: 21, re: 22, fullInspection: false });
    // ↓ to 0/1 at L for AQL 0.065
    assert.deepEqual(planFor(100, 'I', 0.065), { codeLetter: 'D', planLetter: 'L', sampleSize: 100, ac: 0, re: 1, fullInspection: true });
    assert.equal(planFor(100, 'I', 3.0), null);
});

test('sample sheet: totals, AQL and result reproduce the FI report', () => {
    const ev = evaluateInspection(SAMPLE);
    assert.equal(ev.totals.STITCHING.major, 4);   // C20
    assert.equal(ev.totals.STITCHING.minor, 7);   // D11 (3) + J9 (3) + J10 (1) — sheet's typed totals say 4 + 4 = 8
    assert.equal(ev.totals.APPEARANCE.major, 2);  // L20
    assert.equal(ev.totals.APPEARANCE.minor, 0);  // M20
    assert.equal(ev.totalMajor, 6);
    assert.equal(ev.totalMinor, 7);
    assert.equal(ev.majorPlan.re, 6);             // "MAJOR - ALLOWED 6"
    assert.equal(ev.minorPlan.re, 8);             // "MINOR - ALLOWED 8"
    assert.equal(ev.majorResult, 'FAIL');         // "exceed the AQL level"
    assert.equal(ev.minorResult, 'PASS');         // 7 ≤ Ac 7 (with the sheet's typed 8 it would be FAIL)
    assert.equal(evaluateInspection({ ...SAMPLE, defects: [...SAMPLE_DEFECTS,
        { category: 'STITCHING', defectName: 'SKIP STITCH', majorQty: 0, minorQty: 1 }] }).minorResult, 'FAIL');
    assert.equal(ev.systemResult, 'FAIL');
    assert.equal(ev.requiredSample, 50);
    assert.match(ev.warnings[0], /below the AQL sample size \(50\)/);   // INS.QTY 36 < 50
    assert.deepEqual(validateInspection(SAMPLE, 'submit', ev), []);     // DEROGATION with remarks is accepted
});

test('overall result: audits and AQL', () => {
    const clean = { ...SAMPLE, defects: [{ category: 'STITCHING', defectName: 'PLEAT', majorQty: 5, minorQty: 7 }] };
    assert.equal(evaluateInspection(clean).systemResult, 'PASS');                       // 5 ≤ Ac5, 7 ≤ Ac7
    assert.equal(evaluateInspection({ ...clean, packingResult: 'FAIL' }).systemResult, 'FAIL');
    assert.equal(evaluateInspection({ ...clean, measurementResult: 'FAIL' }).systemResult, 'FAIL');
    assert.equal(evaluateInspection({ ...clean, packingResult: null }).systemResult, null);  // incomplete
    assert.deepEqual(allowedFinalResults('PASS'), ['PASS', 'FAIL']);
    assert.deepEqual(allowedFinalResults('FAIL'), ['FAIL', 'DEROGATION']);
});

test('submit validation blocks invalid or incomplete reports', () => {
    const errs = (o, mode = 'submit') => validateInspection({ ...SAMPLE, ...o }, mode);
    assert.ok(errs({ finalResult: 'PASS' }).some(e => /must be FAIL or DEROGATION/.test(e)));
    assert.ok(errs({ finalRemarks: '' }).some(e => /justify a DEROGATION/.test(e)));
    assert.ok(errs({ inspectedQty: 3000 }).some(e => /cannot exceed Lot Qty/.test(e)));
    assert.ok(errs({ inspectedQty: -1 }).some(e => /Inspected Qty must be/.test(e)));
    assert.ok(errs({ inspectedQty: 2.5 }).some(e => /Inspected Qty must be/.test(e)));
    assert.ok(errs({ styleName: '' }).some(e => /Style Name is required/.test(e)));
    assert.ok(errs({ packingResult: '' }).some(e => /Packing Audit is required/.test(e)));
    assert.ok(errs({ measurementResult: 'FAIL', measurementComments: '' }).some(e => /Measurement comments/.test(e)));
    assert.ok(errs({ faultDescription: '' }).some(e => /Fault Description is required/.test(e)));
    assert.ok(errs({ aqlMajor: 3 }).some(e => /Major AQL must be one of/.test(e)));
    assert.ok(errs({ inspectionType: 'RANDOM' }).some(e => /Inspection Type must be one of/.test(e)));
    assert.ok(errs({ inspectionDate: '2999-01-01' }).some(e => /future/.test(e)));
    assert.ok(errs({ defects: [{ category: 'STITCHING', defectName: 'PLEAT', majorQty: -2, minorQty: 0 }] }).some(e => /Major count/.test(e)));
    assert.ok(errs({ defects: [
        { category: 'STITCHING', defectName: 'PLEAT', majorQty: 1, minorQty: 0 },
        { category: 'STITCHING', defectName: 'pleat', majorQty: 1, minorQty: 0 },
    ] }).some(e => /listed twice/.test(e)));
    // overriding a passing inspection to FAIL needs a reason
    const passing = { defects: [], faultDescription: '', finalResult: 'FAIL', finalRemarks: '' };
    assert.ok(errs(passing).some(e => /overriding a passing inspection/.test(e)));
});

test('draft validation is lenient but still type-checks', () => {
    assert.deepEqual(validateInspection({ styleName: 'RADO' }, 'draft'), []);
    assert.ok(validateInspection({}, 'draft').some(e => /Style Name or DC No/.test(e)));
    assert.ok(validateInspection({ styleName: 'X', inspectedQty: 'abc' }, 'draft').some(e => /Inspected Qty/.test(e)));
});
