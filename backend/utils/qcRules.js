/**
 * Final Inspection (FI) business rules, derived from docs/QC_Checking_Sample.xlsx (FI REPORT sheet).
 *
 * MIRRORED in src/utils/qc-rules.ts for live feedback in the browser — keep both in sync.
 * The server copy is authoritative: results are recomputed here on every save.
 */
const { planFor, INSPECTION_LEVELS, AQL_VALUES } = require('./aql');

const INSPECTION_TYPES = ['INLINE', 'PREFINAL', 'FINAL'];   // sheet: "INLINE/PREFINAL/FINAL INSPECTION"
const MEASUREMENT_UNITS = ['INCH', 'CM'];                   // sheet: "INCH/CM"
const AUDIT_RESULTS = ['PASS', 'FAIL'];                     // measurement + packing audits
const FINAL_RESULTS = ['PASS', 'FAIL', 'DEROGATION'];       // sheet row 26–28
const DEFECT_CATEGORIES = ['STITCHING', 'APPEARANCE'];

// Sheet header says "AQL-LEVEL I"; the sheet's allowances (Major 6 / Minor 8 on lot 2829)
// correspond to AQL 4.0 (Major) and 6.5 (Minor) at code letter H — these are the defaults.
const DEFAULTS = { inspectionLevel: 'I', aqlMajor: 4.0, aqlMinor: 6.5 };

const MAX_DEFECT_QTY = 9999;

const toInt = v => {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
};

/**
 * Computes AQL plans, defect totals and pass/fail for an inspection.
 * Pure: never throws on bad input — callers use validateInspection() for errors.
 */
function evaluateInspection(input) {
    const lotQty       = Math.floor(Number(input.lotQty) || 0);
    const inspectedQty = Math.floor(Number(input.inspectedQty) || 0);
    const level        = input.inspectionLevel || DEFAULTS.inspectionLevel;

    const majorPlan = lotQty > 0 ? planFor(lotQty, level, input.aqlMajor) : null;
    const minorPlan = lotQty > 0 ? planFor(lotQty, level, input.aqlMinor) : null;

    const totals = { STITCHING: { major: 0, minor: 0 }, APPEARANCE: { major: 0, minor: 0 } };
    for (const d of input.defects || []) {
        const bucket = totals[d.category];
        if (!bucket) continue;
        bucket.major += Math.max(0, toInt(d.majorQty) || 0);
        bucket.minor += Math.max(0, toInt(d.minorQty) || 0);
    }
    const totalMajor = totals.STITCHING.major + totals.APPEARANCE.major;
    const totalMinor = totals.STITCHING.minor + totals.APPEARANCE.minor;

    // Accept when found ≤ Ac, reject when found ≥ Re (single sampling: Re = Ac + 1).
    const majorResult = majorPlan ? (totalMajor <= majorPlan.ac ? 'PASS' : 'FAIL') : null;
    const minorResult = minorPlan ? (totalMinor <= minorPlan.ac ? 'PASS' : 'FAIL') : null;

    // Where the two AQLs land on different plans (arrows), the larger sample covers both.
    const requiredSample = majorPlan && minorPlan ? Math.max(majorPlan.sampleSize, minorPlan.sampleSize) : null;

    const parts = [majorResult, minorResult, input.measurementResult || null, input.packingResult || null];
    let systemResult = null;
    if (parts.includes('FAIL')) systemResult = 'FAIL';
    else if (parts.every(p => p === 'PASS')) systemResult = 'PASS';

    const warnings = [];
    if (requiredSample && inspectedQty > 0 && inspectedQty < requiredSample) {
        warnings.push(`Inspected qty (${inspectedQty}) is below the AQL sample size (${requiredSample}) for this lot.`);
    }

    return {
        majorPlan, minorPlan, requiredSample,
        totals, totalMajor, totalMinor,
        majorResult, minorResult, systemResult,
        warnings,
    };
}

/** Which final results are allowed for a given system result. */
function allowedFinalResults(systemResult) {
    if (systemResult === 'PASS') return ['PASS', 'FAIL'];
    if (systemResult === 'FAIL') return ['FAIL', 'DEROGATION'];
    return [];
}

/**
 * Validates an inspection payload.
 * mode 'draft'  → only checks values that are present are well-formed.
 * mode 'submit' → additionally enforces every field the FI report requires.
 * Returns an array of error strings (empty when valid).
 */
function validateInspection(input, mode, evaluation) {
    const errors = [];
    const submit = mode === 'submit';
    const s = v => String(v ?? '').trim();
    const ev = evaluation || evaluateInspection(input);

    const required = [
        ['supplierName', 'Supplier Name'], ['brandName', 'Brand Name'], ['styleName', 'Style Name'],
        ['colours', 'Colour'], ['dcNo', 'DC No'], ['sizes', 'Sizes'], ['inspectionDate', 'Inspection Date'],
        ['inspectorName', 'QC Inspector'],
    ];
    if (submit) for (const [k, label] of required) if (!s(input[k])) errors.push(`${label} is required.`);

    // Draft still needs something to identify the record by.
    if (!submit && !s(input.styleName) && !s(input.dcNo)) errors.push('Enter at least a Style Name or DC No to save a draft.');

    const qtyField = (key, label, min) => {
        const raw = input[key];
        if (raw === null || raw === undefined || raw === '') {
            if (submit) errors.push(`${label} is required.`);
            return null;
        }
        const n = Number(raw);
        if (!Number.isInteger(n) || n < min) { errors.push(`${label} must be a whole number of at least ${min}.`); return null; }
        if (n > 10000000) { errors.push(`${label} is too large.`); return null; }
        return n;
    };
    const orderQty     = qtyField('orderQty', 'Order Qty', 1);
    const lotQty       = qtyField('lotQty', 'Lot Qty', 1);
    const inspectedQty = qtyField('inspectedQty', 'Inspected Qty', 1);
    if (lotQty !== null && inspectedQty !== null && inspectedQty > lotQty) {
        errors.push(`Inspected Qty (${inspectedQty}) cannot exceed Lot Qty (${lotQty}).`);
    }
    if (orderQty !== null && lotQty === null && inspectedQty !== null && inspectedQty > orderQty) {
        errors.push(`Inspected Qty (${inspectedQty}) cannot exceed Order Qty (${orderQty}).`);
    }

    if (s(input.inspectionDate)) {
        const d = new Date(s(input.inspectionDate));
        if (Number.isNaN(d.getTime())) errors.push('Inspection Date is invalid.');
        else {
            const tomorrow = new Date(); tomorrow.setHours(0, 0, 0, 0); tomorrow.setDate(tomorrow.getDate() + 1);
            if (d >= tomorrow) errors.push('Inspection Date cannot be in the future.');
        }
    }

    const enumField = (key, label, allowed) => {
        const v = s(input[key]);
        if (!v) { if (submit) errors.push(`${label} is required.`); return; }
        if (!allowed.includes(v)) errors.push(`${label} must be one of: ${allowed.join(', ')}.`);
    };
    enumField('inspectionType', 'Inspection Type', INSPECTION_TYPES);
    enumField('measurementUnit', 'Measurement Unit', MEASUREMENT_UNITS);
    enumField('inspectionLevel', 'Inspection Level', INSPECTION_LEVELS);
    enumField('measurementResult', 'Measurement Audit', AUDIT_RESULTS);
    enumField('packingResult', 'Packing Audit', AUDIT_RESULTS);

    for (const [key, label] of [['aqlMajor', 'Major AQL'], ['aqlMinor', 'Minor AQL']]) {
        const v = input[key];
        if (v === null || v === undefined || v === '') { if (submit) errors.push(`${label} is required.`); continue; }
        if (!AQL_VALUES.some(a => Math.abs(a - Number(v)) < 1e-9)) errors.push(`${label} must be one of: ${AQL_VALUES.join(', ')}.`);
    }

    const seen = new Set();
    for (const d of input.defects || []) {
        const name = s(d.defectName);
        if (!DEFECT_CATEGORIES.includes(d.category)) { errors.push(`Defect "${name || '?'}" has an invalid category.`); continue; }
        const major = toInt(d.majorQty), minor = toInt(d.minorQty);
        if (!name) {
            if (major || minor) errors.push('A defect with counts is missing its description.');
            continue;
        }
        const key = `${d.category}|${name.toUpperCase()}`;
        if (seen.has(key)) errors.push(`Defect "${name}" is listed twice under ${d.category}.`);
        seen.add(key);
        for (const [q, label] of [[major, 'Major'], [minor, 'Minor']]) {
            if (!Number.isInteger(q) || q < 0 || q > MAX_DEFECT_QTY) {
                errors.push(`${label} count for "${name}" must be a whole number between 0 and ${MAX_DEFECT_QTY}.`);
            }
        }
    }

    if (s(input.finalResult) && !FINAL_RESULTS.includes(s(input.finalResult))) {
        errors.push(`Final Result must be one of: ${FINAL_RESULTS.join(', ')}.`);
    }

    if (submit) {
        if (input.measurementResult === 'FAIL' && !s(input.measurementComments)) {
            errors.push('Measurement comments are required when the Measurement Audit fails.');
        }
        if (input.packingResult === 'FAIL' && !s(input.packingComments)) {
            errors.push('Packing comments are required when the Packing Audit fails.');
        }
        if ((ev.totalMajor + ev.totalMinor) > 0 && !s(input.faultDescription)) {
            errors.push('Fault Description is required when defects are recorded.');
        }
        const fr = s(input.finalResult);
        if (!fr) errors.push('Final Result is required.');
        else if (ev.systemResult && !allowedFinalResults(ev.systemResult).includes(fr)) {
            errors.push(ev.systemResult === 'FAIL'
                ? 'The inspection fails the QC criteria — Final Result must be FAIL or DEROGATION.'
                : 'DEROGATION applies only when the inspection fails the QC criteria.');
        }
        if ((fr === 'DEROGATION' || (fr === 'FAIL' && ev.systemResult === 'PASS')) && !s(input.finalRemarks)) {
            errors.push(fr === 'DEROGATION'
                ? 'Final remarks are required to justify a DEROGATION.'
                : 'Final remarks are required when overriding a passing inspection to FAIL.');
        }
    }

    return errors;
}

module.exports = {
    INSPECTION_TYPES, MEASUREMENT_UNITS, AUDIT_RESULTS, FINAL_RESULTS, DEFECT_CATEGORIES, DEFAULTS, MAX_DEFECT_QTY,
    evaluateInspection, validateInspection, allowedFinalResults,
};
