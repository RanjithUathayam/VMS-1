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
