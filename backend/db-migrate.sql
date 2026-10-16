-- ════════════════════════════════════════════════════════════
--  Migration: Create AppRoles table and seed default roles
--  Run once against the WMS_Uathayam database
-- ════════════════════════════════════════════════════════════

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='AppRoles' AND xtype='U')
BEGIN
    CREATE TABLE AppRoles (
        Id          INT IDENTITY(1,1) PRIMARY KEY,
        RoleName    NVARCHAR(50)   NOT NULL,
        DisplayName NVARCHAR(100)  NOT NULL,
        Description NVARCHAR(500)  NULL,
        Permissions NVARCHAR(MAX)  NOT NULL DEFAULT '[]',
        IsSystem    BIT            NOT NULL DEFAULT 0,
        CreatedAt   DATETIME       NOT NULL DEFAULT GETDATE(),
        CONSTRAINT UQ_AppRoles_RoleName UNIQUE (RoleName)
    );
    PRINT 'AppRoles table created.';
END
ELSE
BEGIN
    PRINT 'AppRoles table already exists – skipping create.';
END
GO

-- Seed / upsert default system roles
MERGE AppRoles AS target
USING (VALUES
    ('admin',     'Administrator', 'Full system access — all screens and user management.',
     '["dashBoard","vendor","warehouse","gate","partyBinMaster","joStatus","userManagement"]', 1),

    ('manager',   'Manager', 'View JO Status overview, production details, reports and warehouse approvals.',
     '["dashBoard","warehouse","joStatus"]', 1),

    ('vendor',    'Vendor', 'Access vendor entry process and assigned JO Status entries.',
     '["vendor","joStatus"]', 1),

    ('watchman',  'Watchman', 'Access Dashboard and Gate Entry screens.',
     '["dashBoard","gate"]', 1),

    ('inventory', 'Inventory', 'Access Vendor Entry and Party Bin Master screens.',
     '["vendor","partyBinMaster"]', 1),

    ('operator',  'Operator', 'Limited operational task access.',
     '["vendor"]', 1)
) AS source (RoleName, DisplayName, Description, Permissions, IsSystem)
ON target.RoleName = source.RoleName
WHEN NOT MATCHED THEN
    INSERT (RoleName, DisplayName, Description, Permissions, IsSystem, CreatedAt)
    VALUES (source.RoleName, source.DisplayName, source.Description,
            source.Permissions, source.IsSystem, GETDATE());

PRINT 'Default roles seeded.';
GO

-- ════════════════════════════════════════════════════════════
--  Migration: QC Final Inspection (FI) Report
--  Source: docs/QC_Checking_Sample.xlsx (FI REPORT + DEFECT PHOTO)
--  Idempotent. api/qcInspection.js also creates these on first use.
-- ════════════════════════════════════════════════════════════

IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='QC_DefectMaster' AND xtype='U')
CREATE TABLE QC_DefectMaster (
    Id          INT IDENTITY(1,1) PRIMARY KEY,
    Category    NVARCHAR(20)  NOT NULL,          -- STITCHING | APPEARANCE
    DefectName  NVARCHAR(100) NOT NULL,
    SortOrder   INT           NOT NULL DEFAULT 0,
    IsActive    BIT           NOT NULL DEFAULT 1,
    CONSTRAINT UQ_QC_DefectMaster UNIQUE (Category, DefectName)
);
GO

IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='QC_Inspection' AND xtype='U')
CREATE TABLE QC_Inspection (
    Id                  INT IDENTITY(1,1) PRIMARY KEY,
    ReportNo            NVARCHAR(30)   NOT NULL,     -- QC/YYMM/0001
    ClientToken         NVARCHAR(64)   NULL,         -- idempotency key for double-submits
    DocType             NVARCHAR(10)   NULL,         -- JO | PO | ST  (from [@ASRS_Transaction] 'Binning')
    DocNum              NVARCHAR(100)  NULL,
    DocEntry            INT            NULL,
    SupplierCode        NVARCHAR(50)   NULL,
    SupplierName        NVARCHAR(200)  NULL,
    BrandName           NVARCHAR(100)  NULL,
    StyleName           NVARCHAR(200)  NULL,
    Colours             NVARCHAR(500)  NULL,
    DcNo                NVARCHAR(100)  NULL,
    Sizes               NVARCHAR(300)  NULL,
    OrderQty            INT            NULL,
    LotQty              INT            NULL,         -- AQL lot size
    InspectedQty        INT            NULL,
    InspectionDate      DATE           NULL,
    InspectionType      NVARCHAR(20)   NULL,         -- INLINE | PREFINAL | FINAL
    MeasurementUnit     NVARCHAR(10)   NULL,         -- INCH | CM
    InspectionLevel     NVARCHAR(5)    NULL,         -- I, II, III, S1–S4
    AqlMajor            DECIMAL(6,3)   NULL,
    AqlMinor            DECIMAL(6,3)   NULL,
    CodeLetter          NVARCHAR(2)    NULL,
    SampleSize          INT            NULL,
    MajorAc             INT            NULL,
    MajorRe             INT            NULL,
    MinorAc             INT            NULL,
    MinorRe             INT            NULL,
    MeasurementResult   NVARCHAR(10)   NULL,         -- PASS | FAIL
    MeasurementComments NVARCHAR(1000) NULL,
    PackingResult       NVARCHAR(10)   NULL,         -- PASS | FAIL
    PackingComments     NVARCHAR(1000) NULL,
    TotalMajor          INT            NOT NULL DEFAULT 0,
    TotalMinor          INT            NOT NULL DEFAULT 0,
    MajorResult         NVARCHAR(10)   NULL,
    MinorResult         NVARCHAR(10)   NULL,
    SystemResult        NVARCHAR(10)   NULL,         -- computed from AQL + audits
    FinalResult         NVARCHAR(20)   NULL,         -- PASS | FAIL | DEROGATION
    FaultDescription    NVARCHAR(2000) NULL,
    DefectComments      NVARCHAR(1000) NULL,
    FinalRemarks        NVARCHAR(1000) NULL,
    InspectorName       NVARCHAR(100)  NULL,
    UnitIncharge        NVARCHAR(100)  NULL,
    Merchandiser        NVARCHAR(100)  NULL,
    Amqc                NVARCHAR(100)  NULL,
    Gm                  NVARCHAR(100)  NULL,
    Status              NVARCHAR(20)   NOT NULL DEFAULT 'DRAFT',   -- DRAFT | SUBMITTED | APPROVED | REJECTED
    SubmittedAt         DATETIME       NULL,
    SubmittedBy         NVARCHAR(100)  NULL,
    ApprovedAt          DATETIME       NULL,
    ApprovedBy          NVARCHAR(100)  NULL,
    ApprovalRemarks     NVARCHAR(1000) NULL,
    CreatedAt           DATETIME       NOT NULL DEFAULT GETDATE(),
    CreatedBy           NVARCHAR(100)  NULL,
    UpdatedAt           DATETIME       NULL,
    UpdatedBy           NVARCHAR(100)  NULL,
    RowVer              ROWVERSION,
    CONSTRAINT UQ_QC_Inspection_ReportNo UNIQUE (ReportNo)
);
GO

-- Upgrade a QC_Inspection created by an earlier build (JO_Id / JO_No → DocType / DocNum / DocEntry)
IF COL_LENGTH('QC_Inspection', 'DocType')  IS NULL ALTER TABLE QC_Inspection ADD DocType  NVARCHAR(10)  NULL;
IF COL_LENGTH('QC_Inspection', 'DocNum')   IS NULL ALTER TABLE QC_Inspection ADD DocNum   NVARCHAR(100) NULL;
IF COL_LENGTH('QC_Inspection', 'DocEntry') IS NULL ALTER TABLE QC_Inspection ADD DocEntry INT           NULL;
GO
IF COL_LENGTH('QC_Inspection', 'JO_No') IS NOT NULL
    EXEC sp_executesql N'UPDATE QC_Inspection SET DocNum = JO_No WHERE DocNum IS NULL AND JO_No IS NOT NULL';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_QC_Inspection_ClientToken')
CREATE UNIQUE INDEX UX_QC_Inspection_ClientToken ON QC_Inspection (ClientToken) WHERE ClientToken IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_QC_Inspection_Date')
CREATE INDEX IX_QC_Inspection_Date ON QC_Inspection (InspectionDate, Status);
GO

IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='QC_InspectionDefects' AND xtype='U')
CREATE TABLE QC_InspectionDefects (
    Id           INT IDENTITY(1,1) PRIMARY KEY,
    InspectionId INT           NOT NULL
        CONSTRAINT FK_QC_InspectionDefects_Inspection REFERENCES QC_Inspection(Id) ON DELETE CASCADE,
    Category     NVARCHAR(20)  NOT NULL,
    DefectName   NVARCHAR(100) NOT NULL,
    MajorQty     INT           NOT NULL DEFAULT 0,
    MinorQty     INT           NOT NULL DEFAULT 0,
    IsCustom     BIT           NOT NULL DEFAULT 0,
    SortOrder    INT           NOT NULL DEFAULT 0
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_QC_InspectionDefects_Inspection')
CREATE INDEX IX_QC_InspectionDefects_Inspection ON QC_InspectionDefects (InspectionId);
GO

IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='QC_DefectPhotos' AND xtype='U')
CREATE TABLE QC_DefectPhotos (
    Id           INT IDENTITY(1,1) PRIMARY KEY,
    InspectionId INT            NOT NULL
        CONSTRAINT FK_QC_DefectPhotos_Inspection REFERENCES QC_Inspection(Id) ON DELETE CASCADE,
    Caption      NVARCHAR(200)  NOT NULL,
    MimeType     NVARCHAR(30)   NOT NULL,
    ImageData    VARBINARY(MAX) NOT NULL,
    CreatedAt    DATETIME       NOT NULL DEFAULT GETDATE(),
    CreatedBy    NVARCHAR(100)  NULL
);
GO

-- Defect checklist from the sample sheet (spelling corrected)
MERGE QC_DefectMaster AS target
USING (VALUES
    ('STITCHING','SKIP STITCH',1),('STITCHING','PUCKERING',2),('STITCHING','OPEN CHAIN STITCH',3),
    ('STITCHING','OPEN SEAM',4),('STITCHING','HOLE & DAMAGE',5),('STITCHING','ASYMMETRIC STITCH',6),
    ('STITCHING','SHAPE OFF',7),('STITCHING','YELLOW STAIN',8),('STITCHING','SPI VARIATION',9),
    ('STITCHING','LOOSE STITCH',10),('STITCHING','BROKEN STITCH',11),('STITCHING','UNTRIMMED THREAD',12),
    ('STITCHING','PLEAT',13),
    ('APPEARANCE','DYE STAIN',14),('APPEARANCE','HIKING',15),('APPEARANCE','CREASE MARK',16),
    ('APPEARANCE','ROPY HEM',17),('APPEARANCE','BLEEDING',18),('APPEARANCE','OIL STAIN OR WAX',19),
    ('APPEARANCE','WAVE STITCH',20),('APPEARANCE','COLOUR FLY',21),('APPEARANCE','WEAVING DEFECT',22),
    ('APPEARANCE','SHADE VARIATION',23),('APPEARANCE','BARTACK MISSING',24)
) AS source (Category, DefectName, SortOrder)
ON target.Category = source.Category AND target.DefectName = source.DefectName
WHEN NOT MATCHED THEN
    INSERT (Category, DefectName, SortOrder) VALUES (source.Category, source.DefectName, source.SortOrder);
GO

-- Grant the QC screens to the admin role (other roles: assign in User Management → Roles)
UPDATE AppRoles
SET Permissions = STUFF(Permissions, LEN(Permissions), 1,
        CASE WHEN Permissions = '[]' THEN '' ELSE ',' END + '"qcInspection","qcReport","qcApprove"]')
WHERE RoleName = 'admin' AND Permissions NOT LIKE '%qcInspection%';
GO
