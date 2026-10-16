export type DefectCategory = 'STITCHING' | 'APPEARANCE';
export type QcStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

export interface QcDefectLine {
    category: DefectCategory;
    defectName: string;
    majorQty: number | null;
    minorQty: number | null;
    isCustom: boolean;
}

/** Editable fields of a Final Inspection report (mirrors the FI REPORT sheet). */
export interface QcForm {
    docType: string;          // JO | PO | ST — from [@ASRS_Transaction] @type = 'Binning'
    docNum: string;
    docEntry: number | null;
    supplierCode: string;
    supplierName: string;
    brandName: string;
    styleName: string;
    colours: string;
    dcNo: string;
    sizes: string;
    orderQty: number | null;
    lotQty: number | null;
    inspectedQty: number | null;
    inspectionDate: string;
    inspectionType: string;
    measurementUnit: string;
    inspectionLevel: string;
    aqlMajor: number | null;
    aqlMinor: number | null;
    measurementResult: string;
    measurementComments: string;
    packingResult: string;
    packingComments: string;
    finalResult: string;
    faultDescription: string;
    defectComments: string;
    finalRemarks: string;
    inspectorName: string;
    unitIncharge: string;
    merchandiser: string;
    amqc: string;
    gm: string;
    defects: QcDefectLine[];
}

export interface AqlPlan {
    codeLetter: string;
    planLetter: string;
    sampleSize: number;
    ac: number;
    re: number;
    fullInspection: boolean;
}

export interface QcEvaluation {
    majorPlan: AqlPlan | null;
    minorPlan: AqlPlan | null;
    requiredSample: number | null;
    totals: Record<DefectCategory, { major: number; minor: number }>;
    totalMajor: number;
    totalMinor: number;
    majorResult: 'PASS' | 'FAIL' | null;
    minorResult: 'PASS' | 'FAIL' | null;
    systemResult: 'PASS' | 'FAIL' | null;
    warnings: string[];
}

export interface QcPhoto {
    id: number;
    caption: string;
    dataUrl?: string;
}

/** A saved inspection as returned by the API. */
export interface QcInspection extends Omit<QcForm, 'defects'> {
    id: number;
    reportNo: string;
    codeLetter: string | null;
    sampleSize: number | null;
    majorAc: number | null;
    majorRe: number | null;
    minorAc: number | null;
    minorRe: number | null;
    totalMajor: number;
    totalMinor: number;
    majorResult: string | null;
    minorResult: string | null;
    systemResult: string | null;
    status: QcStatus;
    submittedAt: string | null;
    submittedBy: string | null;
    approvedAt: string | null;
    approvedBy: string | null;
    approvalRemarks: string | null;
    createdAt: string;
    createdBy: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
    rowVersion: string | null;
    defects?: QcDefectLine[];
    photos?: QcPhoto[];
}

export interface QcMeta {
    defectMaster: Array<{ category: DefectCategory; defectName: string }>;
    inspectionTypes: string[];
    measurementUnits: string[];
    auditResults: string[];
    finalResults: string[];
    inspectionLevels: string[];
    aqlValues: number[];
    defaults: { inspectionLevel: string; aqlMajor: number; aqlMinor: number };
    permissions: { canEdit: boolean; canApprove: boolean };
}

export interface QcListFilter {
    fromDate?: string;
    toDate?: string;
    supplier?: string;
    brand?: string;
    style?: string;
    dcNo?: string;
    docNum?: string;
    inspector?: string;
    inspectionType?: string;
    finalResult?: string;
    status?: string;
    search?: string;
    page?: number;
    pageSize?: number;
}

/** One document from [@ASRS_Transaction] @type = 'Binning', grouped by DocNum. */
export interface QcSourceDoc {
    docNum: string;
    docEntry: number | null;
    docDate: string | null;
    partyName: string;
    colours: string[];
    sizes: string[];
    sleeves: string[];
    groups: string[];
    lineCount: number;
    totalQty: number;
    pendingQty: number;
}

export interface QcParty { code: string; name: string; }

export interface QcSummary {
    total: number; pass: number; fail: number; derogation: number;
    draft: number; submitted: number; approved: number; rejected: number;
    inspectedQty: number; totalMajor: number; totalMinor: number;
}
