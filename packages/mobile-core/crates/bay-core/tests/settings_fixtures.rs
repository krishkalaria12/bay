//! Replays `fixtures/settings.jsonl` (scripts/settings-vector.mjs): the TypeScript Settings' pages, index values and
//! search for a range of states in every language. Each row's action is compared with the call the TypeScript row's
//! callback made.

use std::collections::HashMap;

use bay_core::settings::{
    INDEX, IndexCounts, RowKind, SettingsAction, SettingsContext, SettingsPage, SettingsSection,
    index_value, match_settings, path_to, search_entries, sections,
};
use bay_core::sync::service::SyncType;
use serde_json::{Value, json};

fn call(action: &SettingsAction) -> Value {
    let (name, args) = match action {
        SettingsAction::Change { update } => ("change", json!([update])),
        SettingsAction::ChooseEngine { id } => ("chooseEngine", json!([id])),
        // JavaScript has one kind of number: a whole number of days is written as one.
        SettingsAction::SetArchiveAfterDays { days } => (
            "setArchiveAfterDays",
            json!([days.map(|days| if days.fract() == 0.0 {
                json!(days as i64)
            } else {
                json!(days)
            })]),
        ),
        SettingsAction::SetBlockContent { on } => ("setBlockContent", json!([on])),
        SettingsAction::ResumeBlocking { host } => ("resumeBlocking", json!([host])),
        SettingsAction::SetLockPrivateTabs { on } => ("setLockPrivateTabs", json!([on])),
        SettingsAction::SetLanguage { locale } => ("setLanguage", json!([locale])),
        SettingsAction::MakeDefault => ("makeDefault", json!([])),
        SettingsAction::ExportTabs => ("exportTabs", json!([])),
        SettingsAction::ForgetLogin { login } => ("forgetLogin", json!([login])),
        SettingsAction::AskToClear => ("clear.ask", json!([])),
        SettingsAction::ConfirmClear => ("clear.confirm", json!([])),
        SettingsAction::KeepData => ("clear.keep", json!([])),
        SettingsAction::ShowWelcome => ("showWelcome", json!([])),
        SettingsAction::OpenLink { url } => ("openLink", json!([url])),
        SettingsAction::SyncNow => ("sync.syncNow", json!([])),
        SettingsAction::SetSyncType { kind, on } => {
            let kind = match kind {
                SyncType::Tabs => "tabs",
                SyncType::Bookmarks => "bookmarks",
                SyncType::History => "history",
            };
            ("sync.setType", json!([kind, on]))
        }
        SettingsAction::LeaveSync => ("sync.leave", json!([])),
        SettingsAction::OpenSyncedTab { url } => ("sync.openTab", json!([url])),
    };
    json!({ "fn": name, "args": args })
}

fn kind(kind: &RowKind) -> Value {
    match kind {
        RowKind::Page { page, checked } => {
            json!({ "type": "page", "page": page, "checked": checked })
        }
        RowKind::Choice { selected, action } => {
            json!({ "type": "choice", "selected": selected, "action": call(action) })
        }
        RowKind::Toggle {
            on,
            when_on,
            when_off,
        } => {
            json!({ "type": "toggle", "on": on, "whenOn": call(when_on), "whenOff": call(when_off) })
        }
        RowKind::Action { action } => json!({ "type": "action", "action": call(action) }),
        RowKind::Info => json!({ "type": "info" }),
    }
}

fn plain(sections: &[SettingsSection]) -> Value {
    sections
        .iter()
        .map(|section| {
            json!({
                "id": section.id,
                "title": section.title,
                "rows": section.rows.iter().map(|row| json!({
                    "id": row.id,
                    "testID": row.test_id,
                    "label": row.label,
                    "detail": row.detail,
                    "value": row.value,
                    "icon": row.icon,
                    "danger": row.danger,
                    "disabled": row.disabled,
                    "kind": kind(&row.kind),
                })).collect::<Vec<_>>(),
                "footer": section.footer,
                "footerTestID": section.footer_test_id,
            })
        })
        .collect()
}

#[test]
fn settings_says_and_does_what_the_typescript_settings_does() {
    let mut contexts: HashMap<u64, SettingsContext> = HashMap::new();
    let mut checked = 0;
    let mut failures = Vec::new();

    for (number, line) in include_str!("../../../fixtures/settings.jsonl")
        .lines()
        .enumerate()
    {
        let line: Value = serde_json::from_str(line).unwrap();
        let fun = line["fn"].as_str().unwrap();
        if fun == "context" {
            let ctx = serde_json::from_value(line["ctx"].clone())
                .unwrap_or_else(|error| panic!("context {}: {error}", line["scenario"]));
            contexts.insert(line["scenario"].as_u64().unwrap(), ctx);
            continue;
        }
        let ctx = line["scenario"]
            .as_u64()
            .map(|scenario| &contexts[&scenario]);
        let got = match fun {
            "sections" => {
                let page: SettingsPage = serde_json::from_value(line["page"].clone()).unwrap();
                plain(&sections(page, ctx.unwrap()))
            }
            "indexValues" => {
                let counts: IndexCounts = serde_json::from_value(line["counts"].clone()).unwrap();
                json!(
                    INDEX
                        .iter()
                        .flat_map(|card| card.iter())
                        .map(|entry| index_value(*entry, ctx.unwrap(), counts))
                        .collect::<Vec<_>>()
                )
            }
            "searchEntries" => serde_json::to_value(search_entries(ctx.unwrap())).unwrap(),
            "matchSettings" => serde_json::to_value(match_settings(
                line["query"].as_str().unwrap(),
                &search_entries(ctx.unwrap()),
            ))
            .unwrap(),
            "pathTo" => {
                let page: SettingsPage = serde_json::from_value(line["page"].clone()).unwrap();
                serde_json::to_value(path_to(page)).unwrap()
            }
            other => panic!("unknown fn {other}"),
        };
        checked += 1;
        if got != line["result"] {
            failures.push(format!(
                "line {} {fun} {} {}:\n  want {}\n  got  {}",
                number + 1,
                line["scenario"],
                line.get("page")
                    .or(line.get("query"))
                    .unwrap_or(&Value::Null),
                line["result"],
                got
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {checked} differ:\n{}",
        failures.len(),
        failures
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
    println!("{checked} checked");
}

fn every_context() -> Vec<SettingsContext> {
    include_str!("../../../fixtures/settings.jsonl")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|line| line["fn"] == "context")
        .map(|line| serde_json::from_value(line["ctx"].clone()).unwrap())
        .collect()
}

#[test]
fn every_page_builds_with_unique_rows_and_test_ids() {
    for ctx in every_context() {
        for page in bay_core::settings::SETTINGS_PAGES {
            let rows: Vec<_> = sections(page, &ctx)
                .into_iter()
                .flat_map(|section| section.rows)
                .collect();
            let ids: std::collections::HashSet<_> = rows.iter().map(|row| &row.id).collect();
            let test_ids: std::collections::HashSet<_> =
                rows.iter().map(|row| &row.test_id).collect();
            assert_eq!(ids.len(), rows.len(), "{page:?}: row ids");
            assert_eq!(test_ids.len(), rows.len(), "{page:?}: test ids");
        }
    }
}

#[test]
fn a_row_that_opens_a_page_opens_one_whose_parent_is_the_page_it_is_on() {
    for ctx in every_context() {
        for page in bay_core::settings::SETTINGS_PAGES {
            for row in sections(page, &ctx)
                .into_iter()
                .flat_map(|section| section.rows)
            {
                if let RowKind::Page { page: opened, .. } = row.kind {
                    assert_eq!(opened.parent(), Some(page), "{page:?} → {opened:?}");
                }
            }
        }
    }
}

#[test]
fn the_index_and_a_page_come_whole_for_the_apps() {
    let ctx = every_context().remove(0);
    let counts = IndexCounts {
        bookmarks: 0,
        history: 3,
        downloads: 1,
        crashes: 0,
    };
    let index = bay_core::settings::settings_index(ctx.clone(), counts);
    assert_eq!(index.len(), 4);
    assert_eq!(index[0][1].value.as_deref(), Some("Google"));
    assert_eq!(index[3][0].tile.icon, "mark");
    let page = bay_core::settings::settings_page(SettingsPage::Language, ctx);
    assert_eq!(page.parent, Some(SettingsPage::General));
    assert!(page.blurb.is_none());
    assert_eq!(
        bay_core::settings::settings_path(SettingsPage::Language),
        [SettingsPage::General, SettingsPage::Language]
    );
}
