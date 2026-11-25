use diesel::prelude::*;

use crate::{
    api::EmptyResult,
    db::{
        DbConn, DbConnInner,
        schema::{
            ciphers, ciphers_collections, collection_parents, collection_reader_roles, collections, collections_groups,
            groups, users, users_collections, users_organizations,
        },
    },
    error::MapResult,
};

use super::{
    CipherId, Collection, CollectionGroup, CollectionId, CollectionInheritance, CollectionUser, MembershipId,
    OrganizationId,
};

#[derive(Default)]
pub struct CollectionHierarchyChanges {
    pub revision: Option<String>,
    pub parents: Vec<(CollectionId, Option<CollectionId>)>,
    pub bootstrap: Vec<(CollectionId, Option<CollectionId>)>,
    pub readers: Vec<(CollectionId, Vec<MembershipId>, Vec<MembershipId>)>,
    // A legacy client has supplied a new encrypted name without supplying its parent.
    pub unknown_paths: Vec<CollectionId>,
}

impl CollectionHierarchyChanges {
    /// Names are ciphertext. Compare the exact catalog the browser decrypted before accepting
    /// edges, so a concurrent rename or creation cannot attach an item to a stale branch.
    fn check_revision(&self, org_id: &OrganizationId, conn: &mut DbConnInner) -> EmptyResult {
        let Some(revision) = &self.revision else {
            return Ok(());
        };
        let catalog: Vec<(CollectionId, String, Option<String>)> = collections::table
            .filter(collections::org_uuid.eq(org_id))
            .select((collections::uuid, collections::name, collections::external_id))
            .order(collections::uuid)
            .load(conn)?;
        let mut bytes = Vec::new();
        for (id, name, external_id) in catalog {
            if external_id.as_deref().is_some_and(|id| id.starts_with("vaultwarden:item-access:")) {
                continue;
            }
            bytes.extend_from_slice(id.as_bytes());
            bytes.push(0);
            bytes.extend_from_slice(name.as_bytes());
            bytes.push(0);
        }
        if crate::crypto::sha256_hex(&bytes) != *revision {
            err!("The collection hierarchy changed. Reopen the form and try again.");
        }
        Ok(())
    }

    fn apply(&self, org_id: &OrganizationId, conn: &mut DbConnInner) -> EmptyResult {
        if !self.unknown_paths.is_empty() {
            let roles = collection_reader_roles::table.filter(collection_reader_roles::org_uuid.eq(org_id));
            if diesel::select(diesel::dsl::exists(roles)).get_result::<bool>(conn)? {
                err!(
                    "This organization uses descendant reader roles. Use the updated web vault to create, rename or move collections with their parent information."
                );
            }
            diesel::delete(
                collection_parents::table
                    .filter(collection_parents::org_uuid.eq(org_id))
                    .filter(collection_parents::collection_uuid.eq_any(&self.unknown_paths)),
            )
            .execute(conn)?;
        }
        CollectionInheritance::apply(org_id, &self.parents, &self.bootstrap, &self.readers, conn)
            .map_res("Invalid collection hierarchy or reader assignment. Refresh the collection and try again.")
    }
}

/// One existing collection and its optional access changes. Item associations are never replaced.
pub struct CollectionUpdate {
    pub collection: Collection,
    pub users: Option<Vec<CollectionUser>>,
    pub groups: Option<Vec<CollectionGroup>>,
}

impl CollectionUpdate {
    pub async fn save_item_access(
        org_id: OrganizationId,
        cipher_id: CipherId,
        name: String,
        users: Vec<CollectionUser>,
        conn: &DbConn,
    ) -> EmptyResult {
        conn.run(move |conn| {
            Self::save_item_access_transaction(&org_id, &cipher_id, name, users, conn)
                .map_res("Error updating single-item access")
        })
        .await
    }

    fn save_item_access_transaction(
        org_id: &OrganizationId,
        cipher_id: &CipherId,
        name: String,
        users: Vec<CollectionUser>,
        conn: &mut DbConnInner,
    ) -> QueryResult<()> {
        conn.transaction(|conn| {
            let target = ciphers::table
                .filter(ciphers::uuid.eq(cipher_id))
                .filter(ciphers::organization_uuid.eq(org_id))
                .filter(ciphers::atype.eq(1))
                .filter(ciphers::deleted_at.is_null());
            target.select(ciphers::uuid).first::<CipherId>(conn)?;
            let collection_id = CollectionId::from(cipher_id.to_string());
            let external_id = Collection::item_access_external_id(cipher_id);
            let existing =
                collections::table.filter(collections::uuid.eq(&collection_id)).first::<Collection>(conn).optional()?;
            if let Some(existing) = &existing
                && (existing.org_uuid != *org_id || existing.external_id.as_deref() != Some(external_id.as_str()))
            {
                return Err(diesel::result::Error::NotFound);
            }
            if ciphers_collections::table
                .filter(ciphers_collections::collection_uuid.eq(&collection_id))
                .filter(ciphers_collections::cipher_uuid.ne(cipher_id))
                .count()
                .get_result::<i64>(conn)?
                != 0
                || users.iter().any(|u| u.collection_uuid != collection_id || u.manage)
            {
                return Err(diesel::result::Error::NotFound);
            }
            // Avoid leaving an empty reserved collection when a user saves the
            // dialog without selecting anyone for an item that never had a grant.
            if existing.is_none() && users.is_empty() {
                return Ok(());
            }
            // The item row lock serializes concurrent saves of its deterministic access collection.
            diesel::update(target).set(ciphers::updated_at.eq(chrono::Utc::now().naive_utc())).execute(conn)?;
            target.select(ciphers::uuid).first::<CipherId>(conn)?;
            let collection = Collection {
                uuid: collection_id.clone(),
                org_uuid: org_id.clone(),
                name,
                external_id: Some(external_id),
            };
            if existing.is_none() {
                diesel::insert_into(collections::table).values(&collection).execute(conn)?;
            }
            let linked = ciphers_collections::table
                .filter(ciphers_collections::cipher_uuid.eq(cipher_id))
                .filter(ciphers_collections::collection_uuid.eq(&collection_id))
                .count()
                .get_result::<i64>(conn)?;
            if linked == 0 {
                diesel::insert_into(ciphers_collections::table)
                    .values((
                        ciphers_collections::cipher_uuid.eq(cipher_id),
                        ciphers_collections::collection_uuid.eq(&collection_id),
                    ))
                    .execute(conn)?;
            }
            Self::save_transaction(
                org_id,
                &[Self {
                    collection,
                    users: Some(users),
                    groups: None,
                }],
                conn,
            )
        })
    }

    /// Serialize collection structure and its grants with the organization row. A stale
    /// permission form cannot overwrite a concurrent move with an outdated encrypted path.
    pub async fn save_all(
        org_id: &OrganizationId,
        updates: &[Self],
        previous: Vec<(CollectionId, String, Option<String>)>,
        hierarchy: CollectionHierarchyChanges,
        conn: &DbConn,
    ) -> EmptyResult {
        conn.run(move |conn| {
            conn.transaction(|conn| {
                CollectionInheritance::lock(org_id, conn)?;
                hierarchy.check_revision(org_id, conn)?;
                for (id, name, external_id) in previous {
                    let current = collections::table
                        .find(&id)
                        .filter(collections::org_uuid.eq(org_id))
                        .select((collections::name, collections::external_id))
                        .first::<(String, Option<String>)>(conn)?;
                    if current != (name, external_id) {
                        err!("The collection changed. Refresh it before saving.");
                    }
                }
                hierarchy.apply(org_id, conn)?;
                Self::save_transaction(org_id, updates, conn).map_res("Error updating collections")
            })
        })
        .await
    }

    pub async fn create_all(
        org_id: &OrganizationId,
        updates: &[Self],
        hierarchy: CollectionHierarchyChanges,
        conn: &DbConn,
    ) -> EmptyResult {
        conn.run(move |conn| {
            conn.transaction(|conn| {
                CollectionInheritance::lock(org_id, conn)?;
                hierarchy.check_revision(org_id, conn)?;
                for update in updates {
                    diesel::insert_into(collections::table).values(&update.collection).execute(conn)?;
                }
                hierarchy.apply(org_id, conn)?;
                Self::save_transaction(org_id, updates, conn).map_res("Error creating collections")
            })
        })
        .await
    }

    pub(super) fn update_org_revision(org_id: &OrganizationId, conn: &mut DbConnInner) -> QueryResult<()> {
        let member_users = users_organizations::table
            .filter(users_organizations::org_uuid.eq(org_id))
            .select(users_organizations::user_uuid);
        diesel::update(users::table.filter(users::uuid.eq_any(member_users)))
            .set(users::updated_at.eq(chrono::Utc::now().naive_utc()))
            .execute(conn)?;
        Ok(())
    }

    fn save_transaction(org_id: &OrganizationId, updates: &[Self], conn: &mut DbConnInner) -> QueryResult<()> {
        conn.transaction(|conn| {
            for update in updates {
                let collection = &update.collection;
                let exists = collections::table
                    .filter(collections::uuid.eq(&collection.uuid))
                    .filter(collections::org_uuid.eq(org_id))
                    .select(collections::uuid)
                    .first::<CollectionId>(conn)
                    .optional()?
                    .is_some();
                if collection.org_uuid != *org_id || !exists {
                    return Err(diesel::result::Error::NotFound);
                }

                diesel::update(collections::table.filter(collections::uuid.eq(&collection.uuid)))
                    .set(collection)
                    .execute(conn)?;

                if let Some(access) = &update.users {
                    diesel::delete(
                        users_collections::table.filter(users_collections::collection_uuid.eq(&collection.uuid)),
                    )
                    .execute(conn)?;
                    for entry in access {
                        users_organizations::table
                            .filter(users_organizations::org_uuid.eq(org_id))
                            .filter(users_organizations::user_uuid.eq(&entry.user_uuid))
                            .select(users_organizations::uuid)
                            .first::<MembershipId>(conn)?;
                        if entry.collection_uuid != collection.uuid {
                            return Err(diesel::result::Error::NotFound);
                        }
                        diesel::insert_into(users_collections::table).values(entry).execute(conn)?;
                    }
                }
                if let Some(access) = &update.groups {
                    diesel::delete(
                        collections_groups::table.filter(collections_groups::collections_uuid.eq(&collection.uuid)),
                    )
                    .execute(conn)?;
                    for entry in access {
                        groups::table
                            .filter(groups::organizations_uuid.eq(org_id))
                            .filter(groups::uuid.eq(&entry.groups_uuid))
                            .select(groups::uuid)
                            .first::<super::GroupId>(conn)?;
                        if entry.collections_uuid != collection.uuid {
                            return Err(diesel::result::Error::NotFound);
                        }
                        diesel::insert_into(collections_groups::table).values(entry).execute(conn)?;
                    }
                }
            }

            // Include removed assignees and group members, so their next sync drops revoked access.
            Self::update_org_revision(org_id, conn)
        })
    }
}

#[cfg(all(test, sqlite))]
mod tests;
