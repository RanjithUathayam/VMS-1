// HTTP-level checks for api/qcInspection.js with the database stubbed out.
// Covers auth, permissions and request validation — paths that respond before touching SQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-qc-api';

// Stub ../db before the router loads it: any SQL call fails loudly.
const dbPath = path.join(__dirname, '..', 'db.js');
const failing = () => { throw new Error('DB should not be reached in this test'); };
require.cache[require.resolve(dbPath)] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { pool: { request: failing, connect: failing }, sql: require('mssql'), connect: failing },
};

const express = require('express');
const { signToken } = require('../middleware/auth');
const qcRouter = require('../api/qcInspection');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/qc', qcRouter);

let server, base;
test.before(async () => {
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/qc`;
});
test.after(() => server.close());

const token = (role, permissions) => signToken({ username: 'u', name: 'Tester', role, permissions });
const call = (method, url, user, body) => fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ status: r.status, body: await r.json() }));

const inspector = token('operator', ['qcInspection']);
const viewer    = token('manager', ['qcReport']);
const nobody    = token('watchman', ['gate']);

test('requires a session', async () => {
    assert.equal((await call('POST', '/list', null, {})).status, 401);
});

test('blocks users without any QC permission', async () => {
    assert.equal((await call('POST', '/list', nobody, {})).status, 403);
    assert.equal((await call('POST', '/save', nobody, { styleName: 'X' })).status, 403);
});

test('report-only users cannot save, approve or delete', async () => {
    assert.equal((await call('POST', '/save', viewer, { styleName: 'X' })).status, 403);
    assert.equal((await call('POST', '/approve/1', viewer, { decision: 'APPROVE' })).status, 403);
    assert.equal((await call('POST', '/delete/1', viewer)).status, 403);
    assert.equal((await call('POST', '/photos/1', viewer, {})).status, 403);
});

test('save rejects invalid submissions before touching the DB', async () => {
    const empty = await call('POST', '/save', inspector, { action: 'draft' });
    assert.equal(empty.status, 400);
    assert.match(empty.body.message, /Style Name or DC No/);

    const incomplete = await call('POST', '/save', inspector, { action: 'submit', styleName: 'RADO' });
    assert.equal(incomplete.status, 400);
    assert.ok(incomplete.body.errors.length > 5);
    assert.ok(incomplete.body.errors.includes('Final Result is required.'));

    const badQty = await call('POST', '/save', inspector, { action: 'draft', styleName: 'RADO', lotQty: 10, inspectedQty: 20 });
    assert.equal(badQty.status, 400);
    assert.match(badQty.body.message, /cannot exceed Lot Qty/);
});

test('approve validates the decision and requires remarks to reject', async () => {
    const approver = token('manager', ['qcApprove']);
    assert.equal((await call('POST', '/approve/1', approver, { decision: 'MAYBE' })).status, 400);
    const r = await call('POST', '/approve/1', approver, { decision: 'REJECT' });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /Remarks are required/);
});

test('photo upload validates caption and image type', async () => {
    const noCaption = await call('POST', '/photos/1', inspector, { dataUrl: 'data:image/png;base64,AAAA' });
    assert.match(noCaption.body.message, /caption/);
    const notImage = await call('POST', '/photos/1', inspector, { caption: 'X', dataUrl: 'data:text/html;base64,AAAA' });
    assert.match(notImage.body.message, /JPEG, PNG or WEBP/);
});

test('evaluate returns the AQL plan and results for the sample sheet', async () => {
    const r = await call('POST', '/evaluate', viewer, {
        lotQty: 2829, inspectedQty: 36, inspectionLevel: 'I', aqlMajor: 4, aqlMinor: 6.5,
        measurementResult: 'PASS', packingResult: 'PASS',
        defects: [
            { category: 'STITCHING', defectName: 'OPEN SEAM', majorQty: 4, minorQty: 3 },
            { category: 'APPEARANCE', defectName: 'SHADE VARIATION', majorQty: 2, minorQty: 0 },
        ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.majorPlan.codeLetter, 'H');
    assert.equal(r.body.data.majorPlan.re, 6);
    assert.equal(r.body.data.minorPlan.re, 8);
    assert.equal(r.body.data.totalMajor, 6);
    assert.equal(r.body.data.systemResult, 'FAIL');
    assert.deepEqual(r.body.data.allowedFinalResults, ['FAIL', 'DEROGATION']);
});

test('documents endpoint validates doc type and party before running the procedure', async () => {
    const bad = await call('GET', '/documents?docType=XX&partyCode=V01', inspector);
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /JO, PO, ST/);
    const noParty = await call('GET', '/documents?docType=JO', inspector);
    assert.equal(noParty.status, 400);
    assert.equal((await call('GET', '/documents?docType=JO&partyCode=V01', viewer)).status, 403);
});

test('Binning procedure rows are grouped into one summary per document', () => {
    const { groupBinningDocs } = qcRouter._internals;
    const rows = [
        { DocNum: 5001, DocEntry: 77, DocDate: '2026-09-20', PartyName: 'SB CREATION', ItemColor: 'TR3218901', ItemSize: '32', ItemSlive: 'FULL', ItemGroup: 'TROUSER', Quantity: 100, PendingQty: 80 },
        { DocNum: 5001, DocEntry: 77, DocDate: '2026-09-20', PartyName: 'SB CREATION', ItemColor: 'TR3218901', ItemSize: '28', ItemSlive: 'FULL', ItemGroup: 'TROUSER', Quantity: 50, PendingQty: null },
        { DocNum: 5001, DocEntry: 77, DocDate: '2026-09-20', PartyName: 'SB CREATION', ItemColor: 'TR3618902 ', ItemSize: '40', ItemSlive: '', GroupName: 'TROUSER', Quantity: 25, PendingQty: 25 },
        { DocNum: 5002, DocEntry: 78, PartyName: 'SB CREATION', ItemColor: 'BLUE', ItemSize: 'XL', Quantity: 10, PendingQty: 10 },
        { DocNum: null, Quantity: 999 },
    ];
    const docs = groupBinningDocs(rows);
    assert.equal(docs.length, 2);
    assert.deepEqual(docs[0], {
        docNum: '5001', docEntry: 77, docDate: '2026-09-20', partyName: 'SB CREATION',
        colours: ['TR3218901', 'TR3618902'], sizes: ['28', '32', '40'], sleeves: ['FULL'], groups: ['TROUSER'],
        lineCount: 3, totalQty: 175, pendingQty: 155,
    });
    assert.equal(docs[1].docNum, '5002');
});
