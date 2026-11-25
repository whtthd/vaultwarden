-- A NULL parent records an explicitly known root. Missing rows represent legacy collections.
CREATE TABLE collection_parents (
    collection_uuid VARCHAR(40) NOT NULL PRIMARY KEY,
    org_uuid VARCHAR(40) NOT NULL,
    parent_uuid VARCHAR(40),
    FOREIGN KEY (collection_uuid) REFERENCES collections (uuid) ON DELETE CASCADE,
    FOREIGN KEY (parent_uuid) REFERENCES collections (uuid) ON DELETE SET NULL,
    CHECK (parent_uuid IS NULL OR parent_uuid <> collection_uuid)
);
CREATE INDEX collection_parents_children ON collection_parents (org_uuid, parent_uuid);

CREATE TABLE collection_reader_roles (
    collection_uuid VARCHAR(40) NOT NULL,
    membership_uuid CHAR(36) NOT NULL,
    org_uuid VARCHAR(40) NOT NULL,
    PRIMARY KEY (collection_uuid, membership_uuid),
    FOREIGN KEY (collection_uuid) REFERENCES collections (uuid) ON DELETE CASCADE,
    FOREIGN KEY (membership_uuid) REFERENCES users_organizations (uuid) ON DELETE CASCADE
);
CREATE INDEX collection_reader_roles_member ON collection_reader_roles (membership_uuid);

-- Starting at children keeps the root itself outside the role. UNION deduplicates overlapping roots.
CREATE VIEW inherited_collection_readers AS
WITH RECURSIVE readers (user_uuid, org_uuid, collection_uuid) AS (
    SELECT m.user_uuid, m.org_uuid, e.collection_uuid
    FROM collection_reader_roles r
    JOIN users_organizations m ON m.uuid = r.membership_uuid AND m.org_uuid = r.org_uuid AND m.status = 2
    JOIN collections root ON root.uuid = r.collection_uuid AND root.org_uuid = r.org_uuid
    JOIN collection_parents e ON e.org_uuid = r.org_uuid AND e.parent_uuid = root.uuid
    JOIN collections child ON child.uuid = e.collection_uuid AND child.org_uuid = e.org_uuid
    WHERE (root.external_id IS NULL OR LEFT(root.external_id, 24) COLLATE "C" <> 'vaultwarden:item-access:')
      AND (child.external_id IS NULL OR LEFT(child.external_id, 24) COLLATE "C" <> 'vaultwarden:item-access:')
    UNION
    SELECT readers.user_uuid, readers.org_uuid, e.collection_uuid
    FROM readers
    JOIN collection_parents e ON e.org_uuid = readers.org_uuid AND e.parent_uuid = readers.collection_uuid
    JOIN collections child ON child.uuid = e.collection_uuid AND child.org_uuid = e.org_uuid
    WHERE child.external_id IS NULL OR LEFT(child.external_id, 24) COLLATE "C" <> 'vaultwarden:item-access:'
)
SELECT user_uuid, collection_uuid FROM readers;
