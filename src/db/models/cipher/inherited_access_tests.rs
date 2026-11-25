use std::sync::Arc;

use diesel::{connection::SimpleConnection, prelude::*, r2d2::Pool};
use diesel_migrations::MigrationHarness;
use tokio::sync::Semaphore;

use super::{Cipher, CipherId, CipherSyncData, CipherSyncType, CollectionId, Membership, OrganizationId, User, UserId};
use crate::db::{
    DbConn, DbConnInner, DbConnManager, DbPool,
    models::{Collection, CollectionUser},
    schema::{ciphers, users},
    sqlite_migrations::MIGRATIONS,
};

async fn database() -> DbConn {
    let pool = DbPool {
        pool: Some(Pool::builder().max_size(1).build(DbConnManager::new("sqlite://:memory:")).unwrap()),
        semaphore: Arc::new(Semaphore::new(1)),
    };
    let conn = pool.get().await.unwrap();
    conn.run(|connection| {
        #[cfg(any(mysql, postgresql))]
        let DbConnInner::Sqlite(sqlite) = connection else { unreachable!() };
        #[cfg(not(any(mysql, postgresql)))]
        let DbConnInner::Sqlite(sqlite) = connection;
        sqlite.run_pending_migrations(MIGRATIONS).unwrap();
        let mut user = User::new("reader@example.invalid", None);
        user.uuid = UserId::from("reader".to_owned());
        diesel::insert_into(users::table).values(&user).execute(sqlite).unwrap();
        sqlite.batch_execute(
            "INSERT INTO organizations (uuid, name, billing_email) VALUES ('org', 'Org', 'org@example.invalid');
             INSERT INTO users_organizations (uuid, user_uuid, org_uuid, access_all, akey, status, atype)
             VALUES ('member', 'reader', 'org', 0, 'key', 2, 2);
             INSERT INTO collections (uuid, org_uuid, name) VALUES
               ('root', 'org', 'opaque-a'), ('child', 'org', 'opaque-b'), ('other', 'org', 'opaque-c');
             INSERT INTO collection_parents (collection_uuid, org_uuid, parent_uuid) VALUES ('child', 'org', 'root');
             INSERT INTO collection_reader_roles (collection_uuid, membership_uuid, org_uuid) VALUES ('root', 'member', 'org');",
        ).unwrap();
        for id in ["child", "root", "other"] {
            let mut item = Cipher::new(1, id.to_owned());
            item.uuid = CipherId::from(id.to_owned());
            item.organization_uuid = Some(OrganizationId::from("org".to_owned()));
            item.data = "{}".into();
            diesel::insert_into(ciphers::table).values(item).execute(sqlite).unwrap();
        }
        sqlite.batch_execute(
            "INSERT INTO ciphers_collections (cipher_uuid, collection_uuid) VALUES
               ('child', 'child'), ('root', 'root'), ('other', 'other');",
        ).unwrap();
    }).await;
    conn
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inherited_read_in_lists_details_sync_and_write_checks() {
    let conn = database().await;
    let user = UserId::from("reader".to_owned());
    let child = CollectionId::from("child".to_owned());
    let cipher = Cipher::find_by_uuid(&CipherId::from("child".to_owned()), &conn).await.unwrap();
    let collection = Collection::find_by_uuid_and_user(&child, user.clone(), &conn).await.unwrap();
    assert_eq!(Collection::find_by_user_uuid(user.clone(), &conn).await.len(), 1);
    assert_eq!(Cipher::find_by_user_visible(&user, &conn).await.len(), 1);
    assert!(cipher.is_accessible_to_user(&user, &conn).await);
    assert!(!cipher.is_write_accessible_to_user(&user, &conn).await);
    assert!(!cipher.is_in_editable_collection_by_user(&user, &conn).await);
    assert!(!collection.is_writable_by_user(&user, &conn).await);
    assert!(!collection.is_manageable_by_user(&user, &conn).await);
    assert!(CollectionUser::find_by_user(&user, &conn).await.is_empty());
    let org = OrganizationId::from("org".to_owned());
    assert_eq!(Membership::find_by_cipher_and_org(&cipher.uuid, &org, &conn).await.len(), 1);
    assert_eq!(Membership::find_by_collection_and_org(&child, &org, &conn).await.len(), 1);

    // Group configuration is fixed per server process. Run the same fixture both ways to
    // ensure an inherited read cannot mask a configured group's existing edit grant.
    conn.run(|db| {
        db.batch_execute(
            "INSERT INTO groups (uuid, organizations_uuid, name, access_all, creation_date, revision_date)
         VALUES ('team','org','Team',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
         INSERT INTO groups_users (groups_uuid, users_organizations_uuid) VALUES ('team','member');
         INSERT INTO collections_groups (collections_uuid, groups_uuid, read_only, hide_passwords, manage)
         VALUES ('child','team',0,1,0);",
        )
        .unwrap();
    })
    .await;
    let group_edit = crate::CONFIG.org_groups_enabled();
    assert_eq!(cipher.is_write_accessible_to_user(&user, &conn).await, group_edit);
    let sync = CipherSyncData::new(&user, CipherSyncType::User, &conn).await;
    for cache in [None, Some(&sync)] {
        let item = cipher.to_json("", &user, cache, CipherSyncType::User, &conn).await.unwrap();
        assert_eq!(item["edit"], group_edit);
        assert_eq!(item["viewPassword"], true);
    }
    conn.run(|db| db.batch_execute("DELETE FROM collections_groups;").unwrap()).await;

    for has_direct_edit in [false, true] {
        if has_direct_edit {
            conn.run(|db| {
                db.batch_execute(
                    "INSERT INTO users_collections (user_uuid, collection_uuid, read_only, hide_passwords, manage)
                 VALUES ('reader','child',0,1,0);",
                )
                .unwrap();
            })
            .await;
        }
        let sync = CipherSyncData::new(&user, CipherSyncType::User, &conn).await;
        for cache in [None, Some(&sync)] {
            let item = cipher.to_json("", &user, cache, CipherSyncType::User, &conn).await.unwrap();
            assert_eq!(item["edit"], has_direct_edit);
            assert_eq!(item["viewPassword"], true);
            assert_eq!(item["collectionIds"], json!(["child"]));
            let details = collection.to_json_details(&user, cache, &conn).await;
            assert_eq!(details["readOnly"], !has_direct_edit);
            assert_eq!(details["hidePasswords"], false);
            assert_eq!(details["manage"], false);
        }
        assert_eq!(cipher.is_write_accessible_to_user(&user, &conn).await, has_direct_edit);
        assert!(!cipher.is_in_editable_collection_by_user(&user, &conn).await);
    }

    conn.run(|db| db.batch_execute("UPDATE users_organizations SET status = -1;").unwrap()).await;
    assert!(!cipher.is_accessible_to_user(&user, &conn).await);
    assert!(Cipher::find_by_user_visible(&user, &conn).await.is_empty());
    assert!(Collection::find_by_user_uuid(user.clone(), &conn).await.is_empty());
    conn.run(|db| {
        db.batch_execute("UPDATE users_organizations SET status = 2; DELETE FROM collection_reader_roles;").unwrap();
    })
    .await;
    let details = cipher.to_json("", &user, None, CipherSyncType::User, &conn).await.unwrap();
    assert_eq!(details["edit"], true);
    assert_eq!(details["viewPassword"], false);
    conn.run(|db| db.batch_execute("DELETE FROM users_collections;").unwrap()).await;
    assert!(!cipher.is_accessible_to_user(&user, &conn).await);
    assert!(Cipher::find_by_user_visible(&user, &conn).await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn single_item_dialog_separates_collection_access_from_actual_item_access() {
    use crate::db::models::MembershipId;
    use crate::db::schema::users_organizations;

    let conn = database().await;
    let org_id = OrganizationId::from("org".to_owned());
    let cipher = conn.run(|db| {
        let mut item = Cipher::new(1, "encrypted-name".to_owned());
        item.uuid = CipherId::from("login".to_owned());
        item.organization_uuid = Some(OrganizationId::from("org".to_owned()));
        item.data = "{}".to_owned();
        diesel::insert_into(ciphers::table).values(&item).execute(db).unwrap();
        for (id, role, status, access_all) in [
            ("owner", 0, 2, false),
            ("admin", 1, 2, false),
            ("all", 3, 2, true),
            ("group-full", 2, 2, false),
            ("group-with-single", 2, 2, false),
            ("mixed", 2, 2, false),
            ("direct-strong", 2, 2, false),
            ("only-single", 2, 2, false),
            ("revoked", 2, -1, true),
            ("invited", 2, 0, false),
            ("none", 2, 2, false),
        ] {
            let mut user = User::new(&format!("{id}@example.invalid"), None);
            user.uuid = UserId::from(id.to_owned());
            diesel::insert_into(users::table).values(&user).execute(db).unwrap();
            let mut member = Membership::new(user.uuid, OrganizationId::from("org".to_owned()), None);
            member.uuid = MembershipId::from(id.to_owned());
            member.atype = role;
            member.status = status;
            member.access_all = access_all;
            diesel::insert_into(users_organizations::table).values(&member).execute(db).unwrap();
        }
        db.batch_execute(
            "INSERT INTO collections (uuid, org_uuid, name, external_id)
             VALUES ('login','org','opaque-single','vaultwarden:item-access:login');
             INSERT INTO ciphers_collections (cipher_uuid, collection_uuid) VALUES ('login','child'),('login','other'),('login','login');
             INSERT INTO users_collections (user_uuid, collection_uuid, read_only, hide_passwords, manage) VALUES
              ('reader','login',0,1,0), ('group-with-single','login',1,1,0),
              ('mixed','other',1,1,0), ('direct-strong','child',0,1,0), ('direct-strong','login',1,0,0),
              ('only-single','login',1,0,0), ('revoked','other',0,0,0), ('invited','other',0,0,0);
             INSERT INTO groups (uuid,organizations_uuid,name,access_all,creation_date,revision_date) VALUES
              ('full','org','Full',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
              ('editing','org','Editors',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
             INSERT INTO groups_users (groups_uuid,users_organizations_uuid) VALUES
              ('full','group-full'),('full','revoked'),('editing','mixed'),('editing','group-with-single');
             INSERT INTO collections_groups (collections_uuid,groups_uuid,read_only,hide_passwords,manage)
              VALUES ('child','editing',0,0,0);",
        ).unwrap();
        item
    }).await;
    let members = Membership::find_by_org(&org_id, &conn).await;
    let access = cipher.member_item_access(&members, &conn).await.unwrap();
    let edit = Some((false, false));
    let view = Some((true, false));
    let hidden_view = Some((true, true));
    let hidden_edit = Some((false, true));
    let group_edit = if crate::CONFIG.org_groups_enabled() {
        edit
    } else {
        None
    };
    for (member_id, expected_collection, expected_effective) in [
        ("member", view, edit),
        ("direct-strong", hidden_edit, edit),
        ("only-single", None, view),
        ("group-with-single", group_edit, hidden_view),
        ("mixed", hidden_view, hidden_view),
        ("group-full", group_edit, group_edit),
        ("owner", edit, edit),
        ("admin", edit, edit),
        ("all", edit, edit),
        ("none", None, None),
    ] {
        let id = MembershipId::from(member_id.to_owned());
        let entry = &access[&id];
        let flags = |p: super::member_item_access::ItemAccessPermission| (p.read_only, p.hide_passwords);
        assert_eq!(entry.collection_access.map(flags), expected_collection, "{member_id}: collection");
        assert_eq!(entry.effective_access.map(flags), expected_effective, "{member_id}: effective");
        let user = &members.iter().find(|m| m.uuid == id).unwrap().user_uuid;
        assert_eq!(cipher.is_accessible_to_user(user, &conn).await, expected_effective.is_some());
        assert_eq!(
            cipher.is_write_accessible_to_user(user, &conn).await,
            expected_effective.is_some_and(|(read_only, _)| !read_only)
        );
        if let Some((_, hide)) = expected_effective {
            let actual = cipher.to_json("", user, None, CipherSyncType::User, &conn).await.unwrap();
            assert_eq!(actual["viewPassword"], !hide, "{member_id}: password");
        }
    }
    for id in ["revoked", "invited"] {
        assert!(!access.contains_key(&MembershipId::from(id.to_owned())));
    }

    // Remove the dedicated collection link, then compare the ordinary-collection
    // preview to the actual server checks for every member in the same fixture.
    conn.run(|db| {
        db.batch_execute("DELETE FROM ciphers_collections WHERE cipher_uuid = 'login' AND collection_uuid = 'login';")
            .unwrap();
    })
    .await;
    for member in &members {
        let preview = access.get(&member.uuid).and_then(|entry| entry.collection_access);
        assert_eq!(cipher.is_accessible_to_user(&member.user_uuid, &conn).await, preview.is_some());
        assert_eq!(
            cipher.is_write_accessible_to_user(&member.user_uuid, &conn).await,
            preview.is_some_and(|p| !p.read_only)
        );
        if let Some(permission) = preview {
            let actual = cipher.to_json("", &member.user_uuid, None, CipherSyncType::User, &conn).await.unwrap();
            assert_eq!(actual["viewPassword"], !permission.hide_passwords);
        }
    }
}
