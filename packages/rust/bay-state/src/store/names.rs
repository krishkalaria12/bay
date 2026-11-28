//! A name for a group nobody named, from its tabs' titles (store/groupNames.ts). Sites put their name at one end of
//! the title ("Home / X", "Rick Astley - YouTube", "GitHub - user/repo"): that's the site; the rest is the page. Tabs
//! of one site on one page name the group "X Home", of one site "X". A tab still loading (no title) takes its site
//! from a loaded tab of its host, else from the host itself.

use std::collections::HashMap;

use crate::model::Tab;

const SEPARATORS: [&str; 8] = [" / ", " | ", " - ", " — ", " – ", " · ", " • ", " :: "];

/// A page's host without "www.", or "" when it has none.
pub(crate) fn host_of(url: &str) -> String {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_default();
    host.strip_prefix("www.").map(str::to_owned).unwrap_or(host)
}

fn squash(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

/// "x.com" → "x", "news.ycombinator.com" → "ycombinator", "bbc.co.uk" → "bbc".
fn host_label(host: &str) -> &str {
    let parts: Vec<&str> = host.split('.').filter(|p| !p.is_empty()).collect();
    match parts.as_slice() {
        [] => "",
        [only] => only,
        [.., third, second, last] if second.len() <= 3 && last.len() <= 2 => third,
        [.., second, _] => second,
    }
}

fn tidy_host(host: &str) -> String {
    let mut chars = host_label(host).chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

/// The title's two ends: (site candidate, page) pairs.
fn ends(title: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for sep in SEPARATORS {
        if let Some(last) = title.rfind(sep).filter(|&at| at > 0) {
            out.push((
                title[last + sep.len()..].trim().to_owned(),
                title[..last].trim().to_owned(),
            ));
        }
        if let Some(first) = title.find(sep).filter(|&at| at > 0) {
            out.push((
                title[..first].trim().to_owned(),
                title[first + sep.len()..].trim().to_owned(),
            ));
        }
    }
    out.retain(|(site, page)| !site.is_empty() && !page.is_empty());
    out
}

/// The site name a host's titles agree on: the end that looks like the host, else one end all of them share.
fn site_from_titles(host: &str, titles: &[&str]) -> Option<String> {
    let label = squash(host_label(host));
    let looks_like_host = |site: &str| {
        let s = squash(site);
        !s.is_empty()
            && !label.is_empty()
            && (s == label || (s.len() >= 3 && (label.contains(&s) || s.contains(&label))))
    };
    let shared = |site: &str| {
        titles
            .iter()
            .all(|t| ends(t).iter().any(|(s, _)| s == site))
    };
    let first = ends(titles[0]);
    for (site, _) in &first {
        if site.split(' ').count() <= 3 && looks_like_host(site) && shared(site) {
            return Some(site.clone());
        }
    }
    if titles.len() < 2 {
        return None;
    }
    first
        .into_iter()
        .map(|(site, _)| site)
        .find(|site| shared(site))
}

fn page_of(title: &str, site: Option<&str>) -> String {
    let Some(site) = site else {
        return title.trim().to_owned();
    };
    ends(title)
        .into_iter()
        .find(|(s, _)| s == site)
        .map_or_else(|| title.trim().to_owned(), |(_, page)| page)
}

pub fn auto_group_name(members: &[&Tab]) -> String {
    let Some(first) = members.first() else {
        return String::new();
    };
    let hosts: Vec<String> = members.iter().map(|m| host_of(&m.url)).collect();
    let mut titled_by_host: Vec<(&str, Vec<&str>)> = Vec::new();
    // The first tab with a title for each URL, for tabs of that URL still loading.
    let mut loaded_by_url: HashMap<&str, &Tab> = HashMap::new();
    for (m, host) in members.iter().zip(&hosts) {
        if m.title.is_empty() || m.title == m.url {
            continue;
        }
        match titled_by_host.iter_mut().find(|(h, _)| h == host) {
            Some((_, titles)) => titles.push(&m.title),
            None => titled_by_host.push((host, vec![&m.title])),
        }
        loaded_by_url.entry(&m.url).or_insert(m);
    }
    let site_of_host = |host: &str| {
        titled_by_host
            .iter()
            .find(|(h, _)| *h == host)
            .and_then(|(_, titles)| site_from_titles(host, titles))
            .unwrap_or_else(|| tidy_host(host))
    };
    let sites: Vec<String> = hosts.iter().map(|h| site_of_host(h)).collect();
    let site = &sites[0];
    if site.is_empty() || sites.iter().any(|s| s != site) {
        return if site.is_empty() {
            first.title.clone()
        } else {
            site.clone()
        };
    }
    // One site: add the page when every tab is on the same one (a loading tab counts if a loaded one has its URL).
    let site_in_titles = members
        .iter()
        .any(|m| !m.title.is_empty() && page_of(&m.title, Some(site)) != m.title.trim())
        .then_some(site.as_str());
    let pages: Vec<Option<String>> = members
        .iter()
        .map(|m| {
            let loaded = if !m.title.is_empty() && m.title != m.url {
                Some(*m)
            } else {
                loaded_by_url.get(m.url.as_str()).copied()
            };
            loaded.map(|l| page_of(&l.title, site_in_titles))
        })
        .collect();
    match (&site_in_titles, &pages[0]) {
        (Some(_), Some(page))
            if !page.is_empty()
                && pages.iter().all(|p| p.as_ref() == Some(page))
                && squash(page) != squash(site) =>
        {
            format!("{site} {page}")
        }
        _ => site.clone(),
    }
}
