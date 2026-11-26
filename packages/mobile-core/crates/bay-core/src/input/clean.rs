//! Tracking parameters taken out of addresses (`utm_*`, `fbclid`, a site's own sharing marks).

use crate::js;

const GLOBAL_PARAMS: &[&str] = &[
    "gclid",
    "gclsrc",
    "dclid",
    "gbraid",
    "wbraid",
    "gad_source",
    "gad_campaignid",
    "_ga",
    "_gl",
    "srsltid",
    "fbclid",
    "igshid",
    "msclkid",
    "twclid",
    "ttclid",
    "li_fat_id",
    "yclid",
    "ysclid",
    "rdt_cid",
    "epik",
    "mc_cid",
    "mc_eid",
    "_hsenc",
    "_hsmi",
    "__hssc",
    "__hstc",
    "__hsfp",
    "hsctatracking",
    "mkt_tok",
    "elqtrackid",
    "elqtrack",
    "vero_id",
    "vero_conv",
    "_kx",
    "__s",
    "oly_anon_id",
    "oly_enc_id",
    "_openstat",
    "wickedid",
    "rb_clickid",
    "s_cid",
    "irclickid",
    "cjevent",
    "sscid",
    "zanpid",
    "ranmid",
    "raneaid",
    "ransiteid",
    "trk_contact",
    "trk_msg",
    "trk_module",
    "trk_sid",
];

const GLOBAL_PREFIXES: &[&str] = &["utm_", "pk_", "mtm_", "piwik_", "matomo_", "hsa_", "stm_"];

struct SiteParams {
    hosts: &'static [&'static str],
    params: &'static [&'static str],
    prefixes: &'static [&'static str],
}

const SITE_PARAMS: &[SiteParams] = &[
    SiteParams {
        hosts: &["youtube.com", "youtu.be", "music.youtube.com"],
        params: &["si", "pp", "feature"],
        prefixes: &[],
    },
    SiteParams {
        hosts: &["open.spotify.com"],
        params: &["si", "nd", "context"],
        prefixes: &[],
    },
    SiteParams {
        hosts: &["instagram.com"],
        params: &["igsh", "img_index"],
        prefixes: &[],
    },
    SiteParams {
        hosts: &["x.com", "twitter.com"],
        params: &["s", "t", "ref_src", "ref_url"],
        prefixes: &[],
    },
    SiteParams {
        hosts: &["threads.net", "threads.com"],
        params: &["xmt", "slof"],
        prefixes: &[],
    },
    SiteParams {
        hosts: &["tiktok.com"],
        params: &[
            "is_from_webapp",
            "sender_device",
            "sender_web_id",
            "_r",
            "_t",
        ],
        prefixes: &[],
    },
    SiteParams {
        hosts: &["linkedin.com"],
        params: &[
            "trk",
            "trackingid",
            "lipi",
            "midtoken",
            "midsig",
            "trkemail",
            "eid",
        ],
        prefixes: &[],
    },
    SiteParams {
        hosts: &["reddit.com"],
        params: &["share_id", "ref_source", "ref_campaign"],
        prefixes: &[],
    },
    SiteParams {
        hosts: &["medium.com"],
        params: &["source"],
        prefixes: &[],
    },
    SiteParams {
        hosts: &["facebook.com"],
        params: &["mibextid", "sfnsn", "rdid", "share_url"],
        prefixes: &[],
    },
    SiteParams {
        hosts: &[
            "amazon.com",
            "amazon.co.uk",
            "amazon.de",
            "amazon.fr",
            "amazon.it",
            "amazon.es",
            "amazon.ca",
            "amazon.co.jp",
            "amazon.in",
            "amazon.com.au",
        ],
        params: &[
            "_encoding",
            "psc",
            "ref",
            "ref_",
            "tag",
            "linkcode",
            "linkid",
            "camp",
            "creative",
            "creativeasin",
            "content-id",
            "crid",
            "sprefix",
            "qid",
            "sr",
            "dib",
            "dib_tag",
        ],
        prefixes: &["pd_rd_", "pf_rd_"],
    },
];

fn site_rules(hostname: &str) -> impl Iterator<Item = &'static SiteParams> {
    let lower = hostname.to_lowercase();
    let host = lower.strip_prefix("www.").unwrap_or(&lower).to_owned();
    SITE_PARAMS.iter().filter(move |rule| {
        rule.hosts
            .iter()
            .any(|h| host == *h || host.ends_with(&format!(".{h}")))
    })
}

fn decode_name(raw: &str) -> String {
    js::decode_uri_component(&raw.replace('+', " "))
        .unwrap_or_else(|| raw.to_owned())
        .to_lowercase()
}

pub fn is_tracking_param(name: &str, hostname: &str) -> bool {
    let key = name.to_lowercase();
    if GLOBAL_PARAMS.contains(&key.as_str()) || GLOBAL_PREFIXES.iter().any(|p| key.starts_with(p)) {
        return true;
    }
    site_rules(hostname).any(|rule| {
        rule.params.contains(&key.as_str()) || rule.prefixes.iter().any(|p| key.starts_with(p))
    })
}

/// The tracking-parameter table as JSON (`{ global, prefixes, sites: [{ hosts, params, prefixes }] }`), for the engines,
/// which strip the same parameters from main-frame navigations.
#[uniffi::export]
pub fn tracking_parameters_json() -> String {
    serde_json::json!({
        "global": GLOBAL_PARAMS,
        "prefixes": GLOBAL_PREFIXES,
        "sites": SITE_PARAMS
            .iter()
            .map(|site| serde_json::json!({ "hosts": site.hosts, "params": site.params, "prefixes": site.prefixes }))
            .collect::<Vec<_>>(),
    })
    .to_string()
}

/// The address without its tracking parameters.
#[uniffi::export]
pub fn clean_url(url: &str) -> String {
    let hash_at = url.find('#').unwrap_or(url.len());
    let Some(query_at) = url[..hash_at].find('?') else {
        return url.to_owned();
    };
    let Ok(parsed) = url::Url::parse(url) else {
        return url.to_owned();
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return url.to_owned();
    }
    let hostname = parsed.host_str().unwrap_or_default();
    let (base, query, hash) = (
        &url[..query_at],
        &url[query_at + 1..hash_at],
        &url[hash_at..],
    );
    let pairs: Vec<&str> = query.split('&').collect();
    let kept: Vec<&str> = pairs
        .iter()
        .copied()
        .filter(|pair| {
            !pair.is_empty()
                && !is_tracking_param(&decode_name(pair.split('=').next().unwrap_or("")), hostname)
        })
        .collect();
    if kept.len() == pairs.len() {
        return url.to_owned();
    }
    format!(
        "{base}{}{hash}",
        if kept.is_empty() {
            String::new()
        } else {
            format!("?{}", kept.join("&"))
        }
    )
}
