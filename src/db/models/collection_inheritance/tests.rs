use diesel::connection::SimpleConnection;

use super::*;
use crate::db::schema::inherited_collection_readers;

fn db(foreign_keys: bool) -> DbConnInner {
    let mut conn = DbConnInner::Sqlite(SqliteConnection::establish(":memory:").unwrap());
    if foreign_keys {
        conn.batch_execute("PRAGMA foreign_keys=ON").unwrap();
    }
    conn.batch_execute(
        "CREATE TABLE organizations (uuid TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE collections (uuid TEXT PRIMARY KEY, org_uuid TEXT, external_id TEXT);
        CREATE TABLE users_organizations (uuid TEXT PRIMARY KEY, org_uuid TEXT, user_uuid TEXT, status INTEGER);
        INSERT INTO organizations VALUES ('org','org'),('elsewhere','elsewhere');
        INSERT INTO collections VALUES ('a','org',NULL),('a1','org',NULL),('a2','org',NULL),('l','org',NULL),
        ('new','org',NULL),('b','org',NULL),('ordinary','org','VAULTWARDEN:item-access:p'),('private','org','vaultwarden:item-access:p'),('foreign','elsewhere',NULL);
        INSERT INTO users_organizations VALUES ('mx','org','x',2),('my','org','y',2),('invited','org','i',0),
        ('foreign-m','elsewhere','z',2);",
    )
    .unwrap();
    conn.batch_execute(include_str!(
        "../../../../migrations/sqlite/2026-11-25-120000_add_collection_reader_roles/up.sql"
    ))
    .unwrap();
    conn
}

fn change(
    conn: &mut DbConnInner,
    edits: &[(&str, Option<&str>)],
    initial: &[(&str, Option<&str>)],
    roles: &[(&str, &[&str], &[&str])],
) -> QueryResult<()> {
    let org = OrganizationId::from("org");
    let convert = |pairs: &[(&str, Option<&str>)]| -> Vec<ParentChange> {
        pairs.iter().map(|(c, p)| ((*c).to_owned().into(), p.map(|id| id.to_owned().into()))).collect()
    };
    let memberships = |ids: &[&str]| ids.iter().map(|s| MembershipId::from((*s).to_owned())).collect();
    let readers: Vec<ReaderChange> =
        roles.iter().map(|(root, a, r)| ((*root).to_owned().into(), memberships(a), memberships(r))).collect();
    conn.transaction(|conn| {
        CollectionInheritance::lock(&org, conn)?;
        CollectionInheritance::apply(&org, &convert(edits), &convert(initial), &readers, conn)
    })
}

fn visible(conn: &mut DbConnInner, user: &str) -> Vec<String> {
    inherited_collection_readers::table
        .filter(inherited_collection_readers::user_uuid.eq(user))
        .select(inherited_collection_readers::collection_uuid)
        .order(inherited_collection_readers::collection_uuid)
        .load(conn)
        .unwrap()
}

#[test]
fn root_grants_follow_existing_and_future_children_without_changing_other_members() {
    let mut conn = db(true);
    change(
        &mut conn,
        &[],
        &[("a", None), ("a1", Some("a")), ("a2", Some("a")), ("l", Some("a1"))],
        &[("a", &["my"], &[]), ("a1", &["mx"], &[])],
    )
    .unwrap();
    assert_eq!(visible(&mut conn, "y"), ["a1", "a2", "l"]);
    assert_eq!(visible(&mut conn, "x"), ["l"]);
    change(&mut conn, &[("new", Some("l"))], &[], &[("a1", &["my"], &[])]).unwrap();
    assert_eq!(visible(&mut conn, "y"), ["a1", "a2", "l", "new"]);
    change(&mut conn, &[], &[], &[("a", &[], &["my"])]).unwrap();
    assert_eq!(visible(&mut conn, "y"), ["l", "new"]);
    assert_eq!(visible(&mut conn, "x"), ["l", "new"]);
    conn.batch_execute("UPDATE users_organizations SET status=-1 WHERE uuid='my'").unwrap();
    assert_eq!(visible(&mut conn, "y"), Vec::<String>::new());
    change(&mut conn, &[], &[], &[("a1", &[], &["my"])]).unwrap();
    assert_eq!(visible(&mut conn, "x"), ["l", "new"]);
}

#[test]
fn moves_override_stale_initialization_and_recompute_visible_items() {
    let mut conn = db(true);
    change(&mut conn, &[("a1", Some("a")), ("l", Some("a1"))], &[], &[("a", &["my"], &[])]).unwrap();
    change(&mut conn, &[("a1", Some("b"))], &[("a1", Some("a"))], &[]).unwrap();
    assert_eq!(visible(&mut conn, "y"), Vec::<String>::new());
    change(&mut conn, &[("a1", None)], &[], &[]).unwrap();
    change(&mut conn, &[], &[("a1", Some("a"))], &[]).unwrap();
    assert_eq!(visible(&mut conn, "y"), Vec::<String>::new());
    change(&mut conn, &[("l", Some("a"))], &[], &[]).unwrap();
    assert_eq!(visible(&mut conn, "y"), ["l"]);
}

#[test]
fn system_collection_marker_is_case_sensitive() {
    let mut conn = db(true);
    change(
        &mut conn,
        &[("ordinary", Some("a")), ("l", Some("ordinary"))],
        &[],
        &[("a", &["my"], &[]), ("ordinary", &["mx"], &[])],
    )
    .unwrap();
    assert_eq!(visible(&mut conn, "y"), ["l", "ordinary"]);
    assert_eq!(visible(&mut conn, "x"), ["l"]);
    assert!(change(&mut conn, &[("private", Some("a"))], &[], &[]).is_err());
}

#[test]
fn invalid_edges_cycles_and_roles_roll_back_whole_batch() {
    let mut conn = db(true);
    change(&mut conn, &[("a1", Some("a"))], &[], &[("a", &["my"], &[])]).unwrap();
    for invalid_parent in ["foreign", "private", "missing", "new"] {
        assert!(change(&mut conn, &[("new", Some(invalid_parent))], &[], &[]).is_err());
    }
    assert!(change(&mut conn, &[("a", Some("a1"))], &[], &[]).is_err());
    assert!(change(&mut conn, &[("new", Some("a")), ("new", Some("b"))], &[], &[]).is_err());
    for member in ["missing", "foreign-m", "invited"] {
        assert!(change(&mut conn, &[("new", Some("a"))], &[], &[("a", &[member], &[])]).is_err());
    }
    for root in ["private", "foreign", "missing"] {
        assert!(change(&mut conn, &[], &[], &[(root, &["my"], &[])]).is_err());
    }
    assert!(change(&mut conn, &[], &[], &[("a", &["my"], &["my"])]).is_err());
    assert_eq!(visible(&mut conn, "y"), ["a1"]);
    assert_eq!(visible(&mut conn, "z"), Vec::<String>::new());
}

#[test]
fn deleting_intermediate_node_preserves_ancestor_role_but_expires_deleted_role() {
    for fk in [false, true] {
        let mut conn = db(fk);
        change(&mut conn, &[("a1", Some("a")), ("l", Some("a1"))], &[], &[("a", &["my"], &[]), ("a1", &["mx"], &[])])
            .unwrap();
        conn.transaction::<_, diesel::result::Error, _>(|conn| {
            let org = OrganizationId::from("org");
            CollectionInheritance::lock(&org, conn)?;
            CollectionInheritance::prepare_delete(&org, &CollectionId::from("a1".to_owned()), conn)?;
            conn.batch_execute("DELETE FROM collections WHERE uuid='a1'")
        })
        .unwrap();
        assert_eq!(visible(&mut conn, "y"), ["l"]);
        assert_eq!(visible(&mut conn, "x"), Vec::<String>::new());
        conn.batch_execute("DELETE FROM users_organizations WHERE uuid='my'").unwrap();
        assert_eq!(collection_reader_roles::table.count().get_result::<i64>(&mut conn).unwrap(), 0);
        conn.batch_execute(include_str!(
            "../../../../migrations/sqlite/2026-11-25-120000_add_collection_reader_roles/down.sql"
        ))
        .unwrap();
    }
}
