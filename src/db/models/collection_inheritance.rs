use std::collections::{HashMap, HashSet};

use diesel::{prelude::*, result::Error::NotFound};

use super::{CollectionId, MembershipId, MembershipStatus, OrganizationId};
use crate::{
    Error, MapResult,
    db::{
        DbConn, DbConnInner,
        schema::{collection_parents, collection_reader_roles, collections, organizations, users_organizations},
    },
};

pub struct CollectionInheritance;

type ParentChange = (CollectionId, Option<CollectionId>);
type ReaderChange = (CollectionId, Vec<MembershipId>, Vec<MembershipId>);

impl CollectionInheritance {
    /// Acquire before the first read in a tree-changing transaction, including on MySQL REPEATABLE READ.
    /// The write takes a SQLite write lock and a row lock on the organization on the other backends.
    pub fn lock(org: &OrganizationId, conn: &mut DbConnInner) -> QueryResult<()> {
        diesel::update(organizations::table.filter(organizations::uuid.eq(org)))
            .set(organizations::name.eq(organizations::name))
            .execute(conn)?;
        Ok(())
    }

    /// Apply in the same locked transaction as the collection changes and the member revision updates.
    pub fn apply(
        org: &OrganizationId,
        parents: &[ParentChange],
        bootstrap: &[ParentChange],
        readers: &[ReaderChange],
        conn: &mut DbConnInner,
    ) -> QueryResult<()> {
        if parents.is_empty() && bootstrap.is_empty() && readers.is_empty() {
            return Ok(());
        }
        let collections: HashSet<CollectionId> = collections::table
            .filter(collections::org_uuid.eq(org))
            .select((collections::uuid, collections::external_id))
            .load::<(CollectionId, Option<String>)>(conn)?
            .into_iter()
            .filter_map(|(id, external_id)| {
                (!external_id.as_deref().is_some_and(|value| value.starts_with("vaultwarden:item-access:")))
                    .then_some(id)
            })
            .collect();
        if !parents.is_empty() || !bootstrap.is_empty() {
            Self::set_parents(org, parents, bootstrap, &collections, conn)?;
        }
        let mut seen_roots = HashSet::new();
        for (root, added, removed) in readers {
            if !seen_roots.insert(root) || !collections.contains(root) {
                return Err(NotFound);
            }
            let mut touched = HashSet::new();
            for member in added.iter().chain(removed) {
                if !touched.insert(member) {
                    return Err(NotFound);
                }
            }
            for (members, must_be_confirmed) in [(added, true), (removed, false)] {
                if members.is_empty() {
                    continue;
                }
                let statuses: Vec<i32> = users_organizations::table
                    .filter(users_organizations::org_uuid.eq(org))
                    .filter(users_organizations::uuid.eq_any(members))
                    .select(users_organizations::status)
                    .load(conn)?;
                if statuses.len() != members.len()
                    || (must_be_confirmed && statuses.iter().any(|&s| s != MembershipStatus::Confirmed as i32))
                {
                    return Err(NotFound);
                }
            }
            diesel::delete(
                collection_reader_roles::table
                    .filter(collection_reader_roles::collection_uuid.eq(root))
                    .filter(collection_reader_roles::membership_uuid.eq_any(removed)),
            )
            .execute(conn)?;
            for member in added {
                let assigned = collection_reader_roles::table.find((root, member)).count().get_result::<i64>(conn)?;
                if assigned == 0 {
                    diesel::insert_into(collection_reader_roles::table)
                        .values((
                            collection_reader_roles::collection_uuid.eq(root),
                            collection_reader_roles::membership_uuid.eq(member),
                            collection_reader_roles::org_uuid.eq(org),
                        ))
                        .execute(conn)?;
                }
            }
        }
        Ok(())
    }

    fn set_parents(
        org: &OrganizationId,
        changes: &[ParentChange],
        bootstrap: &[ParentChange],
        collections: &HashSet<CollectionId>,
        conn: &mut DbConnInner,
    ) -> QueryResult<()> {
        let stored: HashMap<_, _> = collection_parents::table
            .filter(collection_parents::org_uuid.eq(org))
            .select((collection_parents::collection_uuid, collection_parents::parent_uuid))
            .load::<ParentChange>(conn)?
            .into_iter()
            .collect();
        let mut tree = stored.clone();
        for (input, initialize_only) in [(bootstrap, true), (changes, false)] {
            let mut seen = HashSet::new();
            for (child, parent) in input {
                if !seen.insert(child)
                    || !collections.contains(child)
                    || parent.as_ref().is_some_and(|p| p == child || !collections.contains(p))
                {
                    return Err(NotFound);
                }
                if !initialize_only || !stored.contains_key(child) {
                    tree.insert(child.clone(), parent.clone());
                }
            }
        }
        // Check the final graph so a valid batch move need not arrive in topological order.
        let mut checked = HashSet::new();
        for start in tree.keys() {
            let mut path = HashSet::new();
            let mut next = Some(start);
            while let Some(id) = next {
                if checked.contains(id) {
                    break;
                }
                if !path.insert(id) {
                    return Err(NotFound);
                }
                next = tree.get(id).and_then(Option::as_ref);
            }
            checked.extend(path);
        }
        for (child, parent) in &tree {
            match stored.get(child) {
                Some(old) if old == parent => {}
                Some(_) => {
                    diesel::update(collection_parents::table.find(child))
                        .set(collection_parents::parent_uuid.eq(parent))
                        .execute(conn)?;
                }
                None => {
                    diesel::insert_into(collection_parents::table)
                        .values((
                            collection_parents::collection_uuid.eq(child),
                            collection_parents::org_uuid.eq(org),
                            collection_parents::parent_uuid.eq(parent),
                        ))
                        .execute(conn)?;
                }
            }
        }
        Ok(())
    }

    /// Removing an intermediate node preserves ancestry for its surviving children. Its own roles expire.
    pub fn prepare_delete(org: &OrganizationId, id: &CollectionId, conn: &mut DbConnInner) -> QueryResult<()> {
        let parent = collection_parents::table
            .filter(collection_parents::org_uuid.eq(org))
            .find(id)
            .select(collection_parents::parent_uuid)
            .first::<Option<CollectionId>>(conn)
            .optional()?
            .flatten();
        diesel::update(
            collection_parents::table
                .filter(collection_parents::org_uuid.eq(org))
                .filter(collection_parents::parent_uuid.eq(id)),
        )
        .set(collection_parents::parent_uuid.eq(parent))
        .execute(conn)?;
        Ok(())
    }

    pub async fn readers(org: &OrganizationId, root: &CollectionId, conn: &DbConn) -> Result<Vec<MembershipId>, Error> {
        conn.run(|conn| {
            collection_reader_roles::table
                .filter(collection_reader_roles::org_uuid.eq(org))
                .filter(collection_reader_roles::collection_uuid.eq(root))
                .select(collection_reader_roles::membership_uuid)
                .order(collection_reader_roles::membership_uuid)
                .load(conn)
                .map_res("Error loading descendant reader roles")
        })
        .await
    }
}

#[cfg(all(test, sqlite))]
mod tests;
