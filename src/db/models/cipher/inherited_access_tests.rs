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
