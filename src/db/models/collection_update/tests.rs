use diesel::connection::SimpleConnection;

use super::*;
use crate::db::{
    models::{CollectionId, UserId},
    schema::ciphers_collections,
};

fn database() -> DbConnInner {
    let mut conn = DbConnInner::Sqlite(SqliteConnection::establish(":memory:").unwrap());
    conn.batch_execute(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE collections (uuid TEXT PRIMARY KEY, org_uuid TEXT NOT NULL, name TEXT NOT NULL, external_id TEXT);
         CREATE TABLE users (uuid TEXT PRIMARY KEY, updated_at TIMESTAMP NOT NULL);
         CREATE TABLE users_organizations (uuid TEXT PRIMARY KEY, user_uuid TEXT, org_uuid TEXT);
         CREATE TABLE groups (uuid TEXT PRIMARY KEY, organizations_uuid TEXT);
         CREATE TABLE users_collections (user_uuid TEXT REFERENCES users(uuid), collection_uuid TEXT REFERENCES collections(uuid), read_only BOOL, hide_passwords BOOL, manage BOOL, PRIMARY KEY(user_uuid,collection_uuid));
         CREATE TABLE collections_groups (collections_uuid TEXT REFERENCES collections(uuid), groups_uuid TEXT REFERENCES groups(uuid), read_only BOOL, hide_passwords BOOL, manage BOOL, PRIMARY KEY(collections_uuid,groups_uuid));
         CREATE TABLE ciphers_collections (cipher_uuid TEXT, collection_uuid TEXT REFERENCES collections(uuid), PRIMARY KEY(cipher_uuid,collection_uuid));
         CREATE TABLE ciphers (uuid TEXT PRIMARY KEY, organization_uuid TEXT, atype INTEGER, deleted_at TIMESTAMP, updated_at TIMESTAMP, data TEXT);
         INSERT INTO collections VALUES ('parent','org','encrypted-old-parent','external-parent'), ('child','org','encrypted-old-child',NULL), ('foreign','other-org','unchanged',NULL);
         INSERT INTO users VALUES ('user','2000-01-01 00:00:00'), ('removed','2000-01-01 00:00:00');
         INSERT INTO users_organizations VALUES ('member','user','org'), ('former-assignee','removed','org');
         INSERT INTO groups VALUES ('group','org'), ('foreign-group','other-org');
         INSERT INTO users_collections VALUES ('removed','child',1,1,0);
         INSERT INTO ciphers_collections VALUES ('login','child');
         INSERT INTO ciphers VALUES ('login','org',1,NULL,'2000-01-01 00:00:00','unchanged-encrypted-data'),
           ('foreign-login','other-org',1,NULL,'2000-01-01 00:00:00','foreign-data'),
           ('personal-login',NULL,1,NULL,'2000-01-01 00:00:00','personal-data'),
           ('note','org',2,NULL,'2000-01-01 00:00:00','note-data'),
           ('deleted-login','org',1,'2000-01-01 00:00:00','2000-01-01 00:00:00','deleted-data');"
    ).unwrap();
    conn
}

fn rename(id: &str) -> CollectionUpdate {
    CollectionUpdate {
        collection: Collection {
            uuid: CollectionId::from(id.to_owned()),
            org_uuid: OrganizationId::from("org".to_owned()),
            name: format!("encrypted-new-{id}"),
            external_id: Some("preserved-external".into()),
        },
        users: None,
        groups: None,
    }
}

fn name(id: &str, conn: &mut DbConnInner) -> String {
    collections::table
        .filter(collections::uuid.eq(CollectionId::from(id.to_owned())))
        .select(collections::name)
        .first(conn)
        .unwrap()
}

#[test]
fn rename_keeps_ids_access_and_item_associations() {
    let mut conn = database();
    CollectionUpdate::save_transaction(
        &OrganizationId::from("org".to_owned()),
        &[rename("parent"), rename("child")],
        &mut conn,
    )
    .unwrap();
    assert_eq!(name("parent", &mut conn), "encrypted-new-parent");
    assert_eq!(name("child", &mut conn), "encrypted-new-child");
    assert_eq!(ciphers_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
    assert_eq!(users_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
    let changed = users::table
        .filter(
            users::updated_at.gt(chrono::NaiveDate::from_ymd_opt(2000, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap()),
        )
        .count()
        .get_result::<i64>(&mut conn)
        .unwrap();
    assert_eq!(changed, 2);
}

#[test]
fn invalid_later_collection_rolls_back_names_and_permissions() {
    let mut conn = database();
    let mut child = rename("child");
    child.users = Some(vec![]);
    let result = CollectionUpdate::save_transaction(
        &OrganizationId::from("org".to_owned()),
        &[child, rename("missing")],
        &mut conn,
    );
    assert!(result.is_err());
    assert_eq!(name("child", &mut conn), "encrypted-old-child");
    assert_eq!(users_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
}

#[test]
fn foreign_collection_and_foreign_group_are_rejected_atomically() {
    let mut conn = database();
    assert!(
        CollectionUpdate::save_transaction(
            &OrganizationId::from("org".to_owned()),
            &[rename("parent"), rename("foreign")],
            &mut conn
        )
        .is_err()
    );
    assert_eq!(name("parent", &mut conn), "encrypted-old-parent");
    let mut child = rename("child");
    child.groups = Some(vec![CollectionGroup::new(
        CollectionId::from("child".to_owned()),
        super::super::GroupId::from("foreign-group".to_owned()),
        false,
        false,
        true,
    )]);
    assert!(
        CollectionUpdate::save_transaction(
            &OrganizationId::from("org".to_owned()),
            &[rename("parent"), child],
            &mut conn
        )
        .is_err()
    );
    assert_eq!(name("parent", &mut conn), "encrypted-old-parent");
}

#[test]
fn permission_change_updates_existing_collection_and_revoked_users_revision() {
    let mut conn = database();
    let mut child = rename("child");
    child.users = Some(vec![CollectionUser {
        user_uuid: UserId::from("user".to_owned()),
        collection_uuid: CollectionId::from("child".to_owned()),
        read_only: false,
        hide_passwords: false,
        manage: true,
    }]);
    child.groups = Some(vec![CollectionGroup::new(
        CollectionId::from("child".to_owned()),
        super::super::GroupId::from("group".to_owned()),
        true,
        true,
        false,
    )]);
    CollectionUpdate::save_transaction(&OrganizationId::from("org".to_owned()), &[child], &mut conn).unwrap();
    let assignees = users_collections::table.select(users_collections::user_uuid).load::<UserId>(&mut conn).unwrap();
    assert_eq!(assignees, [UserId::from("user".to_owned())]);
    assert_eq!(collections_groups::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
    assert_eq!(ciphers_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
}

#[test]
fn database_constraint_failure_rolls_back_earlier_updates() {
    let mut conn = database();
    let mut child = rename("child");
    let grant = || CollectionUser {
        user_uuid: UserId::from("user".to_owned()),
        collection_uuid: CollectionId::from("child".to_owned()),
        read_only: false,
        hide_passwords: false,
        manage: true,
    };
    child.users = Some(vec![grant(), grant()]);
    assert!(
        CollectionUpdate::save_transaction(
            &OrganizationId::from("org".to_owned()),
            &[rename("parent"), child],
            &mut conn,
        )
        .is_err()
    );
    assert_eq!(name("parent", &mut conn), "encrypted-old-parent");
    assert_eq!(name("child", &mut conn), "encrypted-old-child");
    let assignee = users_collections::table.select(users_collections::user_uuid).first::<UserId>(&mut conn).unwrap();
    assert_eq!(assignee, UserId::from("removed".to_owned()));
}

#[test]
fn parent_and_child_revocation_commits_once_and_keeps_independent_permissions() {
    let mut conn = database();
    conn.batch_execute(
        "INSERT INTO users_collections VALUES ('removed','parent',1,1,0), ('user','child',0,0,0);
         INSERT INTO groups VALUES ('independent-group','org');
         INSERT INTO collections_groups VALUES ('parent','group',1,1,0), ('child','group',1,1,0),
           ('child','independent-group',0,0,0);",
    )
    .unwrap();
    let mut parent = rename("parent");
    parent.users = Some(vec![]);
    parent.groups = Some(vec![]);
    let mut child = rename("child");
    child.users = Some(vec![CollectionUser {
        user_uuid: UserId::from("user".to_owned()),
        collection_uuid: CollectionId::from("child".to_owned()),
        read_only: false,
        hide_passwords: false,
        manage: false,
    }]);
    child.groups = Some(vec![CollectionGroup::new(
        CollectionId::from("child".to_owned()),
        super::super::GroupId::from("independent-group".to_owned()),
        false,
        false,
        false,
    )]);
    let updates = [parent, child];
    for _ in 0..2 {
        CollectionUpdate::save_transaction(&OrganizationId::from("org".to_owned()), &updates, &mut conn).unwrap();
        assert_eq!(users_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
        assert_eq!(collections_groups::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
        assert_eq!(ciphers_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
        let remaining = users_collections::table
            .select((users_collections::user_uuid, users_collections::collection_uuid, users_collections::manage))
            .first::<(UserId, CollectionId, bool)>(&mut conn)
            .unwrap();
        assert_eq!(remaining, (UserId::from("user".to_owned()), CollectionId::from("child".to_owned()), false));
    }
}

fn item_grant() -> CollectionUser {
    CollectionUser {
        user_uuid: UserId::from("user".to_owned()),
        collection_uuid: CollectionId::from("login".to_owned()),
        read_only: true,
        hide_passwords: true,
        manage: false,
    }
}

fn save_item(grants: Vec<CollectionUser>, conn: &mut DbConnInner) -> QueryResult<()> {
    CollectionUpdate::save_item_access_transaction(
        &OrganizationId::from("org".to_owned()),
        &CipherId::from("login".to_owned()),
        "encrypted-single-item-name".into(),
        grants,
        conn,
    )
}

#[test]
fn empty_new_single_item_access_is_a_noop() {
    let mut conn = database();
    save_item(vec![], &mut conn).unwrap();
    assert_eq!(collections::table.count().get_result::<i64>(&mut conn).unwrap(), 3);
    assert_eq!(ciphers_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
    assert_eq!(users_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
}

#[test]
fn single_item_grant_and_revoke_preserve_original_item_and_collection_access() {
    let mut conn = database();
    save_item(vec![item_grant()], &mut conn).unwrap();
    assert_eq!(collections::table.count().get_result::<i64>(&mut conn).unwrap(), 4);
    assert_eq!(ciphers_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 2);
    assert_eq!(users_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 2);
    save_item(vec![item_grant()], &mut conn).unwrap();
    assert_eq!(collections::table.count().get_result::<i64>(&mut conn).unwrap(), 4);
    assert_eq!(ciphers_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 2);
    save_item(vec![], &mut conn).unwrap();
    assert_eq!(users_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
    assert_eq!(name("child", &mut conn), "encrypted-old-child");
    assert_eq!(
        ciphers::table
            .filter(ciphers::uuid.eq(CipherId::from("login".to_owned())))
            .select(ciphers::data)
            .first::<String>(&mut conn)
            .unwrap(),
        "unchanged-encrypted-data"
    );
    let private = collections::table
        .filter(collections::uuid.eq(CollectionId::from("login".to_owned())))
        .first::<Collection>(&mut conn)
        .unwrap();
    assert!(private.accepts_cipher(&CipherId::from("login".to_owned())));
    assert!(!private.accepts_cipher(&CipherId::from("other-item".to_owned())));
}

#[test]
fn single_item_rejects_foreign_personal_deleted_missing_and_non_login_targets() {
    let mut conn = database();
    for id in ["foreign-login", "personal-login", "deleted-login", "missing", "note"] {
        let result = CollectionUpdate::save_item_access_transaction(
            &OrganizationId::from("org".to_owned()),
            &CipherId::from(id.to_owned()),
            "encrypted-name".into(),
            vec![],
            &mut conn,
        );
        assert!(result.is_err(), "{id}");
    }
    assert_eq!(collections::table.count().get_result::<i64>(&mut conn).unwrap(), 3);
    assert_eq!(ciphers_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
}

#[test]
fn single_item_duplicate_members_and_foreign_members_roll_back_new_collection_and_revision() {
    let mut conn = database();
    assert!(save_item(vec![item_grant(), item_grant()], &mut conn).is_err());
    let mut foreign = item_grant();
    foreign.user_uuid = UserId::from("not-an-org-member".to_owned());
    assert!(save_item(vec![foreign], &mut conn).is_err());
    let mut elevated = item_grant();
    elevated.manage = true;
    assert!(save_item(vec![elevated], &mut conn).is_err());
    assert_eq!(collections::table.count().get_result::<i64>(&mut conn).unwrap(), 3);
    assert_eq!(ciphers_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
    assert_eq!(users_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
    let revision = ciphers::table
        .filter(ciphers::uuid.eq(CipherId::from("login".to_owned())))
        .select(ciphers::updated_at)
        .first::<chrono::NaiveDateTime>(&mut conn)
        .unwrap();
    assert_eq!(revision.to_string(), "2000-01-01 00:00:00");
}

#[test]
fn single_item_uuid_collision_cannot_overwrite_an_existing_collection() {
    let mut conn = database();
    conn.batch_execute("INSERT INTO collections VALUES ('login','other-org','protected',NULL);").unwrap();
    assert!(save_item(vec![item_grant()], &mut conn).is_err());
    assert_eq!(name("login", &mut conn), "protected");
    assert_eq!(ciphers_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 1);
}

#[test]
fn single_item_rejects_a_collection_bound_to_an_additional_item() {
    let mut conn = database();
    save_item(vec![item_grant()], &mut conn).unwrap();
    conn.batch_execute("INSERT INTO ciphers_collections VALUES ('other-item','login');").unwrap();
    assert!(save_item(vec![], &mut conn).is_err());
    assert_eq!(users_collections::table.count().get_result::<i64>(&mut conn).unwrap(), 2);
}
