use libwebrtc::stats::RtcStats;
use livekit::rtc_engine::SessionStats;

pub fn extract_rtt_ms(stats: &SessionStats) -> Option<u32> {
    let mut best: Option<u32> = None;

    for report in stats
        .publisher_stats
        .iter()
        .chain(stats.subscriber_stats.iter())
    {
        if let Some(ms) = rtt_from_report(report) {
            best = Some(best.map_or(ms, |current| current.min(ms)));
        }
    }

    best
}

fn rtt_from_report(report: &RtcStats) -> Option<u32> {
    match report {
        RtcStats::CandidatePair(pair) => {
            if pair.candidate_pair.nominated && pair.candidate_pair.current_round_trip_time > 0.0 {
                Some((pair.candidate_pair.current_round_trip_time * 1000.0).round() as u32)
            } else {
                None
            }
        }
        RtcStats::RemoteInboundRtp(rtp) => {
            if rtp.remote_inbound.round_trip_time > 0.0 {
                Some((rtp.remote_inbound.round_trip_time * 1000.0).round() as u32)
            } else {
                None
            }
        }
        _ => None,
    }
}
