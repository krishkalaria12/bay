//! "new doc", "create sheet": rows that open a new document on a service that makes one at `<thing>.new`.

use serde::Serialize;

use super::{Pattern, pattern};
use crate::js;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, uniffi::Record)]
pub struct QuickCreate {
    pub id: String,
    pub title: String,
    pub url: String,
    pub site: String,
}

const QUICK_CREATE: &[(&str, &str, &str, &[&str], &str)] = &[
    (
        "doc",
        "New Google Doc",
        "https://docs.new",
        &["doc", "docs", "document", "google doc", "gdoc"],
        "docs.google.com",
    ),
    (
        "sheet",
        "New Google Sheet",
        "https://sheets.new",
        &["sheet", "sheets", "spreadsheet", "google sheet"],
        "sheets.google.com",
    ),
    (
        "slides",
        "New Google Slides",
        "https://slides.new",
        &["slides", "slide", "presentation", "deck", "google slides"],
        "slides.google.com",
    ),
    (
        "form",
        "New Google Form",
        "https://forms.new",
        &["form", "forms", "survey", "google form"],
        "forms.google.com",
    ),
    (
        "meeting",
        "New Google Calendar Event",
        "https://meeting.new",
        &["meeting", "event", "calendar", "invite"],
        "calendar.google.com",
    ),
    (
        "meet",
        "New Google Meet",
        "https://meet.new",
        &["meet", "call", "video call", "google meet"],
        "meet.google.com",
    ),
    (
        "notion",
        "New Notion Page",
        "https://notion.new",
        &["notion", "note", "page", "notion page"],
        "notion.so",
    ),
    (
        "linear",
        "New Linear Issue",
        "https://linear.new",
        &["linear", "issue", "ticket", "linear issue"],
        "linear.app",
    ),
    (
        "jira",
        "New Jira Issue",
        "https://jira.new",
        &["jira", "ticket", "issue", "jira issue"],
        "atlassian.com",
    ),
    (
        "confluence",
        "New Confluence Page",
        "https://confluence.new",
        &["wiki", "confluence", "confluence page"],
        "atlassian.com",
    ),
    (
        "gist",
        "New GitHub Gist",
        "https://gist.new",
        &["gist", "snippet", "github gist"],
        "github.com",
    ),
    (
        "repo",
        "New GitHub Repository",
        "https://repo.new",
        &["repo", "repository", "github repo"],
        "github.com",
    ),
    (
        "figma",
        "New Figma Design",
        "https://figma.new",
        &["figma", "design", "figma design"],
        "figma.com",
    ),
    (
        "figjam",
        "New FigJam Board",
        "https://figjam.new",
        &["figjam", "whiteboard", "board"],
        "figma.com",
    ),
    (
        "word",
        "New Word Document",
        "https://word.new",
        &["word", "word document"],
        "word.cloud.microsoft",
    ),
    (
        "excel",
        "New Excel Workbook",
        "https://excel.new",
        &["excel", "workbook"],
        "excel.cloud.microsoft",
    ),
    (
        "powerpoint",
        "New PowerPoint Presentation",
        "https://powerpoint.new",
        &["powerpoint", "ppt"],
        "powerpoint.cloud.microsoft",
    ),
];

static NEW: Pattern = Pattern::new(|| pattern(r"(?i)^(?:new|create)(\s+(.*))?$"));

fn row((id, title, url, _, site): &(&str, &str, &str, &[&str], &str)) -> QuickCreate {
    QuickCreate {
        id: (*id).into(),
        title: (*title).into(),
        url: (*url).into(),
        site: (*site).into(),
    }
}

pub fn match_quick_create(query: &str, limit: usize) -> Vec<QuickCreate> {
    let Some(m) =
        NEW.captures(query.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
    else {
        return Vec::new();
    };
    if m.get(1).is_none() {
        return Vec::new();
    }
    let rest = js::trim(m.get(2).map_or("", |m| m.as_str()))
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if rest.is_empty() {
        return QUICK_CREATE.iter().take(limit).map(row).collect();
    }
    let rank = |aliases: &[&str]| {
        if aliases.contains(&rest.as_str()) {
            Some(0)
        } else if aliases.iter().any(|alias| alias.starts_with(&rest)) {
            Some(1)
        } else {
            None
        }
    };
    let mut ranked: Vec<(usize, usize)> = QUICK_CREATE
        .iter()
        .enumerate()
        .filter_map(|(order, entry)| rank(entry.3).map(|r| (r, order)))
        .collect();
    ranked.sort();
    ranked
        .into_iter()
        .take(limit)
        .map(|(_, order)| row(&QUICK_CREATE[order]))
        .collect()
}
