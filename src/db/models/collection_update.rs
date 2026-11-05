use diesel::prelude::*;

use crate::{
    api::EmptyResult,
    db::{
        DbConn, DbConnInner,
        schema::{
            ciphers, ciphers_collections, collections, collections_groups, groups, users, users_collections,
            users_organizations,
        },
    },
    error::MapResult,
};

use super::{CipherId, Collection, CollectionGroup, CollectionId, CollectionUser, OrganizationId};

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

    pub async fn save_all(org_id: OrganizationId, updates: Vec<Self>, conn: &DbConn) -> EmptyResult {
        conn.run(move |conn| Self::save_transaction(&org_id, &updates, conn).map_res("Error updating collections"))
            .await
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
                            .first::<super::MembershipId>(conn)?;
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
            let member_users = users_organizations::table
                .filter(users_organizations::org_uuid.eq(org_id))
                .select(users_organizations::user_uuid);
            diesel::update(users::table.filter(users::uuid.eq_any(member_users)))
                .set(users::updated_at.eq(chrono::Utc::now().naive_utc()))
                .execute(conn)?;
            Ok(())
        })
    }
}

#[cfg(all(test, sqlite))]
mod tests;
