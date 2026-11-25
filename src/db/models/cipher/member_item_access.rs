use std::collections::{HashMap, HashSet};

use diesel::prelude::*;
use serde::Serialize;

use super::{AccessFlags, Cipher, combine_access, with_inherited_read};
use crate::{
    CONFIG,
    db::{
        DbConn,
        models::{Collection, CollectionId, Membership, MembershipId, MembershipStatus, UserId},
        schema::{
            ciphers_collections, collections, collections_groups, groups, groups_users, inherited_collection_readers,
            users_collections, users_organizations,
        },
    },
};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemAccessPermission {
    pub read_only: bool,
    pub hide_passwords: bool,
}

impl From<AccessFlags> for ItemAccessPermission {
    fn from((read_only, hide_passwords, manage): AccessFlags) -> Self {
        Self {
            read_only: read_only && !manage,
            hide_passwords,
        }
    }
}

pub struct MemberItemAccess {
    pub collection_access: Option<ItemAccessPermission>,
    pub effective_access: Option<ItemAccessPermission>,
}

#[derive(Clone, Copy, Default)]
struct CollectionGrants {
    ordinary: Option<AccessFlags>,
    all: Option<AccessFlags>,
}

type GrantRow = (UserId, CollectionId, Option<String>, AccessFlags);

fn grants_by_user(
    rows: Vec<GrantRow>,
    single_id: &CollectionId,
    external_id: &str,
) -> HashMap<UserId, CollectionGrants> {
    let mut grants = HashMap::<UserId, CollectionGrants>::new();
    for (user, collection_id, external, flags) in rows {
        let entry = grants.entry(user).or_default();
        entry.all = Some(entry.all.map_or(flags, |current| combine_access(current, flags)));
        if collection_id != *single_id || external.as_deref() != Some(external_id) {
            entry.ordinary = Some(entry.ordinary.map_or(flags, |current| combine_access(current, flags)));
        }
    }
    grants
}

impl Cipher {
    /// Compute access twice, with and without this login's single-item collection.
    /// A direct assignment anywhere on the item takes precedence over all group
    /// assignments, matching the server's write check in base_access_restrictions.
    pub async fn member_item_access(
        &self,
        members: &[Membership],
        conn: &DbConn,
    ) -> Result<HashMap<MembershipId, MemberItemAccess>, crate::Error> {
        let Some(org_id) = &self.organization_uuid else {
            return Ok(HashMap::new());
        };
        let single_id = CollectionId::from(self.uuid.to_string());
        let external_id = Collection::item_access_external_id(&self.uuid);
        conn.run(move |db| {
            let attached = ciphers_collections::table
                .filter(ciphers_collections::cipher_uuid.eq(&self.uuid))
                .select(ciphers_collections::collection_uuid);
            let direct_rows = users_collections::table
                .inner_join(collections::table)
                .filter(collections::org_uuid.eq(org_id))
                .filter(users_collections::collection_uuid.eq_any(attached))
                .select((
                    users_collections::user_uuid,
                    collections::uuid,
                    collections::external_id,
                    (users_collections::read_only, users_collections::hide_passwords, users_collections::manage),
                ))
                .load::<GrantRow>(db)?;
            let direct = grants_by_user(direct_rows, &single_id, &external_id);
            let inherited: HashSet<UserId> = inherited_collection_readers::table
                .inner_join(collections::table)
                .filter(collections::org_uuid.eq(org_id))
                .filter(inherited_collection_readers::collection_uuid.eq_any(attached))
                .select(inherited_collection_readers::user_uuid)
                .distinct()
                .load(db)?
                .into_iter()
                .collect();

            let mut group_grants = HashMap::new();
            let mut full_group = HashSet::<UserId>::new();
            if CONFIG.org_groups_enabled() {
                let group_members = groups::table
                    .inner_join(groups_users::table)
                    .inner_join(
                        users_organizations::table
                            .on(users_organizations::uuid.eq(groups_users::users_organizations_uuid)),
                    )
                    .filter(groups::organizations_uuid.eq(org_id))
                    .filter(users_organizations::org_uuid.eq(org_id))
                    .filter(users_organizations::status.eq(MembershipStatus::Confirmed as i32));
                full_group.extend(
                    group_members
                        .filter(groups::access_all.eq(true))
                        .select(users_organizations::user_uuid)
                        .distinct()
                        .load::<UserId>(db)?,
                );
                let group_rows = group_members
                    .inner_join(collections_groups::table.on(collections_groups::groups_uuid.eq(groups::uuid)))
                    .inner_join(collections::table.on(collections::uuid.eq(collections_groups::collections_uuid)))
                    .filter(collections::org_uuid.eq(org_id))
                    .filter(collections_groups::collections_uuid.eq_any(attached))
                    .select((
                        users_organizations::user_uuid,
                        collections::uuid,
                        collections::external_id,
                        (collections_groups::read_only, collections_groups::hide_passwords, collections_groups::manage),
                    ))
                    .load::<GrantRow>(db)?;
                group_grants = grants_by_user(group_rows, &single_id, &external_id);
            }

            let mut result = HashMap::with_capacity(members.len());
            for member in members {
                if &member.org_uuid != org_id || !member.has_status(MembershipStatus::Confirmed) {
                    continue;
                }
                let full_access = member.has_full_access() || full_group.contains(&member.user_uuid);
                let access = if full_access {
                    let full = Some(ItemAccessPermission {
                        read_only: false,
                        hide_passwords: false,
                    });
                    MemberItemAccess {
                        collection_access: full,
                        effective_access: full,
                    }
                } else {
                    let user = direct.get(&member.user_uuid).copied().unwrap_or_default();
                    let group = group_grants.get(&member.user_uuid).copied().unwrap_or_default();
                    let inherited_read = inherited.contains(&member.user_uuid);
                    MemberItemAccess {
                        collection_access: with_inherited_read(user.ordinary.or(group.ordinary), inherited_read)
                            .map(Into::into),
                        effective_access: with_inherited_read(user.all.or(group.all), inherited_read).map(Into::into),
                    }
                };
                result.insert(member.uuid.clone(), access);
            }
            Ok(result)
        })
        .await
    }
}
