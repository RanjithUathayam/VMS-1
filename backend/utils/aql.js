/**
 * AQL sampling engine — ISO 2859-1 / ANSI Z1.4, single sampling, normal inspection.
 *
 * Encodes the two tables embedded in the QC sample sheet (docs/QC_Checking_Sample.xlsx, FI REPORT):
 *   1. "Sample Size Code Letters"            → LEVEL_LETTERS
 *   2. "Single Sampling Plans for Normal Inspection" (AQL 0.065 – 6.5) → planFor()
 *
 * MIRRORED in src/utils/qc-aql.ts for live calculation in the browser — keep both in sync.
 * The server copy is authoritative: every save recomputes the plan and results from here.
 */

const CODE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R'];
const SAMPLE_SIZES = [2, 3, 5, 8, 13, 20, 32, 50, 80, 125, 200, 315, 500, 800, 1250, 2000];

// Upper bound (inclusive) of each lot-size band in the code-letter table.
const LOT_UPPER = [8, 15, 25, 50, 90, 150, 280, 500, 1200, 3200, 10000, 35000, 150000, 500000, Infinity];

// One letter per lot-size band, in LOT_UPPER order.
const LEVEL_LETTERS = {
    I:   'AABCCDEFGHJKLMN',
    II:  'ABCDEFGHJKLMNPQ',
    III: 'BCDEFGHJKLMNPQR',
    S1:  'AAAABBBBCCCCDDD',
    S2:  'AAABBBCCCDDDEEE',
    S3:  'AABBCCDDEEFFGGH',
    S4:  'AABCCDEEFGGHJJK',
};
const INSPECTION_LEVELS = Object.keys(LEVEL_LETTERS);

const AQL_VALUES = [0.065, 0.10, 0.15, 0.25, 0.40, 0.65, 1.0, 1.5, 2.5, 4.0, 6.5];

// Ac/Re progression along each AQL column's diagonal.
const AC_RE = [[0, 1], [1, 2], [2, 3], [3, 4], [5, 6], [7, 8], [10, 11], [14, 15], [21, 22]];

function aqlIndex(aql) {
    const n = Number(aql);
    return AQL_VALUES.findIndex(v => Math.abs(v - n) < 1e-9);
}

/** Code letter for a lot size and inspection level, or null when inputs are invalid. */
function codeLetterFor(lotQty, level) {
    const lot = Math.floor(Number(lotQty));
    const letters = LEVEL_LETTERS[level];
    if (!letters || !Number.isFinite(lot) || lot < 1) return null;
    const band = LOT_UPPER.findIndex(upper => lot <= upper);
    return letters[band];
}

/**
 * Resolves the table cell (letter × AQL), following the ↓ / ↑ arrows to the plan they point at.
 * Within each AQL column: ↓ above 0/1, then 0/1, ↑, ↓, then 1/2 … 21/22, then ↑ to the end.
 * Returns { letterIdx, ac, re } of the plan actually used.
 */
function resolveCell(letterIdx, aqlIdx) {
    const zeroOne = (AQL_VALUES.length - 1) - aqlIdx;   // row where 0/1 sits
    const oneTwo  = zeroOne + 3;                        // row where 1/2 sits
    const last    = oneTwo + AC_RE.length - 2;          // row where 21/22 sits

    if (letterIdx < zeroOne)       return resolveCell(zeroOne, aqlIdx);
    if (letterIdx === zeroOne)     return { letterIdx, ac: 0, re: 1 };
    if (letterIdx === zeroOne + 1) return resolveCell(zeroOne, aqlIdx);
    if (letterIdx === zeroOne + 2) return resolveCell(oneTwo, aqlIdx);
    if (letterIdx > last)          return resolveCell(last, aqlIdx);
    const [ac, re] = AC_RE[letterIdx - oneTwo + 1];
    return { letterIdx, ac, re };
}

/**
 * Sampling plan for a lot.
 * Returns null on invalid input, otherwise:
 *   { codeLetter, planLetter, sampleSize, ac, re, fullInspection }
 * `planLetter` differs from `codeLetter` when an arrow redirected to another plan;
 * `fullInspection` is true when the plan's sample size reaches the lot size (inspect 100%).
 */
function planFor(lotQty, level, aql) {
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

module.exports = {
    CODE_LETTERS, SAMPLE_SIZES, LEVEL_LETTERS, INSPECTION_LEVELS, AQL_VALUES,
    codeLetterFor, planFor,
};
