/**
 * Browser copy of the QC AQL engine and Final Inspection rules, for live feedback while typing.
 * MIRRORS backend/utils/aql.js + backend/utils/qcRules.js — keep them in sync.
 * The server recomputes and re-validates everything on save; it is the source of truth.
 */
import { QcDefectLine, QcForm, QcEvaluation, AqlPlan, DefectCategory } from '../models/qc.model';

export const CODE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R'];
export const SAMPLE_SIZES = [2, 3, 5, 8, 13, 20, 32, 50, 80, 125, 200, 315, 500, 800, 1250, 2000];
const LOT_UPPER = [8, 15, 25, 50, 90, 150, 280, 500, 1200, 3200, 10000, 35000, 150000, 500000, Infinity];
const LEVEL_LETTERS: Record<string, string> = {
    I:   'AABCCDEFGHJKLMN',
    II:  'ABCDEFGHJKLMNPQ',
    III: 'BCDEFGHJKLMNPQR',
    S1:  'AAAABBBBCCCCDDD',
    S2:  'AAABBBCCCDDDEEE',
    S3:  'AABBCCDDEEFFGGH',
    S4:  'AABCCDEEFGGHJJK',
};
export const INSPECTION_LEVELS = Object.keys(LEVEL_LETTERS);
export const AQL_VALUES = [0.065, 0.10, 0.15, 0.25, 0.40, 0.65, 1.0, 1.5, 2.5, 4.0, 6.5];
const AC_RE: Array<[number, number]> = [[0, 1], [1, 2], [2, 3], [3, 4], [5, 6], [7, 8], [10, 11], [14, 15], [21, 22]];

export const INSPECTION_TYPES = ['INLINE', 'PREFINAL', 'FINAL'];
export const MEASUREMENT_UNITS = ['INCH', 'CM'];
export const FINAL_RESULTS = ['PASS', 'FAIL', 'DEROGATION'];
export const DEFAULTS = { inspectionLevel: 'I', aqlMajor: 4.0, aqlMinor: 6.5 };
export const MAX_DEFECT_QTY = 9999;

const aqlIndex = (aql: unknown) => AQL_VALUES.findIndex(v => Math.abs(v - Number(aql)) < 1e-9);

export function codeLetterFor(lotQty: unknown, level: string): string | null {
    const lot = Math.floor(Number(lotQty));
    const letters = LEVEL_LETTERS[level];
    if (!letters || !Number.isFinite(lot) || lot < 1) return null;
    return letters[LOT_UPPER.findIndex(upper => lot <= upper)];
}

function resolveCell(letterIdx: number, aqlIdx: number): { letterIdx: number; ac: number; re: number } {
    const zeroOne = (AQL_VALUES.length - 1) - aqlIdx;
    const oneTwo  = zeroOne + 3;
    const last    = oneTwo + AC_RE.length - 2;
    if (letterIdx < zeroOne)       return resolveCell(zeroOne, aqlIdx);
    if (letterIdx === zeroOne)     return { letterIdx, ac: 0, re: 1 };
    if (letterIdx === zeroOne + 1) return resolveCell(zeroOne, aqlIdx);
    if (letterIdx === zeroOne + 2) return resolveCell(oneTwo, aqlIdx);
    if (letterIdx > last)          return resolveCell(last, aqlIdx);
    const [ac, re] = AC_RE[letterIdx - oneTwo + 1];
    return { letterIdx, ac, re };
}

export function planFor(lotQty: unknown, level: string, aql: unknown): AqlPlan | null {
    const codeLetter = codeLetterFor(lotQty, level);
    const ai = aqlIndex(aql);
    if (!codeLetter || ai < 0) return null;
    const cell = resolveCell(CODE_LETTERS.indexOf(codeLetter), ai);
    const lot = Math.floor(Number(lotQty));
    const tableSample = SAMPLE_SIZES[cell.letterIdx];
    return {
        codeLetter,
        planLetter: CODE_LETTERS[cell.letterIdx],
        sampleSize: Math.min(tableSample, lot),
        ac: cell.ac,
        re: cell.re,
        fullInspection: tableSample >= lot,
    };
}

const isBlank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
const toInt = (v: unknown) => (isBlank(v) ? 0 : Number(v));

export function evaluateInspection(f: Partial<QcForm>): QcEvaluation {
    const lotQty = Math.floor(Number(f.lotQty) || 0);
    const inspectedQty = Math.floor(Number(f.inspectedQty) || 0);
    const level = f.inspectionLevel || DEFAULTS.inspectionLevel;

    const majorPlan = lotQty > 0 ? planFor(lotQty, level, f.aqlMajor) : null;
    const minorPlan = lotQty > 0 ? planFor(lotQty, level, f.aqlMinor) : null;

    const totals: Record<DefectCategory, { major: number; minor: number }> = {
        STITCHING: { major: 0, minor: 0 }, APPEARANCE: { major: 0, minor: 0 },
    };
    for (const d of f.defects || []) {
        const b = totals[d.category];
        if (!b) continue;
        b.major += Math.max(0, toInt(d.majorQty) || 0);
        b.minor += Math.max(0, toInt(d.minorQty) || 0);
    }
    const totalMajor = totals.STITCHING.major + totals.APPEARANCE.major;
    const totalMinor = totals.STITCHING.minor + totals.APPEARANCE.minor;
    const majorResult = majorPlan ? (totalMajor <= majorPlan.ac ? 'PASS' : 'FAIL') : null;
    const minorResult = minorPlan ? (totalMinor <= minorPlan.ac ? 'PASS' : 'FAIL') : null;
    const requiredSample = majorPlan && minorPlan ? Math.max(majorPlan.sampleSize, minorPlan.sampleSize) : null;

    const parts = [majorResult, minorResult, f.measurementResult || null, f.packingResult || null];
    let systemResult: 'PASS' | 'FAIL' | null = null;
    if (parts.includes('FAIL')) systemResult = 'FAIL';
    else if (parts.every(p => p === 'PASS')) systemResult = 'PASS';

    const warnings: string[] = [];
    if (requiredSample && inspectedQty > 0 && inspectedQty < requiredSample) {
        warnings.push(`Inspected qty (${inspectedQty}) is below the AQL sample size (${requiredSample}) for this lot.`);
    }
    return { majorPlan, minorPlan, requiredSample, totals, totalMajor, totalMinor, majorResult, minorResult, systemResult, warnings };
}

export function allowedFinalResults(systemResult: string | null): string[] {
    if (systemResult === 'PASS') return ['PASS', 'FAIL'];
    if (systemResult === 'FAIL') return ['FAIL', 'DEROGATION'];
    return [];
}

/** Same checks as the server; 'submit' enforces every field the FI report requires. */
export function validateInspection(f: Partial<QcForm>, mode: 'draft' | 'submit', ev = evaluateInspection(f)): string[] {
    const errors: string[] = [];
    const submit = mode === 'submit';
    const s = (v: unknown) => String(v ?? '').trim();

    const required: Array<[keyof QcForm, string]> = [
        ['supplierName', 'Supplier Name'], ['brandName', 'Brand Name'], ['styleName', 'Style Name'],
        ['colours', 'Colour'], ['dcNo', 'DC No'], ['sizes', 'Sizes'], ['inspectionDate', 'Inspection Date'],
        ['inspectorName', 'QC Inspector'],
    ];
    if (submit) for (const [k, label] of required) if (!s(f[k])) errors.push(`${label} is required.`);
    if (!submit && !s(f.styleName) && !s(f.dcNo)) errors.push('Enter at least a Style Name or DC No to save a draft.');

    const qty = (v: unknown, label: string): number | null => {
        if (isBlank(v)) { if (submit) errors.push(`${label} is required.`); return null; }
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) { errors.push(`${label} must be a whole number of at least 1.`); return null; }
        if (n > 10000000) { errors.push(`${label} is too large.`); return null; }
        return n;
    };
    const orderQty = qty(f.orderQty, 'Order Qty');
    const lotQty = qty(f.lotQty, 'Lot Qty');
    const inspectedQty = qty(f.inspectedQty, 'Inspected Qty');
    if (lotQty !== null && inspectedQty !== null && inspectedQty > lotQty) {
        errors.push(`Inspected Qty (${inspectedQty}) cannot exceed Lot Qty (${lotQty}).`);
    }
    if (orderQty !== null && lotQty === null && inspectedQty !== null && inspectedQty > orderQty) {
        errors.push(`Inspected Qty (${inspectedQty}) cannot exceed Order Qty (${orderQty}).`);
    }

    if (s(f.inspectionDate)) {
        const d = new Date(s(f.inspectionDate));
        const tomorrow = new Date(); tomorrow.setHours(0, 0, 0, 0); tomorrow.setDate(tomorrow.getDate() + 1);
        if (Number.isNaN(d.getTime())) errors.push('Inspection Date is invalid.');
        else if (d >= tomorrow) errors.push('Inspection Date cannot be in the future.');
    }

    const enumField = (v: unknown, label: string, allowed: string[]) => {
        if (!s(v)) { if (submit) errors.push(`${label} is required.`); return; }
        if (!allowed.includes(s(v))) errors.push(`${label} must be one of: ${allowed.join(', ')}.`);
    };
    enumField(f.inspectionType, 'Inspection Type', INSPECTION_TYPES);
    enumField(f.measurementUnit, 'Measurement Unit', MEASUREMENT_UNITS);
    enumField(f.inspectionLevel, 'Inspection Level', INSPECTION_LEVELS);
    enumField(f.measurementResult, 'Measurement Audit', ['PASS', 'FAIL']);
    enumField(f.packingResult, 'Packing Audit', ['PASS', 'FAIL']);
    for (const [v, label] of [[f.aqlMajor, 'Major AQL'], [f.aqlMinor, 'Minor AQL']] as const) {
        if (isBlank(v)) { if (submit) errors.push(`${label} is required.`); continue; }
        if (aqlIndex(v) < 0) errors.push(`${label} must be one of: ${AQL_VALUES.join(', ')}.`);
    }

    const seen = new Set<string>();
    for (const d of f.defects || []) {
        const name = s(d.defectName);
        const major = toInt(d.majorQty), minor = toInt(d.minorQty);
        if (!name) { if (major || minor) errors.push('A defect with counts is missing its description.'); continue; }
        const key = `${d.category}|${name.toUpperCase()}`;
        if (seen.has(key)) errors.push(`Defect "${name}" is listed twice under ${d.category}.`);
        seen.add(key);
        for (const [q, label] of [[major, 'Major'], [minor, 'Minor']] as const) {
            if (!Number.isInteger(q) || q < 0 || q > MAX_DEFECT_QTY) {
                errors.push(`${label} count for "${name}" must be a whole number between 0 and ${MAX_DEFECT_QTY}.`);
            }
        }
    }

    if (submit) {
        if (f.measurementResult === 'FAIL' && !s(f.measurementComments)) errors.push('Measurement comments are required when the Measurement Audit fails.');
        if (f.packingResult === 'FAIL' && !s(f.packingComments)) errors.push('Packing comments are required when the Packing Audit fails.');
        if ((ev.totalMajor + ev.totalMinor) > 0 && !s(f.faultDescription)) errors.push('Fault Description is required when defects are recorded.');
        const fr = s(f.finalResult);
        if (!fr) errors.push('Final Result is required.');
        else if (ev.systemResult && !allowedFinalResults(ev.systemResult).includes(fr)) {
            errors.push(ev.systemResult === 'FAIL'
                ? 'The inspection fails the QC criteria — Final Result must be FAIL or DEROGATION.'
                : 'DEROGATION applies only when the inspection fails the QC criteria.');
        }
        if ((fr === 'DEROGATION' || (fr === 'FAIL' && ev.systemResult === 'PASS')) && !s(f.finalRemarks)) {
            errors.push(fr === 'DEROGATION'
                ? 'Final remarks are required to justify a DEROGATION.'
                : 'Final remarks are required when overriding a passing inspection to FAIL.');
        }
    }
    return errors;
}

/** Builds the full checklist: master defects first (sheet order), then any custom lines on the record. */
export function mergeDefects(master: Array<{ category: DefectCategory; defectName: string }>, saved: QcDefectLine[]): QcDefectLine[] {
    const byKey = new Map(saved.map(d => [`${d.category}|${d.defectName.toUpperCase()}`, d]));
    const lines: QcDefectLine[] = master.map(m => {
        const hit = byKey.get(`${m.category}|${m.defectName.toUpperCase()}`);
        byKey.delete(`${m.category}|${m.defectName.toUpperCase()}`);
        return { category: m.category, defectName: m.defectName, majorQty: hit?.majorQty ?? null, minorQty: hit?.minorQty ?? null, isCustom: false };
    });
    for (const d of byKey.values()) lines.push({ ...d, isCustom: true });
    return lines;
}
