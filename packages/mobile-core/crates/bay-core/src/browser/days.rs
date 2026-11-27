//! History's day groups: Today, Yesterday, This week and Earlier.

use serde::Serialize;

/// Which day a group covers; the panels show it as a `history.group.<id>` message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum DayGroupId {
    Today,
    Yesterday,
    Week,
    Earlier,
}

/// Where the device's local days start, in milliseconds: today's midnight, yesterday's, and the one six days ago. The
/// apps work these out with the phone's calendar, so a change of clocks lands where the phone says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct DayBounds {
    pub today: i64,
    pub yesterday: i64,
    pub week: i64,
}

/// A day's entries, by their places in the list given.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DayGroup {
    pub id: DayGroupId,
    pub entries: Vec<u32>,
}

/// Splits entries (their times, newest first) into Today, Yesterday, This week and Earlier, leaving out empty groups.
#[uniffi::export]
pub fn group_by_day(times: Vec<i64>, bounds: DayBounds) -> Vec<DayGroup> {
    let mut groups = [
        (DayGroupId::Today, bounds.today),
        (DayGroupId::Yesterday, bounds.yesterday),
        (DayGroupId::Week, bounds.week),
        (DayGroupId::Earlier, i64::MIN),
    ]
    .map(|(id, from)| {
        (
            from,
            DayGroup {
                id,
                entries: Vec::new(),
            },
        )
    });
    for (index, at) in times.iter().enumerate() {
        if let Some((_, group)) = groups.iter_mut().find(|(from, _)| at >= from) {
            group.entries.push(index as u32);
        }
    }
    groups
        .into_iter()
        .map(|(_, group)| group)
        .filter(|group| !group.entries.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = 3_600_000;

    #[test]
    fn history_groups_by_local_day_and_drops_empty_groups() {
        // Days of 24 hours from a midnight, as tests/historyGroups.test.ts builds them on 2 November 2026.
        let today = 1_793_577_600_000;
        let bounds = DayBounds {
            today,
            yesterday: today - 24 * HOUR,
            week: today - 6 * 24 * HOUR,
        };
        let at = |days: i64, hour: i64| today - days * 24 * HOUR + hour * HOUR;
        let times = vec![at(0, 9), at(0, 0), at(1, 23), at(4, 12), at(32, 12)];
        let groups: Vec<(DayGroupId, usize)> = group_by_day(times, bounds)
            .into_iter()
            .map(|group| (group.id, group.entries.len()))
            .collect();
        assert_eq!(
            groups,
            [
                (DayGroupId::Today, 2),
                (DayGroupId::Yesterday, 1),
                (DayGroupId::Week, 1),
                (DayGroupId::Earlier, 1)
            ]
        );
        let only: Vec<DayGroupId> = group_by_day(vec![at(1, 8)], bounds)
            .into_iter()
            .map(|group| group.id)
            .collect();
        assert_eq!(only, [DayGroupId::Yesterday]);
    }
}
